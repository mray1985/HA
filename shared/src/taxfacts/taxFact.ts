/**
 * Canonical extracted fact. Models may create these. They may not write form lines.
 * A missing value stays absent. It is never stored as zero.
 */

export type TaxFactStatus = 'extracted' | 'unknown';

export interface TaxFact {
  factId: string;
  returnId: string;
  taxYear: number;
  factType: string;
  /** Present only when status is extracted. */
  value?: string | number | boolean;
  sourceDocumentId: string;
  sourceFileName: string;
  sourceField: string;
  rawText: string;
  confidence: number | null;
  extractor: string;
  verified: boolean;
  status: TaxFactStatus;
}

export function isExtractedValue(value: unknown): value is string | number | boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Fields safe to send to a tax-engine tool. Missing keys are omitted, not zeroed. */
export function fieldsForToolCall(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isExtractedValue(value)) fields[key] = value;
  }
  return fields;
}

export function factsFromFields(input: {
  returnId: string;
  taxYear: number;
  documentId: string;
  fileName: string;
  extractor: string;
  confidence: number | null;
  fields: Record<string, unknown>;
  factTypeFor: (field: string) => string;
}): TaxFact[] {
  const facts: TaxFact[] = [];
  for (const [field, value] of Object.entries(input.fields)) {
    const present = isExtractedValue(value);
    facts.push({
      factId: `${input.documentId}:${field}`,
      returnId: input.returnId,
      taxYear: input.taxYear,
      factType: input.factTypeFor(field),
      ...(present ? { value } : {}),
      sourceDocumentId: input.documentId,
      sourceFileName: input.fileName,
      sourceField: field,
      rawText: present ? String(value) : '',
      confidence: input.confidence,
      extractor: input.extractor,
      verified: false,
      status: present ? 'extracted' : 'unknown',
    });
  }
  return facts;
}
