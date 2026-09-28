import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getReturn } from '../../api/client';
import { extractFromImage, extractFromPDF, extractFromPDFWithOCR } from '../../services/pdfImporter';
import { buildActionsFromExtraction } from '../../services/documentToActions';
import { executeActions } from '../../services/intentExecutor';
import { crossValidate, extractFieldsWithAI } from '../../services/aiExtractionService';
import { useAISettingsStore } from '../../store/aiSettingsStore';
import { factsForExtraction, appendTaxFacts } from '../../services/preparerTaxFacts';
import type { PDFExtractResult, SupportedFormType } from '../../services/pdfExtractHelpers';
import type { TaxFact } from '@hatax/engine';

interface IntakeRow {
  fileName: string;
  summary: string;
  detail: string;
  facts: TaxFact[];
}

export default function PreparerIntakePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntakeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byok = useAISettingsStore((s) => s.mode === 'byok' && Boolean(s._decryptedApiKey));

  const review = () => {
    if (id) navigate(`/preparer/return/${id}`);
  };

  const readOne = async (file: File): Promise<PDFExtractResult> => {
    if (file.type.startsWith('image/')) {
      return extractFromImage(file);
    }
    const digital = await extractFromPDF(file);
    if (digital.ocrAvailable || digital.errors.some((e) => /scan/i.test(e))) {
      return extractFromPDFWithOCR(file);
    }
    return digital;
  };

  const withModel = async (extracted: PDFExtractResult): Promise<PDFExtractResult> => {
    const settings = useAISettingsStore.getState();
    if (!extracted.rawOCRText || !extracted.formType) return extracted;
    if (settings.mode !== 'byok' || !settings._decryptedApiKey) return extracted;
    const ai = await extractFieldsWithAI(extracted.rawOCRText, extracted.formType, {
      provider: settings.byokProvider,
      apiKey: settings._decryptedApiKey,
      model: settings.byokModel,
    });
    const validated = crossValidate(
      extracted.extractedData,
      ai,
      extracted.formType as SupportedFormType,
    );
    const extractedData = { ...extracted.extractedData };
    for (const field of validated) {
      if (field.confidence !== 'low' || field.source === 'both_agree') {
        extractedData[field.key] = field.finalValue;
      }
    }
    return { ...extracted, extractedData, aiEnhanced: true };
  };

  const onFiles = async (list: FileList | null) => {
    if (!id || !list || list.length === 0) return;
    try {
      getReturn(id);
    } catch {
      setError('This client return is not on this computer.');
      return;
    }
    setBusy(true);
    setError(null);
    const next: IntakeRow[] = [];
    for (const file of Array.from(list)) {
      try {
        const extracted = await withModel(await readOne(file));
        const pieces = [extracted, ...(extracted.additionalResults ?? [])];
        const documentId = `DOC-${file.name}-${file.size}-${file.lastModified}`;
        const bundled = pieces.map((piece) => factsForExtraction({
          returnId: id,
          taxYear: 2025,
          documentId,
          fileName: file.name,
          extracted: piece,
        }));
        const facts = bundled.flatMap((item) => item.facts);
        appendTaxFacts(id, facts);
        const toolErrors = bundled.map((item) => item.toolError).filter(Boolean) as string[];
        const actions = pieces.flatMap((piece, index) => {
          const { toolFields, incomeType, toolError } = bundled[index];
          if (toolError || Object.keys(toolFields).length === 0) return [];
          return buildActionsFromExtraction({
            ...piece,
            incomeType: incomeType ?? piece.incomeType,
            extractedData: toolFields,
          }).actions;
        });
        if (actions.length === 0) {
          next.push({
            fileName: file.name,
            summary: 'Nothing usable was read',
            detail: [
              ...toolErrors,
              ...extracted.errors,
              ...extracted.warnings,
            ].filter(Boolean).join(' ') || 'The form was stored as unknown. Missing amounts were not written as zero.',
            facts,
          });
          continue;
        }
        const applied = executeActions(actions, id);
        const labels = pieces
          .map((piece) => piece.formType || 'form')
          .join(', ');
        next.push({
          fileName: file.name,
          summary: `${labels} · ${applied.successCount} added`,
          detail: [
            extracted.aiEnhanced ? 'The model checked the scanned fields.' : 'Read on this computer.',
            ...extracted.warnings,
            ...applied.results.filter((r) => !r.success).map((r) => r.error || r.summary),
          ].filter(Boolean).join(' '),
          facts,
        });
      } catch (err) {
          next.push({
            fileName: file.name,
            summary: 'Could not read this file',
            detail: err instanceof Error ? err.message : 'Unknown error',
            facts: [],
          });
      }
    }
    setRows((prev) => [...next, ...prev]);
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-surface-900">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <button
          type="button"
          onClick={() => navigate('/preparer')}
          className="text-sm text-slate-400 hover:text-white mb-6"
        >
          Back to clients
        </button>
        <p className="text-xs uppercase tracking-wide text-HATaxService-orange-400 mb-2">New client</p>
        <h1 className="text-3xl font-bold text-white mb-3">Drop the client’s forms</h1>
        <p className="text-slate-300 text-sm leading-relaxed mb-6">
          W-2s and 1099s are read into this return. The assistant only writes values it can see on the form. It does not invent income. You still review the return before anyone files it.
        </p>
        <label className="block border border-dashed border-slate-600 rounded-xl p-8 text-center cursor-pointer hover:border-HATaxService-orange-500">
          <span className="text-white font-medium">{busy ? 'Reading forms...' : 'Choose PDFs or photos'}</span>
          <p className="text-xs text-slate-400 mt-2">
            {byok
              ? 'Scanned pages are sent to the model after names and ID numbers are stripped.'
              : 'Digital PDFs are read on this computer. Turn on the assistant key to read scans.'}
          </p>
          <input
            type="file"
            accept="application/pdf,image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
        {rows.length > 0 && (
          <ul className="mt-6 space-y-3">
            {rows.map((row, index) => (
              <li key={`${row.fileName}-${index}`} className="bg-surface-800 border border-slate-700 rounded-lg p-4">
                <p className="text-white text-sm font-medium">{row.fileName}</p>
                <p className="text-HATaxService-orange-400 text-sm mt-1">{row.summary}</p>
                {row.detail && <p className="text-slate-400 text-xs mt-1">{row.detail}</p>}
                {row.facts.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {row.facts.map((fact) => (
                      <li key={fact.factId} className="text-xs text-slate-300">
                        {fact.sourceField}: {fact.status === 'extracted' ? String(fact.value) : 'unknown — not on the form'}
                        <span className="text-slate-500"> · {fact.sourceFileName} · {fact.extractor}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-3 mt-8">
          <button
            type="button"
            onClick={review}
            className="bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white text-sm font-medium px-4 py-2.5 rounded-lg"
          >
            Review the return
          </button>
        </div>
      </div>
    </div>
  );
}
