/**
 * Document intake for one case (work order §11, §47): each dropped file is
 * registered (hashed, screened, a file already on the case is not read twice),
 * read on this computer — by the local models when the runtime is ready, from
 * the text layer and with OCR otherwise — applied to the return, and audited.
 * The return is then recalculated and its diagnostics run.
 *
 * The Documents tab, a drop anywhere on the case, and the dashboard's batch
 * intake all use it, so a document reaches the return the same way from each.
 */

import { selectDocumentExtractKind } from '@hatax/local-ai';
import { getReturn } from '../api/client';
import { appendAudit, appendModelRuns } from './caseAudit';
import { applyExtractionToDocument, applyModelReadingsToDocument, registerDroppedDocument, type ApplyExtractionResult } from './documentIngestion';
import { fetchModelStatus, type LocalRuntimeStatus, type ModelRunRecord } from './localModels';
import { readWithLocalModels, type ModelReadItem, type ModelReadResult } from './modelIngestion';
import { extractFromImage, extractFromPDF, extractFromPDFWithOCR } from './pdfImporter';
import type { PDFExtractResult } from './pdfExtractHelpers';
import { applyExtraction } from './returnApplier';
import { runReturnChecks } from './recordTools';

/** Files the intake reads: PDFs and photos. */
export const INTAKE_ACCEPT = 'application/pdf,image/*';

export function isIntakeFile(file: File): boolean {
  return file.type === 'application/pdf' || file.type.startsWith('image/') || /\.(pdf|png|jpe?g|tiff?|heic|heif|webp)$/i.test(file.name);
}

/** Read one file on this machine: text layer for digital PDFs, OCR for scans and photos. */
export async function readFile(file: File): Promise<PDFExtractResult> {
  if (selectDocumentExtractKind({ mimeType: file.type, fileName: file.name }) === 'image') return extractFromImage(file);
  const digital = await extractFromPDF(file);
  const kind = selectDocumentExtractKind({
    mimeType: file.type,
    fileName: file.name,
    digital: { ocrAvailable: digital.ocrAvailable, errors: digital.errors },
  });
  return kind === 'scanned_pdf' ? extractFromPDFWithOCR(file) : digital;
}

export interface IntakeHooks {
  /** What the intake is doing now ("Reading w2.pdf…"). */
  onProgress?: (message: string) => void;
  /** The runtime status found for this batch. */
  onRuntime?: (status: LocalRuntimeStatus | null) => void;
  /** Called before the applier reads the return: an edit made meanwhile is saved first. */
  beforeApply?: () => void;
  /** Called after each document reached the return. */
  afterDocument?: () => void;
}

export interface IntakeResult {
  /** Files read and applied. */
  read: number;
  /** Files already on the case, or rejected by the screen. */
  skipped: number;
  /** One line per file that could not be read or applied. */
  failures: string[];
}

/** Register, read and apply a batch of files to one case. */
export async function ingestFiles(returnId: string, files: readonly File[], hooks: IntakeHooks = {}): Promise<IntakeResult> {
  const progress = hooks.onProgress ?? (() => {});
  const failures: string[] = [];
  let skipped = 0;
  const taxYear = getReturn(returnId).taxYear;

  // 1. Register each file: hashed, screened, and a file already on the case is not read twice.
  const items: ModelReadItem[] = [];
  for (const file of files) {
    progress(`Checking ${file.name}…`);
    try {
      const registered = await registerDroppedDocument({ returnId, file });
      if (registered.rejected || registered.duplicate) {
        appendAudit(returnId, { kind: 'document', documentId: registered.document.documentId, fileName: file.name, outcome: registered.rejected ? 'rejected' : 'duplicate' });
        skipped++;
        continue;
      }
      items.push({ document: registered.document, file });
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
    }
  }
  if (items.length === 0) return { read: 0, skipped, failures };

  // 2. The local models read the batch when the runtime is ready; the text layer and OCR otherwise.
  const status = await fetchModelStatus();
  hooks.onRuntime?.(status);
  const runs: ModelRunRecord[] = [];
  let results: ModelReadResult[];
  if (status?.available) {
    try {
      results = await readWithLocalModels(items, progress, runs);
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
  let read = 0;
  for (const result of results) {
    const { file, document } = result.item;
    try {
      let applied: ApplyExtractionResult;
      let how: string;
      if ('readings' in result) {
        hooks.beforeApply?.();
        applied = applyModelReadingsToDocument({ returnId, taxYear, document, readings: result.readings });
        how = `read by the local models in ${result.seconds}s`;
      } else {
        progress(`Reading ${file.name}…`);
        const extracted = await readFile(file);
        hooks.beforeApply?.();
        applied = applyExtractionToDocument({ returnId, taxYear, document, extracted });
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
      read++;
      hooks.afterDocument?.();
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
    }
  }
  // §47: after the documents are applied, the return is recalculated and its diagnostics run.
  runReturnChecks(returnId);
  return { read, skipped, failures };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run intakes one after another (work order §48): the local models load one at
 * a time, so a batch dropped on another case waits for the one being read.
 */
export function enqueueIntake(returnId: string, files: readonly File[], hooks: IntakeHooks = {}): Promise<IntakeResult> {
  const run = queue.then(() => ingestFiles(returnId, files, hooks));
  queue = run.catch(() => undefined);
  return run;
}
