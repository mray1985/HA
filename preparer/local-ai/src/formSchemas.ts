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
import type { CheckboxRowSpec, CheckboxSpec } from './pageEvidence.js';
import type { DocumentToolName } from './taxTools.js';

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

/**
 * W-2 box 13's three squares by table cell, for scans where OCR loses their
 * small labels: the cell of "13", below box 11, or above box 14a.
 */
function w2Box13Row(index: number): CheckboxRowSpec {
  return {
    anchors: [
      { phrase: '13', cellOffset: 0 },
      { phrase: '11 Nonqualified', cellOffset: 1 },
      { phrase: '11', cellOffset: 1 },
      { phrase: '14a Other', cellOffset: -1 },
    ],
    count: 3,
    index,
  };
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
    checkbox('13.statutory', 'Statutory employee', 'tool', { labelPhrase: 'Statutory', direction: 'below', row: w2Box13Row(0) }),
    checkbox('13.retirement', 'Retirement plan', 'tool', { labelPhrase: 'Retirement', direction: 'below', row: w2Box13Row(1) }),
    checkbox('13.sickPay', 'Third-party sick pay', 'tool', { labelPhrase: 'Third-party', direction: 'below', row: w2Box13Row(2) }),
    box('14a', 'Other', 'text', 'review'),
    box('14b', 'Treasury Tipped Occupation Code(s)', 'code', 'review'),
    ...stateRows(2, [
      { key: '15.state', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '15.id', label: "Employer's state ID number", kind: 'text', use: 'info' },
      { key: '16', label: 'State wages, tips, etc.', kind: 'money', use: 'tool' },
      { key: '17', label: 'State income tax', kind: 'money', use: 'tool' },
      { key: '18', label: 'Local wages, tips, etc.', kind: 'money', use: 'tool' },
      { key: '19', label: 'Local income tax', kind: 'money', use: 'tool' },
      { key: '20', label: 'Locality name', kind: 'text', use: 'tool' },
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
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
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
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
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
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
    // The 1099-R tool takes no payer TIN.
    ...SPLIT_PAYER_RECIPIENT.map((b) => (b.key === 'payer.tin' ? { ...b, use: 'info' as const } : b)),
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
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
    box('lender.block', "RECIPIENT'S/LENDER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.", 'text', 'tool', ''),
    box('lender.tin', "RECIPIENT'S/LENDER'S TIN", 'tin', 'tool', ''),
    box('borrower.tin', "PAYER'S/BORROWER'S TIN", 'tin', 'info', ''),
    box('borrower.name', "PAYER'S/BORROWER'S name", 'text', 'info', ''),
    box('borrower.street', "PAYER'S/BORROWER'S street address (including apt. no.)", 'text', 'info', ''),
    box('borrower.city', "PAYER'S/BORROWER'S city or town, state or province, country, and ZIP or foreign postal code", 'text', 'info', ''),
    box('account', 'Account number (see instructions)', 'text', 'info', ''),
    box('1', 'Mortgage interest received from payer(s)/borrower(s)', 'money', 'tool'),
    box('2', 'Outstanding mortgage principal', 'money', 'tool'),
    box('3', 'Mortgage origination date', 'date', 'tool'),
    box('4', 'Refund of overpaid interest', 'money', 'tool'),
    box('5', 'Mortgage insurance premiums', 'money', 'tool'),
    box('6', 'Points paid on purchase of principal residence', 'money', 'tool'),
    checkbox('7', "Address of property securing mortgage is the same as payer's/borrower's address", 'tool', { labelPhrase: 'If address', direction: 'left' }),
    box('8', 'Address or description of property securing mortgage', 'text', 'tool'),
    box('9', 'Number of properties securing the mortgage', 'integer', 'tool'),
    box('10', 'Other', 'text', 'review'),
    box('11', 'Mortgage acquisition date', 'date', 'tool'),
  ],
};

const DIV_SCHEMA: FormExtractionSchema = {
  formType: '1099-DIV',
  revision: 'January 2024',
  boxes: [
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
    ...COMBINED_PAYER_RECIPIENT,
    checkbox('11', 'FATCA filing requirement', 'review', { labelPhrase: 'requirement', direction: 'below' }),
    box('1a', 'Total ordinary dividends', 'money', 'tool'),
    box('1b', 'Qualified dividends', 'money', 'tool'),
    box('2a', 'Total capital gain distr.', 'money', 'tool'),
    box('2b', 'Unrecap. Sec. 1250 gain', 'money', 'tool'),
    box('2c', 'Section 1202 gain', 'money', 'review'),
    box('2d', 'Collectibles (28%) gain', 'money', 'tool'),
    box('2e', 'Section 897 ordinary dividends', 'money', 'review'),
    box('2f', 'Section 897 capital gain', 'money', 'review'),
    box('3', 'Nondividend distributions', 'money', 'review'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Section 199A dividends', 'money', 'review'),
    box('6', 'Investment expenses', 'money', 'review'),
    box('7', 'Foreign tax paid', 'money', 'tool'),
    box('8', 'Foreign country or U.S. possession', 'text', 'info'),
    box('9', 'Cash liquidation distributions', 'money', 'review'),
    box('10', 'Noncash liquidation distributions', 'money', 'review'),
    box('12', 'Exempt-interest dividends', 'money', 'review'),
    box('13', 'Specified private activity bond interest dividends', 'money', 'review'),
    ...stateRows(2, [
      { key: '14', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '15', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '16', label: 'State tax withheld', kind: 'money', use: 'tool' },
    ]),
  ],
};

const TUITION_SCHEMA: FormExtractionSchema = {
  formType: '1098-T',
  revision: '2026',
  boxes: [
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
    box('filer.name', "FILER'S name", 'text', 'tool', ''),
    box('filer.street', "FILER'S street address", 'text', 'info', ''),
    box('filer.suite', "FILER'S room/suite no.", 'text', 'info', ''),
    box('filer.city', "FILER'S city/town", 'text', 'info', ''),
    box('filer.state', "FILER'S state/province", 'text', 'info', ''),
    box('filer.country', "FILER'S country", 'text', 'info', ''),
    box('filer.zip', "FILER'S ZIP/foreign code", 'text', 'info', ''),
    box('filer.phone', "FILER'S telephone number", 'text', 'info', ''),
    box('filer.ein', "FILER'S employer identification no.", 'tin', 'tool', ''),
    box('student.tin', "STUDENT'S TIN", 'tin', 'info', ''),
    box('student.name', "STUDENT'S name", 'text', 'tool', ''),
    box('student.street', "STUDENT'S street address", 'text', 'info', ''),
    box('student.apt', "STUDENT'S apt. no.", 'text', 'info', ''),
    box('student.city', "STUDENT'S city/town", 'text', 'info', ''),
    box('student.state', "STUDENT'S state/province", 'text', 'info', ''),
    box('student.country', "STUDENT'S country", 'text', 'info', ''),
    box('student.zip', "STUDENT'S ZIP/foreign code", 'text', 'info', ''),
    box('account', 'Service Provider/Acct. No.', 'text', 'info', ''),
    box('1', 'Payments received for qualified tuition and related expenses', 'money', 'tool'),
    box('4', 'Adjustments made for a prior year', 'money', 'tool'),
    box('5', 'Scholarships or grants', 'money', 'tool'),
    box('6', 'Adjustments to scholarships or grants for a prior year', 'money', 'tool'),
    // Squares sit at the right end of the last label line.
    checkbox('7', 'Checked if the amount in box 1 includes amounts for an academic period beginning January-March of next year', 'tool', { labelPhrase: 'March', direction: 'right' }),
    checkbox('8', 'Checked if at least half-time student', 'tool', { labelPhrase: 'half-time student', direction: 'right' }),
    checkbox('9', 'Checked if a graduate student', 'tool', { labelPhrase: 'graduate', direction: 'right' }),
    box('10', 'Ins. contract reimb./refund', 'money', 'tool'),
  ],
};

/**
 * SSA-1099 is issued by the Social Security Administration, not the IRS; the
 * layout follows the SSA's printed Social Security Benefit Statement.
 */
const SSA_SCHEMA: FormExtractionSchema = {
  formType: 'SSA-1099',
  revision: 'SSA benefit statement',
  boxes: [
    box('1', 'Name', 'text', 'tool'),
    box('2', "Beneficiary's Social Security Number", 'tin', 'info'),
    box('3', 'Benefits paid', 'money', 'tool'),
    box('4', 'Benefits repaid to SSA', 'money', 'tool'),
    box('5', 'Net benefits (Box 3 minus Box 4)', 'money', 'tool'),
    box('6', 'Voluntary federal income tax withheld', 'money', 'tool'),
    box('7', 'Address', 'text', 'info'),
    box('8', 'Claim number', 'text', 'info'),
  ],
};

// ─── Remaining information returns (work order §16) ──────────
// Labels and box numbers are from each form's Copy B as downloaded from
// irs.gov (local-ai/gauntlet/forms). Checkbox positions were measured on those
// PDFs: the square's rectangle against the printed label's position.

/** Split payer/recipient cells (2026 revisions), with the form's own party words. */
function splitParties(payer: string, recipient: string): FormBoxSchema[] {
  return [
    box('payer.name', `${payer} name`, 'text', 'tool', ''),
    box('payer.street', `${payer} street address`, 'text', 'info', ''),
    box('payer.suite', `${payer} room or suite no.`, 'text', 'info', ''),
    box('payer.city', `${payer} city or town`, 'text', 'info', ''),
    box('payer.phone', `${payer} telephone number`, 'text', 'info', ''),
    box('payer.state', `${payer} state or province`, 'text', 'info', ''),
    box('payer.country', `${payer} country`, 'text', 'info', ''),
    box('payer.zip', `${payer} ZIP or foreign postal code`, 'text', 'info', ''),
    box('payer.tin', `${payer} TIN`, 'tin', 'info', ''),
    box('recipient.tin', `${recipient} TIN`, 'tin', 'info', ''),
    box('recipient.name', `${recipient} name`, 'text', 'info', ''),
    box('recipient.street', `${recipient} street address`, 'text', 'info', ''),
    box('recipient.apt', `${recipient} apt. no.`, 'text', 'info', ''),
    box('recipient.city', `${recipient} city or town`, 'text', 'info', ''),
    box('recipient.state', `${recipient} state or province`, 'text', 'info', ''),
    box('recipient.country', `${recipient} country`, 'text', 'info', ''),
    box('recipient.zip', `${recipient} ZIP or foreign postal code`, 'text', 'info', ''),
    box('account', 'Account number (see instructions)', 'text', 'info', ''),
  ];
}

/** One combined payer block (older revisions), with the form's own party words. */
function combinedParties(payerBlock: string, payerTin: string, recipient: string): FormBoxSchema[] {
  return [
    box('payer.block', payerBlock, 'text', 'tool', ''),
    box('payer.tin', payerTin, 'tin', 'info', ''),
    box('recipient.tin', `${recipient} TIN`, 'tin', 'info', ''),
    box('recipient.name', `${recipient} name`, 'text', 'info', ''),
    box('recipient.street', 'Street address (including apt. no.)', 'text', 'info', ''),
    box('recipient.city', 'City or town, state or province, country, and ZIP or foreign postal code', 'text', 'info', ''),
    box('account', 'Account number (see instructions)', 'text', 'info', ''),
  ];
}

const CORRECTED = checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, '');

const MISC_SCHEMA: FormExtractionSchema = {
  formType: '1099-MISC',
  revision: 'December 2026',
  boxes: [
    CORRECTED,
    ...splitParties("PAYER'S", "RECIPIENT'S"),
    checkbox('fatca', 'FATCA filing requirement', 'review', { labelPhrase: 'requirement', direction: 'below' }, ''),
    box('1', 'Rents', 'money', 'tool'),
    box('2', 'Royalties', 'money', 'tool'),
    box('3', 'Other income', 'money', 'tool'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Fishing boat proceeds', 'money', 'review'),
    box('6', 'Medical and health care payments', 'money', 'review'),
    checkbox('7', 'Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 'info', { labelPhrase: 'for resale', direction: 'right' }),
    box('8', 'Substitute payments in lieu of dividends or interest', 'money', 'review'),
    box('9', 'Crop insurance proceeds', 'money', 'review'),
    box('10', 'Gross proceeds paid to an attorney', 'money', 'review'),
    box('11', 'Fish purchased for resale', 'money', 'review'),
    box('12', 'Section 409A deferrals', 'money', 'review'),
    box('13a', 'Cash tips', 'money', 'review'),
    box('13b', 'TTOC', 'code', 'review'),
    box('14', 'Overtime compensation', 'money', 'review'),
    box('15', 'Nonqualified deferred compensation', 'money', 'review'),
    ...stateRows(2, [
      { key: '16', label: 'State tax withheld', kind: 'money', use: 'tool' },
      { key: '17', label: "State/Payer's state no.", kind: 'stateAndId', use: 'tool' },
      { key: '18', label: 'State income', kind: 'money', use: 'info' },
    ]),
  ],
};

const G_SCHEMA: FormExtractionSchema = {
  formType: '1099-G',
  revision: 'December 2026',
  boxes: [
    CORRECTED,
    ...splitParties("PAYER'S", "RECIPIENT'S"),
    box('1', 'Unemployment compensation', 'money', 'tool'),
    box('2', 'State or local income tax refunds, credits, or offsets', 'money', 'review'),
    box('3', 'Box 2 amount is for tax year', 'integer', 'review'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'RTAA payments', 'money', 'review'),
    box('6', 'Taxable grants', 'money', 'review'),
    box('7', 'Agriculture payments', 'money', 'review'),
    checkbox('8', 'If checked, box 2 is trade or business income', 'review', { labelPhrase: 'trade or business', direction: 'right' }),
    box('9', 'Market gain', 'money', 'review'),
    box('10', 'Family leave benefits', 'money', 'review'),
    ...stateRows(2, [
      { key: '11a', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '11b', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '12', label: 'State income tax withheld', kind: 'money', use: 'tool' },
    ]),
  ],
};

const B_SCHEMA: FormExtractionSchema = {
  formType: '1099-B',
  revision: '2026',
  boxes: [
    CORRECTED,
    ...splitParties("PAYER'S", "RECIPIENT'S"),
    box('cusip', 'CUSIP number', 'text', 'info', ''),
    checkbox('fatca', 'FATCA filing requirement', 'review', { labelPhrase: 'requirement', direction: 'right' }, ''),
    box('8949', 'Applicable checkbox on Form 8949', 'code', 'info', ''),
    box('1a', 'Description of property (Example: 100 sh. XYZ Co.)', 'text', 'tool'),
    // "VARIOUS" is a valid acquisition date, so the box is text.
    box('1b', 'Date acquired', 'text', 'tool'),
    box('1c', 'Date sold or disposed', 'date', 'tool'),
    box('1d', 'Proceeds', 'money', 'tool'),
    box('1e', 'Cost or other basis', 'money', 'tool'),
    box('1f', 'Accrued market discount', 'money', 'review'),
    box('1g', 'Wash sale loss disallowed', 'money', 'tool'),
    // Box 2: one of three squares, each at the right end of its label.
    checkbox('2.short', 'Short-term gain or loss', 'tool', { labelPhrase: 'Short-term gain or loss', direction: 'right', sameRow: true }, '2'),
    checkbox('2.long', 'Long-term gain or loss', 'tool', { labelPhrase: 'Long-term gain or loss', direction: 'right', sameRow: true }, '2'),
    checkbox('2.ordinary', 'Ordinary', 'review', { labelPhrase: 'Ordinary', direction: 'right', sameRow: true }, '2'),
    checkbox('3.collectibles', 'If checked, proceeds from: Collectibles', 'tool', { labelPhrase: 'Collectibles', direction: 'right', sameRow: true }, '3'),
    checkbox('3.qof', 'If checked, proceeds from: QOF', 'review', { labelPhrase: 'QOF', direction: 'right', sameRow: true }, '3'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    // The square is right of the label's second line.
    checkbox('5', 'If checked, noncovered security', 'review', { labelPhrase: 'security', direction: 'right' }),
    checkbox('6.gross', 'Reported to IRS: Gross proceeds', 'info', { labelPhrase: 'Gross proceeds', direction: 'right', sameRow: true }, '6'),
    checkbox('6.net', 'Reported to IRS: Net proceeds', 'info', { labelPhrase: 'Net proceeds', direction: 'right', sameRow: true }, '6'),
    checkbox('7', 'If checked, loss is not allowed based on amount in 1d', 'review', { labelPhrase: 'amount in 1d', direction: 'right' }),
    box('8', 'Profit or (loss) realized in 2026 on closed contracts', 'money', 'review'),
    box('9', 'Unrealized profit or (loss) on open contracts—12/31/2025', 'money', 'review'),
    box('10', 'Unrealized profit or (loss) on open contracts—12/31/2026', 'money', 'review'),
    box('11', 'Aggregate profit or (loss) on contracts', 'money', 'review'),
    // The square sits below "basis reported", at the end of the label's second line ("to IRS").
    checkbox('12', 'If checked, basis reported to IRS', 'tool', { labelPhrase: 'basis reported', direction: 'below' }),
    box('13', 'Bartering', 'money', 'review'),
    // The engine keeps no state data for 1099-B; state withholding is reviewed.
    ...stateRows(2, [
      { key: '14', label: 'State name', kind: 'stateCode', use: 'review' },
      { key: '15', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '16', label: 'State tax withheld', kind: 'money', use: 'review' },
    ]),
  ],
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const K_SCHEMA: FormExtractionSchema = {
  formType: '1099-K',
  revision: 'December 2026',
  boxes: [
    CORRECTED,
    ...splitParties("FILER'S", "PAYEE'S"),
    box('pse', "PSE'S name and telephone number", 'text', 'info', ''),
    box('filer.pse', 'Check to indicate if FILER is a (an): Payment settlement entity (PSE)', 'checkbox', 'info', ''),
    box('filer.epf', 'Check to indicate if FILER is a (an): Electronic payment facilitator (EPF)/Other third party', 'checkbox', 'info', ''),
    box('transactions.card', 'Check to indicate transactions reported are: Payment card', 'checkbox', 'info', ''),
    box('transactions.network', 'Check to indicate transactions reported are: Third party network', 'checkbox', 'info', ''),
    box('1a', 'Gross amount of payment card/third party network transactions', 'money', 'tool'),
    box('1b', 'Card Not Present transactions', 'money', 'tool'),
    box('1c', 'Cash tips', 'money', 'review'),
    box('1d', 'TTOC', 'code', 'review'),
    box('2', 'Merchant category code', 'code', 'info'),
    box('3', 'Number of payment transactions', 'integer', 'info'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    ...MONTHS.map((m, i) => box(`5${'abcdefghijkl'[i]}`, m, 'money', 'info')),
    // The engine keeps no state data for 1099-K; state withholding is reviewed.
    ...stateRows(2, [
      { key: '6', label: 'State income tax withheld', kind: 'money', use: 'review' },
      { key: '7', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '8', label: 'State', kind: 'stateCode', use: 'review' },
    ]),
  ],
};

const OID_SCHEMA: FormExtractionSchema = {
  formType: '1099-OID',
  revision: 'January 2024',
  boxes: [
    CORRECTED,
    ...combinedParties(
      "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
      "PAYER'S TIN",
      "RECIPIENT'S",
    ),
    checkbox('fatca', 'FATCA filing requirement', 'review', { labelPhrase: 'requirement', direction: 'below' }, ''),
    box('1', 'Original issue discount for the year', 'money', 'tool'),
    box('2', 'Other periodic interest', 'money', 'tool'),
    box('3', 'Early withdrawal penalty', 'money', 'tool'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Market discount', 'money', 'tool'),
    box('6', 'Acquisition premium', 'money', 'tool'),
    box('7', 'Description', 'text', 'tool'),
    box('8', 'Original issue discount on U.S. Treasury obligations', 'money', 'review'),
    box('9', 'Investment expenses', 'money', 'review'),
    box('10', 'Bond premium', 'money', 'review'),
    box('11', 'Tax-exempt OID', 'money', 'review'),
    ...stateRows(2, [
      { key: '12', label: 'State', kind: 'stateCode', use: 'tool' },
      { key: '13', label: 'State identification no.', kind: 'text', use: 'info' },
      { key: '14', label: 'State tax withheld', kind: 'money', use: 'tool' },
    ]),
  ],
};

const C_SCHEMA: FormExtractionSchema = {
  formType: '1099-C',
  revision: 'April 2025',
  boxes: [
    CORRECTED,
    ...combinedParties(
      "CREDITOR'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
      "CREDITOR'S TIN",
      "DEBTOR'S",
    ),
    box('1', 'Date of identifiable event', 'date', 'tool'),
    box('2', 'Amount of debt discharged', 'money', 'tool'),
    box('3', 'Interest, if included in box 2', 'money', 'tool'),
    box('4', 'Debt description', 'text', 'tool'),
    checkbox('5', 'If checked, the debtor was personally liable for repayment of the debt', 'tool', { labelPhrase: 'personally liable', direction: 'right' }),
    box('6', 'Identifiable event code', 'code', 'tool'),
    box('7', 'Fair market value of property', 'money', 'review'),
  ],
};

const Q_SCHEMA: FormExtractionSchema = {
  formType: '1099-Q',
  revision: 'April 2025',
  boxes: [
    CORRECTED,
    ...combinedParties(
      "PAYER'S/TRUSTEE'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
      "PAYER'S/TRUSTEE'S TIN",
      "RECIPIENT'S",
    ),
    box('1', 'Gross distribution', 'money', 'tool'),
    box('2', 'Earnings', 'money', 'tool'),
    box('3', 'Basis', 'money', 'tool'),
    checkbox('4a', 'Type of transfer: Trustee-to-trustee', 'tool', { labelPhrase: 'Trustee-to-trustee', direction: 'left', sameRow: true }),
    checkbox('4b', 'Type of transfer: QTP to Roth IRA', 'tool', { labelPhrase: 'QTP to Roth IRA', direction: 'left', sameRow: true }),
    checkbox('5a', 'Distribution is from: Private QTP', 'info', { labelPhrase: 'Private QTP', direction: 'left', sameRow: true }),
    checkbox('5b', 'Distribution is from: State QTP', 'info', { labelPhrase: 'State QTP', direction: 'left', sameRow: true }),
    // A Coverdell ESA is taxed under §530, not as a qualified tuition program.
    checkbox('5c', 'Distribution is from: Coverdell ESA', 'review', { labelPhrase: 'Coverdell ESA', direction: 'left', sameRow: true }),
    // The square sits alone in the cell's bottom-right corner, found by the cell.
    checkbox('6', 'Check if the recipient is not the designated beneficiary', 'tool', {
      labelPhrase: 'beneficiary',
      direction: 'right',
      row: { anchors: [{ phrase: 'Check if the recipient', cellOffset: 0 }], count: 1, index: 0 },
    }),
    // When the payer shows fair market value instead of earnings, the recipient figures earnings (Pub. 970).
    box('7', 'If the fair market value (FMV) is shown below, see Pub. 970', 'money', 'review'),
  ],
};

const SA_SCHEMA: FormExtractionSchema = {
  formType: '1099-SA',
  revision: 'April 2025',
  boxes: [
    CORRECTED,
    ...combinedParties(
      "TRUSTEE'S/PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone number",
      "PAYER'S TIN",
      "RECIPIENT'S",
    ),
    box('1', 'Gross distribution', 'money', 'tool'),
    box('2', 'Earnings on excess cont.', 'money', 'review'),
    box('3', 'Distribution code', 'code', 'tool'),
    box('4', 'FMV on date of death', 'money', 'review'),
    // Box 5: one of three stacked squares, each right of its label.
    checkbox('5.hsa', 'HSA', 'tool', { labelPhrase: 'HSA', direction: 'right', sameRow: true }, '5'),
    checkbox('5.archer', 'Archer MSA', 'tool', { labelPhrase: 'Archer', direction: 'right', sameRow: true }, '5'),
    checkbox('5.ma', 'MA MSA', 'tool', { labelPhrase: 'MA', direction: 'right', sameRow: true }, '5'),
  ],
};

const S_SCHEMA: FormExtractionSchema = {
  formType: '1099-S',
  revision: 'December 2026',
  boxes: [
    CORRECTED,
    ...splitParties("FILER'S", "TRANSFEROR'S"),
    box('1', 'Date of closing', 'date', 'tool'),
    box('2a', 'Total gross proceeds', 'money', 'tool'),
    box('2b', 'Cash gross proceeds', 'money', 'info'),
    box('2c', 'Digital asset gross proceeds', 'money', 'review'),
    box('3', 'Address (including city, state, and ZIP code) or legal description', 'text', 'tool'),
    box('4', "Buyer's part of real estate tax", 'money', 'tool'),
    // Boxes 6 and 7 print their squares at the far end of a dotted leader,
    // beyond the page reader's search window: they are read from the model only.
    box('6', 'If checked, transferor received or will receive services or property (other than cash, notes, or digital assets) as part of the consideration', 'checkbox', 'review'),
    box('7', 'If checked, transferor is a foreign person (nonresident alien, foreign partnership, foreign estate, or foreign trust)', 'checkbox', 'tool'),
    box('8a', 'Code for digital asset received, or to be received, as consideration', 'code', 'review'),
    box('8b', 'Name of digital asset received, or to be received, as consideration', 'text', 'review'),
    box('8c', 'Number of digital asset units received, or to be received, as consideration', 'text', 'review'),
    box('8d', 'Date digital asset received, or to be received, as consideration', 'date', 'review'),
  ],
};

/** One W-2c box printed twice: as previously reported, and as corrected. */
function correctedPair(key: string, label: string, kind: BoxValueKind, use: BoxUse): FormBoxSchema[] {
  return [
    box(`${key}.prev`, `${label} (previously reported)`, kind, use, key.split('.')[0]),
    box(`${key}.correct`, `${label} (correct information)`, kind, use, key.split('.')[0]),
  ];
}

/**
 * Form W-2c (Rev. January 2026), Copy B. Only corrected boxes are printed;
 * each shows the previously reported and the correct amount side by side.
 */
const W2C_SCHEMA: FormExtractionSchema = {
  formType: 'W-2C',
  revision: 'January 2026',
  boxes: [
    box('a', "Employer's name, address, and ZIP code", 'text', 'tool'),
    box('b', 'Employer identification number (EIN)', 'tin', 'tool'),
    box('c', 'Tax year/Form corrected', 'integer', 'tool'),
    box('d', "Employee's correct SSN", 'tin', 'info'),
    box('e', 'Corrected SSN and/or name', 'checkbox', 'tool'),
    box('f', "Employee's previously reported SSN", 'tin', 'info'),
    box('g', "Employee's previously reported name", 'text', 'info'),
    box('h', "Employee's first name and initial, Last name, Suff.", 'text', 'info'),
    box('i', "Employee's address and ZIP code", 'text', 'info'),
    ...correctedPair('1', 'Wages, tips, other compensation', 'money', 'tool'),
    ...correctedPair('2', 'Federal income tax withheld', 'money', 'tool'),
    ...correctedPair('3', 'Social security wages', 'money', 'tool'),
    ...correctedPair('4', 'Social security tax withheld', 'money', 'tool'),
    ...correctedPair('5', 'Medicare wages and tips', 'money', 'tool'),
    ...correctedPair('6', 'Medicare tax withheld', 'money', 'tool'),
    ...correctedPair('7', 'Social security tips', 'money', 'review'),
    ...correctedPair('8', 'Allocated tips', 'money', 'review'),
    ...correctedPair('10', 'Dependent care benefits', 'money', 'review'),
    ...correctedPair('11', 'Nonqualified plans', 'money', 'review'),
    ...['12a', '12b', '12c', '12d'].flatMap((slot) => [
      ...correctedPair(`${slot}.code`, `Box ${slot} code`, 'code', 'review'),
      ...correctedPair(`${slot}.amount`, `Box ${slot} amount`, 'money', 'review'),
    ]),
    ...correctedPair('13.statutory', 'Statutory employee', 'checkbox', 'review'),
    ...correctedPair('13.retirement', 'Retirement plan', 'checkbox', 'review'),
    ...correctedPair('13.sickPay', 'Third-party sick pay', 'checkbox', 'review'),
    ...correctedPair('14a', 'Other (see instructions)', 'text', 'review'),
    ...correctedPair('14b', 'Treasury Tipped Occupation Code(s)', 'code', 'review'),
    // State correction information: two rows; only the first feeds the tool.
    ...[1, 2].flatMap((row) => {
      const use: BoxUse = row === 1 ? 'tool' : 'review';
      return [
        ...correctedPair(`15.state.${row}`, `State (line ${row})`, 'stateCode', use),
        ...correctedPair(`15.id.${row}`, `Employer's state ID number (line ${row})`, 'text', 'info'),
        ...correctedPair(`16.${row}`, `State wages, tips, etc. (line ${row})`, 'money', use),
        ...correctedPair(`17.${row}`, `State income tax (line ${row})`, 'money', use),
        ...correctedPair(`18.${row}`, `Local wages, tips, etc. (line ${row})`, 'money', use),
        ...correctedPair(`19.${row}`, `Local income tax (line ${row})`, 'money', use),
        ...correctedPair(`20.${row}`, `Locality name (line ${row})`, 'text', use),
      ];
    }),
  ],
};

/**
 * Form W-2G (Rev. January 2026), Copy B. Labels are taken from the printed
 * page, so box 1 reads "Reportable winnings" rather than the older "Gross
 * winnings", and "Type of wager" is box 3. The winner's TIN is printed in the
 * numbered box 9, not in the address block, so it is keyed by its box.
 */
const W2G_SCHEMA: FormExtractionSchema = {
  formType: 'W-2G',
  revision: 'January 2026',
  boxes: [
    CORRECTED,
    box('payer.name', "PAYER'S name", 'text', 'tool', ''),
    box('payer.street', "PAYER'S street address", 'text', 'info', ''),
    box('payer.suite', "PAYER'S room or suite no.", 'text', 'info', ''),
    box('payer.city', "PAYER'S city or town", 'text', 'info', ''),
    box('payer.state', "PAYER'S state or province", 'text', 'info', ''),
    box('payer.country', "PAYER'S country", 'text', 'info', ''),
    box('payer.zip', "PAYER'S ZIP or foreign postal code", 'text', 'info', ''),
    box('payer.tin', "PAYER'S TIN", 'tin', 'info', ''),
    box('payer.phone', "PAYER'S telephone no.", 'text', 'info', ''),
    box('9', "WINNER'S TIN", 'tin', 'info'),
    box('winner.name', "WINNER'S name", 'text', 'info', ''),
    box('winner.street', "WINNER'S street address", 'text', 'info', ''),
    box('winner.apt', "WINNER'S apt. no.", 'text', 'info', ''),
    box('winner.city', "WINNER'S city or town", 'text', 'info', ''),
    box('winner.state', "WINNER'S state or province", 'text', 'info', ''),
    box('winner.country', "WINNER'S country", 'text', 'info', ''),
    box('winner.zip', "WINNER'S ZIP or foreign postal code", 'text', 'info', ''),
    box('1', 'Reportable winnings', 'money', 'tool'),
    box('2', 'Date won', 'date', 'review'),
    box('3', 'Type of wager', 'text', 'tool'),
    box('4', 'Federal income tax withheld', 'money', 'tool'),
    box('5', 'Transaction', 'text', 'review'),
    box('6', 'Race', 'text', 'review'),
    box('7', 'Winnings from identical wagers', 'money', 'review'),
    box('8', 'Cashier', 'text', 'info'),
    box('10', 'Window', 'text', 'info'),
    box('11', 'First identification no.', 'text', 'review'),
    box('12', 'Second identification no.', 'text', 'review'),
    box('13', "State/Payer's state identification no.", 'stateAndId', 'tool'),
    box('14', 'State winnings', 'money', 'review'),
    box('15', 'State income tax withheld', 'money', 'tool'),
    box('16', 'Local winnings', 'money', 'review'),
    box('17', 'Local income tax withheld', 'money', 'review'),
    box('18', 'Name of locality', 'text', 'review'),
  ],
};

/**
 * Form 1098-E (Rev. 2026), Copy B for Borrower. The form prints only boxes 1
 * and 2. Box 2 is the one that matters: when it is checked, box 1 excludes loan
 * origination fees and capitalized interest on pre-2004 loans, so box 1 on its
 * own is not the deductible amount and the Deduction Worksheet decides it.
 */
const SLI_SCHEMA: FormExtractionSchema = {
  formType: '1098-E',
  revision: '2026',
  boxes: [
    CORRECTED,
    box('lender.block', "RECIPIENT'S/LENDER'S name, street address, room/suite no., city/town, state/province, country, ZIP/foreign code, and telephone number", 'text', 'tool', ''),
    box('lender.tin', "RECIPIENT'S TIN", 'tin', 'info', ''),
    box('borrower.tin', "BORROWER'S TIN", 'tin', 'info', ''),
    box('borrower.name', "BORROWER'S name", 'text', 'info', ''),
    box('borrower.street', "BORROWER'S street address and apt. no.", 'text', 'info', ''),
    box('borrower.city', "BORROWER'S city/town, state/province, country, and ZIP/foreign code", 'text', 'info', ''),
    box('account', 'Account number (see instructions)', 'text', 'info', ''),
    box('1', 'Student loan interest received by lender', 'money', 'tool'),
    checkbox('2', 'If checked, box 1 does not include loan origination fees and/or capitalized interest for loans made before September 1, 2004', 'tool', { labelPhrase: 'does', direction: 'below' }),
  ],
};

/**
 * Schedule K-1 (Form 1065), 2025, the partner's copy: Part I about the
 * partnership and partner, Part II the income and deductions, Part III the
 * self-employment figure and what follows.
 *
 * Only the boxes that stand on their own are marked `tool`. Boxes 13 and 15 are
 * one undivided number each on this page; what they are made of is carried by
 * codes printed elsewhere (box 20's letters and the Schedule K-1 supplement), so
 * splitting them here would be inventing a breakdown. They go to review with the
 * amount the form prints. Boxes 9b and 9c are rate- and entity-dependent and go
 * to review for the same reason.
 */
const K1_SCHEMA: FormExtractionSchema = {
  formType: 'K-1',
  revision: '2025',
  boxes: [
    box('year.beginning', 'For calendar year, or tax year beginning', 'text', 'review', ''),
    box('year.ending', 'tax year ending', 'text', 'review', ''),
    box('a', "Partnership's employer identification number", 'tin', 'tool'),
    box('b', "Partnership's name, address, city, state, and ZIP code", 'text', 'tool'),
    box('c', 'IRS center where partnership filed return', 'text', 'info'),
    checkbox('d', 'Check if this is a publicly traded partnership (PTP)', 'info', { labelPhrase: 'publicly traded partnership', direction: 'right' }),
    box('e', "Partner's SSN or TIN (Do not use TIN of a disregarded entity)", 'tin', 'info'),
    box('f', 'Name, address, city, state, and ZIP code for partner entered in E', 'text', 'info'),
    checkbox('g.general', 'General partner or LLC member-manager', 'info', { labelPhrase: 'General partner', direction: 'above' }),
    checkbox('g.limited', 'Limited partner or other LLC member', 'info', { labelPhrase: 'Limited partner', direction: 'above' }),
    checkbox('h1.domestic', 'Domestic partner', 'info', { labelPhrase: 'Domestic partner', direction: 'above' }),
    checkbox('h1.foreign', 'Foreign partner', 'info', { labelPhrase: 'Foreign partner', direction: 'above' }),
    box('h2.tin', "If the partner is a disregarded entity (DE), enter the partner's TIN", 'tin', 'review'),
    box('h2.name', "If the partner is a disregarded entity (DE), enter the partner's name", 'text', 'review'),
    box('h2.entityType', 'What type of entity is this partner?', 'text', 'review'),
    checkbox('i1', 'If this partner is a retirement plan (IRA/SEP/Keogh/etc.), check here', 'info', { labelPhrase: 'retirement plan', direction: 'right' }),
    box('j.profit.beginning', "Partner's share of profit, beginning percentage", 'percent', 'review'),
    box('j.profit.ending', "Partner's share of profit, ending percentage", 'percent', 'review'),
    box('j.loss.beginning', "Partner's share of loss, beginning percentage", 'percent', 'review'),
    box('j.loss.ending', "Partner's share of loss, ending percentage", 'percent', 'review'),
    box('j.capital.beginning', "Partner's share of capital, beginning percentage", 'percent', 'review'),
    box('j.capital.ending', "Partner's share of capital, ending percentage", 'percent', 'review'),
    box('k1.nonrecourse.beginning', "Partner's share of liabilities, nonrecourse, beginning", 'money', 'review'),
    box('k1.nonrecourse.ending', "Partner's share of liabilities, nonrecourse, ending", 'money', 'review'),
    box('k1.qualifiedNonrecourse.beginning', "Partner's share of liabilities, qualified nonrecourse financing, beginning", 'money', 'review'),
    box('k1.qualifiedNonrecourse.ending', "Partner's share of liabilities, qualified nonrecourse financing, ending", 'money', 'review'),
    box('k1.recourse.beginning', "Partner's share of liabilities, recourse, beginning", 'money', 'review'),
    box('k1.recourse.ending', "Partner's share of liabilities, recourse, ending", 'money', 'review'),
    checkbox('k2', 'Item K1 includes liability amounts from lower-tier partnerships', 'review', { labelPhrase: 'lower-tier', direction: 'right' }),
    checkbox('k3', 'Any of the above liability is subject to guarantees or other payment obligations by the partner', 'review', { labelPhrase: 'guarantees', direction: 'right' }),
    box('l.beginning', "Partner's capital account, beginning capital account", 'money', 'review'),
    box('l.contributed', 'Capital contributed during the year', 'money', 'review'),
    box('l.netIncome', 'Current year net income (loss)', 'money', 'review'),
    box('l.other', 'Other increase (decrease) (attach explanation)', 'money', 'review'),
    box('l.withdrawals', 'Withdrawals and distributions', 'money', 'review'),
    box('l.ending', 'Ending capital account', 'money', 'review'),
    checkbox('m', 'The partner contributed property with a built-in gain (loss)', 'review', { labelPhrase: 'built-in gain', direction: 'right' }),
    box('n.beginning', "Partner's share of net unrecognized section 704(c) gain (loss), beginning", 'money', 'review'),
    box('n.ending', "Partner's share of net unrecognized section 704(c) gain (loss), ending", 'money', 'review'),
    box('1', 'Ordinary business income (loss)', 'money', 'tool'),
    box('2', 'Net rental real estate income (loss)', 'money', 'tool'),
    box('3', 'Other net rental income (loss)', 'money', 'review'),
    box('4a', 'Guaranteed payments for services', 'money', 'review'),
    box('4b', 'Guaranteed payments for capital', 'money', 'review'),
    box('4c', 'Total guaranteed payments', 'money', 'tool'),
    box('5', 'Interest income', 'money', 'tool'),
    box('6a', 'Ordinary dividends', 'money', 'tool'),
    box('6b', 'Qualified dividends', 'money', 'tool'),
    box('6c', 'Dividend equivalents', 'money', 'review'),
    box('7', 'Royalties', 'money', 'tool'),
    box('8', 'Net short-term capital gain (loss)', 'money', 'tool'),
    box('9a', 'Net long-term capital gain (loss)', 'money', 'tool'),
    box('9b', 'Collectibles (28%) gain (loss)', 'money', 'review'),
    box('9c', 'Unrecaptured section 1250 gain', 'money', 'review'),
    box('10', 'Net section 1231 gain (loss)', 'money', 'tool'),
    box('11', 'Other income (loss)', 'money', 'tool'),
    box('12', 'Section 179 deduction', 'money', 'tool'),
    box('13', 'Other deductions', 'money', 'review'),
    box('14', 'Self-employment earnings (loss)', 'money', 'tool'),
    box('15', 'Credits', 'money', 'review'),
    checkbox('16', 'Schedule K-3 is attached if checked', 'review', { labelPhrase: 'K-3', direction: 'above' }),
    box('17', 'Alternative minimum tax (AMT) items', 'money', 'review'),
    box('18', 'Tax-exempt income and nondeductible expenses', 'money', 'review'),
    box('19', 'Distributions', 'money', 'review'),
    box('20', 'Other information', 'text', 'review'),
    box('21', 'Foreign taxes paid or accrued', 'money', 'review'),
    checkbox('22', 'More than one activity for at-risk purposes', 'review', { labelPhrase: 'at-risk', direction: 'above' }),
    checkbox('23', 'More than one activity for passive activity purposes', 'review', { labelPhrase: 'passive activity', direction: 'above' }),
  ],
};

/** One Part II row: a covered individual, columns A-E as the form prints them. */
function coveredIndividual(row: number): FormBoxSchema[] {
  const line = String(15 + row);
  return [
    box(`${line}.a`, `Covered individual name (line ${line})`, 'text', 'review', `${line}a`),
    box(`${line}.b`, `Covered individual SSN (line ${line})`, 'tin', 'review', `${line}b`),
    box(`${line}.c`, `Covered individual date of birth (line ${line})`, 'date', 'review', `${line}c`),
    box(`${line}.d`, `Coverage start date (line ${line})`, 'date', 'review', `${line}d`),
    box(`${line}.e`, `Coverage termination date (line ${line})`, 'date', 'review', `${line}e`),
  ];
}

/** One Part III row: a month, columns A-C as the form prints them. */
function coverageMonth(line: number, month: string): FormBoxSchema[] {
  return [
    // The month is a printed row label, not a box number, so it prints as none.
  box(`${line}.month`, `${month} (line ${line})`, 'text', 'info', ''),
    box(`${line}.a`, `Monthly enrollment premiums, ${month}`, 'money', 'review', `${line}a`),
    box(`${line}.b`, `Monthly second lowest cost silver plan (SLCSP) premium, ${month}`, 'money', 'review', `${line}b`),
    box(`${line}.c`, `Monthly advance payment of premium tax credit, ${month}`, 'money', 'review', `${line}c`),
  ];
}

/**
 * Form 1095-A (2025), the Marketplace's statement to the recipient.
 *
 * Nothing here is written to the return. The advance premium tax credit in
 * column C drives Form 8962 and is the largest consequential number a
 * Marketplace statement carries, and the engine's own note records that it
 * circles with Form 7206 (self-employment health insurance versus the credit).
 * So the statement is read and recorded as facts, and the credit decision is
 * left to the preparer rather than taken from column C automatically.
 */
const PTC_SCHEMA: FormExtractionSchema = {
  formType: '1095-A',
  revision: '2025',
  boxes: [
    checkbox('void', 'VOID box', 'review', { labelPhrase: 'VOID', direction: 'right' }, ''),
    checkbox('corrected', 'CORRECTED (if checked)', 'review', { labelPhrase: 'CORRECTED', direction: 'left' }, ''),
    box('1', 'Marketplace identifier', 'text', 'tool'),
    box('2', 'Marketplace-assigned policy number', 'text', 'tool'),
    box('3', "Policy issuer's name", 'text', 'tool'),
    box('4', "Recipient's name", 'text', 'tool'),
    box('5', "Recipient's SSN", 'tin', 'tool'),
    box('6', "Recipient's date of birth", 'date', 'review'),
    box('7', "Recipient's spouse's name", 'text', 'review'),
    box('8', "Recipient's spouse's SSN", 'tin', 'review'),
    box('9', "Recipient's spouse's date of birth", 'date', 'review'),
    box('10', 'Policy start date', 'date', 'review'),
    box('11', 'Policy termination date', 'date', 'review'),
    box('12', 'Street address (including apartment no.)', 'text', 'info'),
    box('13', 'City or town', 'text', 'info'),
    box('14', 'State or province', 'text', 'info'),
    box('15', 'Country and ZIP or foreign postal code', 'text', 'info'),
    ...[1, 2, 3, 4, 5].flatMap(coveredIndividual),
    ...[
      [21, 'January'], [22, 'February'], [23, 'March'], [24, 'April'], [25, 'May'], [26, 'June'],
      [27, 'July'], [28, 'August'], [29, 'September'], [30, 'October'], [31, 'November'], [32, 'December'],
    ].flatMap(([line, month]) => coverageMonth(line as number, month as string)),
    box('33.a', 'Annual enrollment premiums, total', 'money', 'tool', '33a'),
    box('33.b', 'Annual second lowest cost silver plan (SLCSP) premium, total', 'money', 'tool', '33b'),
    box('33.c', 'Annual advance payment of premium tax credit, total', 'money', 'review', '33c'),
  ],
};

export const FORM_EXTRACTION_SCHEMAS: Partial<Record<ClassifiableFormType, FormExtractionSchema>> = {
  'W-2': W2_SCHEMA,
  '1099-INT': INT_SCHEMA,
  '1099-DIV': DIV_SCHEMA,
  '1099-NEC': NEC_SCHEMA,
  '1099-R': R_SCHEMA,
  'SSA-1099': SSA_SCHEMA,
  '1098': MORTGAGE_SCHEMA,
  '1098-T': TUITION_SCHEMA,
  '1099-MISC': MISC_SCHEMA,
  '1099-G': G_SCHEMA,
  '1099-B': B_SCHEMA,
  '1099-K': K_SCHEMA,
  '1099-OID': OID_SCHEMA,
  '1099-C': C_SCHEMA,
  '1099-Q': Q_SCHEMA,
  '1099-SA': SA_SCHEMA,
  '1099-S': S_SCHEMA,
  'W-2C': W2C_SCHEMA,
  'W-2G': W2G_SCHEMA,
  '1098-E': SLI_SCHEMA,
  'K-1': K1_SCHEMA,
  '1095-A': PTC_SCHEMA,
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
  tool: DocumentToolName | null;
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
  /** The box keys each tool field was read from (for source location and second readings). */
  sourceKeys: Record<string, string[]>;
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

/**
 * The first line of a name-and-address block. A comma closing the line is the
 * separator before the next line (models write the block as one sentence), never
 * part of the name.
 */
function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]!.trim().replace(/\s*,+$/, '');
}

/**
 * How one form's boxes feed its tax tool. Everything is data so each form's
 * mapping can be reviewed against its printed layout in one place.
 */
interface ToolMappingSpec {
  tool: DocumentToolName;
  /** Box key → tool field, copied as printed text. */
  direct: Record<string, string>;
  /** Name field: first line of the first present key. */
  name?: { keys: readonly string[]; field: string };
  /** State code (first state row only). */
  state?: { key: string; field: string };
  /** Checkbox box key → boolean tool field. Ambiguous checkboxes go to review. */
  checkboxes?: Record<string, string>;
  /**
   * A group of squares where exactly one is checked (1099-B box 2 term,
   * 1099-SA box 5 account): the checked square's value. None read leaves the
   * field unknown; two checked, or an unreadable square, goes to review.
   */
  choice?: { field: string; options: Record<string, string | boolean> };
  /** W-2 box 12 entries and box 13 checkboxes. */
  w2?: true;
  /** Further state-code cells (W-2c: the previously reported and the correct state). */
  moreStates?: ReadonlyArray<{ key: string; field: string }>;
  /** A four-digit year printed in a text cell (W-2c box c, "2025 / W-2"). */
  year?: { key: string; field: string };
  /**
   * A K-1: the entity kind comes from the form number printed on the page, not
   * from a box, because it decides self-employment treatment.
   */
  entity?: true;
}

/** What the page itself says about a form, beyond the boxes it prints. */
export interface ToolMappingContext {
  /**
   * Markers the classifier matched on the printed page (the form number or
   * title). Only read for forms whose entity kind is printed rather than boxed.
   */
  matchedMarkers?: readonly string[];
}

/**
 * The entity kind a Schedule K-1's printed form number establishes.
 *
 * Form 1065 is a partnership and Form 1120-S an S corporation, and the engine
 * relies on the difference. Form 1041 covers estates *and* trusts and the page
 * does not say which, and the engine codes any non-partnership as an S
 * corporation on Schedule E - so guessing here would file a trust's income as a
 * corporation's. Left unknown instead, which holds the form for the preparer
 * (FED.K1.ENTITY_TYPE).
 */
function entityTypeFromMarkers(markers: readonly string[] | undefined): string | undefined {
  if (!markers) return undefined;
  const text = markers.join(' ').toLowerCase();
  if (/1120-?s/.test(text)) return 's_corp';
  if (/form\s*1065|\b1065\b/.test(text)) return 'partnership';
  return undefined;
}

export const TOOL_MAPPINGS: Partial<Record<ClassifiableFormType, ToolMappingSpec>> = {
  'W-2': {
    tool: 'add_w2',
    direct: {
      b: 'employerEin',
      '1': 'wages',
      '2': 'federalTaxWithheld',
      '3': 'socialSecurityWages',
      '4': 'socialSecurityTax',
      '5': 'medicareWages',
      '6': 'medicareTax',
      '16.1': 'stateWages',
      '17.1': 'stateTaxWithheld',
      '18.1': 'localWages',
      '19.1': 'localTaxWithheld',
      '20.1': 'localityName',
    },
    name: { keys: ['c'], field: 'employerName' },
    state: { key: '15.state.1', field: 'state' },
    w2: true,
  },
  '1099-INT': {
    tool: 'add_1099_int',
    direct: {
      '1': 'amount',
      '2': 'earlyWithdrawalPenalty',
      '3': 'usBondInterest',
      '4': 'federalTaxWithheld',
      '8': 'taxExemptInterest',
      '17.1': 'stateTaxWithheld',
    },
    name: { keys: ['payer.block'], field: 'payerName' },
    state: { key: '15.1', field: 'stateCode' },
  },
  '1099-DIV': {
    tool: 'add_1099_div',
    direct: {
      '1a': 'ordinaryDividends',
      '1b': 'qualifiedDividends',
      '2a': 'capitalGainDistributions',
      '2b': 'unrecapturedSection1250Gain',
      '2d': 'collectiblesGain',
      '4': 'federalTaxWithheld',
      '7': 'foreignTaxPaid',
      '16.1': 'stateTaxWithheld',
    },
    name: { keys: ['payer.block'], field: 'payerName' },
    state: { key: '14.1', field: 'stateCode' },
  },
  '1099-NEC': {
    tool: 'add_1099_nec',
    direct: {
      'payer.tin': 'payerEin',
      '1a': 'amount',
      '4': 'federalTaxWithheld',
      '5.1': 'stateTaxWithheld',
    },
    name: { keys: ['payer.name', 'payer.block'], field: 'payerName' },
    state: { key: '6.1', field: 'stateCode' },
  },
  '1099-R': {
    tool: 'add_1099_r',
    direct: {
      '1': 'grossDistribution',
      '2a': 'taxableAmount',
      '4': 'federalTaxWithheld',
      '7a': 'distributionCode',
      '14.1': 'stateTaxWithheld',
    },
    name: { keys: ['payer.name', 'payer.block'], field: 'payerName' },
    state: { key: '15.1', field: 'stateCode' },
    checkboxes: { '7b': 'isIRA' },
  },
  'SSA-1099': {
    tool: 'add_ssa_1099',
    direct: {
      '3': 'benefitsPaid',
      '4': 'benefitsRepaid',
      '5': 'netBenefits',
      '6': 'federalTaxWithheld',
    },
    name: { keys: ['1'], field: 'beneficiaryName' },
  },
  '1098': {
    tool: 'add_mortgage_interest',
    direct: {
      'lender.tin': 'lenderTin',
      '1': 'mortgageInterest',
      '2': 'outstandingPrincipal',
      '3': 'originationDate',
      '4': 'refundOfOverpaidInterest',
      '5': 'mortgageInsurancePremiums',
      '6': 'points',
      '8': 'propertyAddress',
      '9': 'numberOfProperties',
      '11': 'acquisitionDate',
    },
    name: { keys: ['lender.block'], field: 'lenderName' },
    checkboxes: { '7': 'propertyAddressSameAsBorrower' },
  },
  '1099-MISC': {
    tool: 'add_1099_misc',
    direct: { '1': 'rents', '2': 'royalties', '3': 'otherIncome', '4': 'federalTaxWithheld', '16.1': 'stateTaxWithheld' },
    name: { keys: ['payer.name'], field: 'payerName' },
    state: { key: '17.1', field: 'stateCode' },
  },
  '1099-G': {
    tool: 'add_1099_g',
    direct: { '1': 'unemploymentCompensation', '4': 'federalTaxWithheld', '12.1': 'stateTaxWithheld' },
    name: { keys: ['payer.name'], field: 'payerName' },
    state: { key: '11a.1', field: 'stateCode' },
  },
  '1099-B': {
    tool: 'add_1099_b',
    direct: {
      '1a': 'description',
      '1b': 'dateAcquired',
      '1c': 'dateSold',
      '1d': 'proceeds',
      '1e': 'costBasis',
      '1g': 'washSaleLossDisallowed',
      '4': 'federalTaxWithheld',
    },
    name: { keys: ['payer.name'], field: 'brokerName' },
    checkboxes: { '3.collectibles': 'isCollectible', '12': 'basisReportedToIRS' },
    choice: { field: 'isLongTerm', options: { '2.short': false, '2.long': true } },
  },
  '1099-K': {
    tool: 'add_1099_k',
    direct: { '1a': 'grossAmount', '1b': 'cardNotPresent', '4': 'federalTaxWithheld' },
    name: { keys: ['payer.name'], field: 'platformName' },
  },
  '1099-OID': {
    tool: 'add_1099_oid',
    direct: {
      '1': 'originalIssueDiscount',
      '2': 'otherPeriodicInterest',
      '3': 'earlyWithdrawalPenalty',
      '4': 'federalTaxWithheld',
      '5': 'marketDiscount',
      '6': 'acquisitionPremium',
      '7': 'description',
      '14.1': 'stateTaxWithheld',
    },
    name: { keys: ['payer.block'], field: 'payerName' },
    state: { key: '12.1', field: 'stateCode' },
  },
  '1099-C': {
    tool: 'add_1099_c',
    direct: { '1': 'dateOfCancellation', '2': 'amountCancelled', '3': 'interestIncluded', '4': 'debtDescription', '6': 'identifiableEventCode' },
    name: { keys: ['payer.block'], field: 'payerName' },
    checkboxes: { '5': 'personallyLiable' },
  },
  '1099-Q': {
    tool: 'add_1099_q',
    direct: { '1': 'grossDistribution', '2': 'earnings', '3': 'basisReturn' },
    name: { keys: ['payer.block'], field: 'payerName' },
    checkboxes: { '4a': 'trusteeToTrusteeTransfer', '4b': 'qtpToRothIra', '6': 'recipientNotDesignatedBeneficiary' },
  },
  '1099-SA': {
    tool: 'add_1099_sa',
    direct: { '1': 'grossDistribution', '3': 'distributionCode' },
    name: { keys: ['payer.block'], field: 'payerName' },
    choice: { field: 'accountType', options: { '5.hsa': 'HSA', '5.archer': 'Archer MSA', '5.ma': 'MA MSA' } },
  },
  '1099-S': {
    tool: 'add_1099_s',
    direct: { '1': 'closingDate', '2a': 'grossProceeds', '3': 'propertyAddress', '4': 'buyerRealEstateTax' },
    name: { keys: ['payer.name'], field: 'filerName' },
    checkboxes: { '7': 'transferorIsForeign' },
  },
  'W-2C': {
    tool: 'add_w2c',
    direct: {
      b: 'employerEin',
      '1.prev': 'previousWages', '1.correct': 'correctWages',
      '2.prev': 'previousFederalTaxWithheld', '2.correct': 'correctFederalTaxWithheld',
      '3.prev': 'previousSocialSecurityWages', '3.correct': 'correctSocialSecurityWages',
      '4.prev': 'previousSocialSecurityTax', '4.correct': 'correctSocialSecurityTax',
      '5.prev': 'previousMedicareWages', '5.correct': 'correctMedicareWages',
      '6.prev': 'previousMedicareTax', '6.correct': 'correctMedicareTax',
      '16.1.prev': 'previousStateWages', '16.1.correct': 'correctStateWages',
      '17.1.prev': 'previousStateTaxWithheld', '17.1.correct': 'correctStateTaxWithheld',
      '18.1.prev': 'previousLocalWages', '18.1.correct': 'correctLocalWages',
      '19.1.prev': 'previousLocalTaxWithheld', '19.1.correct': 'correctLocalTaxWithheld',
      '20.1.prev': 'previousLocalityName', '20.1.correct': 'correctLocalityName',
    },
    name: { keys: ['a'], field: 'employerName' },
    moreStates: [{ key: '15.state.1.prev', field: 'previousState' }, { key: '15.state.1.correct', field: 'correctState' }],
    year: { key: 'c', field: 'taxYearCorrected' },
    checkboxes: { e: 'correctsSsnOrName' },
  },
  'W-2G': {
    tool: 'add_w2g',
    direct: {
      '1': 'grossWinnings',
      '3': 'typeOfWager',
      '4': 'federalTaxWithheld',
      '15': 'stateTaxWithheld',
    },
    name: { keys: ['payer.name'], field: 'payerName' },
    // Box 13 prints the state and the payer's state ID in one cell; only the
    // two-letter code is an argument.
    state: { key: '13', field: 'stateCode' },
  },
  '1098-E': {
    tool: 'add_1098_e',
    direct: { '1': 'studentLoanInterest' },
    name: { keys: ['lender.block'], field: 'lenderName' },
    checkboxes: { '2': 'originationFeesExcluded' },
  },
  'K-1': {
    tool: 'add_k1',
    direct: {
      a: 'entityEin',
      '1': 'ordinaryBusinessIncome',
      '2': 'rentalIncome',
      '4c': 'guaranteedPayments',
      '5': 'interestIncome',
      '6a': 'ordinaryDividends',
      '6b': 'qualifiedDividends',
      '7': 'royalties',
      '8': 'shortTermCapitalGain',
      '9a': 'longTermCapitalGain',
      '10': 'netSection1231Gain',
      '11': 'otherIncome',
      '12': 'section179Deduction',
      '14': 'selfEmploymentIncome',
    },
    name: { keys: ['b'], field: 'entityName' },
    entity: true,
  },
  '1095-A': {
    tool: 'add_1095_a',
    direct: {
      '1': 'marketplaceIdentifier',
      '2': 'policyNumber',
      '3': 'policyIssuerName',
      '4': 'recipientName',
      '5': 'recipientSsn',
      '33.a': 'annualEnrollmentPremiums',
      '33.b': 'annualSLCSPPremium',
    },
  },
  '1098-T': {
    tool: 'add_education_expense',
    direct: {
      'filer.ein': 'institutionEin',
      'student.name': 'studentName',
      '1': 'tuitionPaid',
      '4': 'priorYearAdjustments',
      '5': 'scholarships',
      '6': 'scholarshipAdjustments',
      '10': 'insuranceReimbursement',
    },
    name: { keys: ['filer.name'], field: 'institutionName' },
    checkboxes: { '7': 'includesNextPeriod', '8': 'halfTimeStudent', '9': 'graduateStudent' },
  },
};

/** The tool a classified form feeds, when one exists. */
export function toolForForm(formType: ClassifiableFormType | null | undefined): DocumentToolName | null {
  return formType ? TOOL_MAPPINGS[formType]?.tool ?? null : null;
}

/**
 * Deterministic mapping from transcribed box text to tax-tool inputs.
 * Never invents a value: blank boxes are absent, unreadable ones are left for
 * extractStructuredFields to mark unknown, and unsupported filled boxes are
 * returned as review items instead of being dropped.
 */
export function mapBoxesToTool(
  schema: FormExtractionSchema,
  values: Record<string, string>,
  context?: ToolMappingContext,
): ToolMapping {
  const spec = TOOL_MAPPINGS[schema.formType];
  const tool = spec?.tool ?? null;
  const bag: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};
  const reviewBoxes: ToolMapping['reviewBoxes'] = [];
  const boxByKey = new Map(schema.boxes.map((b) => [b.key, b]));

  const sourceKeys: Record<string, string[]> = {};
  const put = (field: string, value: unknown, raw: string, keys: string[]) => {
    bag[field] = value;
    rawText[field] = raw;
    sourceKeys[field] = keys;
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
  if (!spec || !tool) return { tool, bag, rawText, reviewBoxes, sourceKeys };

  for (const [key, field] of Object.entries(spec.direct)) {
    const text = values[key];
    if (text !== undefined) put(field, text, text, [key]);
  }

  if (spec.name) {
    const key = spec.name.keys.find((k) => values[k] !== undefined);
    if (key) put(spec.name.field, firstLine(values[key]!), values[key]!, [key]);
  }

  if (spec.state && values[spec.state.key] !== undefined) {
    const stateText = values[spec.state.key]!;
    // An unreadable state cell stays unknown (undefined), never a guessed code.
    put(spec.state.field, stateCodeFromCell(stateText), stateText, [spec.state.key]);
  }

  for (const [key, field] of Object.entries(spec.checkboxes ?? {})) {
    const text = values[key];
    if (text === undefined) continue;
    const state = checkboxState(text);
    if (state === undefined) {
      reviewBoxes.push({ key, label: boxByKey.get(key)!.label, text });
    } else {
      put(field, state, text, [key]);
    }
  }

  for (const cell of spec.moreStates ?? []) {
    const text = values[cell.key];
    if (text !== undefined) put(cell.field, stateCodeFromCell(text), text, [cell.key]);
  }

  if (spec.entity) {
    // The kind is printed as the form number, not in a box, so it has no box key
    // to cite. An unreadable form number leaves the field absent rather than
    // defaulting to partnership, which holds the form (FED.K1.ENTITY_TYPE).
    const markers = context?.matchedMarkers ?? [];
    const kind = entityTypeFromMarkers(markers);
    if (kind !== undefined) put('entityType', kind, markers.join('; '), []);
  }

  if (spec.year && values[spec.year.key] !== undefined) {
    const text = values[spec.year.key]!;
    const year = /\b(20\d\d)\b/.exec(text)?.[1];
    // A cell with no year stays unknown, never a guessed year.
    put(spec.year.field, year !== undefined ? year : undefined, text, [spec.year.key]);
  }

  if (spec.choice) {
    const read = Object.keys(spec.choice.options)
      .filter((key) => values[key] !== undefined)
      .map((key) => ({ key, text: values[key]!, state: checkboxState(values[key]) }));
    const checked = read.filter((r) => r.state === true);
    if (checked.length === 1 && !read.some((r) => r.state === undefined)) {
      put(spec.choice.field, spec.choice.options[checked[0]!.key]!, read.map((r) => `${r.key}=${r.text}`).join('; '), [checked[0]!.key]);
    } else if (checked.length > 1 || read.some((r) => r.state === undefined)) {
      for (const r of read) reviewBoxes.push({ key: r.key, label: boxByKey.get(r.key)!.label, text: r.text });
    }
  }

  if (spec.w2) {
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
    if (entries.length > 0) put('box12', entries, raws.join('; '), ['12a', '12b', '12c', '12d'].flatMap((slot) => [`${slot}.code`, `${slot}.amount`]).filter((k) => values[k] !== undefined));

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
    if (Object.keys(box13).length > 0) put('box13', box13, box13Raw.join('; '), ['13.statutory', '13.retirement', '13.sickPay'].filter((k) => values[k] !== undefined));
  }

  return { tool, bag, rawText, reviewBoxes, sourceKeys };
}
