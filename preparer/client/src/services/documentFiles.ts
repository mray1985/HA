/**
 * The source documents a preparer drops, kept so the review can show them:
 * a held value or an unread box is checked against the page itself, and
 * "checked against the source document" means the preparer saw it.
 *
 * Each file's bytes are encrypted with the case key (AES-256-GCM,
 * services/crypto) and kept in IndexedDB — files are too large for
 * localStorage — keyed by case and document. They are removed with the case
 * (api/client deleteReturn) and by wipeAllData, which deletes every IndexedDB
 * database.
 */

import { decryptBytes, encryptBytes, getActiveKey } from './crypto';

export interface StoredDocumentFile {
  fileName: string;
  mimeType: string;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

/** Where the encrypted files are kept (IndexedDB in the app; memory in tests). */
export interface DocumentFileStore {
  put(key: string, value: StoredDocumentFile): Promise<void>;
  get(key: string): Promise<StoredDocumentFile | undefined>;
  deletePrefix(prefix: string): Promise<void>;
}

const DB_NAME = 'hatax-preparer-documents';
const STORE_NAME = 'files';

function indexedDbStore(): DocumentFileStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) =>
    open().then((database) => new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, mode);
      const request = op(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  return {
    put: (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
    get: (key) => run('readonly', (s) => s.get(key) as IDBRequest<StoredDocumentFile | undefined>),
    deletePrefix: (prefix) => run('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`))).then(() => undefined),
  };
}

let store: DocumentFileStore | null = null;

/** Use another store (tests use memory); null returns to IndexedDB. */
export function setDocumentFileStore(next: DocumentFileStore | null): void {
  store = next;
}

function currentStore(): DocumentFileStore | null {
  if (store) return store;
  if (typeof indexedDB === 'undefined') return null;
  store = indexedDbStore();
  return store;
}

const fileKey = (returnId: string, documentId: string) => `${returnId}/${documentId}`;

/** Keep a dropped file, encrypted. False when it cannot be kept (the vault is locked, or no storage). */
export async function saveDocumentFile(returnId: string, documentId: string, file: File): Promise<boolean> {
  const target = currentStore();
  const key = getActiveKey();
  if (!target || !key) return false;
  try {
    const { iv, ct } = await encryptBytes(await file.arrayBuffer(), key);
    await target.put(fileKey(returnId, documentId), { fileName: file.name, mimeType: file.type || 'application/octet-stream', iv, ct });
    return true;
  } catch (err) {
    console.warn(`The source file ${file.name} could not be kept:`, err);
    return false;
  }
}

/** The dropped file, decrypted; undefined when it was not kept. */
export async function loadDocumentFile(returnId: string, documentId: string): Promise<File | undefined> {
  const source = currentStore();
  const key = getActiveKey();
  if (!source || !key) return undefined;
  const stored = await source.get(fileKey(returnId, documentId));
  if (!stored) return undefined;
  const bytes = await decryptBytes(stored.iv, stored.ct, key);
  return new File([bytes], stored.fileName, { type: stored.mimeType });
}

/**
 * Copy a kept file to another case as it is kept (encrypted with the same
 * vault key), and check the copy is there. 'none' when no file was kept for
 * the document; 'failed' when it could not be copied.
 */
export async function copyDocumentFile(fromReturnId: string, toReturnId: string, documentId: string): Promise<'copied' | 'none' | 'failed'> {
  const target = currentStore();
  if (!target) return 'none';
  try {
    const stored = await target.get(fileKey(fromReturnId, documentId));
    if (!stored) return 'none';
    await target.put(fileKey(toReturnId, documentId), stored);
    const copy = await target.get(fileKey(toReturnId, documentId));
    return copy && copy.ct.byteLength === stored.ct.byteLength ? 'copied' : 'failed';
  } catch (err) {
    console.warn(`The source file of ${documentId} could not be copied:`, err);
    return 'failed';
  }
}

/** Remove one document's kept file. */
export async function deleteDocumentFile(returnId: string, documentId: string): Promise<void> {
  await currentStore()?.deletePrefix(fileKey(returnId, documentId));
}

/** Remove a case's source files (paired with deleteReturn). */
export async function deleteDocumentFiles(returnId: string): Promise<void> {
  await currentStore()?.deletePrefix(`${returnId}/`);
}
