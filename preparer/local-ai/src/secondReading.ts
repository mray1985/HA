/**
 * Two-reader verification (work order §33, §72 "low confidence becomes
 * review, not a guess").
 *
 * A value from the primary document model counts as confirmed when an
 * independent reader agrees: the PDF text layer or OCR word boxes (found by
 * formEvidence), or a second document model. A value no second reader could
 * confirm, or one the readers disagree on, is never applied automatically —
 * it goes to the preparer with both readings. Nothing is averaged or chosen.
 *
 * A box the primary model left blank while the page prints an amount under
 * its label (formEvidence `missed`) is recovered only when the second model
 * reads the same amount: two independent readers — the page's own text and
 * the second model — then agree. Otherwise it goes to review.
 */

import type { FormEvidenceResult } from './formEvidence.js';
import type { FormExtractionSchema } from './formSchemas.js';
import { isIdentityKey } from './identity.js';
import { parseMoneyToken } from './structuredExtraction.js';

export type ReadingStatus = 'confirmed' | 'conflict' | 'unconfirmed' | 'missed' | 'recovered';

export interface FieldReading {
  key: string;
  status: ReadingStatus;
  /** The primary model's text. Absent when it left the box blank (missed / recovered). */
  primary?: string;
  /** The independent reading: page text/OCR, or the second model's text. */
  second?: string;
  /** For missed / recovered boxes: the amount printed under the box's label. */
  page?: string;
  /** Who confirmed it: 'page' (text layer / OCR) or 'model' (second model). */
  confirmedBy?: 'page' | 'model';
}

type Evidence = Pick<FormEvidenceResult, 'values' | 'located' | 'box12FromPage'> & Partial<Pick<FormEvidenceResult, 'missed'>>;

/**
 * Boxes whose values must be confirmed: tool-feeding, transcribed by the
 * model, and the person's identity (a TIN, name and address fill the return).
 */
function verifiableBoxes(schema: FormExtractionSchema) {
  return schema.boxes.filter((b) => (b.use === 'tool' || isIdentityKey(schema.formType, b.key)) && b.kind !== 'checkbox');
}

function normalizedText(text: string): string {
  return text.split(/\r?\n/)[0]!.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Two readings of one box say the same thing (money by amount, text by
 * characters). `allLines` compares every line of a text, not the first.
 */
export function readingsAgree(a: string, b: string, kind: string, allLines = false): boolean {
  if (allLines && kind === 'text') {
    const x = a.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return x.length > 0 && x === b.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  if (kind === 'money') {
    const x = parseMoneyToken(a.replace(/\s+/g, ''));
    const y = parseMoneyToken(b.replace(/\s+/g, ''));
    return x !== undefined && y !== undefined && Math.abs(x - y) < 0.005;
  }
  if (kind === 'integer') {
    // A year or count, by the number printed ("2025 / W-2" and "2025" agree).
    const x = /\d+/.exec(a)?.[0];
    return x !== undefined && x === /\d+/.exec(b)?.[0];
  }
  const x = normalizedText(a);
  return x.length > 0 && x === normalizedText(b);
}

/**
 * Classify every transcribed tool value by whether an independent reader
 * confirmed it, and every missed box by whether the second model recovered
 * it. `secondModel` is another document model's transcription of the same
 * page (schema keys → text); omit it when no second model ran.
 */
export function verifyReadings(
  schema: FormExtractionSchema,
  evidence: Evidence,
  secondModel?: Readonly<Record<string, string>>,
): FieldReading[] {
  const out: FieldReading[] = [];
  const fromPage = new Set(
    Object.keys(evidence.box12FromPage ?? {}).flatMap((slot) => [`${slot}.code`, `${slot}.amount`]),
  );
  const missed = new Map((evidence.missed ?? []).map((m) => [m.key, m.pageText]));
  for (const b of verifiableBoxes(schema)) {
    const primary = evidence.values[b.key];
    const second = secondModel?.[b.key];
    if (primary === undefined) {
      const page = missed.get(b.key);
      if (page === undefined) continue;
      if (second !== undefined && readingsAgree(second, page, b.kind)) {
        out.push({ key: b.key, status: 'recovered', second, page, confirmedBy: 'model' });
      } else {
        out.push({ key: b.key, status: 'missed', page, ...(second !== undefined ? { second } : {}) });
      }
      continue;
    }
    const located = evidence.located[b.key];
    // Read from the page itself (text layer / OCR), not the model: already independent.
    if (fromPage.has(b.key) || located) {
      out.push({ key: b.key, status: 'confirmed', primary, second: located?.pageText ?? primary, confirmedBy: 'page' });
      continue;
    }
    if (second === undefined) {
      out.push({ key: b.key, status: 'unconfirmed', primary });
    } else if (readingsAgree(primary, second, b.kind, isIdentityKey(schema.formType, b.key))) {
      out.push({ key: b.key, status: 'confirmed', primary, second, confirmedBy: 'model' });
    } else {
      out.push({ key: b.key, status: 'conflict', primary, second });
    }
  }
  return out;
}

/** Keys for a second model: values the page did not confirm, and missed boxes. */
export function keysNeedingSecondReader(schema: FormExtractionSchema, evidence: Evidence): string[] {
  return verifyReadings(schema, evidence)
    .filter((r) => r.status === 'unconfirmed' || r.status === 'missed')
    .map((r) => r.key);
}

/** The form schema cut down to the given keys, for a second model's extraction template. */
export function secondReaderSchema(schema: FormExtractionSchema, keys: readonly string[]): FormExtractionSchema {
  return { ...schema, boxes: schema.boxes.filter((b) => keys.includes(b.key)) };
}

/**
 * Box values after verification: recovered boxes gain the agreed reading.
 * Every other status leaves the values as they were — conflicts, unconfirmed
 * and missed boxes are for the preparer to settle.
 */
export function valuesAfterVerification(
  values: Readonly<Record<string, string>>,
  readings: readonly FieldReading[],
): Record<string, string> {
  const out = { ...values };
  for (const r of readings) if (r.status === 'recovered') out[r.key] = r.second!;
  return out;
}
