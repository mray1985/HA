/**
 * Source documents kept with the case so the review can show them: each
 * file encrypted with the case key, removed with the case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveKey } from '../services/crypto';
import {
  deleteDocumentFiles, loadDocumentFile, saveDocumentFile, setDocumentFileStore,
  type DocumentFileStore, type StoredDocumentFile,
} from '../services/documentFiles';
import { clearRecordCache } from '../services/caseRecords';
import { registerDroppedDocument } from '../services/documentIngestion';

function memoryStore(): DocumentFileStore & { entries: Map<string, StoredDocumentFile> } {
  const entries = new Map<string, StoredDocumentFile>();
  return {
    entries,
    put: async (key, value) => { entries.set(key, value); },
    get: async (key) => entries.get(key),
    deletePrefix: async (prefix) => { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k); },
  };
}

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

const W2_TEXT = 'Form W-2 Wage and Tax Statement 52431.18';

describe('source documents', () => {
  let files: ReturnType<typeof memoryStore>;

  beforeEach(async () => {
    files = memoryStore();
    setDocumentFileStore(files);
    setActiveKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  });
  afterEach(() => {
    setDocumentFileStore(null);
    setActiveKey(null);
    vi.unstubAllGlobals();
  });

  it('keeps a file encrypted and gives it back as dropped', async () => {
    const file = new File([W2_TEXT], 'w2.pdf', { type: 'application/pdf' });
    expect(await saveDocumentFile('case-1', 'DOC-1', file)).toBe(true);
    const stored = files.entries.get('case-1/DOC-1')!;
    expect(new TextDecoder().decode(stored.ct)).not.toContain('Wage and Tax Statement');
    const back = await loadDocumentFile('case-1', 'DOC-1');
    expect(back).toMatchObject({ name: 'w2.pdf', type: 'application/pdf' });
    expect(await back!.text()).toBe(W2_TEXT);
  });

  it('keeps and shows nothing while the vault is locked', async () => {
    await saveDocumentFile('case-1', 'DOC-1', new File([W2_TEXT], 'w2.pdf'));
    setActiveKey(null);
    expect(await saveDocumentFile('case-1', 'DOC-2', new File([W2_TEXT], 'w2b.pdf'))).toBe(false);
    expect(await loadDocumentFile('case-1', 'DOC-1')).toBeUndefined();
  });

  it("removes a case's files and no other case's", async () => {
    await saveDocumentFile('case-1', 'DOC-1', new File(['a'], 'a.pdf'));
    await saveDocumentFile('case-2', 'DOC-1', new File(['b'], 'b.pdf'));
    await deleteDocumentFiles('case-1');
    expect(await loadDocumentFile('case-1', 'DOC-1')).toBeUndefined();
    expect(await (await loadDocumentFile('case-2', 'DOC-1'))!.text()).toBe('b');
  });

  it('keeps the file when a document is registered on a case', async () => {
    installMemoryLocalStorage();
    clearRecordCache();
    const file = new File([W2_TEXT], 'w2.pdf', { type: 'application/pdf' });
    const { document } = await registerDroppedDocument({ returnId: 'case-9', file });
    expect(await (await loadDocumentFile('case-9', document.documentId))!.text()).toBe(W2_TEXT);
  });
});
