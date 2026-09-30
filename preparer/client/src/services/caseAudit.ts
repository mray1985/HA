/**
 * A case's review record (decisions on review items, approval) and its audit
 * trail (work order §40 manual overrides, §41 audit events). Both are kept in
 * the encrypted case records and removed with the case.
 */

import type { CaseReviewRecord, ReviewResolution } from './caseReview';
import { readRecord, removeRecord, removeRecordsWithPrefix, writeRecord } from './caseRecords';
import type { ModelRunRecord } from './localModels';
import { AUDIT_KEY_PREFIX, auditStorageKey, MODEL_RUN_KEY_PREFIX, modelRunStorageKey, REVIEW_KEY_PREFIX, reviewStorageKey } from './storageScope';

export type CaseAuditEvent =
  | { at: string; kind: 'correction'; field: string; from: unknown; to: unknown }
  | { at: string; kind: 'resolution'; itemId: string; decision: ReviewResolution['decision']; note: string; message: string }
  | { at: string; kind: 'reopened'; itemId: string }
  | { at: string; kind: 'approval' }
  | { at: string; kind: 'document'; documentId: string; fileName: string; outcome: string }
  /** A tax-engine tool call (work order §40): accepted or rejected by validation, and what it did. */
  | { at: string; kind: 'tool'; tool: string; accepted: boolean; source?: string; detail: string }
  /** A preparer's answer to what a form could not say (§38). */
  | { at: string; kind: 'decision'; subject: string; detail: string }
  /** A client's reply, kept word for word (§25), and how many open questions it answered. */
  | { at: string; kind: 'client_reply'; replyId: string; text: string; answered: number; left: number }
  /** One answer read from a client's reply: recorded, or left for the preparer and why. */
  | { at: string; kind: 'client_answer'; replyId: string; question: string; recorded: boolean; answer?: string; quote?: string; detail: string };

/** An event before it is stamped with its time. */
export type NewAuditEvent = CaseAuditEvent extends infer E ? (E extends CaseAuditEvent ? Omit<E, 'at'> : never) : never;

export function loadReviewRecord(returnId: string): CaseReviewRecord {
  return readRecord<CaseReviewRecord>(reviewStorageKey(returnId)) ?? { resolutions: {} };
}

export function saveReviewRecord(returnId: string, record: CaseReviewRecord): void {
  writeRecord(reviewStorageKey(returnId), record);
}

export function loadAudit(returnId: string): CaseAuditEvent[] {
  const events = readRecord<CaseAuditEvent[]>(auditStorageKey(returnId));
  return Array.isArray(events) ? events : [];
}

/** Corrections to one field this close together are one edit. */
const COALESCE_MS = 10_000;

/**
 * Append an event and return the case's whole trail. Successive corrections
 * to the same field within a few seconds (typing) become one event that keeps
 * the value from before the first.
 */
export function appendAudit(returnId: string, event: NewAuditEvent, now = new Date()): CaseAuditEvent[] {
  const trail = loadAudit(returnId);
  const last = trail[trail.length - 1];
  const stamped = { ...event, at: now.toISOString() } as CaseAuditEvent;
  const events =
    event.kind === 'correction' && last?.kind === 'correction' && last.field === event.field &&
    now.getTime() - new Date(last.at).getTime() < COALESCE_MS
      ? [...trail.slice(0, -1), { ...last, to: event.to, at: stamped.at }]
      : [...trail, stamped];
  writeRecord(auditStorageKey(returnId), events);
  return events;
}

/** The local model runs that read this case's documents (§42); facts name theirs by run id. */
export function loadModelRuns(returnId: string): ModelRunRecord[] {
  return readRecord<ModelRunRecord[]>(modelRunStorageKey(returnId)) ?? [];
}

export function appendModelRuns(returnId: string, runs: readonly ModelRunRecord[]): void {
  if (runs.length === 0) return;
  writeRecord(modelRunStorageKey(returnId), [...loadModelRuns(returnId), ...runs]);
}

/** Remove a case's review record, audit trail and model runs (paired with deleteReturn). */
export function deleteCaseReview(returnId: string): void {
  removeRecord(reviewStorageKey(returnId));
  removeRecord(auditStorageKey(returnId));
  removeRecord(modelRunStorageKey(returnId));
}

/** Remove every case's review record, audit trail and model runs (paired with wipeAllData). */
export function deleteAllCaseReviews(): void {
  removeRecordsWithPrefix(REVIEW_KEY_PREFIX);
  removeRecordsWithPrefix(AUDIT_KEY_PREFIX);
  removeRecordsWithPrefix(MODEL_RUN_KEY_PREFIX);
}
