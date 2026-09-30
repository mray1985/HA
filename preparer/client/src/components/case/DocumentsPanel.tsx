/**
 * Documents tab: the case's evidence. Tax forms dropped here are hashed,
 * identified, read on this machine (text layer, or OCR for scans and photos),
 * turned into TaxFacts through the tax tools, and applied to the return.
 * Bank statements and other structured imports live alongside.
 */

import { useMemo, useState } from 'react';
import { FileText, Landmark, Upload, FolderInput } from 'lucide-react';
import { selectDocumentExtractKind, type DocumentPieceOutcome, type IngestedDocument, type TaxFact } from '@hatax/local-ai';
import { applyExtractionToDocument, registerDroppedDocument } from '../../services/documentIngestion';
import { extractFromImage, extractFromPDF, extractFromPDFWithOCR } from '../../services/pdfImporter';
import type { PDFExtractResult } from '../../services/pdfExtractHelpers';
import { applyExtraction } from '../../services/returnApplier';
import { appendAudit } from '../../services/caseAudit';
import { useCaseStore } from '../../store/caseStore';
import ExpenseScannerToolView from '../tools/ExpenseScannerToolView';
import CSVImportPanel from '../import/CSVImportPanel';
import TXFImportPanel from '../import/TXFImportPanel';
import FDXImportPanel from '../import/FDXImportPanel';
import CompetitorImportPanel from '../import/CompetitorImportPanel';
import YoYComparisonCard from '../common/YoYComparisonCard';

const OUTCOME_LABEL: Record<DocumentPieceOutcome, { text: string; className: string }> = {
  income_item: { text: 'Entered on the return', className: 'text-emerald-300' },
  aggregate: { text: "Included in the return's total", className: 'text-emerald-300' },
  aggregate_waiting: { text: 'Waiting — a related form is held', className: 'text-amber-300' },
  held: { text: 'Held for review', className: 'text-amber-300' },
  recorded: { text: 'Recorded — needs your decision', className: 'text-sky-300' },
  not_applied: { text: 'Read — enter it on the return', className: 'text-sky-300' },
};

const STATUS_LABEL: Record<IngestedDocument['status'], string> = {
  registered: 'Not read yet',
  extracted: 'Read',
  unclassified: 'Not identified',
  duplicate: 'Duplicate',
  rejected: 'Rejected',
};

/** Read one file on this machine: text layer for digital PDFs, OCR for scans and photos. */
async function readFile(file: File): Promise<PDFExtractResult> {
  if (selectDocumentExtractKind({ mimeType: file.type, fileName: file.name }) === 'image') return extractFromImage(file);
  const digital = await extractFromPDF(file);
  const kind = selectDocumentExtractKind({
    mimeType: file.type,
    fileName: file.name,
    digital: { ocrAvailable: digital.ocrAvailable, errors: digital.errors },
  });
  return kind === 'scanned_pdf' ? extractFromPDFWithOCR(file) : digital;
}

function DocumentCard({ doc, facts }: { doc: IngestedDocument; facts: TaxFact[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{doc.fileName}</p>
          <p className="text-xs text-slate-500 font-mono">{doc.documentId}</p>
          {doc.rejectReason && <p className="text-xs text-red-300 mt-1">{doc.rejectReason}</p>}
          {(doc.formTypes ?? []).map((form, i) => {
            const outcome = doc.appliedAs?.[i];
            return (
              <p key={`${form}-${i}`} className="text-xs mt-1">
                <span className="text-slate-300">{form}</span>
                {outcome && <span className={`ml-2 ${OUTCOME_LABEL[outcome].className}`}>{OUTCOME_LABEL[outcome].text}</span>}
              </p>
            );
          })}
        </div>
        <span className="text-xs text-slate-400 whitespace-nowrap">{STATUS_LABEL[doc.status]}</span>
      </div>
      {facts.length > 0 && (
        <button onClick={() => setOpen((v) => !v)} className="text-xs text-sky-300 hover:text-sky-200 mt-2">
          {open ? 'Hide values read' : `Show ${facts.length} values read`}
        </button>
      )}
      {open && (
        <ul className="mt-2 space-y-1">
          {facts.map((fact) => (
            <li key={fact.factId} className="text-xs text-slate-300">
              <span className="text-slate-400">{fact.sourceField}</span>{' '}
              {fact.status === 'extracted' ? String(fact.value) : <span className="text-amber-300">unknown — not read</span>}
              {fact.rawText && fact.status === 'extracted' && String(fact.value) !== fact.rawText && (
                <span className="text-slate-500"> (printed “{fact.rawText}”)</span>
              )}
              <span className="text-slate-600"> · {fact.extractor}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

type Section = 'forms' | 'bank' | 'imports';
type ImportPanel = 'csv' | 'txf' | 'fdx' | 'competitor' | null;

export default function DocumentsPanel() {
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const documents = useCaseStore((s) => s.documents);
  const facts = useCaseStore((s) => s.facts);
  const reloadEvidence = useCaseStore((s) => s.reloadEvidence);
  const [section, setSection] = useState<Section>('forms');
  const [importPanel, setImportPanel] = useState<ImportPanel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const factsByDocument = useMemo(() => {
    const map = new Map<string, TaxFact[]>();
    for (const f of facts) map.set(f.sourceDocumentId, [...(map.get(f.sourceDocumentId) ?? []), f]);
    return map;
  }, [facts]);

  const onFiles = async (list: FileList | null) => {
    if (!returnId || !taxReturn || !list || list.length === 0) return;
    const failures: string[] = [];
    for (const file of Array.from(list)) {
      setBusy(`Reading ${file.name}…`);
      try {
        const registered = await registerDroppedDocument({ returnId, file });
        if (registered.rejected || registered.duplicate) {
          appendAudit(returnId, { kind: 'document', documentId: registered.document.documentId, fileName: file.name, outcome: registered.rejected ? 'rejected' : 'duplicate' });
          continue;
        }
        const extracted = await readFile(file);
        const applied = applyExtractionToDocument({ returnId, taxYear: taxReturn.taxYear, document: registered.document, extracted });
        if (applied.provenanceError) failures.push(`${file.name}: ${applied.provenanceError}`);
        const outcomes = applyExtraction(returnId, applied);
        appendAudit(returnId, {
          kind: 'document',
          documentId: applied.document.documentId,
          fileName: file.name,
          outcome: applied.unclassified ? 'not identified' : outcomes.join(', ') || 'nothing applied',
        });
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
      }
    }
    setBusy(null);
    setErrors(failures);
    reloadEvidence();
  };

  const tabs: Array<{ id: Section; label: string; icon: typeof FileText }> = [
    { id: 'forms', label: 'Tax forms', icon: FileText },
    { id: 'bank', label: 'Bank & card statements', icon: Landmark },
    { id: 'imports', label: 'Other imports', icon: FolderInput },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-slate-700">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSection(t.id)}
            className={`inline-flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px ${section === t.id ? 'border-HATaxService-orange-500 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}
          >
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {section === 'forms' && (
        <>
          <label className="block border border-dashed border-slate-600 rounded-xl p-8 text-center cursor-pointer hover:border-HATaxService-orange-500">
            <Upload className="w-6 h-6 mx-auto text-slate-400 mb-2" />
            <span className="text-white font-medium">{busy ?? 'Drop or choose the client’s PDFs and photos'}</span>
            <p className="text-xs text-slate-400 mt-2">
              Read on this computer. Each file is hashed and kept with its source; a form that cannot be identified, or a value that cannot be read, is never entered as income or as zero.
            </p>
            <input
              type="file"
              accept="application/pdf,image/*"
              multiple
              className="hidden"
              disabled={busy !== null}
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {errors.length > 0 && (
            <ul className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300 space-y-1">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {documents.length === 0 ? (
            <p className="text-sm text-slate-500">No documents yet.</p>
          ) : (
            <ul className="rounded-xl border border-slate-700 bg-surface-800 divide-y divide-slate-700/70">
              {documents.map((doc) => <DocumentCard key={doc.documentId} doc={doc} facts={factsByDocument.get(doc.documentId) ?? []} />)}
            </ul>
          )}
        </>
      )}

      {section === 'bank' && <ExpenseScannerToolView />}

      {section === 'imports' && (
        importPanel === 'csv' ? <CSVImportPanel onBack={() => setImportPanel(null)} />
          : importPanel === 'txf' ? <TXFImportPanel onBack={() => setImportPanel(null)} />
          : importPanel === 'fdx' ? <FDXImportPanel onBack={() => setImportPanel(null)} />
          : importPanel === 'competitor' ? <CompetitorImportPanel onBack={() => setImportPanel(null)} />
          : (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                {([
                  ['csv', 'Brokerage CSV', '1099-B / 1099-DA sales from a broker export'],
                  ['txf', 'TXF file', 'Tax exchange format from brokers and tax software'],
                  ['fdx', 'FDX file', 'Financial Data Exchange tax documents'],
                  ['competitor', "Another program's return", 'Last year’s return from other tax software (PDF)'],
                ] as const).map(([id, title, text]) => (
                  <button key={id} onClick={() => setImportPanel(id)} className="text-left rounded-xl border border-slate-700 bg-surface-800 hover:border-HATaxService-orange-500/60 p-4">
                    <p className="text-sm font-medium text-white">{title}</p>
                    <p className="text-xs text-slate-400 mt-1">{text}</p>
                  </button>
                ))}
              </div>
              {calculation && <YoYComparisonCard priorYear={taxReturn?.priorYearSummary} current={calculation.form1040} />}
            </div>
          )
      )}
    </div>
  );
}
