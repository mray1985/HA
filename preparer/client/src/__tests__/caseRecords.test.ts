import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRecordCache,
  loadRecords,
  readRecord,
  removeRecordsWithPrefix,
  writeRecord,
} from '../services/caseRecords';
import { decrypt, isEncryptedPayload, setActiveKey } from '../services/crypto';

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

async function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Let queued encrypted writes land. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('caseRecords', () => {
  beforeEach(async () => {
    installMemoryLocalStorage();
    clearRecordCache();
    setActiveKey(await newKey());
  });

  it('stores facts encrypted, never as plaintext', async () => {
    const facts = [{ factId: 'DOC:wages', value: 52431.18 }];
    writeRecord('hatax-preparer:facts:r1', facts);
    expect(readRecord('hatax-preparer:facts:r1')).toEqual(facts);
    await settle();
    const raw = localStorage.getItem('hatax-preparer:facts:r1')!;
    expect(isEncryptedPayload(raw)).toBe(true);
    expect(raw).not.toContain('52431.18');
    expect(JSON.parse(await decrypt(raw))).toEqual(facts);
  });

  it('decrypts records into memory on unlock', async () => {
    writeRecord('hatax-preparer:documents:r1', [{ documentId: 'DOC-1' }]);
    await settle();
    clearRecordCache();
    expect(readRecord('hatax-preparer:documents:r1')).toBeUndefined();
    await loadRecords(['hatax-preparer:documents:r1']);
    expect(readRecord('hatax-preparer:documents:r1')).toEqual([{ documentId: 'DOC-1' }]);
  });

  it('encrypts a plaintext record left by an earlier version', async () => {
    localStorage.setItem('hatax-preparer:facts:old', JSON.stringify([{ factId: 'OLD:wages', value: 100 }]));
    await loadRecords(['hatax-preparer:facts:old']);
    expect(readRecord('hatax-preparer:facts:old')).toEqual([{ factId: 'OLD:wages', value: 100 }]);
    expect(isEncryptedPayload(localStorage.getItem('hatax-preparer:facts:old')!)).toBe(true);
  });

  it('does not persist anything while the vault is locked', async () => {
    setActiveKey(null);
    writeRecord('hatax-preparer:facts:r2', [{ factId: 'X' }]);
    await settle();
    expect(localStorage.getItem('hatax-preparer:facts:r2')).toBeNull();
  });

  it('removes every record under a prefix, from memory and storage', async () => {
    writeRecord('hatax-preparer:facts:a', [1]);
    writeRecord('hatax-preparer:facts:b', [2]);
    writeRecord('hatax-preparer:documents:a', [3]);
    await settle();
    removeRecordsWithPrefix('hatax-preparer:facts:');
    await settle();
    expect(readRecord('hatax-preparer:facts:a')).toBeUndefined();
    expect(localStorage.getItem('hatax-preparer:facts:b')).toBeNull();
    expect(readRecord('hatax-preparer:documents:a')).toEqual([3]);
  });
});
