import { FORM_EXTRACTION_SCHEMAS, TOOL_MAPPINGS, type ClassifiableFormType } from '@hatax/local-ai';
import type { RejectedRead } from './extractionVerification';

/**
 * What happened to one box the form prints.
 *
 * `read`      a value was captured and will go on the return
 * `held`      a value was read but the page does not support it, so it was not written
 * `empty`     the box is printed on this form and carries no value
 * `unread`    nothing was captured, and the form does not even show this box as read
 * `informational` the box is not used by the return (an address, a phone number)
 *
 * `unread` is deliberately not collapsed into "empty". A blank box and a box the
 * reader walked past look identical from the outside, and treating them as the
 * same is how a missing box turns into a wrong return without anyone noticing.
 *
 * The two are told apart by whether the form prints the box at all. A money box
 * whose label is on the page with no figure beside it is blank. A checkbox is
 * never called empty: its state is a printed square rather than a figure, so
 * "no value" means the square was not read, not that the box was unticked.
 */
export type BoxState = 'read' | 'held' | 'empty' | 'unread' | 'informational';

export interface BoxLedgerEntry {
  /** Stable box key from the form schema ("1", "8", "filer.ein"). */
  key: string;
  /** Box identifier as printed ("1", "8", "c"); empty for unnumbered areas. */
  box: string;
  /** The form's own printed label. */
  label: string;
  state: BoxState;
  /** The tool field this box feeds, when it feeds one. */
  field?: string;
  value?: unknown;
  /** Why it was held, when it was held. */
  reason?: string;
}

export interface BoxLedger {
  formType: string | null;
  /** Boxes this form prints that bear on the return. */
  declared: number;
  read: number;
  held: number;
  unread: number;
  /** Printed on the form with no value in it. */
  empty: number;
  entries: BoxLedgerEntry[];
}

/** The tool field each declared box feeds, where the schema says it feeds one. */
function fieldsByBox(formType: string | null): Map<string, string> {
  const key = (formType ?? '') as ClassifiableFormType;
  const mapping = TOOL_MAPPINGS[key];
  const out = new Map<string, string>();
  if (!mapping) return out;
  for (const [boxKey, field] of Object.entries(mapping.direct ?? {})) out.set(boxKey, field);
  for (const [boxKey, field] of Object.entries(mapping.checkboxes ?? {})) out.set(boxKey, field);
  if (mapping.state?.key) out.set(mapping.state.key, mapping.state.field);
  if (mapping.name?.keys?.length) out.set(mapping.name.keys[0]!, mapping.name.field);
  return out;
}

/** Words too common to identify a box by. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were', 'not',
  'amount', 'name', 'number', 'code', 'no', 'of', 'to', 'in', 'on', 'at', 'is', 'it',
  'address', 'city', 'state', 'zip', 'box', 'check', 'if', 'or', 'by', 'as', 'be',
]);

/** The words that identify a printed label. */
function significantWords(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Whether the form prints this box's label. */
function labelIsPrinted(label: string, pageText: string): boolean {
  const words = significantWords(label);
  if (words.length === 0) {
    // A label made only of common words ("Code", "Amount") still identifies its
    // box on the page. Falling back to the bare words keeps those boxes from
    // being reported as gaps when they are simply blank.
    const bare = label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    return bare.length > 0 && bare.every((w) => pageText.includes(w));
  }
  return words.every((w) => pageText.includes(w));
}

/**
 * Account for every box the form prints.
 *
 * The point is the gap: a form the reader mostly failed on must say so, naming
 * the boxes, instead of contributing the two values it happened to find and
 * looking like a form with two boxes on it.
 */
export function buildBoxLedger(
  formType: string | null,
  extractedData: Record<string, unknown>,
  rejectedReads: readonly RejectedRead[] = [],
  /** The page text, so a blank box can be told from a missed one. */
  pageText = '',
): BoxLedger {
  const schema = FORM_EXTRACTION_SCHEMAS[(formType ?? '') as ClassifiableFormType];
  const fields = fieldsByBox(formType);
  const held = new Map(rejectedReads.map((r) => [r.field, r]));
  const text = pageText.toLowerCase();

  const entries: BoxLedgerEntry[] = [];
  for (const box of schema?.boxes ?? []) {
    const field = fields.get(box.key);
    const value = field ? extractedData[field] : undefined;
    const rejection = field ? held.get(field) : undefined;

    let state: BoxState;
    if (rejection) state = 'held';
    else if (value !== undefined && value !== null && value !== '') state = 'read';
    else if (box.use === 'info' || box.use === 'review') state = 'informational';
    else if (box.kind === 'checkbox') state = 'unread';
    else state = labelIsPrinted(box.label, text) ? 'empty' : 'unread';

    entries.push({
      key: box.key,
      box: box.box,
      label: box.label,
      state,
      ...(field ? { field } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(rejection ? { reason: rejection.detail } : {}),
    });
  }

  const count = (s: BoxState): number => entries.filter((e) => e.state === s).length;
  return {
    formType: formType ?? null,
    declared: entries.filter((e) => e.state !== 'informational').length,
    read: count('read'),
    held: count('held'),
    unread: count('unread'),
    empty: count('empty'),
    entries,
  };
}

/** One line for the preparer: what this form gave, and what it did not. */
export function summariseBoxLedger(ledger: BoxLedger): string | null {
  if (ledger.declared === 0) return null;
  const parts: string[] = [];
  if (ledger.read > 0) parts.push(`${ledger.read} read`);
  if (ledger.held > 0) parts.push(`${ledger.held} held`);
  if (ledger.unread > 0) parts.push(`${ledger.unread} could not be read`);
  if (parts.length === 0) return null;
  const detail =
    ledger.unread > 0
      ? ` Nothing was assumed about them: ${ledger.entries
          .filter((e) => e.state === 'unread')
          .slice(0, 6)
          .map((e) => (e.box ? `box ${e.box}` : e.label))
          .join(', ')}${ledger.unread > 6 ? ', and more' : ''} — check these against the form.`
      : '';
  return `${parts.join(', ')} of ${ledger.declared} boxes this form needs.${detail}`;
}