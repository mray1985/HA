/**
 * Per-form extraction schemas (work order §15, §16).
 *
 * One schema per information return: every printed box, its label as printed
 * on the named IRS revision, the kind of value it holds, and what the value is
 * used for. The same schema drives:
 *   - the extraction template and JSON grammar sent to the document model,
 *   - deterministic mapping from printed text to tax-tool arguments,
 *   - review routing for filled boxes no tax tool can accept yet.
 *
 * The model transcribes printed text only. Normalizing ("$1,284.66" → 1284.66),
 * validating and calculating stay in deterministic code. A blank box stays
 * unknown — it is never mapped to zero.
 */

import type { ClassifiableFormType } from './documentClassifier.js';
import type { CheckboxSpec } from './pageEvidence.js';
import type { TaxToolIncomeName } from './taxTools.js';

export type BoxValueKind =
  | 'money'
  | 'text'
  | 'tin'
  | 'code'
  | 'checkbox'
  | 'date'
  | 'percent'
  | 'integer'
  | 'stateCode'
  /** "State/Payer's state no." cells such as "LA/1234567". */
  | 'stateAndId';

/**
 * - tool:   feeds a tax-tool argument.
 * - review: can change the return but no tax tool accepts it yet; a filled
 *           box routes the form to preparer review instead of being dropped.
 * - info:   identifiers, addresses and account numbers kept as provenance.
 */
export type BoxUse = 'tool' | 'review' | 'info';

export interface FormBoxSchema {
  /** Stable key, unique within the form (e.g. "1", "12a.code", "15.state.1"). */
  key: string;
  /** Box identifier as printed ("1", "12a", "c"); empty for unnumbered areas. */
  box: string;
  /** Label as printed on the form revision. */
  label: string;
  kind: BoxValueKind;
  use: BoxUse;
  /**
   * Checkbox boxes: where the square sits relative to a printed label word on
   * the official layout. Checkbox state is read deterministically from the page
   * (models were measured to miss marks), never taken from model text alone.
   */
  checkbox?: CheckboxSpec;
}

export interface FormExtractionSchema {
  formType: ClassifiableFormType;
  /** IRS revision the labels were taken from. */
  revision: string;
  boxes: readonly FormBoxSchema[];
}

function box(
  key: string,
  label: string,
  kind: BoxValueKind,
  use: BoxUse,
  printed?: string,
): FormBoxSchema {
  return { key, box: printed ?? key.split('.')[0]!, label, kind, use };
}

function checkbox(
  key: string,
  label: string,
  use: BoxUse,
  spec: CheckboxSpec,
  printed?: string,
): FormBoxSchema {
  return { ...box(key, label, 'checkbox', use, printed), checkbox: spec };
}

function stateRows(
  rows: number,
  cells: ReadonlyArray<{ key: string; label: string; kind: BoxValueKind; use: BoxUse }>,
): FormBoxSchema[] {
  const out: FormBoxSchema[] = [];
  for (let row = 1; row <= rows; row++) {
    for (const cell of cells) {
      // Only the first state row feeds a tool; a second row is a multi-state
      // situation the tools cannot represent yet, so it routes to review.
      const use: BoxUse = row === 1 ? cell.use : cell.use === 'info' ? 'info' : 'review';
      out.push(box(`${cell.key}.${row}`, `${cell.label} (line ${row})`, cell.kind, use, cell.key.split('.')[0]));
    }
  }
  return out;
}

const W2_SCHEMA: FormExtractionSchema = {
  formType: 'W-2',
  revision: '2026',
  boxes: [
    box('a', "Employee's social security number", 'tin', 'info'),
    box('b', 'Employer identification number (EIN)', 'tin', 'tool'),
    box('c', "Employer's name, address, and ZIP code", 'text', 'tool'),
    box('d', 'Control number', 'text', 'info'),
    box('e', "Employee's first name and initial, Last name, Suff.", 'text', 'info'),
    box('f', "Employee's address and ZIP code", 'text', 'info'),
    box('1', 'Wages, tips, other compensation', 'money', 'tool'),
    box('2', 'Federal income tax withheld', 'money', 'tool'),
    box('3', 'Social security wages', 'money', 'tool'),
    box('4', 'Social security tax withheld', 'money', 'tool'),
    box('5', 'Medicare wages and tips', 'money', 'tool'),
    box('6', 'Medicare tax withheld', 'money', 'tool'),
    box('7', 'Social security tips', 'money', 'review'),
    box('8', 'Allocated tips', 'money', 'review'),
    box('10', 'Dependent care benefits', 'money', 'review'),
    box('11', 'Nonqualified plans', 'money', 'review'),
    // Printed as "12a See instructions for box 12" with a Code column and an amount.
    box('12a.code', 'Code', 'code', 'tool'),
    box('12a.amount', 'Amount', 'money', 'tool'),
    box('12b.code', 'Code', 'code', 'tool'),
    box('12b.amount', 'Amount', 'money', 'tool'),
    box('12c.code', 'Code', 'code', 'tool'),
    box('12c.amount', 'Amount', 'money', 'tool'),
    box('12d.code', 'Code', 'code', 'tool'),
    box('12d.amount', 'Amount', 'money', 'tool'),
    checkbox('13.statutory', 'Statutory employee', 'tool', { labelPhrase: 'Statutory', direction: 'below' }),
    checkbox('13.retirement', 'Retirement plan', 'tool', { labelPhrase: 'Retirement', direction: 'below' }),
    checkbox('13.sickPay', 'Third-party sick pay', 'tool', { labelPhrase: 'Third-party', direction: 'below' }),
    box('14a', 'Other', 'text', 'review'),
    box('14b', 'Treasury Tipped Occupation Code(s)', 'code', 'review'),
    ...stateRows(2, [
      { key: '15.state', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '15.id', label: "Employer's state ID number", kind: 'text', use: 'info' },
      { key: '16', label: 'State wages, tips, etc.', kind: 'money', use: 'tool' },
      { key: '17', label: 'State income tax', kind: 'money', use: 'tool' },
      { key: '18', label: 'Local wages, tips, etc.', kind: 'money', use: 'review' },
      { key: '19', label: 'Local income tax', kind: 'money', use: 'review' },
      { key: '20', label: 'Locality name', kind: 'text', use: 'review' },
    ]),
  ],
};

/**
 * Payer/recipient areas mirror each revision's printed layout. Older revisions
 * print one combined payer block; the 2026 1099-NEC and 1099-R split name,
 * street, city, state and ZIP into separate cells.
 */
const COMBINED_PAYER_RECIPIENT: FormBoxSchema[] = [
  box('payer.block', "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.", 'text', 'tool', ''),
  box('payer.tin', "PAYER'S TIN", 'tin', 'info', ''),
  box('recipient.tin', "RECIPIENT'S TIN", 'tin', 'info', ''),
  box('recipient.name', "RECIPIENT'S name", 'text', 'info', ''),
  box('recipient.street', "RECIPIENT'S street address (including apt. no.)", 'text', 'info', ''),
  box('recipient.city', "RECIPIENT'S city or town, state or province, country, and ZIP or foreign postal code", 'text', 'info', ''),
  box('account', 'Account number (see instructions)', 'text', 'info', ''),
];

const SPLIT_PAYER_RECIPIENT: FormBoxSchema[] = [
  box('payer.name', "PAYER'S name", 'text', 'tool', ''),
  box('payer.street', "PAYER'S street address", 'text', 'info', ''),
  box('payer.suite', "PAYER'S room or suite no.", 'text', 'info', ''),
  box('payer.city', "PAYER'S city or town", 'text', 'info', ''),
  box('payer.phone', "PAYER'S telephone number", 'text', 'info', ''),
  box('payer.state', "PAYER'S state or province", 'text', 'info', ''),
  box('payer.country', "PAYER'S country", 'text', 'info', ''),
  box('payer.zip', "PAYER'S ZIP or foreign postal code", 'text', 'info', ''),
  box('payer.tin', "PAYER'S TIN", 'tin', 'tool', ''),
  box('recipient.tin', "RECIPIENT'S TIN", 'tin', 'info', ''),
  box('recipient.name', "RECIPIENT'S name", 'text', 'info', ''),
  box('recipient.street', "RECIPIENT'S street address", 'text', 'info', ''),
  box('recipient.apt', "RECIPIENT'S apt. no.", 'text', 'info', ''),
  box('recipient.city', "RECIPIENT'S city or town", 'text', 'info', ''),
  box('recipient.state', "RECIPIENT'S state or province", 'text', 'info', ''),
  box('recipient.country', "RECIPIENT'S country", 'text', 'info', ''),
  box('recipient.zip', "RECIPIENT'S ZIP or foreign postal code", 'text', 'info', ''),
  box('account', 'Account number (see instructions)', 'text', 'info', ''),
];

const INT_SCHEMA: FormExtractionSchema = {
  formType: '1099-INT',
  revision: 'January 2024',
  boxes: [
    ...COMBINED_PAYER_RECIPIENT,
    box('rtn', "Payer's RTN (optional)", 'text', 'info', ''),
    checkbox('fatca', 'FATCA filing requirement', 'review', { labelPhrase: 'requirement', direction: 'below' }, ''),
    box('1', 'Interest income', 'money', 'tool'),
    box('2', 'Early withdrawal penalty', 'money', 'tool'),
    box('3', 'Interest on U.S. Savings Bonds and Treasury obligations', 'money', 'tool'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Investment expenses', 'money', 'review'),
    box('6', 'Foreign tax paid', 'money', 'review'),
    box('7', 'Foreign country or U.S. territory', 'text', 'review'),
    box('8', 'Tax-exempt interest', 'money', 'tool'),
    box('9', 'Specified private activity bond interest', 'money', 'review'),
    box('10', 'Market discount', 'money', 'review'),
    box('11', 'Bond premium', 'money', 'review'),
    box('12', 'Bond premium on Treasury obligations', 'money', 'review'),
    box('13', 'Bond premium on tax-exempt bond', 'money', 'review'),
    box('14', 'Tax-exempt and tax credit bond CUSIP no.', 'text', 'info'),
    ...stateRows(2, [
      { key: '15', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '16', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '17', label: 'State tax withheld', kind: 'money', use: 'tool' },
    ]),
  ],
};

const NEC_SCHEMA: FormExtractionSchema = {
  formType: '1099-NEC',
  revision: 'December 2026',
  boxes: [
    ...SPLIT_PAYER_RECIPIENT,
    box('1a', 'Nonemployee compensation', 'money', 'tool'),
    box('1b', 'Cash tips', 'money', 'review'),
    box('1c', 'TTOC', 'code', 'review'),
    box('1d', 'Overtime compensation', 'money', 'review'),
    checkbox('2', 'Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 'info', { labelPhrase: 'more of', direction: 'right' }),
    box('3', 'Excess golden parachute payments', 'money', 'review'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    ...stateRows(2, [
      { key: '5', label: 'State tax withheld', kind: 'money', use: 'tool' },
      { key: '6', label: "State/Payer's state no.", kind: 'stateAndId', use: 'tool' },
      { key: '7', label: 'State income', kind: 'money', use: 'info' },
    ]),
  ],
};

const R_SCHEMA: FormExtractionSchema = {
  formType: '1099-R',
  revision: '2026',
  boxes: [
    ...SPLIT_PAYER_RECIPIENT,
    box('1', 'Gross distribution', 'money', 'tool'),
    box('2a', 'Taxable amount', 'money', 'tool'),
    checkbox('2b.notDetermined', 'Taxable amount not determined', 'review', { labelPhrase: 'determined', direction: 'right' }),
    checkbox('2b.total', 'Total distribution', 'review', { labelPhrase: 'Total', direction: 'right' }),
    box('3', 'Capital gain (included in box 2a)', 'money', 'review'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Employee contributions/Designated Roth contributions or insurance premiums', 'money', 'review'),
    box('6', "Net unrealized appreciation in employer's securities", 'money', 'review'),
    box('7a', 'Distribution code(s)', 'code', 'tool'),
    checkbox('7b', 'IRA/SEP/SIMPLE', 'tool', { labelPhrase: 'SIMPLE', direction: 'below' }),
    checkbox('7c', 'Trump account', 'review', { labelPhrase: 'Trump', direction: 'below' }),
    box('7d', 'Earnings on excess contributions', 'money', 'review'),
    box('8a', 'Other', 'money', 'review'),
    box('8b', 'Percentage of annuity contract', 'percent', 'review'),
    box('9a', 'Your percentage of total distribution', 'percent', 'review'),
    box('9b', 'Total employee contributions', 'money', 'review'),
    box('10', 'Amount allocable to IRR within 5 years', 'money', 'review'),
    box('11', '1st year of designated Roth contributions', 'integer', 'review'),
    checkbox('12', 'FATCA filing requirement', 'review', { labelPhrase: 'FATCA', direction: 'below' }),
    box('13', 'Date of payment', 'date', 'info'),
    ...stateRows(2, [
      { key: '14', label: 'State tax withheld', kind: 'money', use: 'tool' },
      { key: '15', label: "State/Payer's state no.", kind: 'stateAndId', use: 'tool' },
      { key: '16', label: 'State distribution', kind: 'money', use: 'info' },
      { key: '17', label: 'Local tax withheld', kind: 'money', use: 'review' },
      { key: '18', label: 'Name of locality', kind: 'text', use: 'review' },
      { key: '19', label: 'Local distribution', kind: 'money', use: 'info' },
    ]),
  ],
};

const MORTGAGE_SCHEMA: FormExtractionSchema = {
  formType: '1098',
  revision: 'April 2025',
  boxes: [
    box('lender.block', "RECIPIENT'S/LENDER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.", 'text', 'info', ''),
    box('lender.tin', "RECIPIENT'S/LENDER'S TIN", 'tin', 'info', ''),
    box('borrower.tin', "PAYER'S/BORROWER'S TIN", 'tin', 'info', ''),
    box('borrower.name', "PAYER'S/BORROWER'S name", 'text', 'info', ''),
    box('borrower.street', "PAYER'S/BORROWER'S street address (including apt. no.)", 'text', 'info', ''),
    box('borrower.city', "PAYER'S/BORROWER'S city or town, state or province, country, and ZIP or foreign postal code", 'text', 'info', ''),
    box('account', 'Account number (see instructions)', 'text', 'info', ''),
    // No mortgage-interest tax tool exists yet (work order §5), so every
    // tax-relevant box routes the form to review instead of being dropped.
    box('1', 'Mortgage interest received from payer(s)/borrower(s)', 'money', 'review'),
    box('2', 'Outstanding mortgage principal', 'money', 'review'),
    box('3', 'Mortgage origination date', 'date', 'review'),
    box('4', 'Refund of overpaid interest', 'money', 'review'),
    box('5', 'Mortgage insurance premiums', 'money', 'review'),
    box('6', 'Points paid on purchase of principal residence', 'money', 'review'),
    checkbox('7', "Address of property securing mortgage is the same as payer's/borrower's address", 'review', { labelPhrase: 'If address', direction: 'left' }),
    box('8', 'Address or description of property securing mortgage', 'text', 'review'),
    box('9', 'Number of properties securing the mortgage', 'integer', 'review'),
    box('10', 'Other', 'text', 'review'),
    box('11', 'Mortgage acquisition date', 'date', 'review'),
  ],
};

export const FORM_EXTRACTION_SCHEMAS: Partial<Record<ClassifiableFormType, FormExtractionSchema>> = {
  'W-2': W2_SCHEMA,
  '1099-INT': INT_SCHEMA,
  '1099-NEC': NEC_SCHEMA,
  '1099-R': R_SCHEMA,
  '1098': MORTGAGE_SCHEMA,
};

export function getFormExtractionSchema(
  formType: ClassifiableFormType | null | undefined,
): FormExtractionSchema | null {
  if (!formType) return null;
  return FORM_EXTRACTION_SCHEMAS[formType] ?? null;
}

// ─── Extraction template + grammar ───────────────────────────

/** Template field name shown to the model: printed box id plus printed label. */
export function templateFieldName(b: FormBoxSchema): string {
  return b.box ? `${b.box} ${b.label}` : b.label;
}

export interface ExtractionTemplate {
  /** JSON object with every template field set to "" (the model fills printed text). */
  template: Record<string, string>;
  /**
   * JSON Schema for grammar-constrained decoding. Every field is a string;
   * "" is the model's explicit way to say the box is blank.
   */
  jsonSchema: Record<string, unknown>;
  /** Template field name → schema box key. */
  keyByField: Record<string, string>;
}

export function buildExtractionTemplate(schema: FormExtractionSchema): ExtractionTemplate {
  const template: Record<string, string> = {};
  const keyByField: Record<string, string> = {};
  const properties: Record<string, unknown> = {};
  for (const b of schema.boxes) {
    const field = templateFieldName(b);
    if (Object.prototype.hasOwnProperty.call(template, field)) {
      throw new Error(`Duplicate template field "${field}" in ${schema.formType} schema`);
    }
    template[field] = '';
    keyByField[field] = b.key;
    properties[field] = { type: 'string' };
  }
  return {
    template,
    keyByField,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(template),
      properties,
    },
  };
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Kinds whose values are short tokens that can legitimately occur inside a label. */
const NO_LABEL_ECHO_KINDS = new Set<BoxValueKind>(['code', 'stateCode', 'stateAndId', 'tin', 'checkbox']);

/** Every word of the value is a whole word of the label (e.g. "(optional)", "Other"). */
function echoesLabel(value: string, label: string): boolean {
  const valueWords = words(value);
  if (valueWords.length === 0 || !valueWords.some((w) => w.length >= 3)) return false;
  const labelWords = new Set(words(label));
  return valueWords.every((w) => labelWords.has(w));
}

/**
 * True when a transcription carries no value for its box: only symbols
 * ("$", "%"), an amount-shaped box with no digit, or text that merely repeats
 * the box's own printed label (e.g. "(optional)" read from "Payer's RTN (optional)").
 */
export function isBlankTranscription(text: string, b: FormBoxSchema): boolean {
  const t = text.trim();
  if (!t) return true;
  if (!/[A-Za-z0-9]/.test(t)) return true;
  if ((b.kind === 'money' || b.kind === 'percent' || b.kind === 'integer' || b.kind === 'date') && !/\d/.test(t)) {
    return true;
  }
  if (/[A-Za-z]/.test(t) && !NO_LABEL_ECHO_KINDS.has(b.kind) && echoesLabel(t, b.label)) return true;
  return false;
}

/**
 * Map a model's filled template back to schema keys. Missing, blank,
 * symbol-only and label-echo fields are absent — never zero.
 */
export function boxValuesFromTemplate(
  filled: Record<string, unknown>,
  template: ExtractionTemplate,
  schema: FormExtractionSchema,
): Record<string, string> {
  const boxByKey = new Map(schema.boxes.map((b) => [b.key, b]));
  const values: Record<string, string> = {};
  for (const [field, key] of Object.entries(template.keyByField)) {
    const raw = filled[field];
    if (typeof raw !== 'string') continue;
    const b = boxByKey.get(key)!;
    if (isBlankTranscription(raw, b)) continue;
    values[key] = raw;
  }
  return values;
}

// ─── Deterministic mapping to tax-tool arguments ─────────────

export interface ToolMapping {
  tool: TaxToolIncomeName | null;
  /**
   * Extractor bag for extractStructuredFields: raw printed strings keyed by tool
   * field. Normalization (money, booleans, box 12/13) happens there.
   */
  bag: Record<string, unknown>;
  /** Original printed text per tool field (provenance rawText). */
  rawText: Record<string, string>;
  /**
   * Filled boxes no tool accepts yet. A non-empty list means the form needs
   * preparer review before the return can be treated as complete.
   */
  reviewBoxes: Array<{ key: string; label: string; text: string }>;
}

const CHECKED_TOKEN = /^(x|✓|✔|☑|☒|yes|checked|true)$/i;

/** Checkbox text as printed/reported: only an explicit mark counts as checked. */
export function checkboxState(text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  if (CHECKED_TOKEN.test(t)) return true;
  if (/^(no|unchecked|false|☐)$/i.test(t)) return false;
  return undefined;
}

/** "LA/1234567", "LA 1234567", "LA" → "LA". Anything else is not a state code. */
export function stateCodeFromCell(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /^\s*([A-Za-z]{2})(?:\s*[/\-\s]\s*\S.*)?\s*$/.exec(text);
  return m ? m[1]!.toUpperCase() : undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]!.trim();
}

const TOOL_FOR_FORM: Partial<Record<ClassifiableFormType, TaxToolIncomeName>> = {
  'W-2': 'add_w2',
  '1099-INT': 'add_1099_int',
  '1099-NEC': 'add_1099_nec',
  '1099-R': 'add_1099_r',
};

/** Schema box key → tool field, per tool. Box 12/13 and state cells are assembled separately. */
const DIRECT_FIELDS: Record<TaxToolIncomeName, Record<string, string>> = {
  add_w2: {
    b: 'employerEin',
    '1': 'wages',
    '2': 'federalTaxWithheld',
    '3': 'socialSecurityWages',
    '4': 'socialSecurityTax',
    '5': 'medicareWages',
    '6': 'medicareTax',
    '16.1': 'stateWages',
    '17.1': 'stateTaxWithheld',
  },
  add_1099_int: {
    '1': 'amount',
    '2': 'earlyWithdrawalPenalty',
    '3': 'usBondInterest',
    '4': 'federalTaxWithheld',
    '8': 'taxExemptInterest',
    '17.1': 'stateTaxWithheld',
  },
  add_1099_div: {},
  add_1099_nec: {
    'payer.tin': 'payerEin',
    '1a': 'amount',
    '4': 'federalTaxWithheld',
    '5.1': 'stateTaxWithheld',
  },
  add_1099_r: {
    '1': 'grossDistribution',
    '2a': 'taxableAmount',
    '4': 'federalTaxWithheld',
    '7a': 'distributionCode',
    '14.1': 'stateTaxWithheld',
  },
};

/**
 * Deterministic mapping from transcribed box text to tax-tool inputs.
 * Never invents a value: blank boxes are absent, unreadable ones are left for
 * extractStructuredFields to mark unknown, and unsupported filled boxes are
 * returned as review items instead of being dropped.
 */
export function mapBoxesToTool(
  schema: FormExtractionSchema,
  values: Record<string, string>,
): ToolMapping {
  const tool = TOOL_FOR_FORM[schema.formType] ?? null;
  const bag: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};
  const reviewBoxes: ToolMapping['reviewBoxes'] = [];
  const boxByKey = new Map(schema.boxes.map((b) => [b.key, b]));

  const put = (field: string, value: unknown, raw: string) => {
    bag[field] = value;
    rawText[field] = raw;
  };

  for (const b of schema.boxes) {
    const text = values[b.key];
    if (text === undefined) continue;
    // An unchecked box is a known "no" — it never needs review on its own.
    if (b.kind === 'checkbox' && checkboxState(text) === false) continue;
    if (b.use === 'review' || (b.use === 'tool' && !tool)) {
      reviewBoxes.push({ key: b.key, label: b.label, text });
    }
  }
  if (!tool) return { tool, bag, rawText, reviewBoxes };

  for (const [key, field] of Object.entries(DIRECT_FIELDS[tool])) {
    const text = values[key];
    if (text !== undefined) put(field, text, text);
  }

  // Payer / employer name: first line of the name cell or combined block only.
  const nameKey = tool === 'add_w2' ? 'c' : values['payer.name'] !== undefined ? 'payer.name' : 'payer.block';
  if (values[nameKey] !== undefined) {
    put(tool === 'add_w2' ? 'employerName' : 'payerName', firstLine(values[nameKey]!), values[nameKey]!);
  }

  // State code (first state row only).
  const stateKey =
    tool === 'add_w2' ? '15.state.1' : tool === 'add_1099_int' ? '15.1' : tool === 'add_1099_nec' ? '6.1' : '15.1';
  const stateText = values[stateKey];
  if (stateText !== undefined) {
    const code = stateCodeFromCell(stateText);
    // An unreadable state cell stays unknown (undefined), never a guessed code.
    put(tool === 'add_w2' ? 'state' : 'stateCode', code, stateText);
  }

  if (tool === 'add_w2') {
    const entries: Array<{ code: string; amount: string }> = [];
    const raws: string[] = [];
    for (const slot of ['12a', '12b', '12c', '12d']) {
      const code = values[`${slot}.code`];
      const amount = values[`${slot}.amount`];
      if (code === undefined && amount === undefined) continue;
      raws.push(`${code ?? ''} ${amount ?? ''}`.trim());
      if (code !== undefined && amount !== undefined) {
        entries.push({ code: code.trim(), amount });
      } else {
        // Half a box 12 entry cannot be applied; the preparer resolves it.
        reviewBoxes.push({
          key: slot,
          label: `Box ${slot}`,
          text: `${code ?? '(no code)'} ${amount ?? '(no amount)'}`,
        });
      }
    }
    if (entries.length > 0) put('box12', entries, raws.join('; '));

    const box13: Record<string, boolean> = {};
    const box13Raw: string[] = [];
    for (const [key, field] of [
      ['13.statutory', 'statutoryEmployee'],
      ['13.retirement', 'retirementPlan'],
      ['13.sickPay', 'thirdPartySickPay'],
    ] as const) {
      const text = values[key];
      if (text === undefined) continue;
      box13Raw.push(`${field}=${text}`);
      const state = checkboxState(text);
      if (state === undefined) {
        reviewBoxes.push({ key, label: boxByKey.get(key)!.label, text });
      } else {
        box13[field] = state;
      }
    }
    if (Object.keys(box13).length > 0) put('box13', box13, box13Raw.join('; '));
  }

  if (tool === 'add_1099_r' && values['7b'] !== undefined) {
    const state = checkboxState(values['7b']);
    if (state === undefined) {
      reviewBoxes.push({ key: '7b', label: boxByKey.get('7b')!.label, text: values['7b']! });
    } else {
      put('isIRA', state, values['7b']!);
    }
  }

  return { tool, bag, rawText, reviewBoxes };
}
