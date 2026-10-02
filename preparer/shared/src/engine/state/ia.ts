/**
 * Iowa, full-year residents (IA 1040; TY2025 corpus TAX-007): the IA 1040 lines
 * from federal taxable income through the school district / EMS surtax, for the
 * years whose instructions are checked in (2024, 2025). Part-year and
 * nonresident returns (IA 126) stop at TAX-008.
 *
 * Line 2   federal taxable income (1040 line 15); when that is zero, 1c − 1d −
 *          1e − federal line 13b, which may be negative (rolling conformity).
 * Line 3   Schedule 1: − taxable Social Security (line 5); − U.S. obligation
 *          interest (1099-INT box 3, line 1B); + tax-exempt interest (1099-INT
 *          box 8) except from the Iowa bonds exempt by statute (line 1A); −
 *          retirement income of a recipient 55 or older on December 31,
 *          disabled, or a surviving spouse who qualifies (line 7; not a
 *          nonqualified annuity, 1099-R code D); − post-tax health and dental
 *          premiums at 65 or older under $100,000 (line 15).
 * Line 5   2025: 3.8%. 2024: 4.4% / 4.82% / 5.7% (Tax Calculation Worksheet
 *          41-026). The low-income exemption and the alternate tax (4.3%;
 *          2024: 5.7%) apply.
 * Line 8   exemption credit: $40 each (two for joint and head of household),
 *          $20 for each 65 or older (on or before January 1) or blind, $40
 *          per dependent.
 * Line 9   tuition and textbook credit: 25% of the first $2,000 per dependent.
 * Line 12  single filers: the Income Tax Reduction Worksheet (41-146).
 * Line 19  line 18 × the school district / EMS rate for the county and district
 *          lived in on December 31 (constants/states/ia.ts, table 41-027).
 * Line 24  child and dependent care credit: federal Form 2441 line 9c × the
 *          rate for Iowa taxable income under $90,000.
 * Line 25  Iowa earned income tax credit: 15% of the federal credit.
 *
 * What the return cannot show is asked once (the other Schedule 1 lines, IA
 * 148 credits, lump-sum tax, the out-of-state credit, and others); a yes
 * stops the return.
 */

import type {
  CalculationResult, CalculationTrace, Dependent, StateCalculationResult, StateQuestion, StateReturnConfig, TaxReturn, UnsupportedPattern,
} from '../../types/index.js';
import { FilingStatus } from '../../types/index.js';
import { IA_COUNTIES, IA_SURTAX } from '../../constants/states/ia.js';
import { getStateEstimatedPayments, getStateWithholding } from './index.js';
import { parseDateString, round2 } from '../utils.js';
import type { StateCalculator } from './stateRegistry.js';

/** The answers kept in the Iowa state return's stateSpecificData. */
export const IA_ANSWER = {
  county: 'iaCounty',
  schoolDistrict: 'iaSchoolDistrict',
  retirementEligible: 'iaRetirementEligible',
  spouseRetirementEligible: 'iaSpouseRetirementEligible',
  exemptIowaBondInterest: 'iaExemptIowaBondInterest',
  healthInsurance: 'iaHealthInsurance',
  spouseNetIncome: 'iaSpouseNetIncome',
  /** Followed by the dependent's id. */
  tuition: 'iaTuition:',
  otherItems: 'iaOtherItems',
} as const;

/** [over, rate, tax on the amount over]: the Tax Calculation Worksheet columns A, B and C. */
type Bracket = readonly [number, number, number];

interface IowaYear {
  brackets: { joint: readonly Bracket[]; other: readonly Bracket[] };
  /** Alternate tax worksheet, line 4. */
  alternateRate: number;
}

const IA_YEARS: Record<number, IowaYear> = {
  2024: {
    brackets: {
      other: [[0, 0.044, 0], [6210, 0.0482, 273.24], [31050, 0.057, 1470.53]],
      joint: [[0, 0.044, 0], [12420, 0.0482, 546.48], [62100, 0.057, 2941.06]],
    },
    alternateRate: 0.057,
  },
  2025: {
    brackets: { other: [[0, 0.038, 0]], joint: [[0, 0.038, 0]] },
    alternateRate: 0.043,
  },
};

/** Low-income exemption (line 4 instructions) and alternate tax thresholds. */
const LOW_INCOME = { single: 9000, single65: 24000, dependentSingle: 5000, other: 13500, other65: 32000, separateOwn: 9000, separateCombined: 13500 };
const CREDIT = { personal: 40, ageOrBlind: 20, dependent: 40 };
const TUITION = { rate: 0.25, perDependent: 2000 };
const HEALTH_INSURANCE_LIMIT = 100000;
const EITC_RATE = 0.15;
/** Child and dependent care credit worksheet: Iowa taxable income below each limit → rate. */
const CHILD_CARE: ReadonlyArray<readonly [number, number]> = [[10000, 0.75], [20000, 0.65], [25000, 0.55], [35000, 0.5], [40000, 0.4], [90000, 0.3]];

const OUTSIDE = 'Prepare the Iowa return outside HA Tax.';

type Question = Omit<StateQuestion, 'stateCode'>;

function answerOf(config: StateReturnConfig | undefined, key: string): unknown {
  return config?.stateSpecificData?.[key];
}

function amountAnswer(config: StateReturnConfig, key: string, max = Infinity): number | undefined {
  const v = answerOf(config, key);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
}

function born(dateOfBirth: string | undefined) {
  return dateOfBirth ? parseDateString(dateOfBirth) : null;
}

/** Age reached by December 31 of the year is at least `age`. */
function ageByYearEnd(dateOfBirth: string | undefined, year: number, age: number): boolean | undefined {
  const b = born(dateOfBirth);
  return b ? year - b.year >= age : undefined;
}

/** 65 or older on or before January 1 of the next year (exemption credit, Step 3b). */
function credit65(dateOfBirth: string | undefined, year: number): boolean {
  const b = born(dateOfBirth);
  if (!b) return false;
  return b.year < year - 64 || (b.year === year - 64 && b.month === 0 && b.day === 1);
}

function tax(bracketsFor: readonly Bracket[], taxable: number): number {
  if (taxable <= 0) return 0;
  const [over, rate, base] = [...bracketsFor].reverse().find(([o]) => taxable > o) ?? bracketsFor[0]!;
  return round2(base + (taxable - over) * rate);
}

function residentConfig(taxReturn: TaxReturn): StateReturnConfig | undefined {
  return (taxReturn.stateReturns ?? []).find((s) => s.stateCode.toUpperCase() === 'IA' && s.residencyType === 'resident');
}

const nameOf = (d: Dependent) => `${d.firstName} ${d.lastName}`.trim() || 'a dependent';

export interface IowaLines {
  line2: number; line3: number; line4: number; line5: number; line7: number; line8: number; line9: number;
  line11: number; line12: number; line18: number; line19: number; line20: number;
  line24: number; line25: number;
  lowIncomeExempt: boolean; alternateTax: boolean; taxReduction: boolean;
  surtaxRate?: number;
  retirementExclusion: number; socialSecurity: number; usInterest: number; municipalInterest: number; healthInsurance: number;
}

export interface IowaAssessment {
  applies: boolean;
  findings: UnsupportedPattern[];
  /** Every question this return asks, answered or not. */
  questions: StateQuestion[];
  lines?: IowaLines;
}

/** The IA 1040 lines of a full-year resident, and what the return does not settle. */
export function assessIowa(taxReturn: TaxReturn, federal?: CalculationResult | null): IowaAssessment {
  const year = taxReturn.taxYear || 2025;
  const config = residentConfig(taxReturn);
  if (!config) return { applies: false, findings: [], questions: [] };

  const findings: UnsupportedPattern[] = [];
  const asked: Question[] = [];
  const relevant: Question[] = [];
  const find = (itemId: string, message: string, question?: Question) => {
    findings.push({
      ruleId: 'TAX-007', jurisdiction: 'IA', section: 'state', itemId, message,
      ...(question ? { question: { stateCode: 'IA', ...question } } : {}),
    });
    if (question) asked.push(question);
  };
  const ask = (q: Question) => { relevant.push(q); return q; };
  const done = (lines?: IowaLines): IowaAssessment => ({
    applies: true, findings, lines,
    questions: relevant
      .filter((q) => asked.some((a) => a.key === q.key) || answerOf(config, q.key) !== undefined)
      .map((q) => ({ stateCode: 'IA', ...q })),
  });

  const params = IA_YEARS[year];
  const surtaxTable = IA_SURTAX[year];
  if (!params || !surtaxTable) {
    find('year', `Iowa ${year}: the IA 1040 tax rates, thresholds and school district surtax rates for ${year} are not built in HA Tax. ${OUTSIDE}`);
    return done();
  }

  const status = taxReturn.filingStatus;
  const joint = status === FilingStatus.MarriedFilingJointly;
  const separate = status === FilingStatus.MarriedFilingSeparately;
  const single = status === FilingStatus.Single || status === undefined;
  const dependentOfAnother = taxReturn.canBeClaimedAsDependent === true || taxReturn.isClaimedAsDependent === true;

  // ── What the return cannot show ──
  const otherQ = ask({
    key: IA_ANSWER.otherItems, kind: 'yes_no',
    prompt: 'Do any of these apply: Iowa 529 or ABLE contributions; the Iowa capital gain deduction (IA 100); military retirement or active duty military pay; Iowa modifications from a partnership, S corporation or trust K-1; bonus depreciation or section 179 differences (IA 4562A/B); an NOL from before 2023; farm tenancy income; railroad retirement or unemployment; exempt-interest dividends from a fund, or dividends from a fund attributable to federal securities; a first-time homebuyer savings account; tax paid to another state (IA 130); Iowa lump-sum tax; the early childhood development credit; the volunteer firefighter, EMS or reserve peace officer credit; IA 148 credits; or other Schedule 1 line 11 or 19 items?',
  });
  const other = answerOf(config, otherQ.key);
  if (other === true) {
    find('other-items', `Iowa: an Iowa modification or credit that HA Tax does not figure applies. ${OUTSIDE}`);
    return done();
  }
  if (other !== false) find('other-items', 'Iowa: some Schedule 1 modifications and credits depend on facts the return does not hold.', otherQ);

  // ── Line 19: the school district and county on December 31 ──
  const countyQ = ask({
    key: IA_ANSWER.county, kind: 'choice',
    options: IA_COUNTIES.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })),
    prompt: `Iowa county you lived in on December 31, ${year}`,
  });
  const county = answerOf(config, countyQ.key);
  const districts = typeof county === 'string' ? surtaxTable.districts[county] : undefined;
  if (!districts) find('county', 'Iowa school district surtax (IA 1040 line 19) uses the county and school district you lived in on December 31.', countyQ);
  let surtaxRate: number | undefined;
  if (districts) {
    const districtQ = ask({
      key: IA_ANSWER.schoolDistrict, kind: 'choice',
      options: districts.map((d) => ({ value: d.code, label: `${d.code} ${d.name}` })),
      prompt: `Iowa school district you lived in on December 31, ${year} (see tax-mapper.iowa.gov)`,
    });
    const district = districts.find((d) => d.code === answerOf(config, districtQ.key));
    if (!district) find('school-district', 'Iowa school district surtax: choose the school district you lived in on December 31 (the table lists the districts in your county).', districtQ);
    else surtaxRate = district.rate;
  }

  if (!federal) return done();
  const f = federal.form1040;

  // ── Line 2 ──
  const line1d = f.deductionAmount;
  const line1e = f.qbiDeduction;
  const line1f = federal.schedule1A?.seniorDeduction ?? 0;
  const line2 = f.taxableIncome > 0 ? f.taxableIncome : round2(f.agi - line1d - line1e - f.schedule1ADeduction);

  // ── Line 3: Schedule 1 ──
  const socialSecurity = f.taxableSocialSecurity || 0;
  const usInterest = round2((taxReturn.income1099INT ?? []).reduce((s, i) => s + Math.max(0, i.usBondInterest || 0), 0));
  const exemptInterest = round2((taxReturn.income1099INT ?? []).reduce((s, i) => s + Math.max(0, i.taxExemptInterest || 0), 0));
  let municipalInterest = 0;
  if (exemptInterest > 0) {
    const q = ask({
      key: IA_ANSWER.exemptIowaBondInterest, kind: 'amount',
      prompt: `Of the $${exemptInterest.toLocaleString('en-US')} tax-exempt interest, the part from the Iowa bonds that are exempt from Iowa tax by statute ($0 if none; most municipal bond interest is taxed by Iowa)`,
    });
    const a = amountAnswer(config, q.key, exemptInterest);
    if (a === undefined) find('bond-interest', 'Iowa taxes interest from state and municipal bonds (Schedule 1, line 1A), except certain Iowa bonds.', q);
    else municipalInterest = round2(exemptInterest - a);
  }

  // Line 7: the retirement income exclusion, by recipient.
  const people = [
    { who: 'you', spouse: false, dob: taxReturn.dateOfBirth, key: IA_ANSWER.retirementEligible },
    ...(joint ? [{ who: 'your spouse', spouse: true, dob: taxReturn.spouseDateOfBirth, key: IA_ANSWER.spouseRetirementEligible }] : []),
  ];
  const forms = taxReturn.income1099R ?? [];
  const eligible = new Map<boolean, boolean | undefined>();
  for (const p of people) {
    const own = forms.filter((r) => (r.isSpouse === true) === p.spouse);
    if (own.length === 0) continue;
    const by55 = ageByYearEnd(p.dob, year, 55);
    if (by55 === true) { eligible.set(p.spouse, true); continue; }
    const q = ask({
      key: p.key, kind: 'yes_no',
      prompt: `Was ${p.who} disabled in ${year}, or a surviving spouse (or survivor with an insurable interest) of someone who would have qualified, or a surviving spouse receiving a deceased spouse's protection-occupation, sheriff, firefighter or police pension?`,
    });
    const a = answerOf(config, q.key);
    if (typeof a === 'boolean') eligible.set(p.spouse, a);
    else {
      eligible.set(p.spouse, undefined);
      find(`retirement:${p.spouse ? 'spouse' : 'you'}`, `Iowa excludes retirement income of a recipient 55 or older on December 31, disabled, or a qualifying surviving spouse (Schedule 1, line 7).${by55 === undefined ? ` Enter ${p.who === 'you' ? 'your' : "your spouse's"} date of birth, or answer below.` : ''}`, q);
    }
  }
  const isRollover = (code: string | undefined) => ['G', 'T', 'Q'].includes((code || '7').toUpperCase());
  const nonqualified = round2(forms.filter((r) => (r.distributionCode || '').toUpperCase().includes('D')).reduce((s, r) => s + Math.max(0, r.taxableAmount || 0), 0));
  const allEligible = [...eligible.values()].every((v) => v === true) && eligible.size > 0;
  let retirementExclusion = 0;
  if (allEligible) {
    // Every recipient qualifies: federal lines 4b and 5b, less nonqualified annuities.
    retirementExclusion = round2(Math.max(0, f.iraDistributionsTaxable + f.pensionDistributionsTaxable - nonqualified));
  } else {
    const adjusted = forms.filter((r) => eligible.get(r.isSpouse === true) === true)
      .filter((r) => r.useSimplifiedMethod || (r.isRothIRA && (r.rothContributionBasis ?? 0) > 0) || (r.qcdAmount ?? 0) > 0);
    if (adjusted.length > 0 || (taxReturn.form8606 && [...eligible.values()].some((v) => v === true))) {
      find('retirement-split', `Iowa retirement exclusion: only one spouse qualifies, and a distribution's federal taxable amount is adjusted (simplified method, Roth basis, QCD or Form 8606), so HA Tax cannot split it by recipient. ${OUTSIDE}`);
    }
    retirementExclusion = round2(forms
      .filter((r) => eligible.get(r.isSpouse === true) === true && !isRollover(r.distributionCode) && !(r.distributionCode || '').toUpperCase().includes('D'))
      .reduce((s, r) => s + Math.max(0, r.taxableAmount || 0), 0));
  }

  // Line 15: health and dental premiums paid with post-tax money, at 65 or older.
  let healthInsurance = 0;
  const over65 = ageByYearEnd(taxReturn.dateOfBirth, year, 65) === true || (joint && ageByYearEnd(taxReturn.spouseDateOfBirth, year, 65) === true);
  if (over65) {
    const q = ask({
      key: IA_ANSWER.healthInsurance, kind: 'amount',
      prompt: 'Health and dental insurance premiums paid with after-tax money, including Medicare Part B and D and long-term care premiums, not deducted on the federal return ($0 if none)',
    });
    const a = amountAnswer(config, q.key);
    if (a === undefined) find('health-insurance', 'Iowa deducts health and dental premiums paid with after-tax money at 65 or older when income is under $100,000 (Schedule 1, line 15).', q);
    else if (a > 0 && f.deductionUsed === 'itemized' && (taxReturn.itemizedDeductions?.medicalExpenses ?? 0) > 0) {
      find('health-insurance', `Iowa health insurance deduction: medical expenses are itemized on the federal return, so the deduction is the premiums' share of the disallowed medical expenses; HA Tax does not split it. ${OUTSIDE}`);
    } else healthInsurance = a;
  }

  let line3 = round2(municipalInterest - socialSecurity - usInterest - retirementExclusion - healthInsurance);
  let line4 = round2(line2 + line3);
  if (healthInsurance > 0) {
    // Health Insurance Taxable Income Worksheet: line 4 plus the listed amounts must be under $100,000.
    const worksheet = round2(line4 + Math.min(line1d, f.agi) + line1f + line1e + socialSecurity + retirementExclusion + healthInsurance);
    if (worksheet >= HEALTH_INSURANCE_LIMIT) {
      healthInsurance = 0;
      line3 = round2(municipalInterest - socialSecurity - usInterest - retirementExclusion);
      line4 = round2(line2 + line3);
    }
  }

  // ── Line 5: tax, the low-income exemption and the alternate tax ──
  const brackets = joint ? params.brackets.joint : params.brackets.other;
  const regular = tax(brackets, line4);
  const net = round2(line4 + line1d + line1f + line1e);
  const any65 = ageByYearEnd(taxReturn.dateOfBirth, year, 65) === true || ((joint || separate) && ageByYearEnd(taxReturn.spouseDateOfBirth, year, 65) === true);
  let line5 = regular;
  let lowIncomeExempt = false;
  let alternateTax = false;
  if (single) {
    lowIncomeExempt = dependentOfAnother ? line4 < LOW_INCOME.dependentSingle : net <= (any65 ? LOW_INCOME.single65 : LOW_INCOME.single);
  } else if (!separate) {
    lowIncomeExempt = !dependentOfAnother && net <= (any65 ? LOW_INCOME.other65 : LOW_INCOME.other);
    if (!lowIncomeExempt) {
      const alt = round2(Math.max(0, net - (any65 ? LOW_INCOME.other65 : LOW_INCOME.other)) * params.alternateRate);
      if (alt < regular) { line5 = alt; alternateTax = true; }
    }
  } else {
    // Married filing separately: both spouses' net incomes decide.
    const threshold = any65 || !taxReturn.spouseDateOfBirth ? LOW_INCOME.other65 : LOW_INCOME.other;
    const leastAlternate = round2(Math.max(0, net - threshold) * params.alternateRate);
    const mayMatter = (!dependentOfAnother && net <= LOW_INCOME.separateOwn) || leastAlternate < regular;
    if (mayMatter) {
      const q = ask({
        key: IA_ANSWER.spouseNetIncome, kind: 'amount', allowNegative: true,
        prompt: "Your spouse's Iowa net income: their Iowa taxable income plus their federal deduction, QBI deduction and senior deduction (IA alternate tax worksheet, line 1g, column B)",
      });
      const v = answerOf(config, q.key);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        find('spouse-income', 'Iowa: on a separate return, the low-income exemption and the alternate tax use both spouses\' net income.', q);
      } else {
        const combined = round2(net + v);
        lowIncomeExempt = !dependentOfAnother && net <= LOW_INCOME.separateOwn && combined <= LOW_INCOME.separateCombined;
        if (!lowIncomeExempt && combined > 0) {
          const t = any65 || ageByYearEnd(taxReturn.spouseDateOfBirth, year, 65) === true ? LOW_INCOME.other65 : LOW_INCOME.other;
          const alt = round2(Math.max(0, combined - t) * params.alternateRate);
          // Line 9: your share, to the nearest tenth of a percent.
          const share = Math.round((net / combined) * 1000) / 1000;
          const own = round2(alt * share);
          if (own < regular) { line5 = own; alternateTax = true; }
        }
      }
    }
  }
  if (lowIncomeExempt) line5 = 0;
  const line7 = line5;

  // ── Lines 8-12: credits ──
  const persons = joint || status === FilingStatus.HeadOfHousehold ? 2 : 1;
  const ageBlind = [
    credit65(taxReturn.dateOfBirth, year), taxReturn.isLegallyBlind === true,
    joint && credit65(taxReturn.spouseDateOfBirth, year), joint && taxReturn.spouseIsLegallyBlind === true,
  ].filter(Boolean).length;
  const dependents = taxReturn.dependents ?? [];
  const line8 = CREDIT.personal * persons + CREDIT.ageOrBlind * ageBlind + CREDIT.dependent * dependents.length;

  let line9 = 0;
  for (const d of dependents) {
    const b = born(d.dateOfBirth);
    const age = b ? year - b.year : undefined;
    if (age !== undefined && (age < 4 || age > 21)) continue;
    const q = ask({
      key: `${IA_ANSWER.tuition}${d.id}`, kind: 'amount',
      prompt: `Tuition and textbooks paid for ${nameOf(d)} for kindergarten through 12th grade in Iowa, or private instruction ($0 if none)`,
    });
    const a = amountAnswer(config, q.key);
    if (a === undefined) find(`tuition:${d.id}`, `Iowa tuition and textbook credit (IA 1040 line 9): 25% of up to $2,000 paid per dependent in kindergarten through 12th grade.`, q);
    else line9 = round2(line9 + TUITION.rate * Math.min(TUITION.perDependent, a));
  }
  const line11 = round2(line8 + line9);
  let line12 = round2(Math.max(0, line7 - line11));
  let taxReduction = false;
  if (single && !dependentOfAnother && !lowIncomeExempt) {
    const reduced = round2(Math.max(0, net - (ageByYearEnd(taxReturn.dateOfBirth, year, 65) === true ? LOW_INCOME.single65 : LOW_INCOME.single)));
    if (reduced < line12) { line12 = reduced; taxReduction = true; }
  }
  const line18 = line12;
  const line19 = surtaxRate !== undefined ? round2(line18 * surtaxRate) : 0;
  const line20 = round2(line18 + line19);

  // ── Refundable credits ──
  const childCareRate = CHILD_CARE.find(([limit]) => line4 < limit)?.[1] ?? 0;
  const line24 = round2((federal.dependentCare?.credit ?? 0) * childCareRate);
  const line25 = round2((federal.credits.eitcCredit || 0) * EITC_RATE);

  return done({
    line2, line3, line4, line5, line7, line8, line9, line11, line12, line18, line19, line20, line24, line25,
    lowIncomeExempt, alternateTax, taxReduction, surtaxRate,
    retirementExclusion, socialSecurity, usInterest, municipalInterest, healthInsurance,
  });
}

/**
 * Iowa's calculator: the IA 1040 for a full-year resident in a year that is
 * built; otherwise the flat-tax calculator (a part-year or nonresident return
 * stops at TAX-008, and an unbuilt year at TAX-007).
 */
export function withIowaResident(calculator: StateCalculator | null): StateCalculator | null {
  if (!calculator) return null;
  return {
    calculate(taxReturn, federalResult, config): StateCalculationResult {
      if (config.residencyType !== 'resident') return calculator.calculate(taxReturn, federalResult, config);
      const { lines } = assessIowa(taxReturn, federalResult);
      if (!lines) return calculator.calculate(taxReturn, federalResult, config);
      const withholding = getStateWithholding(taxReturn, 'IA');
      const estimated = getStateEstimatedPayments(config);
      const refundable = round2(lines.line24 + lines.line25);
      const payments = round2(withholding + estimated + refundable);
      const agi = federalResult.form1040.agi;
      const trace = (lineId: string, label: string, value: number, formula: string, inputs: CalculationTrace['inputs'] = []): CalculationTrace =>
        ({ lineId, label, value, formula, authority: 'IA 1040', inputs });
      return {
        stateCode: 'IA',
        stateName: 'Iowa',
        residencyType: config.residencyType,
        federalAGI: agi,
        stateAdditions: lines.municipalInterest,
        stateSubtractions: round2(lines.socialSecurity + lines.usInterest + lines.retirementExclusion + lines.healthInsurance),
        stateAGI: lines.line2,
        stateDeduction: 0,
        stateTaxableIncome: lines.line4,
        stateExemptions: 0,
        stateIncomeTax: lines.line7,
        stateCredits: lines.line11,
        stateTaxAfterCredits: lines.line18,
        localTax: lines.line19,
        totalStateTax: lines.line20,
        stateWithholding: withholding,
        stateEstimatedPayments: estimated,
        stateRefundOrOwed: round2(payments - lines.line20),
        effectiveStateRate: agi > 0 ? Math.round((lines.line20 / agi) * 10000) / 10000 : 0,
        bracketDetails: [],
        additionalLines: {
          line2FederalTaxableIncome: lines.line2,
          line3NetModifications: lines.line3,
          line8ExemptionCredit: lines.line8,
          line9TuitionCredit: lines.line9,
          line19Surtax: lines.line19,
          ...(lines.surtaxRate !== undefined ? { surtaxRate: lines.surtaxRate } : {}),
          line24ChildCareCredit: lines.line24,
          line25EarnedIncomeCredit: lines.line25,
          ...(lines.lowIncomeExempt ? { lowIncomeExemption: 1 } : {}),
          ...(lines.alternateTax ? { alternateTax: 1 } : {}),
          ...(lines.taxReduction ? { taxReduction: 1 } : {}),
        },
        traces: [
          trace('state.stateAGI', 'Federal taxable income (IA 1040 line 2)', lines.line2, 'Federal 1040 line 15'),
          trace('state.taxableIncome', 'Iowa taxable income (line 4)', lines.line4, 'Line 2 + Schedule 1 net modifications', [
            { lineId: 'ia.line3', label: 'Net Iowa modifications', value: lines.line3 },
          ]),
          trace('state.incomeTax', 'Iowa tax (line 5)', lines.line5, lines.lowIncomeExempt ? 'Low-income exemption' : lines.alternateTax ? 'Alternate tax' : 'Tax rate on line 4'),
          trace('state.localTax', 'School district / EMS surtax (line 19)', lines.line19, 'Line 18 × surtax rate', [
            { lineId: 'ia.line18', label: 'Line 18', value: lines.line18 },
            { lineId: 'ia.surtaxRate', label: 'Surtax rate', value: lines.surtaxRate ?? 0 },
          ]),
          trace('state.totalTax', 'Total state and local tax (line 20)', lines.line20, 'Line 18 + line 19'),
          trace('state.refundOrOwed', payments - lines.line20 >= 0 ? 'Iowa Refund' : 'Iowa Amount Owed', round2(payments - lines.line20), 'Withholding + payments + refundable credits − line 20'),
        ],
      };
    },
  };
}
