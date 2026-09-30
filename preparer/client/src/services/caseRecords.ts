/**
 * Encrypted per-case records: a case's TaxFacts and its documents' provenance.
 *
 * Same scheme as returns (api/client): records are decrypted into memory when
 * the vault unlocks, read synchronously, and written back with AES-256-GCM.
 * Nothing is written in plaintext. A plaintext record left by an earlier
 * version is encrypted the next time the vault unlocks.
 */

import { toast } from 'sonner';
import { decrypt, encrypt, getActiveKey, isEncryptedPayload } from './crypto';

const cache = new Map<string, unknown>();

/** Per-key write version: a slower encryption of older data never overwrites newer data. */
const versions = new Map<string, number>();
let pendingWrites = 0;

export function hasPendingRecordWrites(): boolean {
  return pendingWrites > 0;
}

/** Decrypt the given records into memory. Call after the vault unlocks. */
export async function loadRecords(storageKeys: readonly string[]): Promise<void> {
  const key = getActiveKey();
  for (const storageKey of storageKeys) {
    const raw = localStorage.getItem(storageKey);
    if (!raw) continue;
    try {
      if (isEncryptedPayload(raw)) {
        if (!key) continue;
        cache.set(storageKey, JSON.parse(await decrypt(raw, key)));
      } else {
        const parsed: unknown = JSON.parse(raw);
        cache.set(storageKey, parsed);
        if (key) localStorage.setItem(storageKey, await encrypt(JSON.stringify(parsed), key));
      }
    } catch {
      /* unreadable record: left in storage, not loaded */
    }
  }
}

export function readRecord<T>(storageKey: string): T | undefined {
  return cache.get(storageKey) as T | undefined;
}

export function writeRecord(storageKey: string, value: unknown): void {
  cache.set(storageKey, value);
  const version = (versions.get(storageKey) ?? 0) + 1;
  versions.set(storageKey, version);
  const key = getActiveKey();
  if (!key) {
    // The app gate requires an unlocked vault before any case work.
    console.warn('writeRecord: vault locked — record not persisted');
    return;
  }
  pendingWrites++;
  encrypt(JSON.stringify(value), key)
    .then((payload) => {
      if (versions.get(storageKey) !== version) return;
      try {
        localStorage.setItem(storageKey, payload);
      } catch (e) {
        console.error('Failed to save encrypted record:', e);
        toast.error('Storage is nearly full — consider exporting your data.', { id: 'storage-quota', duration: 10000 });
      }
    })
    .finally(() => {
      pendingWrites--;
    });
}

export function removeRecord(storageKey: string): void {
  versions.set(storageKey, (versions.get(storageKey) ?? 0) + 1);
  cache.delete(storageKey);
  localStorage.removeItem(storageKey);
}

/** Remove every record whose key starts with `prefix`, from memory and storage. */
export function removeRecordsWithPrefix(prefix: string): void {
  const keys = new Set<string>([...cache.keys()].filter((k) => k.startsWith(prefix)));
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keys.add(key);
  }
  for (const key of keys) removeRecord(key);
}

export function clearRecordCache(): void {
  cache.clear();
}
