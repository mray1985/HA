/**
 * Document intake (work order §11, §12, §47, §49).
 *
 * One case: each dropped file is registered (hashed, screened, a file already
 * on the case is not read twice), read on this computer — by the local models
 * when the runtime is ready, from the text layer and with OCR otherwise —
 * applied to the return, and audited. The taxpayer's empty identity fields are
 * filled from what the documents confirm; the return is then recalculated and
 * its diagnostics run.
 *
 * A batch for any clients (the dashboard): every file is read first, then
 * placed by the person it names — a confirmed SSN on a case of that year (the
 * taxpayer's or the spouse's), or a confirmed last four digits with the last
 * name on exactly one case. People no case has are grouped into households
 * (the same confirmed address) and each household gets a new case. A file
 * that names no one, or no one confidently, waits for the preparer to assign.
 *
 * The Documents tab, a drop anywhere on a case, and the dashboard all use it,
 * so a document reaches the return the same way from each.
 */

import { identityKeyText, selectDocumentExtractKind, type IngestedDocument, type PageReading, type PartyIdentity } from '@hatax/local-ai';
import type { TaxReturn } from '@hatax/engine';
import { createReturn, getReturn, listReturns } from '../api/client';
import { appendAudit, appendModelRuns } from './caseAudit';
import { applyExtractionToDocument, applyModelReadingsToDocument, loadDocuments, registerDroppedDocument, type ApplyExtractionResult } from './documentIngestion';
import { applyIdentityFromDocuments, clientNameOf, peopleOnDocuments, type IdentitySource } from './caseIdentity';
import { fetchModelStatus, type LocalRuntimeStatus, type ModelRunRecord } from './localModels';
import type { ModelReadItem, readWithLocalModels } from './modelIngestion';
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

/** One file, read and not yet on a case. */
export interface FileRead {
  file: File;
  /** The local models' page readings. */
  readings?: PageReading[];
  /** The text layer / OCR extraction, when the models did not read it. */
  extracted?: PDFExtractResult;
  /** How it was read, for the audit trail. */
  how: string;
  /** The model runs that read it (§42). */
  runs: ModelRunRecord[];
  error?: string;
}

/** A document record for reading before the file is on a case (never stored). */
function unplaced(file: File): IngestedDocument {
  return { documentId: 'unplaced', returnId: '', fileName: file.name, mimeType: file.type, byteLength: file.size, contentHash: '', ingestedAt: '', status: 'registered' };
}

/** Read files on this computer: the local models when ready, the text layer and OCR otherwise. */
export async function readFiles(files: readonly File[], hooks: IntakeHooks = {}): Promise<FileRead[]> {
  const progress = hooks.onProgress ?? (() => {});
  const status = await fetchModelStatus();
  hooks.onRuntime?.(status);
  const items: ModelReadItem[] = files.map((file) => ({ document: unplaced(file), file }));
  const runs: ModelRunRecord[] = [];
  const out: FileRead[] = [];
  let modelResults: Awaited<ReturnType<typeof readWithLocalModels>> | null = null;
  let fallback = status ? `local AI unavailable: ${status.reason ?? 'not ready'}` : '';
  if (status?.available) {
    try {
      // Loaded when the models read: page rendering needs the browser's canvas.
      const { readWithLocalModels: read } = await import('./modelIngestion');
      modelResults = await read(items, progress, runs);
    } catch (err) {
      fallback = `the local models failed (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  for (const [i, item] of items.entries()) {
    const result = modelResults?.[i];
    if (result && 'readings' in result) {
      const ids = new Set(result.readings.flatMap((r) => r.runs.map((run) => run.runId)).filter(Boolean));
      out.push({ file: item.file, readings: result.readings, how: `read by the local models in ${result.seconds}s`, runs: runs.filter((r) => ids.has(r.runId)) });
      continue;
    }
    const reason = result && 'fallback' in result ? result.fallback : fallback;
    progress(`Reading ${item.file.name}…`);
    try {
      out.push({ file: item.file, extracted: await readFile(item.file), how: reason ? `read from the text layer — ${reason}` : 'read from the text layer', runs: [] });
    } catch (err) {
      out.push({ file: item.file, how: '', runs: [], error: err instanceof Error ? err.message : 'could not be read' });
    }
  }
  return out;
}

/** The people a read file names, one per classified form. */
export function identitiesOf(read: FileRead): PartyIdentity[] {
  if (read.readings) return read.readings.flatMap((r) => (r.classification.status === 'classified' && r.identity ? [r.identity] : []));
  const pieces = read.extracted ? [read.extracted, ...(read.extracted.additionalResults ?? [])] : [];
  return pieces.flatMap((p) => (p.identity ? [p.identity] : []));
}

/** Put a read file on a case: registered, applied, audited. Returns false when the case already has it. */
async function placeRead(returnId: string, read: FileRead, hooks: IntakeHooks, failures: string[]): Promise<boolean> {
  const registered = await registerDroppedDocument({ returnId, file: read.file });
  if (registered.rejected || registered.duplicate) {
    appendAudit(returnId, { kind: 'document', documentId: registered.document.documentId, fileName: read.file.name, outcome: registered.rejected ? 'rejected' : 'duplicate' });
    return false;
  }
  applyRead(returnId, registered.document, read, hooks, failures);
  return true;
}

function applyRead(returnId: string, document: IngestedDocument, read: FileRead, hooks: IntakeHooks, failures: string[]): void {
  const taxYear = getReturn(returnId).taxYear;
  if (read.error) {
    failures.push(`${read.file.name}: ${read.error}`);
    return;
  }
  try {
    hooks.beforeApply?.();
    const applied: ApplyExtractionResult = read.readings
      ? applyModelReadingsToDocument({ returnId, taxYear, document, readings: read.readings })
      : applyExtractionToDocument({ returnId, taxYear, document, extracted: read.extracted! });
    appendModelRuns(returnId, read.runs);
    if (applied.provenanceError) failures.push(`${read.file.name}: ${applied.provenanceError}`);
    const outcomes = applyExtraction(returnId, applied);
    appendAudit(returnId, {
      kind: 'document',
      documentId: applied.document.documentId,
      fileName: read.file.name,
      outcome: `${applied.unclassified ? 'not identified' : outcomes.join(', ') || 'nothing applied'} (${read.how})`,
    });
    hooks.afterDocument?.();
  } catch (err) {
    failures.push(`${read.file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
  }
}

/** After documents reached a case: identity from them, then the return's calculation and diagnostics. */
function finishCase(returnId: string, hooks: IntakeHooks): void {
  // §13: the taxpayer's empty identity fields, from what the documents confirm.
  hooks.beforeApply?.();
  applyIdentityFromDocuments(returnId, loadDocuments(returnId));
  // §47: the return is recalculated and its diagnostics run.
  runReturnChecks(returnId);
}

/** Register, read and apply a batch of files to one case. */
export async function ingestFiles(returnId: string, files: readonly File[], hooks: IntakeHooks = {}): Promise<IntakeResult> {
  const progress = hooks.onProgress ?? (() => {});
  const failures: string[] = [];
  let skipped = 0;

  // A file already read onto the case is not read twice.
  const toRead: Array<{ file: File; document: IngestedDocument }> = [];
  for (const file of files) {
    progress(`Checking ${file.name}…`);
    try {
      const registered = await registerDroppedDocument({ returnId, file });
      if (registered.rejected || registered.duplicate) {
        appendAudit(returnId, { kind: 'document', documentId: registered.document.documentId, fileName: file.name, outcome: registered.rejected ? 'rejected' : 'duplicate' });
        skipped++;
        continue;
      }
      toRead.push({ file, document: registered.document });
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
    }
  }
  if (toRead.length === 0) return { read: 0, skipped, failures };

  const reads = await readFiles(toRead.map((t) => t.file), hooks);
  let read = 0;
  for (const [i, r] of reads.entries()) {
    const before = failures.length;
    applyRead(returnId, toRead[i]!.document, r, hooks, failures);
    if (failures.length === before) read++;
  }
  finishCase(returnId, hooks);
  return { read, skipped, failures };
}

// ─── Batch intake for any clients (§12, §49) ─────────────────

export interface BatchPlacement {
  returnId: string;
  name: string;
  created: boolean;
  files: string[];
}

export interface BatchResult {
  placed: BatchPlacement[];
  /** Read, but naming no one the intake can place with confidence. */
  unmatched: FileRead[];
  failures: string[];
}

const digits = (s: string | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length === 9 ? d : undefined;
};

/** The people on a case a form can be for: the taxpayer and spouse, and for a 1098-T or 1099-Q its dependents. */
function peopleOnCase(c: TaxReturn, withDependents: boolean): Array<{ ssn?: string; lastFour?: string; last: string }> {
  return [
    { ssn: c.ssn, lastFour: c.ssnLastFour, last: c.lastName ?? '' },
    { ssn: c.spouseSsn, lastFour: c.spouseSsnLastFour, last: c.spouseLastName ?? c.lastName ?? '' },
    ...(withDependents ? (c.dependents ?? []).map((d) => ({ ssn: d.ssn, lastFour: d.ssnLastFour, last: d.lastName ?? '' })) : []),
  ];
}

/**
 * The case of this year for the person a form names, when exactly one fits:
 * by a confirmed SSN, or the last four digits with the last name. A 1098-T
 * student or 1099-Q recipient may be a dependent on the case.
 */
export function caseForIdentity(identity: PartyIdentity, cases: readonly TaxReturn[]): TaxReturn | null {
  const people = (c: TaxReturn) => peopleOnCase(c, identity.placementOnly === true);
  const tin = identity.tin?.confirmed ? identity.tin.value : undefined;
  if (tin) {
    const hit = cases.filter((c) => people(c).some((p) => digits(p.ssn) === tin));
    return hit.length === 1 ? hit[0]! : null;
  }
  const lastFour = identity.tinLastFour;
  const last = identity.name?.confirmed && identity.name.value ? identityKeyText(identity.name.value.last) : undefined;
  if (lastFour && last) {
    // The last four of a full SSN, or the confirmed last four kept from a masked one.
    const lastFourOf = (full: string | undefined, kept: string | undefined) =>
      digits(full)?.slice(5) ?? (kept && /^\d{4}$/.test(kept) ? kept : undefined);
    const hit = cases.filter((c) => people(c).some((p) => lastFourOf(p.ssn, p.lastFour) === lastFour && identityKeyText(p.last) === last));
    return hit.length === 1 ? hit[0]! : null;
  }
  return null;
}

/** Of the files a batch could not place, the ones a single case of `cases` now fits (after the batch's new cases). */
export function placeableAfterNewCases(reads: readonly FileRead[], cases: readonly TaxReturn[]): Array<{ read: FileRead; returnId: string }> {
  return reads.flatMap((read) => {
    const targets = new Set(identitiesOf(read).map((id) => caseForIdentity(id, cases)?.id).filter((id): id is string => Boolean(id)));
    return targets.size === 1 ? [{ read, returnId: [...targets][0]! }] : [];
  });
}

/**
 * Read a batch for any clients and place each file on its client's case of
 * `taxYear`, starting new cases for new clients.
 */
export async function ingestBatch(files: readonly File[], taxYear: number, hooks: IntakeHooks = {}): Promise<BatchResult> {
  const reads = await readFiles(files, hooks);
  const failures: string[] = reads.filter((r) => r.error).map((r) => `${r.file.name}: ${r.error}`);
  const cases = listReturns().filter((r) => r.taxYear === taxYear);
  const toCase = new Map<string, FileRead[]>();
  const unplacedReads: FileRead[] = [];

  for (const read of reads) {
    if (read.error) continue;
    const ids = identitiesOf(read);
    const targets = new Set(ids.map((id) => caseForIdentity(id, cases)?.id).filter((id): id is string => Boolean(id)));
    if (targets.size === 1) {
      const id = [...targets][0]!;
      toCase.set(id, [...(toCase.get(id) ?? []), read]);
    } else {
      unplacedReads.push(read);
    }
  }

  // New clients: the people the unplaced files confirm, in households by confirmed address.
  // A 1098-T student or 1099-Q recipient never starts a client of its own.
  const sources: Array<IdentitySource & { read: FileRead }> = unplacedReads.flatMap((read, n) =>
    identitiesOf(read).flatMap((identity, index) => (identity.placementOnly ? [] : [{ documentId: `batch-${n}`, fileName: read.file.name, index, identity, read }])));
  const people = peopleOnDocuments(sources).filter((p) => p.tin || (p.tinLastFour && p.name) || (p.name && p.addresses.length > 0));
  const households: Array<{ people: typeof people; reads: Set<FileRead> }> = [];
  for (const person of people) {
    const addressKeys = person.addresses.map((a) => `${identityKeyText(a.street)}|${a.zip.slice(0, 5)}`);
    const home = households.find((h) => h.people.some((p) => p.addresses.some((a) => addressKeys.includes(`${identityKeyText(a.street)}|${a.zip.slice(0, 5)}`))));
    const reads = new Set(sources.filter((s) => person.sources.some((ps) => ps.documentId === s.documentId)).map((s) => s.read));
    if (home) {
      home.people.push(person);
      reads.forEach((r) => home.reads.add(r));
    } else {
      households.push({ people: [person], reads });
    }
  }
  // A file naming people in two households is the preparer's to place.
  const claimed = new Map<FileRead, number>();
  households.forEach((h, i) => h.reads.forEach((r) => claimed.set(r, claimed.has(r) ? -1 : i)));
  const unmatched = unplacedReads.filter((r) => (claimed.get(r) ?? -1) < 0);

  const placed: BatchPlacement[] = [];
  for (const [returnId, list] of toCase) {
    const names: string[] = [];
    for (const read of list) if (await placeRead(returnId, read, hooks, failures)) names.push(read.file.name);
    if (names.length > 0) finishCase(returnId, hooks);
    placed.push({ returnId, name: clientNameOf(getReturn(returnId)), created: false, files: names });
  }
  for (const [i, home] of households.entries()) {
    const list = [...home.reads].filter((r) => claimed.get(r) === i);
    if (list.length === 0) continue;
    const created = createReturn(taxYear);
    const names: string[] = [];
    for (const read of list) if (await placeRead(created.id, read, hooks, failures)) names.push(read.file.name);
    appendAudit(created.id, { kind: 'decision', subject: 'New case', detail: `started from a batch of documents: ${names.join(', ')}` });
    finishCase(created.id, hooks);
    placed.push({ returnId: created.id, name: clientNameOf(getReturn(created.id)), created: true, files: names });
  }

  // What is left — a 1099-Q or 1098-T for a client this batch started — fits a case now.
  const yearCases = listReturns().filter((r) => r.taxYear === taxYear);
  const late = placeableAfterNewCases(unmatched, yearCases);
  for (const { read, returnId } of late) {
    if (!(await placeRead(returnId, read, hooks, failures))) continue;
    finishCase(returnId, hooks);
    const entry = placed.find((p) => p.returnId === returnId);
    if (entry) entry.files.push(read.file.name);
    else placed.push({ returnId, name: clientNameOf(getReturn(returnId)), created: false, files: [read.file.name] });
  }
  const placedLate = new Set(late.map((l) => l.read));
  return { placed, unmatched: unmatched.filter((r) => !placedLate.has(r)), failures };
}

/** Put a file the batch could not place on the case the preparer chose (no second reading). */
export async function placeUnmatched(returnId: string, read: FileRead, hooks: IntakeHooks = {}): Promise<IntakeResult> {
  const failures: string[] = [];
  const placedOk = await placeRead(returnId, read, hooks, failures);
  if (placedOk) finishCase(returnId, hooks);
  appendAudit(returnId, { kind: 'decision', subject: 'Document placed', detail: `${read.file.name} assigned to this case by the preparer` });
  return { read: placedOk && failures.length === 0 ? 1 : 0, skipped: placedOk ? 0 : 1, failures };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run intakes one after another (work order §48): the local models load one at
 * a time, so a batch dropped on another case waits for the one being read.
 */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

export function enqueueIntake(returnId: string, files: readonly File[], hooks: IntakeHooks = {}): Promise<IntakeResult> {
  return enqueue(() => ingestFiles(returnId, files, hooks));
}

export function enqueueBatch(files: readonly File[], taxYear: number, hooks: IntakeHooks = {}): Promise<BatchResult> {
  return enqueue(() => ingestBatch(files, taxYear, hooks));
}
