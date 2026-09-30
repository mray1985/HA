/** Consumer and preparer share one site, so their saved returns use different keys. */
export function isPreparerApp(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.app === 'preparer';
}

export const RETURN_LIST_KEY = isPreparerApp() ? 'hatax-preparer:returns' : 'hatax:returns';

export function returnStorageKey(id: string): string {
  return isPreparerApp() ? `hatax-preparer:return:${id}` : `hatax:return:${id}`;
}

export const CHAT_KEY_PREFIX = isPreparerApp() ? 'hatax-preparer:chat:' : 'hatax:chat:';

export function taxFactStorageKey(returnId: string): string {
  return isPreparerApp() ? `hatax-preparer:facts:${returnId}` : `hatax:facts:${returnId}`;
}

/** Provenance records for dropped preparer documents (metadata only, not file bytes). */
export const DOCUMENT_KEY_PREFIX = isPreparerApp()
  ? 'hatax-preparer:documents:'
  : 'hatax:documents:';

export function documentStorageKey(returnId: string): string {
  return `${DOCUMENT_KEY_PREFIX}${returnId}`;
}
