/** Consumer and preparer share one site, so their saved returns use different keys. */
export function isPreparerApp(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.app === 'preparer';
}

export const RETURN_LIST_KEY = isPreparerApp() ? 'hatax-preparer:returns' : 'hatax:returns';

export function returnStorageKey(id: string): string {
  return isPreparerApp() ? `hatax-preparer:return:${id}` : `hatax:return:${id}`;
}

export const CHAT_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:chat:' : 'hatax:chat:';

export const TAX_FACT_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:facts:' : 'hatax:facts:';

export function taxFactStorageKey(returnId: string): string {
  return `${TAX_FACT_KEY_PREFIX}${returnId}`;
}

/** Review decisions and approval for a case. */
export const REVIEW_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:review:' : 'hatax:review:';

export function reviewStorageKey(returnId: string): string {
  return `${REVIEW_KEY_PREFIX}${returnId}`;
}

/** Audit trail for a case: corrections, review decisions, approvals, documents. */
export const AUDIT_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:audit:' : 'hatax:audit:';

export function auditStorageKey(returnId: string): string {
  return `${AUDIT_KEY_PREFIX}${returnId}`;
}

/** Local model runs for a case (§42): which model, file hash and quantization read which page. */
export const MODEL_RUN_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:model-runs:' : 'hatax:model-runs:';

export function modelRunStorageKey(returnId: string): string {
  return `${MODEL_RUN_KEY_PREFIX}${returnId}`;
}

/** Provenance records for dropped preparer documents (metadata; the files themselves, encrypted, are in services/documentFiles). */
export const DOCUMENT_KEY_PREFIX = isPreparerApp()
  ? 'hatax-preparer:documents:'
  : 'hatax:documents:';

export function documentStorageKey(returnId: string): string {
  return `${DOCUMENT_KEY_PREFIX}${returnId}`;
}
