/**
 * Preparer document ingestion pipeline (work-order step 3).
 * Hashes the dropped file, stores provenance metadata, then turns extracted
 * fields into TaxFacts through the existing tax-tool API.
 * Reuses the existing PDF/image extract path — no new classifier or OCR engine.
 */

import {
  assertImportedValuesHaveSource,
  createIngestedDocument,
  findDocumentByHash,
  screenDocument,
  type IngestedDocument,
  type TaxFact,
} from '@hatax/engine';
import type { PDFExtractResult } from './pdfExtractHelpers';
import { DOCUMENT_KEY_PREFIX, documentStorageKey } from './storageScope';
import { appendTaxFacts, factsForExtraction } from './preparerTaxFacts';

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function loadDocuments(returnId: string): IngestedDocument[] {
  const raw = localStorage.getItem(documentStorageKey(returnId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as IngestedDocument[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDocuments(returnId: string, documents: IngestedDocument[]): void {
  localStorage.setItem(documentStorageKey(returnId), JSON.stringify(documents));
}

/** Remove provenance for one return (paired with deleteReturn). */
export function deleteDocuments(returnId: string): void {
  localStorage.removeItem(documentStorageKey(returnId));
}

/** Remove all document provenance keys for the current app (paired with wipeAllData). */
export function deleteAllDocuments(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(DOCUMENT_KEY_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

export function upsertDocument(returnId: string, document: IngestedDocument): IngestedDocument[] {
  const existing = loadDocuments(returnId);
  const index = existing.findIndex((d) => d.documentId === document.documentId);
  const next =
    index >= 0
      ? existing.map((d, i) => (i === index ? document : d))
      : [...existing, document];
  saveDocuments(returnId, next);
  return next;
}

export interface RegisterDocumentResult {
  document: IngestedDocument;
  duplicate: boolean;
  rejected: boolean;
}

/**
 * Screen + hash + assign document ID + persist provenance.
 * Does not run OCR or classification.
 */
export async function registerDroppedDocument(input: {
  returnId: string;
  file: File;
}): Promise<RegisterDocumentResult> {
  const screened = screenDocument({
    fileName: input.file.name,
    mimeType: input.file.type,
    byteLength: input.file.size,
  });
  if (!screened.ok) {
    // Do not hash or persist rejected drops.
    const rejected: IngestedDocument = {
      documentId: 'DOC-rejected',
      returnId: input.returnId,
      fileName: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      byteLength: input.file.size,
      contentHash: '',
      ingestedAt: new Date().toISOString(),
      status: 'rejected',
      rejectReason: screened.reason,
    };
    return { document: rejected, duplicate: false, rejected: true };
  }

  const contentHash = await sha256Hex(await input.file.arrayBuffer());
  const prior = findDocumentByHash(loadDocuments(input.returnId), contentHash);
  if (prior?.status === 'extracted') {
    // Successful prior extraction of the same bytes — keep the record, no downgrade.
    return { document: prior, duplicate: true, rejected: false };
  }
  if (prior) {
    // Failed or incomplete registration — allow retry with the same document id.
    return { document: prior, duplicate: false, rejected: false };
  }

  const document = createIngestedDocument({
    returnId: input.returnId,
    meta: {
      fileName: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      byteLength: input.file.size,
      contentHash,
    },
    status: 'registered',
  });
  upsertDocument(input.returnId, document);
  return { document, duplicate: false, rejected: false };
}

export interface IngestExtractionPiece {
  facts: TaxFact[];
  toolFields: Record<string, unknown>;
  incomeType: string | null;
  toolError?: string;
  extracted: PDFExtractResult;
}

export interface ApplyExtractionResult {
  document: IngestedDocument;
  pieces: IngestExtractionPiece[];
  facts: TaxFact[];
  provenanceError?: string;
}

/**
 * Map extraction results to TaxFacts via the tax-tool API and store them.
 * Every imported (extracted) value must retain document source provenance.
 */
export function applyExtractionToDocument(input: {
  returnId: string;
  taxYear: number;
  document: IngestedDocument;
  extracted: PDFExtractResult;
}): ApplyExtractionResult {
  const piecesRaw = [input.extracted, ...(input.extracted.additionalResults ?? [])];
  const pieces: IngestExtractionPiece[] = piecesRaw.map((piece) => {
    const built = factsForExtraction({
      returnId: input.returnId,
      taxYear: input.taxYear,
      documentId: input.document.documentId,
      fileName: input.document.fileName,
      extracted: piece,
    });
    return {
      facts: built.facts,
      toolFields: built.toolFields,
      incomeType: built.incomeType,
      toolError: built.toolError,
      extracted: piece,
    };
  });

  const facts = pieces.flatMap((p) => p.facts);
  const provenance = assertImportedValuesHaveSource(facts, input.document.documentId);
  if (!provenance.ok) {
    return {
      document: input.document,
      pieces,
      facts: [],
      provenanceError: provenance.error,
    };
  }

  if (facts.length > 0) {
    appendTaxFacts(input.returnId, facts);
  }

  const formTypes = piecesRaw
    .map((p) => p.formType)
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const extractor =
    pieces.find((p) => p.facts[0]?.extractor)?.facts[0]?.extractor ??
    (input.extracted.aiEnhanced ? 'local-pdf+byok' : input.extracted.ocrUsed ? 'local-ocr' : 'local-pdf');

  const updated: IngestedDocument = {
    ...input.document,
    status: 'extracted',
    extractor,
    formTypes: formTypes.length > 0 ? formTypes : undefined,
  };
  upsertDocument(input.returnId, updated);

  return { document: updated, pieces, facts };
}
