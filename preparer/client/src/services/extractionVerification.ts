import { FORM_EXTRACTION_SCHEMAS, TOOL_MAPPINGS, type ClassifiableFormType } from '@hatax/local-ai';
import type { TextBlock } from './pdfExtractHelpers';

/** A value the extractor proposed that is not supported by what the page prints. */
export interface RejectedRead {
  field: string;
  value: string;
  reason:
    | 'not-printed'
    | 'only-a-tax-year'
    | 'not-an-amount'
    | 'label-read-as-value'
    | 'form-furniture-read-as-value';
  detail: string;
}

export interface VerifiedExtraction {
  /** Only the reads that survive. Nothing dropped silently: see `rejected`. */
  data: Record<string, unknown>;
  rejected: RejectedRead[];
}

/**
 * What the page prints, in the form the verification needs.
 *
 * Carried on the extraction result so the check can run at the write boundary —
 * where the form type actually being written is known — rather than inside one
 * extractor, where a later classification pass could change the answer.
 */
export interface PrintIndex {
  /** Printed number → true when every printed occurrence is only a year fragment. */
  numbers: Record<string, boolean>;
  /** Four-digit years the page prints. */
  years: string[];
}

/** Printed furniture that is never a value: form numbers, OMB codes, URLs. */
const FURNITURE = [
  /^omb\s*no\.?\s*\d/i,
  /^www\./i,
  /^https?:/i,
  /form\s*\d{4}[-–]?[a-z]{0,3}$/i,
  /^copy\s*[ab]$/i,
  /^attention:?$/i,
  /^for (recipient|issuer|payer|recipient's copy)$/i,
  /^irs\.gov/i,
  /^\(?rev\.?\s*\w+\s*\d{4}\)?$/i,
  /^department of the treasury/i,
];

/** Casefolded, punctuation- and space-insensitive, so print and read can be compared. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every number the page prints, with whether it is a fragment of the printed year.
 *
 * A large amount on a 1099-NEC is often printed bare — "78702", no currency, no
 * separator — so the absence of punctuation proves nothing. What does give an
 * amount away is the opposite case: a digit that is only ever half of a printed
 * year. The year graphic renders as two adjacent tokens ("20" then "25"), and a
 * reader that sweeps up "25" has read the tax year, not a box.
 */
function printedNumbers(blocks: readonly TextBlock[]): Map<string, { onlyYearFragments: boolean }> {
  interface Num {
    digits: string;
    value: number;
    x: number;
    y: number;
    page: number;
  }
  const tokens: Num[] = [];

  // Split on whitespace only: a thousands separator belongs to the number.
  for (const b of blocks) {
    for (const tok of b.text.split(/\s+/)) {
      const m = /^[(]?\$?(-?\d[\d,]*\.?\d*)\)?(%)?$/.exec(tok.trim());
      if (!m) continue;
      const digits = m[1]!.replace(/,/g, '');
      const n = Number(digits);
      if (!Number.isFinite(n)) continue;
      tokens.push({ digits, value: n, x: b.x, y: b.y, page: b.page });
    }
  }

  /** This token sits beside another that together spell a printed tax year. */
  const isYearFragment = (t: Num): boolean =>
    tokens.some((o) => {
      if (o === t || o.page !== t.page) return false;
      if (Math.abs(o.y - t.y) > 3) return false;
      // Reading order is left to right: the left token completes the year.
      const pair = o.x <= t.x ? o.digits + t.digits : t.digits + o.digits;
      return /^(19|20)\d{2}$/.test(pair);
    });

  const out = new Map<string, { onlyYearFragments: boolean }>();
  const note = (value: string, fragment: boolean): void => {
    const prev = out.get(value);
    if (prev) prev.onlyYearFragments = prev.onlyYearFragments && fragment;
    else out.set(value, { onlyYearFragments: fragment });
  };

  for (const t of tokens) {
    const bare = t.digits.replace(/\.00$/, '');
    const fragment = isYearFragment(t);
    for (const v of [String(t.value), String(Number(t.value.toFixed(2))), bare, bare.replace(/^0+(?=\d)/, '')]) {
      if (v !== '' && v !== '-') note(v, fragment);
    }
  }
  return out;
}

/** The tool fields this form fills from a box declared as an amount. */
function moneyToolFields(formType: string | null): Set<string> {
  const schema = FORM_EXTRACTION_SCHEMAS[(formType ?? '') as ClassifiableFormType];
  const mapping = TOOL_MAPPINGS[(formType ?? '') as ClassifiableFormType];
  if (!schema || !mapping) return new Set();
  const kindOf = new Map(schema.boxes.map((b) => [b.key, b.kind]));
  const out = new Set<string>();
  const take = (boxKey: string | undefined, field: string | undefined): void => {
    if (field && kindOf.get(boxKey ?? '') === 'money') out.add(field);
  };
  for (const [boxKey, field] of Object.entries(mapping.direct ?? {})) take(boxKey, field);
  for (const [boxKey, field] of Object.entries(mapping.checkboxes ?? {})) take(boxKey, field);
  take(mapping.name?.keys?.[0], mapping.name?.field);
  return out;
}

/** A bare four-digit year, which is a date on a form and never an amount. */
function isPlausibleYear(token: string): boolean {
  const n = Number(token);
  return Number.isInteger(n) && n >= 1990 && n <= 2100 && /^\d{4}$/.test(token);
}

/** The page's own tax year, as printed. */
function printedYears(blocks: readonly TextBlock[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    for (const tok of b.text.split(/\s+/)) {
      const t = tok.trim();
      if (isPlausibleYear(t)) out.add(t);
    }
  }
  return out;
}

/**
 * Index what the page prints, once, so the verification can be re-run anywhere.
 *
 * The check belongs at the write boundary rather than inside a single extractor:
 * a classification pass can relabel a form after extraction, and a value must be
 * verified against the form type it is actually written under.
 */
export function buildPrintIndex(blocks: readonly TextBlock[]): PrintIndex {
  const numbers: Record<string, boolean> = {};
  for (const [value, info] of printedNumbers(blocks)) numbers[value] = info.onlyYearFragments;
  return { numbers, years: [...printedYears(blocks)] };
}

/** Labels the form itself prints, from the schema for this form revision. */
function declaredLabels(formType: string | null): string[] {
  const schema = FORM_EXTRACTION_SCHEMAS[(formType ?? '') as ClassifiableFormType];
  if (!schema) return [];
  return schema.boxes.map((b) => b.label).filter(Boolean);
}

/**
 * The deterministic check that runs on every extraction before anything is
 * written to a return.
 *
 * A read survives only if the page prints the value it claims. A number that
 * appears nowhere on the page was not read, it was invented; a money box whose
 * only printed match is the document's own tax year was filled from the year
 * graphic; a "value" that is one of the form's own labels, or a form number, is
 * furniture the reader walked into.
 *
 * Rejected reads are returned, never discarded, so the caller can hold the box
 * for the preparer instead of writing a wrong number.
 */
export function verifyExtractedValues(
  formType: string | null,
  extractedData: Record<string, unknown>,
  blocks: readonly TextBlock[],
): VerifiedExtraction {
  return verifyAgainstPrint(formType, extractedData, buildPrintIndex(blocks));
}

/** The same check, run against an index captured when the page was read. */
export function verifyAgainstPrint(
  formType: string | null,
  extractedData: Record<string, unknown>,
  print: PrintIndex,
): VerifiedExtraction {
  const numbers = print.numbers;
  const moneyFields = moneyToolFields(formType);
  const years = new Set(print.years);
  const labels = declaredLabels(formType).map(squash);
  const data: Record<string, unknown> = {};
  const rejected: RejectedRead[] = [];

  for (const [field, value] of Object.entries(extractedData)) {
    if (value === undefined || value === null || value === '') {
      data[field] = value;
      continue;
    }

    if (typeof value === 'number') {
      const printed = String(value);
      const fragment = numbers[printed] ?? numbers[String(Number(value.toFixed(2)))];
      if (fragment === undefined) {
        rejected.push({
          field,
          value: printed,
          reason: 'not-printed',
          detail: `no number equal to ${printed} appears anywhere on the page`,
        });
        continue;
      }
      // The document's own year, read into a box that takes an amount.
      const bare = printed.replace(/\.0+$/, '');
      if (moneyFields.has(field) && isPlausibleYear(bare) && years.has(bare)) {
        rejected.push({
          field,
          value: printed,
          reason: 'only-a-tax-year',
          detail: `${printed} is the tax year printed on the form, not an amount in this box`,
        });
        continue;
      }
      // Half of the printed year graphic ("20" beside "25") read as an amount.
      if (moneyFields.has(field) && fragment) {
        rejected.push({
          field,
          value: printed,
          reason: 'not-an-amount',
          detail: `${printed} is only ever printed as part of the tax year on this form, so it is not an amount from this box`,
        });
        continue;
      }
      data[field] = value;
      continue;
    }

    if (typeof value === 'string') {
      const text = value.trim();
      if (FURNITURE.some((re) => re.test(text))) {
        rejected.push({
          field,
          value: text,
          reason: 'form-furniture-read-as-value',
          detail: `"${text}" is printed form furniture, not data`,
        });
        continue;
      }
      const squashed = squash(text);
      // A short value that is exactly one of this form's labels is that label.
      if (squashed.length >= 4 && labels.includes(squashed)) {
        rejected.push({
          field,
          value: text,
          reason: 'label-read-as-value',
          detail: `"${text}" is this form's own printed label for another box`,
        });
        continue;
      }
      // A long value lifted out of one label is a run of caption words, not data.
      if (squashed.length >= 24 && labels.some((l) => l.includes(squashed) || squashed.includes(l))) {
        rejected.push({
          field,
          value: text,
          reason: 'label-read-as-value',
          detail: `"${text}" is text from this form's own printed caption, not a value`,
        });
        continue;
      }
      data[field] = value;
      continue;
    }

    data[field] = value;
  }

  return { data, rejected };
}