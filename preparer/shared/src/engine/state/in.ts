/**
 * Indiana, full-year residents (Form IT-40; TY2025 corpus TAX-006): the
 * Schedule 3 exemptions and the county income tax on Schedule CT-40.
 * Part-year and nonresident returns (IT-40PNR, CT-40PNR) stop at TAX-008.
 *
 * Schedule 3 (the same for 2024 and 2025):
 *   line 1  $2,000 married filing jointly; otherwise $1,000.
 *   line 2  $1,000 per dependent.
 *   line 3  $1,500 per dependent child — a son, daughter, stepchild, a foster
 *           child who lived with you all year, or a child you are legal
 *           guardian of — under 19 at the end of the year, or a full-time
 *           student under 24. $3,000 instead for the first year the exemption
 *           can be claimed for the child (Schedule IN-DEP boxes E and F).
 *   line 4  $1,000 each for being 65 or older and for being blind, for you
 *           and a joint spouse.
 *   line 5  $500 each for being 65 or older when federal AGI (IT-40 line 1) is
 *           under $40,000 ($20,000 married filing separately).
 *   line 6  $3,000 per adopted child (Schedule IN-DEP-A).
 *
 * Schedule CT-40: IT-40 line 7 times the rate of the county where the
 * taxpayer lived on January 1 (constants/states/in.ts). Spouses who lived in
 * different counties split line 7 between them; that is not built, so it
 * stops. A Perry County resident subtracts the Perry rate on income taxed by
 * certain Kentucky localities (lines 5 and 6). County tax withheld is a
 * payment (IT-40 line 2); the forms' local boxes are not read, so it is asked.
 */

import type {
  CalculationTrace, Dependent, StateCalculationResult, StateQuestion, StateReturnConfig, TaxReturn, UnsupportedPattern,
} from '../../types/index.js';
import { FilingStatus } from '../../types/index.js';
import { IN_COUNTIES, IN_COUNTY_TAX_RATES, IN_PERRY_COUNTY } from '../../constants/states/in.js';
import { parseDateString, round2 } from '../utils.js';
import type { StateCalculator } from './stateRegistry.js';

/** The answers kept in the Indiana state return's stateSpecificData. */
export const IN_ANSWER = {
  county: 'inCounty',
  spouseCounty: 'inSpouseCounty',
  perryKentuckyIncome: 'inPerryKentuckyIncome',
  countyTaxWithheld: 'inCountyTaxWithheld',
  guardianChildren: 'inGuardianChildren',
  adoptedChildren: 'inAdoptedChildren',
  firstTimeChildren: 'inFirstTimeChildren',
} as const;

/** Schedule CT-40 code for no Indiana county on January 1 (military stationed outside Indiana). */
const NO_COUNTY = '00';
const OUTSIDE = 'Prepare the Indiana return outside HATax.';

export interface IndianaExemptions {
  line1: number;
  line2: number;
  line3: number;
  line4: number;
  line5: number;
  line6: number;
  total: number;
}

export interface IndianaAssessment {
  /** A full-year resident Indiana return is on the return. */
  applies: boolean;
  findings: UnsupportedPattern[];
  /** Every question this return asks, answered or not. */
  questions: StateQuestion[];
  exemptions: IndianaExemptions;
  /** County rate on line 1A; undefined until the county is known. */
  countyRate?: number;
  countyCode?: string;
  /** Schedule CT-40 line 5. */
  perryKentuckyIncome: number;
  /** IT-40 line 2, county part. */
  countyTaxWithheld: number;
}

type Question = Omit<StateQuestion, 'stateCode'>;

const CHILD = /^(son|daughter|step ?son|step ?daughter|child|step ?child)$/i;
const FOSTER = /^foster ?child$/i;
/** Relationships that cannot be a ward under 24 of the taxpayer. */
const NOT_A_WARD = /^(parent|mother|father|step ?mother|step ?father|grandparent|aunt|uncle|.*-in-law)$/i;

function birthYear(dateOfBirth: string | undefined): number | undefined {
  return dateOfBirth ? parseDateString(dateOfBirth)?.year : undefined;
}

/** Under 19 by December 31, or a full-time student under 24 (Schedule 3, line 3). */
function youngEnough(dep: Dependent, year: number): boolean | undefined {
  const born = birthYear(dep.dateOfBirth);
  if (born === undefined) return undefined;
  const age = year - born;
  return age < 19 || (dep.isStudent === true && age < 24);
}

/** 65 or older by December 31 (Schedule 3, lines 4 and 5). */
function is65(dateOfBirth: string | undefined, year: number): boolean {
  const born = birthYear(dateOfBirth);
  return born !== undefined && year - born >= 65;
}

const nameOf = (d: Dependent) => `${d.firstName} ${d.lastName}`.trim() || 'A dependent';
const listNames = (deps: Dependent[]) => deps.map(nameOf).join(', ');

function answerOf(config: StateReturnConfig | undefined, key: string): unknown {
  return config?.stateSpecificData?.[key];
}

function countAnswer(config: StateReturnConfig, key: string, max: number): number | undefined {
  const v = answerOf(config, key);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
}

function amountAnswer(config: StateReturnConfig, key: string): number | undefined {
  const v = answerOf(config, key);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Forms whose Indiana withholding may include county tax. */
function hasIndianaWithholdingForms(taxReturn: TaxReturn): boolean {
  const byCode = (items: { stateCode?: string }[] | undefined) => (items ?? []).some((i) => i.stateCode?.toUpperCase() === 'IN');
  return (taxReturn.w2Income ?? []).some((w) => w.state?.toUpperCase() === 'IN')
    || byCode(taxReturn.incomeW2G) || byCode(taxReturn.income1099R) || byCode(taxReturn.income1099G)
    || byCode(taxReturn.income1099MISC) || byCode(taxReturn.income1099NEC);
}

function residentConfig(taxReturn: TaxReturn): StateReturnConfig | undefined {
  return (taxReturn.stateReturns ?? []).find((s) => s.stateCode.toUpperCase() === 'IN' && s.residencyType === 'resident');
}

/**
 * The Indiana facts of a full-year resident return: its exemptions, its
 * county, and what the return does not settle. `federalAGI` (IT-40 line 1)
 * sets line 5; without it, line 5 is not figured.
 */
export function assessIndiana(taxReturn: TaxReturn, federalAGI?: number): IndianaAssessment {
  const year = taxReturn.taxYear || 2025;
  const config = residentConfig(taxReturn);
  const zero: IndianaExemptions = { line1: 0, line2: 0, line3: 0, line4: 0, line5: 0, line6: 0, total: 0 };
  if (!config) return { applies: false, findings: [], questions: [], exemptions: zero, perryKentuckyIncome: 0, countyTaxWithheld: 0 };

  const findings: UnsupportedPattern[] = [];
  const asked: Question[] = [];
  const relevant: Question[] = [];
  const find = (itemId: string, message: string, question?: Question) => {
    findings.push({
      ruleId: 'TAX-006', jurisdiction: 'IN', section: 'state', itemId, message,
      ...(question ? { question: { stateCode: 'IN', ...question } } : {}),
    });
    if (question) asked.push(question);
  };
  const joint = taxReturn.filingStatus === FilingStatus.MarriedFilingJointly;
  const separate = taxReturn.filingStatus === FilingStatus.MarriedFilingSeparately;

  // ── Schedule 3: exemptions ──
  const dependents = taxReturn.dependents ?? [];
  const children: Dependent[] = [];
  const wards: Dependent[] = [];
  for (const d of dependents) {
    const rel = (d.relationship ?? '').trim();
    const child = CHILD.test(rel) || (FOSTER.test(rel) && d.monthsLivedWithYou >= 12);
    const maybeWard = !child && !FOSTER.test(rel) && !NOT_A_WARD.test(rel);
    if (!child && !maybeWard) continue;
    const young = youngEnough(d, year);
    if (young === undefined) {
      find(`dob:${d.id}`, `Indiana exemptions: enter ${nameOf(d)}'s date of birth. Indiana's additional exemption for a dependent child depends on age (Schedule 3, line 3).`);
    } else if (young) {
      (child ? children : wards).push(d);
    }
  }
  const newborns = children.filter((d) => birthYear(d.dateOfBirth) === year).length;

  let guardianChildren = 0;
  if (wards.length > 0) {
    const q: Question = {
      key: IN_ANSWER.guardianChildren, kind: 'count', max: wards.length,
      prompt: `How many of ${listNames(wards)} are dependents you are the legal guardian of?`,
    };
    relevant.push(q);
    const a = countAnswer(config, q.key, wards.length);
    if (a === undefined) find('guardian', `Indiana exemptions: a dependent you are the legal guardian of, under 19 or a full-time student under 24, gets Indiana's additional $1,500 exemption (Schedule 3, line 3).`, q);
    else guardianChildren = a;
  }
  let adoptedChildren = 0;
  if (children.length > 0) {
    const q: Question = {
      key: IN_ANSWER.adoptedChildren, kind: 'count', max: children.length,
      prompt: `How many of ${listNames(children)} are adopted children whose adoption was final by December 31, ${year}?`,
    };
    relevant.push(q);
    const a = countAnswer(config, q.key, children.length);
    if (a === undefined) find('adopted', `Indiana exemptions: each adopted child gets an additional $3,000 exemption (Schedule 3, line 6; Schedule IN-DEP-A).`, q);
    else adoptedChildren = a;
  }
  let firstTimeChildren = 0;
  const olderChildren = children.length - newborns + guardianChildren;
  if (olderChildren > 0) {
    const q: Question = {
      key: IN_ANSWER.firstTimeChildren, kind: 'count', max: olderChildren,
      prompt: `How many of the children claimed for Indiana's additional dependent exemption are claimed for it for the first time — it could not have been claimed for them in an earlier year?${newborns > 0 ? ` A child born in ${year} is counted already.` : ''}`,
    };
    relevant.push(q);
    const a = countAnswer(config, q.key, olderChildren);
    if (a === undefined) find('first-time', `Indiana exemptions: the additional dependent exemption is $3,000 instead of $1,500 for the first year it can be claimed for a child (Schedule IN-DEP, box F).`, q);
    else firstTimeChildren = a;
  }

  const you65 = is65(taxReturn.dateOfBirth, year);
  const spouse65 = joint && is65(taxReturn.spouseDateOfBirth, year);
  const line5Limit = separate ? 20000 : 40000;
  const exemptions: IndianaExemptions = {
    line1: joint ? 2000 : 1000,
    line2: 1000 * dependents.length,
    line3: 1500 * (children.length + guardianChildren + newborns + firstTimeChildren),
    line4: 1000 * [you65, taxReturn.isLegallyBlind === true, spouse65, joint && taxReturn.spouseIsLegallyBlind === true].filter(Boolean).length,
    line5: federalAGI !== undefined && federalAGI < line5Limit ? 500 * [you65, spouse65].filter(Boolean).length : 0,
    line6: 3000 * adoptedChildren,
    total: 0,
  };
  exemptions.total = exemptions.line1 + exemptions.line2 + exemptions.line3 + exemptions.line4 + exemptions.line5 + exemptions.line6;

  // ── Schedule CT-40: county ──
  const rates = IN_COUNTY_TAX_RATES[year];
  const options = [
    ...IN_COUNTIES.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })),
    { value: NO_COUNTY, label: '00 None: stationed outside Indiana in the military on January 1' },
  ];
  const validCounty = (v: unknown): v is string => typeof v === 'string' && options.some((o) => o.value === v);
  let countyRate: number | undefined;
  let countyCode: string | undefined;
  let perryKentuckyIncome = 0;
  if (!rates) {
    find('county-rates', `Indiana county tax for ${year}: the Schedule CT-40 county rates for ${year} are not built in HATax. ${OUTSIDE}`);
  } else {
    const countyQ: Question = { key: IN_ANSWER.county, kind: 'choice', options, prompt: `Indiana county where you lived on January 1, ${year}` };
    relevant.push(countyQ);
    const county = answerOf(config, countyQ.key);
    if (!validCounty(county)) {
      find('county', `Indiana county tax (Schedule CT-40) is figured at the rate of the county where you lived on January 1, ${year}.`, countyQ);
    }
    let spouse: unknown = county;
    if (joint) {
      const spouseQ: Question = { key: IN_ANSWER.spouseCounty, kind: 'choice', options, prompt: `Indiana county where your spouse lived on January 1, ${year}` };
      relevant.push(spouseQ);
      spouse = answerOf(config, spouseQ.key);
      if (!validCounty(spouse)) {
        find('spouse-county', `Indiana county tax (Schedule CT-40) on a joint return uses the county where each spouse lived on January 1, ${year}.`, spouseQ);
      } else if (validCounty(county) && spouse !== county) {
        find('spouse-county', `Indiana county tax: the spouses lived in different counties on January 1, ${year}. Each spouse's share of IT-40 line 7 is taxed at their own county's rate, and HATax does not split the income and exemptions between spouses (Schedule CT-40, line 1). ${OUTSIDE}`);
      }
    }
    if (validCounty(county) && (!joint || spouse === county)) {
      countyCode = county;
      countyRate = county === NO_COUNTY ? 0 : rates[county];
    }
    if (county === IN_PERRY_COUNTY || spouse === IN_PERRY_COUNTY) {
      const q: Question = {
        key: IN_ANSWER.perryKentuckyIncome, kind: 'amount',
        prompt: 'Income taxed by Breckinridge, Hancock or Meade County, Kentucky, or a locality in them ($0 if none)',
      };
      relevant.push(q);
      const a = amountAnswer(config, q.key);
      if (a === undefined) find('perry', 'Indiana county tax: a Perry County resident who worked in Breckinridge, Hancock or Meade County, Kentucky, subtracts the Perry rate on income those localities taxed (Schedule CT-40, lines 5 and 6).', q);
      else perryKentuckyIncome = a;
    }
  }

  // ── IT-40 line 2: county tax withheld ──
  let countyTaxWithheld = 0;
  if (hasIndianaWithholdingForms(taxReturn)) {
    const q: Question = {
      key: IN_ANSWER.countyTaxWithheld, kind: 'amount',
      prompt: 'Indiana county tax withheld: the total of box 19 on the Indiana W-2s and other forms ($0 if none)',
    };
    relevant.push(q);
    const a = amountAnswer(config, q.key);
    if (a === undefined) find('county-withheld', 'Indiana county tax withheld is a payment (IT-40 line 2). HATax does not read the local tax boxes of the forms.', q);
    else countyTaxWithheld = a;
  }

  const questions = relevant
    .filter((q) => asked.some((a) => a.key === q.key) || answerOf(config, q.key) !== undefined)
    .map((q) => ({ stateCode: 'IN', ...q }));
  return { applies: true, findings, questions, exemptions, countyRate, countyCode, perryKentuckyIncome, countyTaxWithheld };
}

/** Schedule 3 total (IT-40 line 6) for a full-year resident. */
export function indianaExemptions(taxReturn: TaxReturn, federalAGI: number): IndianaExemptions {
  return assessIndiana(taxReturn, federalAGI).exemptions;
}

/**
 * Indiana's calculator: the flat-tax calculator (whose exemptions for a
 * full-year resident are Schedule 3's), plus the Schedule CT-40 county tax.
 */
export function withIndianaCountyTax(calculator: StateCalculator | null): StateCalculator | null {
  if (!calculator) return null;
  return {
    calculate(taxReturn, federalResult, config): StateCalculationResult {
      const result = calculator.calculate(taxReturn, federalResult, config);
      if (config.residencyType !== 'resident') return result;
      const indiana = assessIndiana(taxReturn, federalResult.form1040.agi);
      const line7 = result.stateTaxableIncome;
      const rate = indiana.countyRate ?? 0;
      const line4 = round2(Math.max(0, line7 * rate));
      const perryRate = IN_COUNTY_TAX_RATES[taxReturn.taxYear || 2025]?.[IN_PERRY_COUNTY] ?? 0;
      const line6 = round2(indiana.perryKentuckyIncome * perryRate);
      const countyTax = round2(Math.max(0, line4 - line6));
      const withholding = round2(result.stateWithholding + indiana.countyTaxWithheld);
      const totalStateTax = round2(result.totalStateTax + countyTax);
      const refundOrOwed = round2(withholding + result.stateEstimatedPayments - totalStateTax);
      const trace: CalculationTrace = {
        lineId: 'state.localTax', label: 'Indiana county tax (Schedule CT-40)', value: countyTax,
        authority: 'Schedule CT-40; IT-40 line 9',
        formula: line6 > 0 ? 'IT-40 line 7 × county rate − Kentucky locality income × Perry rate' : 'IT-40 line 7 × county rate',
        inputs: [
          { lineId: 'state.taxableIncome', label: 'IT-40 line 7', value: line7 },
          { lineId: 'in.countyRate', label: `County rate (${indiana.countyCode ?? 'not set'})`, value: rate },
          ...(line6 > 0 ? [{ lineId: 'in.perryOffset', label: 'Schedule CT-40 line 6', value: line6 }] : []),
        ],
      };
      return {
        ...result,
        localTax: countyTax,
        totalStateTax,
        stateWithholding: withholding,
        stateRefundOrOwed: refundOrOwed,
        effectiveStateRate: result.federalAGI > 0 ? Math.round((totalStateTax / result.federalAGI) * 10000) / 10000 : 0,
        additionalLines: {
          ...(result.additionalLines ?? {}),
          countyTax,
          countyRate: rate,
          countyTaxWithheld: indiana.countyTaxWithheld,
          ...(line6 > 0 ? { perryKentuckyOffset: line6 } : {}),
        },
        traces: [
          ...(result.traces ?? []).map((t): CalculationTrace => {
            if (t.lineId === 'state.totalTax') {
              return { ...t, value: totalStateTax, formula: `${t.formula ?? 'Income Tax'} + County Tax`, inputs: [...t.inputs, { lineId: 'state.localTax', label: 'County Tax', value: countyTax }] };
            }
            return t.lineId === 'state.refundOrOwed' ? { ...t, value: refundOrOwed } : t;
          }),
          trace,
        ],
      };
    },
  };
}
