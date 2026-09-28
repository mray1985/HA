/**
 * Canonical extracted fact. Models may create these. They may not write form lines.
 * A missing value stays unknown. It is never stored as zero.
 * rawText is the extractor's original source text. It is never rebuilt from the coerced value.
 * confidence is scored per field and stays null when that field has no score.
 */

export type TaxFactStatus = 'extracted' | 'unknown';

/** Scalar or nested structured values (W-2 box12/box13, simplified method, etc.). */
export type TaxFactValue =
  | string
  | number
  | boolean
  | TaxFactValue[]
  | { readonly [key: string]: TaxFactValue };

interface TaxFactBase {
  factId: string;
  returnId: string;
  taxYear: number;
  factType: string;
  sourceDocumentId: string;
  sourceFileName: string;
  sourceField: string;
  rawText: string;
  confidence: number | null;
  extractor: string;
  verified: boolean;
}

export type TaxFact =
  | (TaxFactBase & {
      status: 'extracted';
      value: TaxFactValue;
    })
  | (TaxFactBase & {
      status: 'unknown';
      /** Unknown facts cannot carry a value, including zero. */
      value?: never;
    });

export type FieldConfidenceSource =
  | Record<string, number | null>
  | ((field: string) => number | null);

export type FieldRawTextSource =
  | Record<string, string>
  | ((field: string) => string | undefined);

export function isExtractedValue(value: unknown): value is TaxFactValue {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    // Empty arrays are treated as missing (omit), not as an extracted value.
    return value.length > 0 && value.every(isExtractedValue);
  }
  if (typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>);
    // Empty objects are missing; nested values must themselves be extractable.
    return entries.length > 0 && entries.every(isExtractedValue);
  }
  return false;
}

/** Fields safe to send to a tax-engine tool. Missing keys are omitted, not zeroed. */
export function fieldsForToolCall(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isExtractedValue(value)) fields[key] = value;
  }
  return fields;
}

function confidenceForField(source: FieldConfidenceSource | undefined, field: string): number | null {
  if (!source) return null;
  const score = typeof source === 'function' ? source(field) : source[field];
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

function rawTextForField(source: FieldRawTextSource | undefined, field: string): string {
  if (!source) return '';
  const text = typeof source === 'function' ? source(field) : source[field];
  return typeof text === 'string' ? text : '';
}

export function factsFromFields(input: {
  returnId: string;
  taxYear: number;
  documentId: string;
  fileName: string;
  extractor: string;
  fields: Record<string, unknown>;
  factTypeFor: (field: string) => string;
  /** Per-field score. A missing field stays null. */
  confidence?: FieldConfidenceSource;
  /** Original source text by field. A missing field stays empty. */
  rawText?: FieldRawTextSource;
}): TaxFact[] {
  const facts: TaxFact[] = [];
  for (const [field, value] of Object.entries(input.fields)) {
    const base: TaxFactBase = {
      factId: `${input.documentId}:${field}`,
      returnId: input.returnId,
      taxYear: input.taxYear,
      factType: input.factTypeFor(field),
      sourceDocumentId: input.documentId,
      sourceFileName: input.fileName,
      sourceField: field,
      rawText: rawTextForField(input.rawText, field),
      confidence: confidenceForField(input.confidence, field),
      extractor: input.extractor,
      verified: false,
    };
    if (isExtractedValue(value)) {
      facts.push({ ...base, status: 'extracted', value });
    } else {
      facts.push({ ...base, status: 'unknown' });
    }
  }
  return facts;
}
