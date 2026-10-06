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

/**
 * A K-1 other than a 1065, read off the page text.
 *
 * The K-1 schema is the 1065's, so its box map is wrong for a 1120-S: interest
 * and dividends swap places at box 4, short-term gain lands where royalties go,
 * and box 14 is a "Schedule K-3 is attached" checkbox rather than self-employment
 * earnings. Those boxes are held rather than placed, but the review panel still
 * renders "type the value" from this map, so leaving it in place offered a
 * preparer the 1065 label for a box the 1120-S prints differently. Returns null
 * for a 1065 and for a page that does not say, so an unread subtype keeps the
 * existing behaviour instead of being held on a guess.
 */
function nonPartnershipK1Subtype(pageText: string): string | null {
  if (/form\s+1120[-\s]?s\b/.test(pageText)) return '1120-S';
  if (/form\s+1041\b/.test(pageText)) return '1041';
  return null;
}

/** The tool field each declared box feeds, where the schema says it feeds one. */
function fieldsByBox(formType: string | null, pageText = ''): Map<string, string> {
  const key = (formType ?? '') as ClassifiableFormType;
  const mapping = TOOL_MAPPINGS[key];
  const out = new Map<string, string>();
  if (!mapping) return out;
  // Only a positively identified non-1065 K-1 loses its associations: those
  // labels belong to the 1065 and would misroute a correction into the wrong
  // return field.
  if (key === 'K-1' && nonPartnershipK1Subtype(pageText)) return out;
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

/**
 * Whether the form prints this box's label.
 *
 * Only the words that identify the box are compared. The schema appends
 * disambiguators the form does not print — "(line 1)" to tell the per-state rows
 * apart, and a "(s)" that no form carries — and requiring those made every
 * W-2 state and local box read as unread when the form plainly prints them.
 * Every identifying word must be present, so this stays strict about identity and
 * lenient only about wording the form was never going to print.
 */
function labelIsPrinted(label: string, pageText: string): boolean {
  const all = label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Words that carry no identity: a plural marker, and the row disambiguator.
  const ignorable = new Set(['s', 'line', 'lines', 'no', 'of', 'the', 'and', 'or']);
  const words = all.filter((w) => w.length >= 3 && !ignorable.has(w) && !STOPWORDS.has(w));
  if (words.length > 0) return words.every((w) => pageText.includes(w));

  // A label made only of common words ("Code", "Amount") still identifies its box
  // on the page, so fall back to the bare words rather than calling it a miss.
  const bare = all.filter((w) => w.length >= 3 && !ignorable.has(w));
  return bare.length > 0 && bare.every((w) => pageText.includes(w));
}

/**
 * A box the page prints a value in, that no tax tool accepts yet.
 *
 * The reader model path produces these as `ToolMapping.reviewBoxes`; the text
 * layer produces the same condition as a RejectedRead. Without them a box that is
 * plainly filled in reads as blank or missed, and the preparer is never told.
 */
export interface UnplacedBox {
  key: string;
  label: string;
  text: string;
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
  /**
   * The page text, so a blank box can be told from a missed one. Omit it when
   * the text is not available: see below.
   */
  pageText?: string,
  /** Boxes the form fills in that no tool can place, keyed by schema box key. */
  unplaced: readonly UnplacedBox[] = [],
): BoxLedger {
  const schema = FORM_EXTRACTION_SCHEMAS[(formType ?? '') as ClassifiableFormType];
  const text = (pageText ?? '').toLowerCase();
  const fields = fieldsByBox(formType, text);
  const held = new Map(rejectedReads.map((r) => [r.field, r]));
  const filled = new Map(unplaced.map((u) => [u.key, u]));

  const entries: BoxLedgerEntry[] = [];
  // The schema declares a row per state (W-2 boxes 15–20), so a form for one
  // state prints one of each. Only the first occurrence is a box to look at;
  // counting the rest would list the same printed box four times.
  const seenPrintedBox = new Set<string>();

  for (const box of schema?.boxes ?? []) {
    const field = fields.get(box.key);
    const value = field ? extractedData[field] : undefined;
    const rejection = field ? held.get(field) : undefined;
    const unplacedBox = filled.get(box.key);
    const repeat = box.box !== '' && seenPrintedBox.has(box.box);
    if (box.box !== '') seenPrintedBox.add(box.box);

    let state: BoxState;
    if (repeat && value === undefined && !rejection && !unplacedBox) state = 'informational';
    // `info` is furniture (an address, a phone number). `review` is not: those are
    // boxes the return needs that only a person can settle, such as 1099-DIV box
    // 3 nondividend distributions. Counting them as informational would drop a
    // real gap from the list.
    else if (rejection) state = 'held';
    // Filled in, and nothing can put it on the return. Held, not blank: the
    // figure is on the form and a preparer has to decide where it belongs.
    else if (unplacedBox) state = 'held';
    else if (value !== undefined && value !== null && value !== '') state = 'read';
    else if (box.use === 'info') state = 'informational';
    else if (box.kind === 'checkbox') state = 'unread';
    // Without the page's own words there is no telling a blank box from one that
    // was walked past, and calling it unread claims a miss nobody has evidence
    // for — which invents a gap, and a gap now holds a case open. The reader's
    // own page evidence reports the boxes it genuinely could not read, so an
    // absent page text leaves the box blank rather than guessing.
    else state = pageText === undefined || labelIsPrinted(box.label, text) ? 'empty' : 'unread';

    entries.push({
      key: box.key,
      box: box.box,
      label: box.label,
      state,
      ...(field ? { field } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(rejection ? { reason: rejection.detail } : {}),
      ...(unplacedBox
        ? { value: unplacedBox.text, reason: 'the form prints this, but no part of the return takes it yet' }
        : {}),
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