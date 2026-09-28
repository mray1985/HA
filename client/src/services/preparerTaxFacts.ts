import type { TaxFact } from '@hatax/engine';
import { factsFromFields, fieldsForToolCall } from '@hatax/engine';
import type { PDFExtractResult } from './pdfExtractHelpers';
import { taxFactStorageKey } from './storageScope';

export function loadTaxFacts(returnId: string): TaxFact[] {
  const raw = localStorage.getItem(taxFactStorageKey(returnId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TaxFact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTaxFacts(returnId: string, facts: TaxFact[]): void {
  localStorage.setItem(taxFactStorageKey(returnId), JSON.stringify(facts));
}

export function appendTaxFacts(returnId: string, facts: TaxFact[]): TaxFact[] {
  const next = [...loadTaxFacts(returnId), ...facts];
  saveTaxFacts(returnId, next);
  return next;
}

export function factsForExtraction(input: {
  returnId: string;
  taxYear: number;
  documentId: string;
  fileName: string;
  extracted: PDFExtractResult;
}): { facts: TaxFact[]; toolFields: Record<string, unknown> } {
  const prefix = (input.extracted.incomeType || input.extracted.formType || 'DOC').toUpperCase();
  const facts = factsFromFields({
    returnId: input.returnId,
    taxYear: input.taxYear,
    documentId: input.documentId,
    fileName: input.fileName,
    extractor: input.extracted.aiEnhanced ? 'local-pdf+byok' : input.extracted.ocrUsed ? 'local-ocr' : 'local-pdf',
    fields: input.extracted.extractedData,
    factTypeFor: (field) => `${prefix}_${field}`,
  });
  return {
    facts,
    toolFields: fieldsForToolCall(input.extracted.extractedData),
  };
}
