/**
 * Preparer document ingestion pipeline (work-order steps 3–4).
 * Hashes the dropped file, stores provenance metadata, classifies form type
 * from extractor markers, then turns extracted fields into TaxFacts through
 * the existing tax-tool API. Unclassified documents never write income.
 * Reuses the existing PDF/image extract path — no new OCR engine or model download.
 */

import {
  assertImportedValuesHaveSource,
  classificationAllowsIncomeWrite,
  classifyDocument,
  createIngestedDocument,
  findDocumentByHash,
  screenDocument,
  type DocumentClassification,
  type DocumentClassificationRecord,
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

function classificationRecord(c: DocumentClassification): DocumentClassificationRecord {
  return {
    status: c.status,
    formType: c.formType,
    confidence: c.confidence,
    reason: c.reason,
    matchedMarkers: c.matchedMarkers,
    source: c.source,
  };
}

/**
 * Classify one extraction piece from text / importer markers already on the result.
 * Does not invent a form type when markers are missing.
 */
export function classifyExtractionPiece(extracted: PDFExtractResult): DocumentClassification {
  return classifyDocument({
    text: extracted.rawOCRText ?? null,
    detectedFormType: extracted.formType,
    matchedMarkers: extracted.trace?.formDetection.matchedKeywords ?? [],
    detectedConfidence: extracted.confidence,
  });
}

/**
 * Persist an unclassified outcome. Does not write TaxFacts or income tools.
 */
export function markDocumentUnclassified(input: {
  returnId: string;
  document: IngestedDocument;
  classification: DocumentClassification;
}): IngestedDocument {
  const updated: IngestedDocument = {
    ...input.document,
    status: 'unclassified',
    classification: classificationRecord(input.classification),
  };
  upsertDocument(input.returnId, updated);
  return updated;
}

export interface IngestExtractionPiece {
  facts: TaxFact[];
  toolFields: Record<string, unknown>;
  incomeType: string | null;
  toolError?: string;
  extracted: PDFExtractResult;
  classification: DocumentClassification;
}

export interface ApplyExtractionResult {
  document: IngestedDocument;
  pieces: IngestExtractionPiece[];
  facts: TaxFact[];
  provenanceError?: string;
  /** True when every piece stayed unclassified — no income was written. */
  unclassified?: boolean;
  classification?: DocumentClassification;
}

/**
 * Map extraction results to TaxFacts via the tax-tool API and store them.
 * Classification runs first: unclassified pieces never create income facts.
 * Every imported (extracted) value must retain document source provenance.
 */
export function applyExtractionToDocument(input: {
  returnId: string;
  taxYear: number;
  document: IngestedDocument;
  extracted: PDFExtractResult;
}): ApplyExtractionResult {
  const piecesRaw = [input.extracted, ...(input.extracted.additionalResults ?? [])];
  const classifications = piecesRaw.map((piece) => classifyExtractionPiece(piece));

  // If nothing classifies, persist unclassified and stop before tax tools.
  if (!classifications.some((c) => classificationAllowsIncomeWrite(c))) {
    const primary = classifications[0] ?? classifyDocument({});
    const updated = markDocumentUnclassified({
      returnId: input.returnId,
      document: input.document,
      classification: primary,
    });
    return {
      document: updated,
      pieces: piecesRaw.map((piece, i) => ({
        facts: [],
        toolFields: {},
        incomeType: null,
        extracted: piece,
        classification: classifications[i] ?? primary,
      })),
      facts: [],
      unclassified: true,
      classification: primary,
    };
  }

  const pieces: IngestExtractionPiece[] = piecesRaw.map((piece, index) => {
    const classification = classifications[index]!;
    if (!classificationAllowsIncomeWrite(classification)) {
      return {
        facts: [],
        toolFields: {},
        incomeType: null,
        toolError: `Unclassified form piece skipped: ${classification.reason}`,
        extracted: piece,
        classification,
      };
    }

    // Prefer classifier income type when the extractor left it null.
    const extractedForTools: PDFExtractResult = {
      ...piece,
      formType: piece.formType ?? classification.formType,
      incomeType: piece.incomeType ?? classification.incomeType,
    };

    const built = factsForExtraction({
      returnId: input.returnId,
      taxYear: input.taxYear,
      documentId: input.document.documentId,
      fileName: input.document.fileName,
      extracted: extractedForTools,
    });
    return {
      facts: built.facts,
      toolFields: built.toolFields,
      incomeType: built.incomeType,
      toolError: built.toolError,
      extracted: extractedForTools,
      classification,
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

  const formTypes = pieces
    .filter((p) => classificationAllowsIncomeWrite(p.classification))
    .map((p) => p.classification.formType)
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const extractor =
    pieces.find((p) => p.facts[0]?.extractor)?.facts[0]?.extractor ??
    (input.extracted.aiEnhanced ? 'local-pdf+byok' : input.extracted.ocrUsed ? 'local-ocr' : 'local-pdf');

  const primaryClassified = classifications.find((c) => c.status === 'classified');
  const updated: IngestedDocument = {
    ...input.document,
    status: 'extracted',
    extractor,
    formTypes: formTypes.length > 0 ? formTypes : undefined,
    classification: primaryClassified
      ? classificationRecord(primaryClassified)
      : classificationRecord(classifications[0]!),
  };
  upsertDocument(input.returnId, updated);

  return {
    document: updated,
    pieces,
    facts,
    classification: primaryClassified ?? classifications[0],
  };
}
