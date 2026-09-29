import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getReturn } from '../../api/client';
import { extractFromImage, extractFromPDF, extractFromPDFWithOCR } from '../../services/pdfImporter';
import { buildActionsFromExtraction } from '../../services/documentToActions';
import { executeActions } from '../../services/intentExecutor';
import { crossValidate, extractFieldsWithAI } from '../../services/aiExtractionService';
import { useAISettingsStore } from '../../store/aiSettingsStore';
import {
  applyExtractionToDocument,
  registerDroppedDocument,
} from '../../services/documentIngestion';
import type { PDFExtractResult, SupportedFormType } from '../../services/pdfExtractHelpers';
import { selectDocumentExtractKind, type TaxFact } from '@hatax/engine';

interface IntakeRow {
  fileName: string;
  summary: string;
  detail: string;
  facts: TaxFact[];
  documentId?: string;
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
    // Step 5: images and scanned PDFs prefer Granite Docling / LightOnOCR Q4_K_M,
    // then fall back to Tesseract when both GGUFs are absent.
    // Digital PDFs stay on the text-layer extractor. No new OCR engine.
    const kind = selectDocumentExtractKind({
      mimeType: file.type,
      fileName: file.name,
    });
    if (kind === 'image') {
      return extractFromImage(file);
    }
    const digital = await extractFromPDF(file);
    const afterProbe = selectDocumentExtractKind({
      mimeType: file.type,
      fileName: file.name,
      digital: {
        ocrAvailable: digital.ocrAvailable,
        errors: digital.errors,
      },
    });
    if (afterProbe === 'scanned_pdf') {
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
    let taxYear: number;
    try {
      taxYear = getReturn(id).taxYear;
    } catch {
      setError('This client return is not on this computer.');
      return;
    }
    setBusy(true);
    setError(null);
    const next: IntakeRow[] = [];
    for (const file of Array.from(list)) {
      try {
        const registered = await registerDroppedDocument({ returnId: id, file });
        if (registered.rejected) {
          next.push({
            fileName: file.name,
            summary: 'File rejected',
            detail: registered.document.rejectReason || 'This file cannot be ingested.',
            facts: [],
            documentId: registered.document.documentId,
          });
          continue;
        }
        if (registered.duplicate) {
          next.push({
            fileName: file.name,
            summary: 'Already on this return',
            detail: `Same file content was ingested earlier as ${registered.document.documentId}.`,
            facts: [],
            documentId: registered.document.documentId,
          });
          continue;
        }

        // Extract first (existing PDF/OCR path), then classify before any tax-tool write.
        const extracted = await withModel(await readOne(file));
        const applied = applyExtractionToDocument({
          returnId: id,
          taxYear,
          document: registered.document,
          extracted,
        });

        if (applied.unclassified) {
          next.push({
            fileName: file.name,
            summary: 'Form type unknown',
            detail: [
              `Stored as ${applied.document.documentId} without writing income.`,
              applied.classification?.reason,
              ...extracted.errors,
              ...extracted.warnings,
            ].filter(Boolean).join(' '),
            facts: [],
            documentId: applied.document.documentId,
          });
          continue;
        }

        if (applied.provenanceError) {
          next.push({
            fileName: file.name,
            summary: 'Could not store facts',
            detail: applied.provenanceError,
            facts: [],
            documentId: applied.document.documentId,
          });
          continue;
        }

        const toolErrors = applied.pieces
          .map((item) => item.toolError)
          .filter(Boolean) as string[];
        // toolFields already omit structurally invalid values (e.g. negative wages).
        // Surface validation issues so the preparer sees why a field was not applied.
        const validationMessages = applied.pieces.flatMap((piece) =>
          piece.validation.issues.map((issue) => issue.message),
        );
        const actions = applied.pieces.flatMap((piece) => {
          if (piece.toolError || Object.keys(piece.toolFields).length === 0) return [];
          return buildActionsFromExtraction({
            ...piece.extracted,
            incomeType: piece.incomeType ?? piece.extracted.incomeType,
            extractedData: piece.toolFields,
          }).actions;
        });

        if (actions.length === 0) {
          next.push({
            fileName: file.name,
            summary: validationMessages.length > 0
              ? 'Validation blocked income write'
              : 'Nothing usable was read',
            detail: [
              `Stored as ${applied.document.documentId}.`,
              applied.classification
                ? `${applied.classification.formType}: ${applied.classification.reason}`
                : null,
              ...toolErrors,
              ...validationMessages,
              ...extracted.errors,
              ...extracted.warnings,
            ].filter(Boolean).join(' ') || 'The form was stored as unknown. Missing amounts were not written as zero.',
            facts: applied.facts,
            documentId: applied.document.documentId,
          });
          continue;
        }

        const executed = executeActions(actions, id);
        const labels = applied.pieces
          .filter((piece) => piece.classification.status === 'classified')
          .map((piece) => piece.classification.formType || piece.extracted.formType || 'form')
          .join(', ');
        next.push({
          fileName: file.name,
          summary: `${labels || 'form'} · ${executed.successCount} added`,
          detail: [
            `Source ${applied.document.documentId}.`,
            applied.classification?.reason,
            extracted.aiEnhanced ? 'The model checked the scanned fields.' : 'Read on this computer.',
            ...toolErrors,
            ...validationMessages,
            ...extracted.warnings,
            ...executed.results.filter((r) => !r.success).map((r) => r.error || r.summary),
          ].filter(Boolean).join(' '),
          facts: applied.facts,
          documentId: applied.document.documentId,
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
          W-2s and 1099s are identified from form markers, then read into this return. Photos and scanned PDFs use the local OCR path already in the app; digital PDFs use the text layer. Each file is hashed and stored with provenance. Empty or unreadable scans stay unclassified and are not written as income. Low OCR confidence stays low. The assistant does not invent form types or amounts. You still review the return before anyone files it.
        </p>
        <label className="block border border-dashed border-slate-600 rounded-xl p-8 text-center cursor-pointer hover:border-HATaxService-orange-500">
          <span className="text-white font-medium">{busy ? 'Reading forms...' : 'Choose PDFs or photos'}</span>
          <p className="text-xs text-slate-400 mt-2">
            {byok
              ? 'Scans are read with local OCR on this computer; the model may check fields after names and ID numbers are stripped.'
              : 'Digital PDFs and scans are read on this computer with the built-in OCR path. No cloud model is required.'}
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
              <li key={`${row.documentId ?? row.fileName}-${index}`} className="bg-surface-800 border border-slate-700 rounded-lg p-4">
                <p className="text-white text-sm font-medium">{row.fileName}</p>
                <p className="text-HATaxService-orange-400 text-sm mt-1">{row.summary}</p>
                {row.documentId && (
                  <p className="text-slate-500 text-xs mt-1 font-mono">{row.documentId}</p>
                )}
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
