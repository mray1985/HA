/** Storage keys for saved cases: every key starts hatax-preparer:. */

export const RETURN_LIST_KEY = 'hatax-preparer:returns';

export function returnStorageKey(id: string): string {
  return `hatax-preparer:return:${id}`;
}

export const TAX_FACT_KEY_PREFIX = 'hatax-preparer:facts:';

export function taxFactStorageKey(returnId: string): string {
  return `${TAX_FACT_KEY_PREFIX}${returnId}`;
}

/** Review decisions and approval for a case. */
export const REVIEW_KEY_PREFIX = 'hatax-preparer:review:';

export function reviewStorageKey(returnId: string): string {
  return `${REVIEW_KEY_PREFIX}${returnId}`;
}

/** Audit trail for a case: corrections, review decisions, approvals, documents. */
export const AUDIT_KEY_PREFIX = 'hatax-preparer:audit:';

export function auditStorageKey(returnId: string): string {
  return `${AUDIT_KEY_PREFIX}${returnId}`;
}

/** Local model runs for a case (§42): which model, file hash and quantization read which page. */
export const MODEL_RUN_KEY_PREFIX = 'hatax-preparer:model-runs:';

export function modelRunStorageKey(returnId: string): string {
  return `${MODEL_RUN_KEY_PREFIX}${returnId}`;
}

/** Provenance records for dropped preparer documents (metadata; the files themselves, encrypted, are in services/documentFiles). */
export const DOCUMENT_KEY_PREFIX = 'hatax-preparer:documents:';

export function documentStorageKey(returnId: string): string {
  return `${DOCUMENT_KEY_PREFIX}${returnId}`;
}
