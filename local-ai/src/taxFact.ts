/**
 * Canonical extracted fact. Models may create these. They may not write form lines.
 * A missing value stays unknown. It is never stored as zero.
 * rawText is the extractor's original source text. It is never rebuilt from the coerced value.
 * confidence is scored per field and stays null when that field has no score.
 * sourcePage / sourceBox are set only when the extractor located the token on the page.
 * Coordinates are never invented.
 */

export type TaxFactStatus = 'extracted' | 'unknown';

/** Scalar or nested structured values (W-2 box12/box13, simplified method, etc.). */
export type TaxFactValue =
  | string
  | number
  | boolean
  | TaxFactValue[]
  | { readonly [key: string]: TaxFactValue };

/** Geometry of the located text block (PDF/OCR units). Not invented. */
export interface TaxFactSourceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page + box when the extractor found the source token. */
export interface TaxFactSourceLocation {
  page: number;
  box: TaxFactSourceBox;
}

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
  /**
   * 1-based page when the extractor located this field's token.
   * Absent when no text block was found (including missing amounts).
   */
  sourcePage?: number;
  /**
   * Bounding box of the located text block. Absent when no block was found.
   * Never a fake box for a missing value.
   */
  sourceBox?: TaxFactSourceBox;
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

/**
 * Per-field provenance. Scalar fields map to one location.
 * Multi-entry fields (W-2 box12) may map to one entry per located item;
 * those arrays are not collapsed into a single TaxFact box.
 */
export type FieldSourceLocationValue =
  | TaxFactSourceLocation
  | Array<TaxFactSourceLocation | undefined>;

export type FieldSourceLocationSource =
  | Record<string, FieldSourceLocationValue | undefined>
  | ((field: string) => FieldSourceLocationValue | undefined);

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

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Accept only a real located box. Do not invent coordinates. */
export function normalizeSourceLocation(
  location: TaxFactSourceLocation | undefined | null,
): TaxFactSourceLocation | undefined {
  if (!location) return undefined;
  const { page, box } = location;
  // 1-based page only — page 0 / fractional / negative cannot identify a token.
  if (!Number.isInteger(page) || page < 1) return undefined;
  if (!box || typeof box !== 'object') return undefined;
  if (
    !isFiniteNumber(box.x) ||
    !isFiniteNumber(box.y) ||
    !isFiniteNumber(box.width) ||
    !isFiniteNumber(box.height)
  ) {
    return undefined;
  }
  // Zero or negative size cannot highlight a token (e.g. Syncfusion missing bounds).
  if (box.width <= 0 || box.height <= 0) return undefined;
  return {
    page,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
}

function sourceLocationForField(
  source: FieldSourceLocationSource | undefined,
  field: string,
): TaxFactSourceLocation | undefined {
  if (!source) return undefined;
  const location = typeof source === 'function' ? source(field) : source[field];
  // Per-entry arrays (box12) are not a single fact box — leave the fact without one.
  if (Array.isArray(location)) return undefined;
  return normalizeSourceLocation(location);
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
  /**
   * Page + box when the extractor located the token.
   * Absent for missing fields. A printed 0 keeps its box when located.
   */
  sourceLocation?: FieldSourceLocationSource;
}): TaxFact[] {
  const facts: TaxFact[] = [];
  for (const [field, value] of Object.entries(input.fields)) {
    const location = sourceLocationForField(input.sourceLocation, field);
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
      ...(location ? { sourcePage: location.page, sourceBox: location.box } : {}),
    };
    if (isExtractedValue(value)) {
      facts.push({ ...base, status: 'extracted', value });
    } else {
      facts.push({ ...base, status: 'unknown' });
    }
  }
  return facts;
}
