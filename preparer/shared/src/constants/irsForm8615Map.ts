/**
 * IRS Form 8615 (2025) — AcroForm Field Mapping
 *
 * Tax for Certain Children Who Have Unearned Income
 * PDF: client/public/irs-forms/f8615.pdf (Form 8615, 2025)
 * Attachment Sequence No. 33
 *
 * Field prefix: topmostSubform[0].Page1[0]
 *
 * Layout (single page, read from the PDF's field positions):
 *   f1_1 / f1_2 = Child's name / SSN
 *   f1_3 / f1_4 = Line A: Parent's name / Line B: Parent's SSN
 *   c1_1[0..4]  = Line C: Single, MFJ, MFS, HOH, QSS
 *   f1_5 – f1_9 = Lines 1–5 (Part I)
 *   f1_10 = Line 6, f1_11 = Line 7, f1_12 = Line 8
 *   c1_2 / f1_13 = Line 9 worksheet box / Line 9
 *   c1_3 / f1_14 = Line 10 worksheet box / Line 10
 *   f1_15 = Line 11, f1_16 = Line 12a, f1_17 = Line 12b (the digits after the printed decimal point), f1_18 = Line 13
 *   f1_19 = Line 14
 *   c1_4 / f1_20 = Line 15 worksheet box / Line 15
 *   f1_21 = Line 16
 *   c1_5 / f1_22 = Line 17 worksheet box / Line 17
 *   f1_23 = Line 18
 *
 * Every figure comes from the engine's Form 8615 (calc.form8615, engine/form8615.ts).
 * Where the form says stop (line 3 zero or less, line 5 zero), the lines after it stay blank.
 */
import type { IRSFieldMapping, IRSFormTemplate } from '../types/irsFormMappings.js';
import { FilingStatus, type CalculationResult, type Form8615Result, type TaxReturn } from '../types/index.js';

const P1 = 'topmostSubform[0].Page1[0]';

/** Whole dollars; blank for a missing figure. */
function dollars(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.round(n).toString();
}

function form8615Of(calc: CalculationResult): Form8615Result | undefined {
  return calc.form8615?.status === 'figured' ? calc.form8615.result : undefined;
}

/** A line of Part I (shown through line 3, and to line 5 when line 3 is more than zero). */
function partOne(line: 1 | 2 | 3 | 4 | 5) {
  return (_tr: TaxReturn, calc: CalculationResult) => {
    const r = form8615Of(calc);
    if (!r || (line > 3 && r.line3 <= 0)) return undefined;
    return dollars(r[`line${line}`]);
  };
}

/** A line of Parts II and III, shown only when the form is completed. */
function completed(pick: (r: Form8615Result) => number | string | boolean | undefined) {
  return (_tr: TaxReturn, calc: CalculationResult) => {
    const r = form8615Of(calc);
    if (!r?.applies) return undefined;
    const value = pick(r);
    return typeof value === 'number' ? dollars(value) : value;
  };
}

function money(pdf: string, label: string, transform: IRSFieldMapping['transform']): IRSFieldMapping {
  return { pdfFieldName: `${P1}.${pdf}`, formLabel: label, sourcePath: '', source: 'calculationResult', format: 'dollarNoCents', transform };
}

const PARENT_STATUS: Array<[string, FilingStatus, string]> = [
  ['c1_1[0]', FilingStatus.Single, 'Single'],
  ['c1_1[1]', FilingStatus.MarriedFilingJointly, 'Married filing jointly'],
  ['c1_1[2]', FilingStatus.MarriedFilingSeparately, 'Married filing separately'],
  ['c1_1[3]', FilingStatus.HeadOfHousehold, 'Head of household'],
  ['c1_1[4]', FilingStatus.QualifyingSurvivingSpouse, 'Qualifying surviving spouse'],
];

export const FORM_8615_FIELDS: IRSFieldMapping[] = [
  // Header
  {
    pdfFieldName: `${P1}.f1_1[0]`,
    formLabel: "Child's name shown on return",
    sourcePath: '',
    source: 'taxReturn',
    format: 'string',
    transform: (tr) => [tr.firstName, tr.lastName].filter(Boolean).join(' ') || undefined,
  },
  {
    pdfFieldName: `${P1}.f1_2[0]`,
    formLabel: "Child's social security number",
    sourcePath: '',
    source: 'taxReturn',
    format: 'string',
    transform: (tr) => tr.ssn?.replace(/\D/g, '') || undefined,
  },
  {
    pdfFieldName: `${P1}.f1_3[0]`,
    formLabel: "Line A: Parent's name",
    sourcePath: '',
    source: 'taxReturn',
    format: 'string',
    transform: (tr) => tr.form8615?.parentName?.trim() || undefined,
  },
  {
    pdfFieldName: `${P1}.f1_4[0]`,
    formLabel: "Line B: Parent's social security number",
    sourcePath: '',
    source: 'taxReturn',
    format: 'string',
    transform: (tr) => tr.form8615?.parentSsn?.replace(/\D/g, '') || undefined,
  },
  ...PARENT_STATUS.map(([pdf, status, name]): IRSFieldMapping => ({
    pdfFieldName: `${P1}.${pdf}`,
    formLabel: `Line C: Parent's filing status - ${name}`,
    sourcePath: '',
    source: 'taxReturn',
    format: 'checkbox',
    transform: (tr) => tr.form8615?.parentFilingStatus === status,
  })),

  // Part I: the child's net unearned income
  money('f1_5[0]', "Line 1: Child's unearned income", partOne(1)),
  money('f1_6[0]', "Line 2: the year's amount, or the itemized deduction amount", partOne(2)),
  money('f1_7[0]', 'Line 3: Subtract line 2 from line 1', partOne(3)),
  money('f1_8[0]', "Line 4: Child's taxable income", partOne(4)),
  money('f1_9[0]', 'Line 5: Smaller of line 3 or line 4', partOne(5)),

  // Part II: the tentative tax at the parent's rate
  money('f1_10[0]', "Line 6: Parent's taxable income", completed((r) => r.line6)),
  money('f1_11[0]', "Line 7: Other children's line 5", completed((r) => (r.line7 > 0 ? r.line7 : undefined))),
  money('f1_12[0]', 'Line 8: Add lines 5, 6 and 7', completed((r) => r.line8)),
  {
    pdfFieldName: `${P1}.Line9_ReadOrder[0].c1_2[0]`,
    formLabel: 'Line 9: Qualified Dividends and Capital Gain Tax Worksheet used',
    sourcePath: '',
    source: 'calculationResult',
    format: 'checkbox',
    transform: completed((r) => r.worksheet.line9),
  },
  money('f1_13[0]', "Line 9: Tax on line 8 at the parent's filing status", completed((r) => r.line9)),
  {
    pdfFieldName: `${P1}.Line10_ReadOrder[0].c1_3[0]`,
    formLabel: "Line 10: Parent's tax figured with the Qualified Dividends and Capital Gain Tax Worksheet",
    sourcePath: '',
    source: 'calculationResult',
    format: 'checkbox',
    transform: (tr, calc) => Boolean(form8615Of(calc)?.applies && ((tr.form8615?.parentQualifiedDividends ?? 0) > 0 || (tr.form8615?.parentNetCapitalGain ?? 0) > 0)),
  },
  money('f1_14[0]', "Line 10: Parent's tax", completed((r) => r.line10)),
  money('f1_15[0]', 'Line 11: Subtract line 10 from line 9', completed((r) => r.line11)),
  money('f1_16[0]', 'Line 12a: Add lines 5 and 7', completed((r) => r.line12a)),
  {
    pdfFieldName: `${P1}.f1_17[0]`,
    formLabel: 'Line 12b: Line 5 divided by line 12a (decimal)',
    sourcePath: '',
    source: 'calculationResult',
    format: 'string',
    // The form prints "× ." before the field: the three decimal places.
    transform: completed((r) => (r.line12b !== undefined ? String(Math.round(r.line12b * 1000)).padStart(3, '0') : undefined)),
  },
  money('f1_18[0]', 'Line 13: Multiply line 11 by line 12b', completed((r) => r.line13)),

  // Part III: the child's tax
  money('f1_19[0]', 'Line 14: Subtract line 5 from line 4', completed((r) => (r.line14 > 0 ? r.line14 : undefined))),
  {
    pdfFieldName: `${P1}.Line15_ReadOrder[0].c1_4[0]`,
    formLabel: 'Line 15: Qualified Dividends and Capital Gain Tax Worksheet used',
    sourcePath: '',
    source: 'calculationResult',
    format: 'checkbox',
    transform: completed((r) => r.worksheet.line15),
  },
  // "If lines 4 and 5 above are the same, enter -0- on line 15."
  money('f1_20[0]', "Line 15: Tax on line 14 at the child's filing status", completed((r) => (r.line14 > 0 ? dollars(r.line15) : '0'))),
  money('f1_21[0]', 'Line 16: Add lines 13 and 15', completed((r) => r.line16)),
  {
    pdfFieldName: `${P1}.Line17_ReadOrder[0].c1_5[0]`,
    formLabel: 'Line 17: Qualified Dividends and Capital Gain Tax Worksheet used',
    sourcePath: '',
    source: 'calculationResult',
    format: 'checkbox',
    transform: completed((r) => r.worksheet.line17),
  },
  money('f1_22[0]', "Line 17: Tax on line 4 at the child's filing status", completed((r) => r.line17)),
  money('f1_23[0]', 'Line 18: The larger of line 16 or line 17', completed((r) => r.line18)),
];

export const FORM_8615_TEMPLATE: IRSFormTemplate = {
  formId: 'f8615',
  displayName: 'Form 8615',
  attachmentSequence: 33,
  pdfFileName: 'f8615.pdf',
  // "Do attach it to the child's return" even where the form stops at line 3 or 5.
  condition: (_tr, calc) => calc.form8615?.status === 'figured',
  fields: FORM_8615_FIELDS,
};
