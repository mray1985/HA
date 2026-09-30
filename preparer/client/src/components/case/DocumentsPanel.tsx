/**
 * Documents tab: the case's evidence. Tax forms dropped here are hashed,
 * identified, read on this machine (text layer, or OCR for scans and photos),
 * turned into TaxFacts through the tax tools, and applied to the return.
 * Bank statements and other structured imports live alongside.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Landmark, Upload, FolderInput } from 'lucide-react';
import { missingDocumentTitle, selectDocumentExtractKind, type DocumentPieceOutcome, type IngestedDocument, type MissingDocument, type TaxFact } from '@hatax/local-ai';
import { applyExtractionToDocument, applyModelReadingsToDocument, registerDroppedDocument, type ApplyExtractionResult } from '../../services/documentIngestion';
import { fetchModelStatus, type LocalRuntimeStatus, type ModelRunRecord } from '../../services/localModels';
import { readWithLocalModels, type ModelReadItem, type ModelReadResult } from '../../services/modelIngestion';
import { extractFromImage, extractFromPDF, extractFromPDFWithOCR } from '../../services/pdfImporter';
import type { PDFExtractResult } from '../../services/pdfExtractHelpers';
import { applyExtraction } from '../../services/returnApplier';
import { appendAudit, appendModelRuns } from '../../services/caseAudit';
import { runReturnChecks } from '../../services/recordTools';
import { flushCaseSave, useCaseStore } from '../../store/caseStore';
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
  dependent: { text: 'Added as a dependent', className: 'text-emerald-300' },
  dependent_waiting: { text: 'Dependent — details needed', className: 'text-amber-300' },
  correction: { text: 'Corrected the W-2', className: 'text-emerald-300' },
  correction_waiting: { text: 'W-2c — waiting for its W-2', className: 'text-amber-300' },
  held:{ text: 'Held for review', className: 'text-amber-300' },
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

/** How documents will be read: the local models, or the text layer and OCR. */
function RuntimeLine({ status }: { status: LocalRuntimeStatus | null | undefined }) {
  if (status === undefined) return null;
  if (status === null) {
    return <p className="text-xs text-slate-500 mt-2">Documents are read from their text layer and with OCR.</p>;
  }
  const names = status.models.map((m) => m.name).join(' + ');
  const loaded = status.models.find((m) => m.loaded);
  return status.available ? (
    <p className="text-xs text-emerald-300 mt-2">
      Local AI ready: {names}{loaded?.memoryBytes ? ` · ${loaded.name} loaded (${Math.round(loaded.memoryBytes / 1_048_576)} MB)` : ''}
    </p>
  ) : (
    <p className="text-xs text-amber-300 mt-2">Local AI unavailable — {status.reason}. Documents are read from their text layer and with OCR.</p>
  );
}

/**
 * §23: last year's documents this case does not have — possibly missing, never
 * "missing" — with the client's answer when there is one.
 */
function MissingDocumentsCard({ missing }: { missing: MissingDocument[] }) {
  if (missing.length === 0) return null;
  const open = missing.filter((m) => m.status !== 'client_says_none').length;
  return (
    <section aria-label="Possibly missing documents" className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <p className="text-sm font-medium text-amber-200">
        {open > 0 ? `${open} document${open === 1 ? '' : 's'} from last year not received yet` : 'Last year’s documents are accounted for'}
      </p>
      <ul className="mt-2 space-y-1.5">
        {missing.map((m) => (
          <li key={m.id} className="text-xs">
            <span className="text-slate-200">{missingDocumentTitle(m)}</span>
            <span className="text-slate-400"> — {m.lastYear}.</span>
            {m.status === 'client_says_none' && <span className="block text-slate-400">The client says there is none this year: “{m.answer?.words}”</span>}
            {m.status === 'client_says_received' && <span className="block text-amber-300">The client says they have it: “{m.answer?.words}” — upload it.</span>}
          </li>
        ))}
      </ul>
      {open > 0 && <p className="text-xs text-slate-500 mt-2">Each is asked about on the Client tab.</p>}
    </section>
  );
}

type Section = 'forms' | 'bank' | 'imports';
type ImportPanel = 'csv' | 'txf' | 'fdx' | 'competitor' | null;

export default function DocumentsPanel() {
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const documents = useCaseStore((s) => s.documents);
  const missingDocuments = useCaseStore((s) => s.missingDocuments);
  const facts = useCaseStore((s) => s.facts);
  const reloadEvidence = useCaseStore((s) => s.reloadEvidence);
  const [section, setSection] = useState<Section>('forms');
  const [importPanel, setImportPanel] = useState<ImportPanel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<LocalRuntimeStatus | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void fetchModelStatus().then((status) => { if (live) setRuntime(status); });
    return () => { live = false; };
  }, []);

  const factsByDocument = useMemo(() => {
    const map = new Map<string, TaxFact[]>();
    for (const f of facts) map.set(f.sourceDocumentId, [...(map.get(f.sourceDocumentId) ?? []), f]);
    return map;
  }, [facts]);

  const onFiles = async (list: FileList | null) => {
    if (!returnId || !taxReturn || !list || list.length === 0) return;
    const failures: string[] = [];

    // 1. Register each file: hashed, screened, and a file already on the case is not read twice.
    const items: ModelReadItem[] = [];
    for (const file of Array.from(list)) {
      setBusy(`Checking ${file.name}…`);
      try {
        const registered = await registerDroppedDocument({ returnId, file });
        if (registered.rejected || registered.duplicate) {
          appendAudit(returnId, { kind: 'document', documentId: registered.document.documentId, fileName: file.name, outcome: registered.rejected ? 'rejected' : 'duplicate' });
          continue;
        }
        items.push({ document: registered.document, file });
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
      }
    }

    // 2. The local models read the batch when the runtime is ready; the text layer and OCR otherwise.
    const status = await fetchModelStatus();
    setRuntime(status);
    const runs: ModelRunRecord[] = [];
    let results: ModelReadResult[];
    if (status?.available) {
      try {
        results = await readWithLocalModels(items, setBusy, runs);
      } catch (err) {
        const reason = `the local models failed (${err instanceof Error ? err.message : String(err)})`;
        results = items.map((item) => ({ item, fallback: reason }));
      }
      appendModelRuns(returnId, runs);
    } else {
      const reason = status ? `local AI unavailable: ${status.reason ?? 'not ready'}` : '';
      results = items.map((item) => ({ item, fallback: reason }));
    }

    // 3. Each document to the return.
    for (const result of results) {
      const { file, document } = result.item;
      try {
        let applied: ApplyExtractionResult;
        let how: string;
        if ('readings' in result) {
          // An edit made while the batch was read is saved before the applier reads the return.
          flushCaseSave();
          applied = applyModelReadingsToDocument({ returnId, taxYear: taxReturn.taxYear, document, readings: result.readings });
          how = `read by the local models in ${result.seconds}s`;
        } else {
          setBusy(`Reading ${file.name}…`);
          const extracted = await readFile(file);
          flushCaseSave();
          applied = applyExtractionToDocument({ returnId, taxYear: taxReturn.taxYear, document, extracted });
          how = result.fallback ? `read from the text layer — ${result.fallback}` : 'read from the text layer';
        }
        if (applied.provenanceError) failures.push(`${file.name}: ${applied.provenanceError}`);
        const outcomes = applyExtraction(returnId, applied);
        appendAudit(returnId, {
          kind: 'document',
          documentId: applied.document.documentId,
          fileName: file.name,
          outcome: `${applied.unclassified ? 'not identified' : outcomes.join(', ') || 'nothing applied'} (${how})`,
        });
        reloadEvidence();
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
      }
    }
    // §47: after the documents are applied, the return is recalculated and its diagnostics run.
    runReturnChecks(returnId);
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
            <RuntimeLine status={runtime} />
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
          <MissingDocumentsCard missing={missingDocuments} />
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
