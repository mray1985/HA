/**
 * The unlocked vault key, kept for this browser session so reloading a page
 * does not lock the preparer out.
 *
 * The key is the non-extractable AES key itself (its bytes can never be read
 * back out), kept in IndexedDB under a session id held in sessionStorage — a
 * reload keeps the id; closing the tab or the browser ends it. Locking (the
 * idle and hidden-window timeouts, signing out, wiping data) forgets the key.
 * A closed tab's key cannot be used without its session id, and any key older
 * than SESSION_MS is deleted at the next start.
 */

export interface StoredSessionKey {
  key: CryptoKey;
  savedAt: number;
}

/** Where the key is kept (IndexedDB in the app; memory in tests). */
export interface SessionKeyStore {
  put(id: string, value: StoredSessionKey): Promise<void>;
  get(id: string): Promise<StoredSessionKey | undefined>;
  delete(id: string): Promise<void>;
  entries(): Promise<Array<[string, StoredSessionKey]>>;
}

/** A session longer than a working day starts with the passphrase again. */
export const SESSION_MS = 12 * 60 * 60 * 1000;
const SESSION_ID_KEY = 'hatax-preparer:session';
const DB_NAME = 'hatax-preparer-session';
const STORE_NAME = 'keys';

function indexedDbStore(): SessionKeyStore {
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
    put: (id, value) => run('readwrite', (s) => s.put(value, id)).then(() => undefined),
    get: (id) => run('readonly', (s) => s.get(id) as IDBRequest<StoredSessionKey | undefined>),
    delete: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
    entries: async () => {
      const [keys, values] = await Promise.all([
        run('readonly', (s) => s.getAllKeys()),
        run('readonly', (s) => s.getAll() as IDBRequest<StoredSessionKey[]>),
      ]);
      return keys.map((k, i) => [String(k), values[i]!] as [string, StoredSessionKey]);
    },
  };
}

let store: SessionKeyStore | null = null;

/** Use another store (tests use memory); null returns to IndexedDB. */
export function setSessionKeyStore(next: SessionKeyStore | null): void {
  store = next;
}

function currentStore(): SessionKeyStore | null {
  if (store) return store;
  if (typeof indexedDB === 'undefined') return null;
  store = indexedDbStore();
  return store;
}

function sessionId(create: boolean): string | null {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing || !create) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/** Keep the unlocked key for this browser session. */
export async function rememberSessionKey(key: CryptoKey): Promise<void> {
  const target = currentStore();
  const id = sessionId(true);
  if (!target || !id) return;
  try {
    await target.put(id, { key, savedAt: Date.now() });
  } catch (err) {
    console.warn('The unlocked session could not be kept; a reload will ask for the passphrase.', err);
  }
}

/** This session's key, if a page of it was unlocked within SESSION_MS; ended sessions' keys are deleted. */
export async function restoreSessionKey(now = Date.now()): Promise<CryptoKey | null> {
  const source = currentStore();
  if (!source) return null;
  const id = sessionId(false);
  try {
    for (const [other, value] of await source.entries()) {
      if (other !== id && now - value.savedAt > SESSION_MS) await source.delete(other);
    }
    if (!id) return null;
    const stored = await source.get(id);
    if (!stored) return null;
    if (now - stored.savedAt > SESSION_MS) {
      await source.delete(id);
      return null;
    }
    return stored.key;
  } catch {
    return null;
  }
}

/** Forget this session's key (locking, signing out). */
export async function forgetSessionKey(): Promise<void> {
  const id = sessionId(false);
  try {
    if (id) await currentStore()?.delete(id);
    sessionStorage.removeItem(SESSION_ID_KEY);
  } catch {
    /* nothing kept */
  }
}
