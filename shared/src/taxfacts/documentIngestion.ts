/**
 * Document ingestion records and pure helpers (work-order step 3 / HA-AI doc ingestion).
 * A dropped file gets a stable hash-based document ID and provenance metadata.
 * Extracted fields become TaxFacts through the tax-tool API (HA-AI-011).
 * Classification models and new OCR engines are later phases — callers reuse existing extractors.
 */

import type { TaxFact } from './taxFact.js';

/** Local screening only — not antivirus. Rejects empty / oversized / wrong-type drops. */
export const MAX_INGEST_BYTES = 50 * 1024 * 1024;

export const ALLOWED_INGEST_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/heic',
  'image/heif',
] as const;

export type IngestDocumentStatus =
  | 'registered'
  | 'extracted'
  | 'duplicate'
  | 'rejected';

/**
 * Provenance record for one dropped file on a return.
 * File bytes are not stored here — contentHash is the durable identity.
 */
export interface IngestedDocument {
  documentId: string;
  returnId: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  ingestedAt: string;
  status: IngestDocumentStatus;
  /** Set after extraction succeeds for at least one form piece. */
  extractor?: string;
  formTypes?: string[];
  rejectReason?: string;
}

export interface DocumentFileMeta {
  fileName: string;
  mimeType: string;
  byteLength: number;
  /** SHA-256 hex of file bytes. */
  contentHash: string;
  /** Optional ISO timestamp; defaults to now when building a record. */
  ingestedAt?: string;
}

export interface ScreenDocumentInput {
  fileName: string;
  mimeType: string;
  byteLength: number;
}

export type ScreenDocumentResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Stable document ID from content hash (not file name / mtime). */
export function documentIdFromHash(contentHash: string): string {
  const hex = contentHash.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 16) {
    throw new Error('contentHash must be a SHA-256 hex digest');
  }
  return `DOC-${hex.slice(0, 32)}`;
}

export function screenDocument(input: ScreenDocumentInput): ScreenDocumentResult {
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    return { ok: false, reason: 'File is empty.' };
  }
  if (input.byteLength > MAX_INGEST_BYTES) {
    return { ok: false, reason: `File exceeds ${MAX_INGEST_BYTES} bytes.` };
  }
  const mime = (input.mimeType || '').toLowerCase().trim();
  const name = input.fileName.toLowerCase();
  const mimeOk =
    mime === '' ||
    ALLOWED_INGEST_MIME_TYPES.includes(mime as (typeof ALLOWED_INGEST_MIME_TYPES)[number]) ||
    mime.startsWith('image/');
  const extOk = /\.(pdf|png|jpe?g|webp|gif|tiff?|heic|heif)$/i.test(name);
  if (!mimeOk && !extOk) {
    return { ok: false, reason: 'Only PDF and image files are accepted.' };
  }
  return { ok: true };
}

export function findDocumentByHash(
  documents: readonly IngestedDocument[],
  contentHash: string,
): IngestedDocument | undefined {
  const hash = contentHash.trim().toLowerCase();
  return documents.find((doc) => doc.contentHash.toLowerCase() === hash);
}

/**
 * Build a new document record after screening and hashing.
 * Does not extract fields — that happens after the existing PDF/OCR path runs.
 */
export function createIngestedDocument(input: {
  returnId: string;
  meta: DocumentFileMeta;
  status?: IngestDocumentStatus;
  rejectReason?: string;
}): IngestedDocument {
  const hash = input.meta.contentHash.trim().toLowerCase();
  return {
    documentId: documentIdFromHash(hash),
    returnId: input.returnId,
    fileName: input.meta.fileName,
    mimeType: input.meta.mimeType || 'application/octet-stream',
    byteLength: input.meta.byteLength,
    contentHash: hash,
    ingestedAt: input.meta.ingestedAt ?? new Date().toISOString(),
    status: input.status ?? 'registered',
    rejectReason: input.rejectReason,
  };
}

/** Every imported value must point at the ingested document. */
export function factsHaveDocumentSource(
  facts: readonly TaxFact[],
  documentId: string,
): boolean {
  if (facts.length === 0) return true;
  return facts.every(
    (fact) =>
      fact.sourceDocumentId === documentId &&
      typeof fact.sourceFileName === 'string' &&
      fact.sourceFileName.length > 0 &&
      typeof fact.sourceField === 'string' &&
      fact.sourceField.length > 0 &&
      typeof fact.extractor === 'string' &&
      fact.extractor.length > 0,
  );
}

/**
 * Extracted facts must keep a source. Unknown facts still carry document provenance
 * (so the preparer can see which form was missing a box).
 */
export function assertImportedValuesHaveSource(
  facts: readonly TaxFact[],
  documentId: string,
): { ok: true } | { ok: false; error: string } {
  const extracted = facts.filter((f) => f.status === 'extracted');
  if (extracted.length === 0) {
    return { ok: true };
  }
  if (!factsHaveDocumentSource(extracted, documentId)) {
    return {
      ok: false,
      error: 'Every imported value must include document source provenance.',
    };
  }
  return { ok: true };
}
