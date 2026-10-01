/**
 * The person a tax form is about (work order §12, §13): the W-2 employee, the
 * recipient of a 1099, the borrower on a 1098, the beneficiary on an SSA-1099.
 * Read from the form's identity boxes, split into return fields only where the
 * split is unambiguous, and marked confirmed only when an independent reader
 * (the page's text layer or OCR, or the second model) agrees with the value.
 *
 * Nothing here is guessed: a masked TIN gives only its last four digits, a
 * name that cannot be split (a joint account's two names, a compound surname)
 * keeps its printed text only, and an address that is not a US street and
 * "City, ST 12345" line is kept as printed.
 *
 * The 1098-T student and the 1099-Q recipient can be a dependent, so those
 * forms never name the taxpayer: their person is read only to place the form
 * on its case (`placementOnly`) — the taxpayer, the spouse or a dependent.
 */

import type { ClassifiableFormType } from './documentClassifier.js';

export interface IdentityPart<T> {
  /** As printed (the reader's text). */
  raw: string;
  /** An independent reader agrees with it. */
  confirmed: boolean;
  value: T;
}

export interface PersonName {
  first: string;
  middleInitial?: string;
  last: string;
  suffix?: string;
}

export interface USAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface PartyIdentity {
  formType: ClassifiableFormType;
  /** Full SSN/ITIN, 9 digits, when the form prints it unmasked. */
  tin?: IdentityPart<string>;
  /** Last four digits, from a full or a masked TIN. */
  tinLastFour?: string;
  /** The printed name; `value` is null when it cannot be split without guessing. */
  name?: IdentityPart<PersonName | null>;
  /** The printed address; `value` is null when it is not a plain US address. */
  address?: IdentityPart<USAddress | null>;
  /** The 1098-T student or 1099-Q recipient: places the form, never fills the taxpayer's identity. */
  placementOnly?: boolean;
}

/** Schema keys of the person's TIN, name and address lines, by form. */
export interface IdentityKeys {
  tin: string;
  name: string;
  address: string[];
}

const RECIPIENT: IdentityKeys = {
  tin: 'recipient.tin',
  name: 'recipient.name',
  address: ['recipient.street', 'recipient.apt', 'recipient.city', 'recipient.state', 'recipient.zip'],
};

export const IDENTITY_KEYS: Partial<Record<ClassifiableFormType, IdentityKeys>> = {
  'W-2': { tin: 'a', name: 'e', address: ['f'] },
  '1099-INT': RECIPIENT,
  '1099-DIV': RECIPIENT,
  '1099-NEC': RECIPIENT,
  '1099-R': RECIPIENT,
  '1099-MISC': RECIPIENT,
  '1099-G': RECIPIENT,
  '1099-B': RECIPIENT,
  '1099-K': RECIPIENT,
  '1099-OID': RECIPIENT,
  '1099-C': RECIPIENT,
  '1099-SA': RECIPIENT,
  '1099-S': RECIPIENT,
  '1098': { tin: 'borrower.tin', name: 'borrower.name', address: ['borrower.street', 'borrower.city'] },
  'SSA-1099': { tin: '2', name: '1', address: ['7'] },
};

/** Forms whose person may be a dependent: read to place the form only. */
export const PLACEMENT_ONLY_KEYS: Partial<Record<ClassifiableFormType, IdentityKeys>> = {
  '1099-Q': { tin: 'recipient.tin', name: 'recipient.name', address: ['recipient.street', 'recipient.city'] },
  '1098-T': { tin: 'student.tin', name: 'student.name', address: ['student.street', 'student.apt', 'student.city', 'student.state', 'student.zip'] },
};

/** Name boxes printed in columns (first name and initial | last name | suffix). */
export const NAME_COLUMN_KEYS: Partial<Record<ClassifiableFormType, string>> = { 'W-2': 'e' };

/** Every schema key that holds a person's identity on some form. */
export function isIdentityKey(formType: ClassifiableFormType, key: string): boolean {
  const k = IDENTITY_KEYS[formType] ?? PLACEMENT_ONLY_KEYS[formType];
  return Boolean(k && (k.tin === key || k.name === key || k.address.includes(key)));
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const NAME_WORD = /^[A-Za-z][A-Za-z'-]*$/;

/** A printed name word in title case ("O'NEIL-PARK" → "O'Neil-Park"). */
export function titleCase(word: string): string {
  return word
    .toLowerCase()
    .replace(/(^|[-'])([a-z])/g, (_m, sep: string, c: string) => `${sep}${c.toUpperCase()}`);
}

/**
 * Split a printed name into first, middle initial, last and suffix, only when
 * the words leave no choice: "MAYA LEE", "MAYA R LEE", "Maya R. Lee Jr.".
 * Anything else — one word, several middle names, "&", "AND", a comma, a
 * compound surname — is not split.
 */
export function parsePersonName(text: string): PersonName | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (line.length !== 1) return null;
  if (/[&,/]|\bAND\b|\bOR\b/i.test(line[0]!)) return null;
  const words = line[0]!.split(/\s+/).map((w) => w.replace(/\.$/, ''));
  let suffix: string | undefined;
  if (words.length > 2 && SUFFIXES.has(words[words.length - 1]!.toUpperCase())) {
    suffix = words.pop()!.toUpperCase();
    suffix = suffix === 'JR' || suffix === 'SR' ? `${titleCase(suffix)}.` : suffix;
  }
  if (!words.every((w) => NAME_WORD.test(w))) return null;
  if (words.length === 2) return { first: titleCase(words[0]!), last: titleCase(words[1]!), ...(suffix ? { suffix } : {}) };
  if (words.length === 3 && /^[A-Za-z]$/.test(words[1]!)) {
    return { first: titleCase(words[0]!), middleInitial: words[1]!.toUpperCase(), last: titleCase(words[2]!), ...(suffix ? { suffix } : {}) };
  }
  return null;
}

/**
 * A name from its printed columns: the first name with an optional middle
 * initial, the last name (all of it: "De La Cruz"), and an optional suffix.
 */
export function parseNameColumns(first: string, last: string, suffix = ''): PersonName | null {
  const NAME_TEXT = /^[A-Za-z][A-Za-z' .-]*$/;
  if (!first || !last || !NAME_TEXT.test(first) || !NAME_TEXT.test(last)) return null;
  const words = first.trim().split(/\s+/).map((w) => w.replace(/\.$/, ''));
  const initial = words.length > 1 && /^[A-Za-z]$/.test(words[words.length - 1]!) ? words.pop()!.toUpperCase() : undefined;
  const s = suffix.trim().replace(/\.$/, '').toUpperCase();
  if (s && !SUFFIXES.has(s)) return null;
  return {
    first: words.map(titleCase).join(' '),
    ...(initial ? { middleInitial: initial } : {}),
    last: last.trim().split(/\s+/).map(titleCase).join(' '),
    ...(s ? { suffix: s === 'JR' || s === 'SR' ? `${titleCase(s)}.` : s } : {}),
  };
}

const CITY_LINE = /^(.+?),?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/;
const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA',
  'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * A US address from its printed lines: one street line (an apartment on its
 * own line joins it) and a last line "City, ST 12345[-6789]". A name line
 * before the street (W-2 box e and f printed together) is not part of it.
 */
export function parseUSAddress(lines: readonly string[]): USAddress | null {
  const clean = lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (clean.length < 2 || clean.length > 3) return null;
  const last = CITY_LINE.exec(clean[clean.length - 1]!);
  if (!last || !STATE_CODES.has(last[2]!.toUpperCase())) return null;
  // A city is a word, not the comma before the state.
  if (!/[A-Za-z]/.test(last[1]!)) return null;
  const streetLines = clean.slice(0, -1);
  // A street line begins with a house number or a PO box; an apartment line may follow.
  if (!/^(\d+[A-Z]?\b|P\.?\s*O\.?\s+BOX\b)/i.test(streetLines[0]!)) return null;
  if (streetLines.length === 2 && !/^(APT|UNIT|STE|SUITE|#)\b/i.test(streetLines[1]!)) return null;
  return { street: streetLines.join(' '), city: last[1]!.replace(/,$/, '').trim(), state: last[2]!.toUpperCase(), zip: last[3]! };
}

/** The lines before a trailing US address ("CARA / OKAFOR / 1427 ASPEN CT / NAPERVILLE IL 60540" → the name lines). */
function withoutTrailingAddress(lines: readonly string[]): string[] {
  for (let cut = 1; cut < lines.length - 1; cut++) {
    if (parseUSAddress(lines.slice(cut))) return lines.slice(0, cut);
  }
  return [...lines];
}

/** A printed TIN: nine digits, or a masked one showing only the last four. */
export function parseTin(text: string): { full?: string; lastFour?: string } {
  const t = text.trim();
  const full = /^(\d{3})-?(\d{2})-?(\d{4})$/.exec(t);
  if (full) return { full: `${full[1]}${full[2]}${full[3]}`, lastFour: full[3] };
  const masked = /^[X*•]{3}-?[X*•]{2}-?(\d{4})$/i.exec(t);
  return masked ? { lastFour: masked[1] } : {};
}

/**
 * The person on one form, from its box values. `confirmed(key)` says whether
 * an independent reader agrees with that box's value: for a text layer,
 * always; for the models, the page or the second model.
 */
export function identityFromValues(
  formType: ClassifiableFormType,
  values: Readonly<Record<string, string>>,
  confirmed: (key: string) => boolean,
  /** The name box's lines are its printed columns, as the page's geometry showed them. */
  options: { nameColumns?: boolean } = {},
): PartyIdentity | null {
  const placementOnly = !IDENTITY_KEYS[formType] && Boolean(PLACEMENT_ONLY_KEYS[formType]);
  const keys = IDENTITY_KEYS[formType] ?? PLACEMENT_ONLY_KEYS[formType];
  if (!keys) return null;
  const out: PartyIdentity = { formType, ...(placementOnly ? { placementOnly: true } : {}) };
  const tinText = values[keys.tin]?.trim();
  if (tinText) {
    const tin = parseTin(tinText);
    if (tin.full) out.tin = { raw: tinText, confirmed: confirmed(keys.tin), value: tin.full };
    // The last four digits match people across documents: only a confirmed reading does.
    if (tin.lastFour && confirmed(keys.tin)) out.tinLastFour = tin.lastFour;
  }
  const nameText = values[keys.name]?.trim();
  if (nameText) {
    // A reading of the name box that ran on into the address below it (W-2 box e into f):
    // the address lines are not part of the name (the address is read from its own box).
    const nameLines = withoutTrailingAddress(nameText.split(/\r?\n/).map((p) => p.trim()).filter(Boolean));
    const columns = options.nameColumns && NAME_COLUMN_KEYS[formType] === keys.name ? nameLines : null;
    const value = columns && (columns.length === 2 || columns.length === 3)
      ? parseNameColumns(columns[0]!, columns[1]!, columns[2] ?? '')
      : parsePersonName(nameLines.join('\n'));
    out.name = { raw: nameText, confirmed: confirmed(keys.name), value };
  }
  const addressKeys = keys.address.filter((k) => values[k]?.trim());
  if (addressKeys.length > 0) {
    let lines = addressKeys.map((k) => values[k]!.trim());
    // Split cells (2026 1099s): street, city, state and ZIP each read, or no
    // address — a city line is never built from the cells that happened to be
    // read (measured: a scan's empty city cell made ", LA 70802").
    const split = keys.address.some((k) => k.endsWith('.state') || k.endsWith('.zip'));
    let complete = true;
    if (split) {
      const byKey = (suffix: string) => values[keys.address.find((k) => k.endsWith(suffix)) ?? '']?.trim() ?? '';
      complete = ['.street', '.city', '.state', '.zip'].every((suffix) => byKey(suffix) !== '');
      lines = [
        [byKey('.street'), byKey('.apt')].filter(Boolean).join(' '),
        `${byKey('.city')}, ${byKey('.state')} ${byKey('.zip')}`.trim(),
      ];
    }
    // W-2 box f may repeat the employee's name above the street.
    const flat = lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.trim()).filter(Boolean);
    const printedName = nameText ? identityKeyText(nameText) : '';
    const withoutName = printedName && identityKeyText(flat[0] ?? '') === printedName ? flat.slice(1) : flat;
    out.address = {
      raw: flat.join('\n'),
      confirmed: complete && addressKeys.every((k) => confirmed(k)),
      value: complete ? parseUSAddress(withoutName) : null,
    };
  }
  return out.tin || out.tinLastFour || out.name || out.address ? out : null;
}

/** Normalized for comparison: letters and digits, upper case. */
export function identityKeyText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
