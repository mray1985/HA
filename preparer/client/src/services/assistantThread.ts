/**
 * What the preparer said to the assistant, and what came of it.
 *
 * The thread itself is recomputed from the case on every render, so it cannot go
 * stale. What cannot be recomputed is what was typed and what the assistant
 * answered — that is the preparer's own record of the conversation, and it is
 * kept per case so switching tabs or reloading does not erase it.
 *
 * Kept in the encrypted case records, like everything else on a case, and removed
 * with it.
 */
import { readRecord, removeRecord, removeRecordsWithPrefix, writeRecord } from './caseRecords';
import { SPOKEN_KEY_PREFIX, spokenStorageKey } from './storageScope';

export interface SpokenEntry {
  id: string;
  /** What the preparer typed. */
  text: string;
  /** What the assistant said in return. */
  said: string;
  /** Whether it went onto the return. */
  written: boolean;
}

/** A case's conversation, oldest first. */
export function loadSpoken(returnId: string): SpokenEntry[] {
  const entries = readRecord<SpokenEntry[]>(spokenStorageKey(returnId));
  return Array.isArray(entries) ? entries : [];
}

export function saveSpoken(returnId: string, entries: SpokenEntry[]): void {
  writeRecord(spokenStorageKey(returnId), entries);
}

export function clearSpoken(returnId: string): void {
  removeRecord(spokenStorageKey(returnId));
}

export function clearAllSpoken(): void {
  removeRecordsWithPrefix(SPOKEN_KEY_PREFIX);
}