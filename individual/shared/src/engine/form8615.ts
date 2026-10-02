import { FilingStatus, type Form8615Field, type Form8615Info, type Form8615Outcome, type Form8615Result } from '../types/index.js';
import { getKiddieTax } from '../constants/taxConstants.js';
import { calculateTaxTableTax } from './brackets.js';
import { calculatePreferentialRateTax } from './capitalGains.js';
import { round2 } from './utils.js';

/**
 * Form 8615 (2025), Tax for Certain Children Who Have Unearned Income, line by
 * line on the child's own return: the child's net unearned income is taxed at
 * the parent's rate (lines 6–13), the rest at the child's (lines 14–15), and
 * line 18 — the larger of that and the child's tax on all taxable income —
 * is the child's Form 1040 line 16.
 *
 * Qualified dividends and net capital gain follow the Line 5 Worksheets and
 * the Qualified Dividends and Capital Gain Tax Worksheet with the parent's or
 * the child's filing status, as the instructions direct. What the
 * instructions send to the Schedule D Tax Worksheet, Schedule J or the
 * Foreign Earned Income Tax Worksheet, and itemized deductions directly
 * connected with dividends or gain, are not figured: the result carries them
 * as unsupported and the return holds until the preparer settles them.
 *
 * Whether the form applies (the child's age and support, a living parent, no
 * joint return) is the preparer's answer; the engine asks for it when the
 * child's unearned income is over $2,700 and the child's age or dependency
 * leaves it possible, and asks for each of the parent's figures it needs.
 *
 * @authority
 *   IRC: Section 1(g) — certain unearned income of children taxed as if the parent's income
 *   Form: Form 8615 (2025) and its instructions (Line 1 worksheets, Line 5 Worksheets #1 and #3, lines 9, 15, 17)
 * @scope The child's tax with Form 8615
 * @limitations Schedule D Tax Worksheet, Schedule J, Form 2555, and directly connected deductions with dividends or gain (Line 5 Worksheet #2) are reported unsupported
 */

export interface Form8615Input {
  info: Form8615Info;
  taxYear: number;
  childFilingStatus: FilingStatus;
  /** The child's Form 1040: line 9 (total income), line 11 (AGI), line 15 (taxable income). */
  totalIncome: number;
  agi: number;
  taxableIncome: number;
  /** The deduction taken on line 12 (standard or itemized), and whether it is itemized. */
  deduction: number;
  itemizes: boolean;
  /** Earned income: Form 1040 line 1z, Schedule 1 lines 3 and 6 (business and farm income). */
  wages: number;
  businessIncome: number;
  farmIncome: number;
  /** Schedule 1 line 18: penalty on early withdrawal of savings. */
  earlyWithdrawalPenalty: number;
  nolDeduction: number;
  qualifiedDividends: number;
  netCapitalGain: number;
  /** The child's 28% rate gain and unrecaptured section 1250 gain (Schedule D lines 18 and 19). */
  has28RateOr1250Gain: boolean;
  filesForm2555: boolean;
}

/** A decimal on Form 8615 and its worksheets: "rounded to at least three places". */
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const num = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** Tax on an amount: the Qualified Dividends and Capital Gain Tax Worksheet when it includes either, else the Tax Table or Tax Computation Worksheet. */
function taxOn(amount: number, qd: number, ncg: number, status: FilingStatus, year: number): number {
  if (amount <= 0) return 0;
  return qd > 0 || ncg > 0
    ? calculatePreferentialRateTax(amount, Math.max(0, qd), Math.max(0, ncg), status, 0, year).totalTax
    : calculateTaxTableTax(amount, status, year).tax;
}

/** Line 1: the child's unearned income (the Child's Unearned Income Worksheet, or the Alternate Worksheet). */
export function form8615Line1(input: Pick<Form8615Input, 'totalIncome' | 'agi' | 'wages' | 'businessIncome' | 'farmIncome' | 'earlyWithdrawalPenalty' | 'nolDeduction'>): number {
  const earned = round2(Math.max(0, input.wages) + Math.max(0, input.businessIncome) + Math.max(0, input.farmIncome));
  const selfEmploymentLoss = Math.max(0, -input.businessIncome) + Math.max(0, -input.farmIncome);
  let line1: number;
  if (selfEmploymentLoss > 0 || input.nolDeduction > 0) {
    // Alternate Worksheet for Form 8615, Line 1 (a net loss from self-employment, a net operating loss deduction).
    line1 = round2(input.totalIncome + selfEmploymentLoss + Math.max(0, input.nolDeduction) - (earned + input.earlyWithdrawalPenalty));
  } else if (earned === 0) {
    line1 = round2(input.agi);
  } else {
    // Child's Unearned Income Worksheet.
    line1 = round2(input.totalIncome - (earned + input.earlyWithdrawalPenalty));
  }
  return Math.max(0, line1);
}

/**
 * The figures Form 8615 needs that the return does not have, in the order the
 * form takes them. A form that stops at line 3 or 5 needs only lines A–C and,
 * when the child itemizes, the directly connected deductions line 2 takes:
 * Part II is never reached.
 */
export function form8615Missing(info: Form8615Info, childItemizes: boolean, stops = false): Form8615Field[] {
  const needed: Form8615Field[] = stops
    ? ['parentName', 'parentSsn', 'parentFilingStatus']
    : ['parentName', 'parentSsn', 'parentFilingStatus', 'parentTaxableIncome', 'parentTax',
      'parentQualifiedDividends', 'parentNetCapitalGain', 'otherChildrenNetUnearnedIncome'];
  if (!stops && num(info.otherChildrenNetUnearnedIncome) > 0) needed.push('otherChildrenQualifiedDividends', 'otherChildrenNetCapitalGain');
  if (childItemizes) needed.push('childDirectlyConnectedDeductions');
  if (!stops) needed.push('parentSpecialComputation');
  return needed.filter((field) => {
    const value = info[field];
    if (field === 'parentName') return typeof value !== 'string' || !value.trim();
    if (field === 'parentSsn') return typeof value !== 'string' || !/^\d{9}$/.test(value.replace(/\D/g, ''));
    if (field === 'parentFilingStatus') return !Object.values(FilingStatus).includes(value as FilingStatus);
    if (field === 'parentSpecialComputation') return typeof value !== 'boolean';
    return typeof value !== 'number' || !Number.isFinite(value);
  });
}

/** Lines 1–5 (Part I). */
function partOne(input: Omit<Form8615Input, 'info'>, directlyConnected: number) {
  const KIDDIE = getKiddieTax(input.taxYear);
  const line1 = form8615Line1(input);
  // Line 2: $2,700 (2025), or when the child itemizes, the larger of that and $1,350 plus the directly connected deductions.
  const line2 = Math.max(KIDDIE.UNEARNED_INCOME_THRESHOLD, round2(KIDDIE.STANDARD_DEDUCTION_UNEARNED + directlyConnected));
  const line3 = round2(line1 - line2);
  const line4 = round2(Math.max(0, input.taxableIncome));
  const line5 = line3 > 0 ? Math.min(line3, line4) : 0;
  return { line1, line2, line3, line4, line5 };
}

/** Whether the form stops at line 3 or 5; undefined while line 2 waits for the child's directly connected deductions. */
function stopsInPartOne(input: Omit<Form8615Input, 'info'>, info: Form8615Info): boolean | undefined {
  if (input.itemizes && (typeof info.childDirectlyConnectedDeductions !== 'number' || !Number.isFinite(info.childDirectlyConnectedDeductions))) return undefined;
  const { line3, line5 } = partOne(input, input.itemizes ? Math.max(0, num(info.childDirectlyConnectedDeductions)) : 0);
  return line3 <= 0 || line5 <= 0;
}

/**
 * Form 8615 on the return: asked about when the return does not say whether
 * it applies and it may, missing figures while any are, else figured.
 * Undefined when there is no Form 8615.
 */
export function figureForm8615(input: Omit<Form8615Input, 'info'> & { info?: Form8615Info; age?: number; canBeClaimedAsDependent?: boolean }): Form8615Outcome | undefined {
  const { info } = input;
  if (info?.applies === false) return undefined;
  if (info?.applies !== true) {
    const line1 = form8615Line1(input);
    // Under 24 at the end of the year. With no date of birth the age is not known, and being
    // someone's dependent is not one of the conditions: it stays open.
    const young = input.age === undefined || input.age < getKiddieTax(input.taxYear).STUDENT_AGE_LIMIT;
    // Taxable income is not one of the conditions: with none, the form stops at line 5 but is still attached.
    const possible = young && input.childFilingStatus !== FilingStatus.MarriedFilingJointly
      && line1 > getKiddieTax(input.taxYear).UNEARNED_INCOME_THRESHOLD;
    return possible ? { status: 'ask', unearnedIncome: line1, ...(input.age !== undefined ? { age: input.age } : {}) } : undefined;
  }
  const missing = form8615Missing(info, input.itemizes, stopsInPartOne(input, info) === true);
  if (missing.length > 0) return { status: 'missing', missing };
  return { status: 'figured', result: calculateForm8615({ ...input, info }) };
}

/** Form 8615 line by line. Every figure form8615Missing names is entered. */
export function calculateForm8615(input: Form8615Input): Form8615Result {
  const { info, taxYear: year } = input;
  const KIDDIE = getKiddieTax(year);
  const unsupported: Form8615Result['unsupported'] = [];

  if (input.childFilingStatus === FilingStatus.MarriedFilingJointly) {
    unsupported.push({ ruleId: 'FED.8615.JOINT_RETURN', message: 'Form 8615 is marked as applying, but the child files a joint return, and a child who files jointly does not file Form 8615. Correct the filing status or the Form 8615 answer.' });
  }
  if (input.has28RateOr1250Gain) {
    unsupported.push({ ruleId: 'FED.8615.SCHEDULE_D_WORKSHEET', message: 'Form 8615: the child has 28% rate gain or unrecaptured section 1250 gain, so lines 9, 15 and 17 come from the Schedule D Tax Worksheet, which HATax does not fill for Form 8615. Figure the child\'s tax by hand.' });
  }
  if (input.filesForm2555) {
    unsupported.push({ ruleId: 'FED.8615.FORM2555', message: 'Form 8615 with the child\'s Form 2555 (foreign earned income exclusion) uses the Alternate Worksheet and the Foreign Earned Income Tax Worksheet, which HATax does not fill for Form 8615. Figure the child\'s tax by hand.' });
  }
  if (info.parentSpecialComputation) {
    unsupported.push({ ruleId: 'FED.8615.PARENT_WORKSHEET', message: 'Form 8615: the parent\'s tax used the Schedule D Tax Worksheet, Schedule J or the Foreign Earned Income Tax Worksheet (or another child has 28% rate or unrecaptured section 1250 gain), so line 9 follows that worksheet, which HATax does not fill for Form 8615. Figure the child\'s tax by hand.' });
  }

  const directlyConnected = input.itemizes ? Math.max(0, num(info.childDirectlyConnectedDeductions)) : 0;
  const { line1, line2, line3, line4, line5 } = partOne(input, directlyConnected);

  const empty: Form8615Result = {
    applies: false, line1, line2, line3, line4, line5,
    line6: 0, line7: 0, line8: 0, line9: 0, line10: 0, line11: 0, line13: 0, line14: 0, line15: 0, line16: 0, line17: 0, line18: 0,
    worksheet: { line9: false, line15: false, line17: false },
    included: { line5: { qd: 0, ncg: 0 }, line8: { qd: 0, ncg: 0 }, line14: { qd: 0, ncg: 0 } },
    unsupported,
  };
  // "If zero or less, stop" (line 3) and "If zero, stop" (line 5).
  if (line3 <= 0 || line5 <= 0) return empty;

  // Line 5 Worksheets: the child's qualified dividends and net capital gain included on line 5.
  const qd = Math.max(0, input.qualifiedDividends);
  const ncg = Math.max(0, input.netCapitalGain);
  let qd5 = 0;
  let ncg5 = 0;
  let line5Worksheet: Form8615Result['line5Worksheet'];
  if (qd > 0 || ncg > 0) {
    if (line5 === line3 && line2 === KIDDIE.UNEARNED_INCOME_THRESHOLD) {
      // Worksheet #1.
      line5Worksheet = 1;
      const r4 = Math.min(1, round3(qd / line1));
      const r5 = Math.min(1, round3(ncg / line1));
      qd5 = clamp(round2(qd - KIDDIE.UNEARNED_INCOME_THRESHOLD * r4), 0, line5);
      ncg5 = clamp(round2(ncg - KIDDIE.UNEARNED_INCOME_THRESHOLD * r5), 0, round2(line5 - qd5));
    } else if (directlyConnected > 0) {
      // Worksheets #2 and #3 take the part of the directly connected deductions that produced the dividends and gain alone.
      unsupported.push({ ruleId: 'FED.8615.DIRECTLY_CONNECTED', message: 'The child itemizes deductions directly connected with unearned income and has qualified dividends or capital gain: the Form 8615 Line 5 Worksheet needs the part connected with the dividends and gain, which HATax does not have. Figure the child\'s tax by hand.' });
    } else {
      // Worksheet #3 (line 5 is less than line 3); with nothing directly connected its lines 5–7 are 0.
      line5Worksheet = 3;
      const l3 = round2(qd + ncg);
      const r4 = round3(qd / l3);
      const l11 = round2(input.deduction);
      const r14 = Math.min(1, round3(l3 / input.agi));
      const l15 = round2(l11 * r14);
      const l16 = round2(l15 * r4);
      const l17 = round2(l15 - l16);
      qd5 = clamp(round2(qd - l16), 0, line5);
      ncg5 = clamp(round2(ncg - l17), 0, round2(line5 - qd5));
    }
  }
  if (unsupported.length > 0) return { ...empty, unsupported };

  // Part II: the tentative tax at the parent's rate.
  const parentStatus = info.parentFilingStatus ?? FilingStatus.Single;
  const line6 = round2(Math.max(0, num(info.parentTaxableIncome)));
  const line7 = round2(Math.max(0, num(info.otherChildrenNetUnearnedIncome)));
  const line8 = round2(line5 + line6 + line7);
  const qd8 = round2(qd5 + Math.max(0, num(info.parentQualifiedDividends)) + (line7 > 0 ? Math.max(0, num(info.otherChildrenQualifiedDividends)) : 0));
  const ncg8 = round2(ncg5 + Math.max(0, num(info.parentNetCapitalGain)) + (line7 > 0 ? Math.max(0, num(info.otherChildrenNetCapitalGain)) : 0));
  const line9 = taxOn(line8, qd8, ncg8, parentStatus, year);
  const line10 = round2(Math.max(0, num(info.parentTax)));
  const line11 = round2(Math.max(0, line9 - line10));
  let line12a: number | undefined;
  let line12b: number | undefined;
  let line13 = line11;
  if (line7 > 0) {
    line12a = round2(line5 + line7);
    line12b = round3(line5 / line12a);
    line13 = round2(line11 * line12b);
  }

  // Part III: the child's tax.
  const line14 = round2(line4 - line5);
  const qd14 = line14 > 0 ? round2(qd - qd5) : 0;
  const ncg14 = line14 > 0 ? round2(ncg - ncg5) : 0;
  const line15 = line14 > 0 ? taxOn(line14, qd14, ncg14, input.childFilingStatus, year) : 0;
  const line16 = round2(line13 + line15);
  const line17 = taxOn(line4, qd, ncg, input.childFilingStatus, year);
  const line18 = Math.max(line16, line17);

  return {
    applies: true,
    line1, line2, line3, line4, line5, line6, line7, line8, line9, line10, line11,
    ...(line12a !== undefined ? { line12a, line12b } : {}),
    line13, line14, line15, line16, line17, line18,
    worksheet: { line9: line8 > 0 && (qd8 > 0 || ncg8 > 0), line15: line14 > 0 && (qd14 > 0 || ncg14 > 0), line17: line4 > 0 && (qd > 0 || ncg > 0) },
    included: { line5: { qd: qd5, ncg: ncg5 }, line8: { qd: qd8, ncg: ncg8 }, line14: { qd: qd14, ncg: ncg14 } },
    ...(line5Worksheet ? { line5Worksheet } : {}),
    unsupported,
  };
}
