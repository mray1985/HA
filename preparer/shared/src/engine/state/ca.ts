/**
 * California State Tax Calculator — Tax Years 2025 and 2026 (per-year tables in
 * constants/states/ca.ts; a 2026 amount the FTB has not published is held, see
 * `assessCalifornia`)
 *
 * Calculates:
 *   1. CA income tax (9 progressive brackets)
 *   2. Mental Health Services Tax (1% on income over $1M)
 *   3. Personal exemption credits
 *   4. CalEITC (California Earned Income Tax Credit)
 *   5. CA itemized deduction recalculation (no SALT cap, $1M mortgage limit)
 *
 * Starting point: Federal AGI → CA modifications → CA brackets
 *
 * Form 540 ordering (critical for MHST):
 *   Line 31: Tax from brackets
 *   Line 32: Exemption credits
 *   Lines 33-47: Other credits
 *   Line 48: Tax after credits
 *   Line 62: MHST added AFTER all credits (never reduced by credits)
 *   Line 64: Total tax
 */

import {
  TaxReturn, CalculationResult, StateCalculationResult,
  StateReturnConfig, FilingStatus, CalculationTrace,
  type StateQuestion, type UnsupportedPattern,
} from '../../types/index.js';
import {
  CA_MHST_THRESHOLD, CA_MHST_RATE,
  CA_MORTGAGE_LIMIT, CA_SECTION_179_LIMIT, CA_SECTION_179_THRESHOLD,
  CA_DEPENDENT_CARE_TABLE, CA_DEPENDENT_CARE_EXPENSE_LIMIT_1, CA_DEPENDENT_CARE_EXPENSE_LIMIT_2,
  CA_SENIOR_HOH_CREDIT_RATE, CA_DEPENDENT_PARENT_CREDIT_RATE,
  CA_ITEMIZED_LIMITATION_RATE, CA_ITEMIZED_LIMITATION_MAX_REDUCTION,
  CA_EXEMPTION_PHASEOUT_REDUCTION_PER_STEP, CA_EXEMPTION_PHASEOUT_STEP,
  californiaTables, type CaliforniaYearTables, type CalEitcTables,
} from '../../constants/states/ca.js';
import { parseDateString } from '../utils.js';
import { STATE_FORM_REFS, StateFormLineRefs } from '../../constants/states/stateFormRefs.js';
import { TraceBuilder } from '../traceBuilder.js';
import { applyBrackets, getStateEstimatedPayments, getStateWithholding, getStateFilingKey, getStateName } from './index.js';
import { round2 } from '../utils.js';
import { calculateForm4562 } from '../form4562.js';

// ─── CA Additions / Subtractions ────────────────────────────────

/**
 * CA additions to federal AGI (items CA taxes but federal doesn't).
 */
function getAdditions(taxReturn: TaxReturn, federalResult: CalculationResult): number {
  let additions = 0;

  // Out-of-state municipal bond interest (taxable in CA)
  const stateData = (taxReturn.stateReturns || []).find(s => s.stateCode === 'CA')?.stateSpecificData || {};
  const otherStateMuni = typeof stateData.otherStateMuniBondInterest === 'number'
    ? stateData.otherStateMuniBondInterest : 0;
  if (otherStateMuni > 0) additions += otherStateMuni;

  // Federal depreciation over California's (FTB 3885A): no §168(k) bonus, a smaller §179.
  const depreciation = caDepreciationAdjustment(taxReturn, federalResult);
  if (depreciation > 0) additions += depreciation;

  return round2(additions);
}

/**
 * CA subtractions from federal AGI (items federal taxes but CA doesn't).
 */
function getSubtractions(taxReturn: TaxReturn, federalResult: CalculationResult): number {
  let subtractions = 0;

  // CA fully exempts Social Security benefits (R&TC §17087)
  const ssaBenefits = federalResult.socialSecurity?.taxableBenefits || 0;
  if (ssaBenefits > 0) {
    subtractions += ssaBenefits;
  }

  // CA lottery winnings — exempt from CA income tax
  const stateData = (taxReturn.stateReturns || []).find(s => s.stateCode === 'CA')?.stateSpecificData || {};
  const lotteryWinnings = typeof stateData.caLotteryWinnings === 'number'
    ? stateData.caLotteryWinnings : 0;
  if (lotteryWinnings > 0) subtractions += lotteryWinnings;

  // Military pay subtraction (active-duty stationed outside CA)
  const militaryPay = typeof stateData.militaryPaySubtraction === 'number'
    ? stateData.militaryPaySubtraction : 0;
  if (militaryPay > 0) subtractions += militaryPay;

  // Railroad Retirement benefits — CA exempts like Social Security
  const railroadRetirement = typeof stateData.railroadRetirementBenefits === 'number'
    ? stateData.railroadRetirementBenefits : 0;
  if (railroadRetirement > 0) subtractions += railroadRetirement;

  // California depreciation over federal (FTB 3885A), e.g. a later year of an
  // asset whose federal basis went to bonus depreciation in its first year.
  const depreciation = caDepreciationAdjustment(taxReturn, federalResult);
  if (depreciation < 0) subtractions += -depreciation;

  return round2(subtractions);
}

/**
 * Federal depreciation of the Schedule C assets less California's (FTB 3885A,
 * 2025 instructions): California has not conformed to IRC §168(k) additional
 * depreciation, and its IRC §179 deduction is limited to $25,000, reduced by
 * the cost of §179 property placed in service over $200,000, with the
 * California basis reduced by the California §179 expense. California's figure
 * is the same Form 4562 computation with no special depreciation and those
 * limits. Positive: an addition on Schedule CA; negative: a subtraction.
 * What this cannot settle — an earlier year's §179 beyond California's limits,
 * a §179 limited by business income, a vehicle's depreciation — holds the
 * California return (engine/unsupported.ts).
 */
export function caDepreciationAdjustment(taxReturn: TaxReturn, federalResult: CalculationResult): number {
  const federal = federalResult.form4562;
  const assets = taxReturn.depreciationAssets ?? [];
  if (!federal || assets.length === 0) return 0;
  const california = calculateForm4562(
    assets.map((a) => ({ ...a, electOutOfBonus: true })),
    federal.section179BusinessIncomeLimit,
    taxReturn.taxYear || 2025,
    { maxDeduction: CA_SECTION_179_LIMIT, phaseOutThreshold: CA_SECTION_179_THRESHOLD },
    { priorDepreciationFromRates: true },
  );
  return round2(federal.totalDepreciation - california.totalDepreciation);
}

// ─── CA Itemized Deductions ─────────────────────────────────────

/**
 * Recalculate itemized deductions under CA rules (Schedule CA):
 * - No SALT cap (federal $40K OBBBA cap doesn't apply)
 * - CA state income tax is NOT deductible on CA return
 * - CA SDI is NOT deductible on CA return
 * - Mortgage interest: CA uses $1M limit (pre-TCJA), not federal $750K
 * - Medical, charitable: CA conforms to federal rules, except the 2026 federal
 *   0.5%-of-AGI charitable floor (IRC §170(b)(1)(I), P.L. 119-21, enacted after
 *   California's specified date of January 1, 2025 — R&TC §17024.5)
 */
function calculateCAItemizedDeductions(
  taxReturn: TaxReturn,
  federalResult: CalculationResult,
  filingKey: string,
  caAGI: number,
  threshold: number | undefined,
): number {
  const itemized = taxReturn.itemizedDeductions;
  if (!itemized) return 0;

  const sa = federalResult.scheduleA;
  if (!sa) return 0;

  // Medical: CA conforms — reuse federal calculation
  const medical = Math.max(0, sa.medicalDeduction);

  // SALT: re-derive without federal cap, excluding CA state income tax and SDI
  // Sum W-2 state tax withheld for non-CA states only (other states' taxes are deductible)
  let otherStateTaxWithheld = 0;
  for (const w2 of taxReturn.w2Income || []) {
    if (w2.state && w2.state.toUpperCase() !== 'CA' && w2.stateTaxWithheld) {
      otherStateTaxWithheld += w2.stateTaxWithheld;
    }
  }
  // Real estate and personal property tax — no cap
  const realEstateTax = itemized.realEstateTax || 0;
  const personalPropertyTax = itemized.personalPropertyTax || 0;
  const caSALT = round2(otherStateTaxWithheld + realEstateTax + personalPropertyTax);

  // Mortgage interest: CA $1M/$500K limit vs federal $750K/$375K
  const caMortgageLimit = CA_MORTGAGE_LIMIT[filingKey] || 1000000;
  let mortgageInterest = itemized.mortgageInterest || 0;
  const mortgageBalance = itemized.mortgageBalance || 0;

  if (mortgageBalance > 0 && mortgageInterest > 0) {
    // If balance exceeds CA limit, pro-rate the interest
    if (mortgageBalance > caMortgageLimit) {
      mortgageInterest = round2(mortgageInterest * (caMortgageLimit / mortgageBalance));
    }
    // If balance is between federal limit and CA limit, CA allows full deduction
    // (already handled — we only limit at CA threshold)
  }
  const mortgageInsurance = itemized.mortgageInsurancePremiums || 0;

  // Charitable: CA conforms — reuse federal calculation, without the federal 0.5% floor
  const charitable = Math.max(0, sa.charitableDeduction) + Math.max(0, sa.charitableFloorReduction ?? 0);

  // Other deductions: pass through
  const otherDeductions = Math.max(0, sa.otherDeduction);

  const totalBeforeLimitation = round2(
    medical +
    Math.max(0, caSALT) +
    Math.max(0, mortgageInterest) +
    Math.max(0, mortgageInsurance) +
    charitable +
    otherDeductions
  );

  // ── CA Itemized Deduction Limitation (Pease-style phase-out) ──
  // Medical expenses are exempt from the limitation.
  // All other categories are subject to reduction.
  // A year whose threshold is not published: held when AGI is over last year's (assessCalifornia).
  if (threshold === undefined || caAGI <= threshold) return totalBeforeLimitation;

  const subjectAmount = round2(totalBeforeLimitation - medical);
  if (subjectAmount <= 0) return totalBeforeLimitation;

  const excess = caAGI - threshold;
  const reductionFromRate = round2(excess * CA_ITEMIZED_LIMITATION_RATE);
  const reductionFromCap = round2(subjectAmount * CA_ITEMIZED_LIMITATION_MAX_REDUCTION);
  const reduction = Math.min(reductionFromRate, reductionFromCap);

  return round2(medical + Math.max(0, subjectAmount - reduction));
}

// ─── CA Credits ─────────────────────────────────────────────────

/** Age 65 by December 31 (a 65th birthday on January 1 of the next year counts: Form 540 line 9). */
function age65(dateOfBirth: string | undefined, year: number): boolean {
  const dob = dateOfBirth ? parseDateString(dateOfBirth) : null;
  if (!dob) return false;
  return dob.year <= year - 65 || (dob.year === year - 64 && dob.month === 0 && dob.day === 1);
}

/** A dependent mother or father (dependent parent credit). */
const PARENT = /^(parent|mother|father)$/i;
/** A qualifying child's relationship for CalEITC (FTB 3514, Step 3). */
const EITC_CHILD = /^(child|son|daughter|step ?(child|son|daughter)|foster ?child|brother|sister|half ?(brother|sister)|step ?(brother|sister)|grand ?(child|son|daughter)|niece|nephew)$/i;

/** California's answers kept in the CA state return (stateSpecificData). */
export const CA_ANSWERS = {
  livedApart: 'livedApartLast6Months',
  parentHome: 'parentHomeExpenses',
  seniorHoh: 'seniorHohPriorYears',
  yctcNetLoss: 'yctcTotalNetLoss',
} as const;

type Answers = Record<string, unknown>;

/** Married filing separately and living apart from the spouse for the last six months: the return's answer, or the CA answer. */
function livedApartLast6Months(taxReturn: TaxReturn, answers: Answers): boolean | undefined {
  if (taxReturn.livedApartFromSpouse === true) return true;
  const a = answers[CA_ANSWERS.livedApart];
  return typeof a === 'boolean' ? a : undefined;
}

function parentDependents(taxReturn: TaxReturn) {
  return (taxReturn.dependents || []).filter((d) => PARENT.test((d.relationship || '').trim()));
}

function seniorHohCandidate(taxReturn: TaxReturn, year: number): boolean {
  return age65(taxReturn.dateOfBirth, year)
    || (taxReturn.filingStatus === FilingStatus.MarriedFilingJointly && age65(taxReturn.spouseDateOfBirth, year));
}

/** Form 540 lines 7–10: the boxes for personal, blind and senior exemptions, and the dependents. */
function exemptionCounts(taxReturn: TaxReturn, filingKey: string, year: number) {
  const joint = taxReturn.filingStatus === FilingStatus.MarriedFilingJointly;
  // Someone else can claim the taxpayer: no personal, blind or senior credit for them (line 6, R&TC §17054(h)).
  const dependentOfAnother = taxReturn.canBeClaimedAsDependent === true;
  const personal = filingKey === 'married_joint' ? (dependentOfAnother ? 1 : 2) : (dependentOfAnother ? 0 : 1);
  const blind = (!dependentOfAnother && taxReturn.isLegallyBlind ? 1 : 0) + (joint && taxReturn.spouseIsLegallyBlind ? 1 : 0);
  const senior = (!dependentOfAnother && age65(taxReturn.dateOfBirth, year) ? 1 : 0)
    + (joint && age65(taxReturn.spouseDateOfBirth, year) ? 1 : 0);
  return { personal, blind, senior, dependents: taxReturn.dependents?.length || 0 };
}

/**
 * Form 540 line 32: personal, blind and senior exemption credits (lines 7–9)
 * and dependent exemption credits (line 10), limited by the AGI Limitation
 * Worksheet when federal AGI is over the threshold: $6 less per exemption for
 * each $2,500 ($1,250 MFS), or part, of the excess.
 */
function calculatePersonalExemptionCredits(
  counts: ReturnType<typeof exemptionCounts>,
  filingKey: string,
  federalAGI: number,
  t: CaliforniaYearTables,
): number {
  const boxes = counts.personal + counts.blind + counts.senior;
  const personalAmount = boxes * t.exemptionCredit;
  const dependentAmount = counts.dependents * t.dependentExemptionCredit;

  // A year whose threshold is not published is held when AGI is over last year's (assessCalifornia).
  const threshold = t.agiLimitationThreshold?.[filingKey];
  const agi = Math.round(federalAGI);
  if (threshold === undefined || agi <= threshold) return personalAmount + dependentAmount;

  const steps = Math.ceil((agi - threshold) / (CA_EXEMPTION_PHASEOUT_STEP[filingKey] ?? 2500));
  const perExemption = CA_EXEMPTION_PHASEOUT_REDUCTION_PER_STEP * steps;
  return Math.max(0, personalAmount - perExemption * boxes) + Math.max(0, dependentAmount - perExemption * counts.dependents);
}

/** What FTB 3514 is figured from. */
interface CaEitcFacts {
  /** Line 19: California wages (W-2 box 16) plus business income (Worksheet 3). */
  earnedIncome: number;
  /** Line 23a: all wages, California or not. */
  totalWages: number;
  federalAGI: number;
  /** Worksheet 1. */
  investmentIncome: number;
  qualifyingChildren: number;
  /** Qualifying children younger than 6 at the end of the year (YCTC). */
  youngChildren: number;
  /** Line 17 before California's floor at zero (YCTC's total net loss). */
  californiaAGI: number;
}

function caEitcFacts(taxReturn: TaxReturn, federalResult: CalculationResult, federalAGI: number, californiaAGI: number): CaEitcFacts {
  const f = federalResult.form1040;
  const year = taxReturn.taxYear || 2025;
  const combat = taxReturn.includeCombatPayForEITC ? Math.max(0, taxReturn.nontaxableCombatPay || 0) : 0;
  // Line 13: wages subject to California withholding — a California W-2's box 16 (a W-2 with no state is taken as California's).
  let caWages = 0;
  let totalWages = combat;
  for (const w of taxReturn.w2Income || []) {
    const wages = w.wages || 0;
    totalWages += wages;
    const state = (w.state || '').trim().toUpperCase();
    if (!state) caWages += wages;
    else if (state === 'CA') caWages += w.stateWages ?? wages;
  }
  // Worksheet 3: Schedule 1 lines 3 and 6, K-1 box 14 code A, less the deductible part of SE tax.
  const business = round2((f.scheduleCNetProfit || 0) + (f.scheduleFNetProfit || 0) + (f.k1SEIncome || 0) - (f.seDeduction || 0));
  const earnedIncome = round2(caWages + combat + business);
  // Worksheet 1: interest (taxable and tax-exempt), dividends, capital gain net income, net passive (rental and royalty) income.
  const investmentIncome = round2(
    (f.totalInterest || 0) + (f.taxExemptInterest || 0) + (f.totalDividends || 0)
    + Math.max(0, federalResult.scheduleD?.netGainOrLoss || 0) + Math.max(0, f.scheduleEIncome || 0),
  );
  const children = (taxReturn.dependents || []).filter((d) => {
    if (!EITC_CHILD.test((d.relationship || '').trim())) return false;
    if ((d.monthsLivedWithYou ?? 0) < 7) return false;               // more than half the year
    if (d.isDisabled) return true;
    const dob = d.dateOfBirth ? parseDateString(d.dateOfBirth) : null;
    if (!dob) return false;
    const age = year - dob.year;
    return age < 19 || (age < 24 && d.isStudent === true);
  });
  const youngChildren = children.filter((d) => {
    const dob = d.dateOfBirth ? parseDateString(d.dateOfBirth) : null;
    return dob !== null && year - dob.year < 6;
  }).length;
  return {
    earnedIncome, totalWages: round2(totalWages), federalAGI, investmentIncome,
    qualifyingChildren: Math.min(children.length, 3), youngChildren, californiaAGI,
  };
}

/**
 * The CalEITC tests other than the amount of earned income (FTB 3514 Steps 1–4):
 * federal AGI and investment income within the limits; not someone else's
 * dependent; 18 or older without a qualifying child; married filing separately
 * only with a qualifying child and living apart for the last six months.
 * Undefined when a fact is not answered yet (asked by assessCalifornia).
 */
function caEitcOtherwiseAllowed(taxReturn: TaxReturn, facts: CaEitcFacts, e: CalEitcTables, answers: Answers): boolean | undefined {
  const year = taxReturn.taxYear || 2025;
  if (taxReturn.canBeClaimedAsDependent === true) return false;
  if (Math.round(facts.federalAGI) > e.limit) return false;
  if (facts.investmentIncome > e.investmentIncomeLimit) return false;
  if (facts.qualifyingChildren === 0) {
    const adult = (dob: string | undefined) => {
      const d = dob ? parseDateString(dob) : null;
      return !d || year - d.year >= 18;
    };
    if (!adult(taxReturn.dateOfBirth) && !(taxReturn.filingStatus === FilingStatus.MarriedFilingJointly && adult(taxReturn.spouseDateOfBirth))) return false;
  }
  if (taxReturn.filingStatus === FilingStatus.MarriedFilingSeparately) {
    if (facts.qualifyingChildren === 0) return false;
    return livedApartLast6Months(taxReturn, answers);
  }
  return true;
}

/** The EITC Table's credit for an amount, in whole dollars; zero outside the table. */
function eitcTableCredit(amount: number, children: number, e: CalEitcTables): number {
  const whole = Math.round(amount);
  if (whole < 1 || whole > e.limit) return 0;
  return e.table[Math.ceil(whole / 50) - 1]?.[Math.min(children, 3)] ?? 0;
}

/**
 * CalEITC (FTB 3514, California Earned Income Tax Credit Worksheet): the
 * table's amount for earned income; when federal AGI differs and is at least
 * Part II's amount, the smaller of that and the table's amount for federal AGI.
 */
function calculateCalEITC(taxReturn: TaxReturn, facts: CaEitcFacts, e: CaliforniaYearTables['calEitc'], answers: Answers): number {
  // A year whose table is not published: held (assessCalifornia).
  if (!e || facts.earnedIncome <= 0) return 0;
  if (caEitcOtherwiseAllowed(taxReturn, facts, e, answers) !== true) return 0;
  const credit = eitcTableCredit(facts.earnedIncome, facts.qualifyingChildren, e);
  if (credit === 0) return 0;
  const agi = Math.round(facts.federalAGI);
  if (agi === Math.round(facts.earnedIncome) || agi < e.agiTestStart[facts.qualifyingChildren]!) return credit;
  return Math.min(credit, eitcTableCredit(agi, facts.qualifyingChildren, e));
}

/**
 * YCTC's total net loss (FTB 3514 line 23b): losses over income for the year
 * without utilization limits or earlier years' carryovers. Known when no
 * capital or passive loss is limited and none is carried in; otherwise the CA
 * answer.
 */
function yctcNetLoss(taxReturn: TaxReturn, federalResult: CalculationResult, facts: CaEitcFacts, answers: Answers): number | undefined {
  const carriedIn = (taxReturn.capitalLossCarryforward || 0) + (taxReturn.capitalLossCarryforwardST || 0) + (taxReturn.capitalLossCarryforwardLT || 0);
  const limited = (federalResult.scheduleD?.capitalLossCarryforward || 0) > 0 || (federalResult.form8582?.totalSuspendedLoss || 0) > 0;
  if (carriedIn === 0 && !limited) return Math.max(0, -facts.californiaAGI);
  const a = answers[CA_ANSWERS.yctcNetLoss];
  return typeof a === 'number' && Number.isFinite(a) && a >= 0 ? a : undefined;
}

/**
 * Young Child Tax Credit (FTB 3514 Part VII): one credit per return with a
 * qualifying child under 6, for a filer allowed CalEITC — or, with earned
 * income of zero or less, one who otherwise would be and whose total net loss
 * and total wages are not over the limit. Over the threshold it is reduced by
 * $21.71 for each $100 (lines 25–27, two decimals, not rounded); a credit
 * between $0 and $1 is $1, over $1 rounded to the dollar (line 28).
 */
function calculateYCTC(
  taxReturn: TaxReturn,
  federalResult: CalculationResult,
  facts: CaEitcFacts,
  calEITC: number,
  t: CaliforniaYearTables,
  answers: Answers,
): number {
  const y = t.yctc;
  // A year whose amounts are not published: held (assessCalifornia).
  if (!y || !t.calEitc || facts.youngChildren === 0) return 0;
  if (facts.earnedIncome > 0) {
    if (calEITC <= 0) return 0;
  } else {
    if (caEitcOtherwiseAllowed(taxReturn, facts, t.calEitc, answers) !== true) return 0;
    if (facts.totalWages > y.wagesLimit) return 0;
    const netLoss = yctcNetLoss(taxReturn, federalResult, facts, answers);
    if (netLoss === undefined || netLoss > y.netLossLimit) return 0;
  }
  if (facts.earnedIncome <= y.phaseOutStart) return y.credit;
  const truncate2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
  const line26 = truncate2((facts.earnedIncome - y.phaseOutStart) / 100);
  const line27 = truncate2(line26 * y.reductionPer100);
  const credit = y.credit - line27;
  return credit <= 0 ? 0 : credit < 1 ? 1 : Math.round(credit);
}

/**
 * CA Renter's Credit — nonrefundable credit for qualifying renters
 * with CA AGI below a filing-status-specific threshold.
 */
function calculateRentersCredit(
  caAGI: number,
  filingKey: string,
  isRenter: boolean,
  rentersCredit: CaliforniaYearTables['rentersCredit'],
): number {
  if (!isRenter) return 0;
  const entry = rentersCredit[filingKey];
  if (!entry || caAGI > entry.agiLimit) return 0;
  return entry.credit;
}

/**
 * CA Dependent Care Credit (Form 3506) — nonrefundable credit
 * for child/dependent care expenses. Separate from federal.
 */
function calculateCADependentCareCredit(
  taxReturn: TaxReturn,
  caAGI: number,
): number {
  const dc = taxReturn.dependentCare;
  if (!dc || dc.totalExpenses <= 0) return 0;

  // Find the CA rate based on AGI
  let rate = 0;
  for (const tier of CA_DEPENDENT_CARE_TABLE) {
    if (caAGI <= tier.maxAGI) {
      rate = tier.rate;
      break;
    }
  }
  if (rate === 0) return 0; // AGI over $100K → no credit

  // Expense limit: $3K for 1, $6K for 2+
  const expenseLimit = dc.qualifyingPersons >= 2
    ? CA_DEPENDENT_CARE_EXPENSE_LIMIT_2
    : CA_DEPENDENT_CARE_EXPENSE_LIMIT_1;

  // Reduce by employer FSA benefits
  const fsaReduction = dc.dependentCareFSA || 0;
  const qualifiedExpenses = Math.min(dc.totalExpenses - fsaReduction, expenseLimit);
  if (qualifiedExpenses <= 0) return 0;

  return round2(qualifiedExpenses * rate);
}

/**
 * CA Senior Head of Household Credit — code 163 (2025 Form 540 instructions):
 * 65 or older by December 31; head of household in either of the two prior
 * years for a qualifying individual who died during one of them (the CA
 * answer); AGI not over the limit. 2% of taxable income, at most the maximum,
 * in whole dollars. This year's filing status does not matter.
 */
function calculateSeniorHoHCredit(
  taxReturn: TaxReturn,
  caAGI: number,
  taxableIncome: number,
  senior: CaliforniaYearTables['seniorHoH'],
  answers: Answers,
): number {
  // A year whose amounts are not published: held (assessCalifornia).
  if (!senior) return 0;
  if (!seniorHohCandidate(taxReturn, taxReturn.taxYear || 2025) || caAGI > senior.agiLimit) return 0;
  // Unanswered: asked and held (assessCalifornia).
  if (answers[CA_ANSWERS.seniorHoh] !== true) return 0;
  return Math.min(Math.round(Math.round(taxableIncome) * CA_SENIOR_HOH_CREDIT_RATE), senior.credit);
}

/**
 * CA Dependent Parent Credit — code 173 (2025 Form 540 instructions): married
 * filing separately; the spouse not a member of the household for the last six
 * months; more than half the household expenses of a dependent mother's or
 * father's home paid (the CA answers). One credit per return: 30% of line 35,
 * at most the maximum, in whole dollars.
 */
function calculateDependentParentCredit(
  taxReturn: TaxReturn,
  filingKey: string,
  line35: number,
  max: number | undefined,
  answers: Answers,
): number {
  // A year whose amount is not published: held (assessCalifornia).
  if (max === undefined || filingKey !== 'married_separate') return 0;
  if (parentDependents(taxReturn).length === 0) return 0;
  // Unanswered: asked and held (assessCalifornia).
  if (livedApartLast6Months(taxReturn, answers) !== true || answers[CA_ANSWERS.parentHome] !== true) return 0;
  return Math.min(Math.round(Math.max(0, Math.round(line35)) * CA_DEPENDENT_PARENT_CREDIT_RATE), max);
}

/**
 * Mental Health Services Tax (MHST) — Proposition 63.
 * Additional 1% on taxable income exceeding $1,000,000.
 */
function calculateMHST(taxableIncome: number): number {
  if (taxableIncome <= CA_MHST_THRESHOLD) return 0;
  return round2((taxableIncome - CA_MHST_THRESHOLD) * CA_MHST_RATE);
}

/**
 * What California's credits need that the return does not say, and the
 * amounts the FTB has not published for the year (2026: late December). Each
 * is a finding — answered, or held until published — never taken as zero.
 *
 * Questions (kept in the CA state answers):
 * - livedApartLast6Months: married filing separately, for CalEITC with a
 *   qualifying child and for the dependent parent credit;
 * - parentHomeExpenses: the dependent parent credit;
 * - seniorHohPriorYears: the senior head of household credit;
 * - yctcTotalNetLoss: YCTC with no earned income, when a loss is limited or
 *   carried in.
 *
 * Unpublished amounts (held where they can matter):
 * - the AGI threshold of the exemption credit phase-out and the itemized
 *   deduction limitation (R&TC §17054.1, §17077), when AGI is over last
 *   year's — the threshold is recomputed by the year's CCPI change (3.4% for
 *   2026), so AGI at or under last year's is under this year's too;
 * - CalEITC and YCTC, when earned income (and federal AGI) is within last
 *   year's limit recomputed by the CCPI change (R&TC §17052(c)(4)(A)), rounded
 *   up to the next $100;
 * - the senior head of household and dependent parent credits, when the
 *   answers allow them.
 */
export function assessCalifornia(taxReturn: TaxReturn, calculation: CalculationResult | null | undefined): { findings: UnsupportedPattern[]; questions: StateQuestion[] } {
  const year = taxReturn.taxYear || 2025;
  const t = californiaTables(year);
  const config = (taxReturn.stateReturns ?? []).find((s) => s.stateCode.toUpperCase() === 'CA');
  const result = calculation?.stateResults?.find((r) => r.stateCode === 'CA');
  const none = { findings: [], questions: [] };
  if (!t || !config || !calculation || !result || result.additionalLines?.unavailable === 1) return none;

  const answers: Answers = config.stateSpecificData ?? {};
  const prior = californiaTables(year - 1);
  const growth = 1 + (t.ccpiChange ?? 0);
  const upTo100 = (n: number) => Math.ceil(n / 100) * 100;
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const filingKey = getStateFilingKey(taxReturn.filingStatus);
  const federalAGI = calculation.form1040.agi;
  const rawCaAGI = round2(federalAGI + getAdditions(taxReturn, calculation) - getSubtractions(taxReturn, calculation));
  const caAGI = Math.max(0, rawCaAGI);
  const facts = caEitcFacts(taxReturn, calculation, federalAGI, rawCaAGI);
  const mfs = filingKey === 'married_separate';
  const parents = parentDependents(taxReturn);

  const findings: UnsupportedPattern[] = [];
  const questions: StateQuestion[] = [];
  const ask = (q: Omit<StateQuestion, 'stateCode'>, message: string) => {
    const question: StateQuestion = { stateCode: 'CA', ...q };
    questions.push(question);
    if (answers[q.key] === undefined) {
      findings.push({ ruleId: 'CA.CREDIT.FACTS', jurisdiction: 'CA', section: 'state', itemId: q.key, message, question });
    }
  };
  const hold = (itemId: string, message: string) => findings.push({
    ruleId: 'CA.YEAR.UNPUBLISHED', jurisdiction: 'CA', section: 'state', itemId,
    message: `${message} Prepare the California return when the FTB publishes them, or outside HATax.`,
  });

  // CalEITC / YCTC limit: the year's, or last year's recomputed by the CCPI change.
  const eitcLimit = t.calEitc?.limit ?? (prior?.calEitc ? upTo100(prior.calEitc.limit * growth) : undefined);
  const inEitcRange = eitcLimit !== undefined && Math.round(federalAGI) <= eitcLimit && facts.earnedIncome <= eitcLimit;

  // ── Questions ──
  const livedApart = livedApartLast6Months(taxReturn, answers);
  if (mfs && taxReturn.livedApartFromSpouse !== true && (parents.length > 0 || (facts.qualifyingChildren > 0 && inEitcRange))) {
    ask({ key: CA_ANSWERS.livedApart, kind: 'yes_no', prompt: `Did the taxpayer and spouse live apart (the spouse not a member of the household) for the last 6 months of ${year}?` },
      `California: married filing separately — whether the taxpayer and spouse lived apart for the last 6 months of ${year} decides the CalEITC and the dependent parent credit.`);
  }
  if (mfs && parents.length > 0 && livedApart !== false) {
    const names = parents.map((d) => [d.firstName, d.lastName].filter(Boolean).join(' ')).filter(Boolean).join(', ');
    ask({ key: CA_ANSWERS.parentHome, kind: 'yes_no', prompt: `Did the taxpayer pay more than half the household expenses of the dependent parent's home${names ? ` (${names})` : ''}, whether or not the parent lived there?` },
      `California dependent parent credit: whether the taxpayer paid more than half the household expenses of the dependent parent's home.`);
  }
  const seniorLimit = t.seniorHoH?.agiLimit ?? (prior?.seniorHoH ? upTo100(prior.seniorHoH.agiLimit * growth) : undefined);
  if (seniorLimit !== undefined && seniorHohCandidate(taxReturn, year) && caAGI <= seniorLimit) {
    ask({ key: CA_ANSWERS.seniorHoh, kind: 'yes_no', prompt: `Did the taxpayer qualify as head of household in ${year - 2} or ${year - 1} by providing a household for a qualifying person who died in ${year - 2} or ${year - 1}?` },
      `California senior head of household credit: whether the taxpayer was head of household in ${year - 2} or ${year - 1} for a qualifying person who died in one of those years.`);
  }
  if (t.yctc && t.calEitc && facts.youngChildren > 0 && facts.earnedIncome <= 0 && facts.totalWages <= t.yctc.wagesLimit
      && caEitcOtherwiseAllowed(taxReturn, facts, t.calEitc, answers) !== false) {
    const carriedIn = (taxReturn.capitalLossCarryforward || 0) + (taxReturn.capitalLossCarryforwardST || 0) + (taxReturn.capitalLossCarryforwardLT || 0);
    const limited = (calculation.scheduleD?.capitalLossCarryforward || 0) > 0 || (calculation.form8582?.totalSuspendedLoss || 0) > 0;
    if (carriedIn > 0 || limited) {
      ask({ key: CA_ANSWERS.yctcNetLoss, kind: 'amount', prompt: `Young Child Tax Credit: the total net loss for ${year} — losses over income, before the capital and passive loss limits and without losses carried from earlier years (0 if none).` },
        `California Young Child Tax Credit: with no earned income it is allowed only if the total net loss is not over ${money(t.yctc.netLossLimit)}; a loss is limited or carried in, so enter the total net loss.`);
    }
  }

  // ── Amounts not published for the year ──
  const threshold = prior?.agiLimitationThreshold?.[filingKey];
  if (!t.agiLimitationThreshold && threshold !== undefined) {
    const over = [
      federalAGI > threshold ? `federal AGI (${money(federalAGI)}) for the exemption credit phase-out` : '',
      taxReturn.deductionMethod === 'itemized' && caAGI > threshold ? `California AGI (${money(caAGI)}) for the itemized deduction limitation` : '',
    ].filter(Boolean);
    if (over.length > 0) {
      hold('agiThreshold', `California's ${year} AGI threshold for the exemption credit phase-out and the itemized deduction limitation is not published yet (the FTB publishes it in late December). This return's ${over.join(' and ')} is over the ${year - 1} threshold (${money(threshold)}), so the phase-out may apply.`);
    }
  }
  if (!t.calEitc && prior?.calEitc && inEitcRange && facts.earnedIncome > 0) {
    hold('calEitc', `CalEITC: the ${year} credit table is not published yet. Earned income of ${money(facts.earnedIncome)} is within reach of the credit (the ${year - 1} limit, ${money(prior.calEitc.limit)}, recomputed by the ${year} CCPI change).`);
  }
  if (!t.yctc && prior?.yctc && inEitcRange && facts.youngChildren > 0) {
    hold('yctc', `Young Child Tax Credit: the ${year} amounts are not published yet, and the return has a qualifying child under 6 with income within reach of the credit.`);
  }
  if (!t.seniorHoH && prior?.seniorHoH && answers[CA_ANSWERS.seniorHoh] === true && seniorLimit !== undefined && caAGI <= seniorLimit && seniorHohCandidate(taxReturn, year)) {
    hold('seniorHoH', `Senior head of household credit: the ${year} credit and AGI limit are not published yet.`);
  }
  if (t.dependentParentMax === undefined && prior?.dependentParentMax !== undefined && mfs && parents.length > 0
      && livedApart === true && answers[CA_ANSWERS.parentHome] === true) {
    hold('dependentParent', `Dependent parent credit: the ${year} maximum is not published yet.`);
  }
  return { findings, questions };
}

/** Earned income for CalEITC and YCTC (FTB 3514 line 19), for this return. */
export function caEarnedIncome(taxReturn: TaxReturn, federalResult: CalculationResult): number {
  return caEitcFacts(taxReturn, federalResult, federalResult.form1040.agi, 0).earnedIncome;
}

// ─── Core Tax Computation (reusable for resident + 540NR) ───────

interface CACoreTaxResult {
  caAGI: number;
  additions: number;
  subtractions: number;
  deduction: number;
  taxableIncome: number;
  baseTax: number;
  mhst: number;
  bracketDetails: ReturnType<typeof applyBrackets>['details'];
  exemptionCredits: number;
  rentersCredit: number;
  caDependentCareCredit: number;
  seniorHoHCredit: number;
  dependentParentCredit: number;
  nonrefundableCredits: number;
  calEITC: number;
  yctc: number;
  refundableCredits: number;
  earnedIncome: number;
  qualifyingChildrenForEIC: number;
  /** Form 540 lines 7–10. */
  exemptionCounts: ReturnType<typeof exemptionCounts>;
}

/**
 * Compute core CA tax values for a given AGI.
 * Used by both resident path (actual AGI) and 540NR path (full-year AGI).
 */
function computeCACoreTax(
  agi: number,
  taxReturn: TaxReturn,
  federalResult: CalculationResult,
  config: StateReturnConfig,
): CACoreTaxResult {
  const filingKey = getStateFilingKey(taxReturn.filingStatus);
  const year = taxReturn.taxYear || 2025;
  // The registry offers California only for a year with tables; a direct call for another year uses 2025's.
  const t = californiaTables(year) ?? californiaTables(2025)!;
  const answers: Answers = config.stateSpecificData || {};

  const additions = getAdditions(taxReturn, federalResult);
  const subtractions = getSubtractions(taxReturn, federalResult);
  const rawCaAGI = round2(agi + additions - subtractions);
  const caAGI = Math.max(0, rawCaAGI);

  const standardDeduction = t.standardDeduction[filingKey] ?? t.standardDeduction.single!;
  let caItemized = 0;
  if (taxReturn.deductionMethod === 'itemized' && federalResult.scheduleA) {
    caItemized = calculateCAItemizedDeductions(taxReturn, federalResult, filingKey, caAGI, t.agiLimitationThreshold?.[filingKey]);
  }
  const deduction = Math.max(standardDeduction, caItemized);
  const taxableIncome = Math.max(0, caAGI - deduction);

  const brackets = t.brackets[filingKey] ?? t.brackets.single!;
  const { tax: baseTax, details: bracketDetails } = applyBrackets(taxableIncome, brackets);
  const mhst = calculateMHST(taxableIncome);

  const counts = exemptionCounts(taxReturn, filingKey, year);
  const exemptionCredits = calculatePersonalExemptionCredits(counts, filingKey, agi, t);

  const facts = caEitcFacts(taxReturn, federalResult, agi, rawCaAGI);
  const calEITC = calculateCalEITC(taxReturn, facts, t.calEitc, answers);
  const yctc = calculateYCTC(taxReturn, federalResult, facts, calEITC, t, answers);

  const isRenter = answers.isRenter === true;
  const rentersCredit = calculateRentersCredit(caAGI, filingKey, isRenter, t.rentersCredit);
  const caDependentCareCredit = calculateCADependentCareCredit(taxReturn, caAGI);
  const seniorHoHCredit = calculateSeniorHoHCredit(taxReturn, caAGI, taxableIncome, t.seniorHoH, answers);
  // Form 540 line 35: line 31 less line 32 (HATax has no Schedule G-1 or FTB 5870A tax for line 34).
  const line35 = Math.max(0, baseTax - exemptionCredits);
  const dependentParentCredit = calculateDependentParentCredit(taxReturn, filingKey, line35, t.dependentParentMax, answers);

  const nonrefundableCredits = exemptionCredits + rentersCredit + caDependentCareCredit + seniorHoHCredit + dependentParentCredit;
  const refundableCredits = calEITC + yctc;

  return {
    caAGI, additions, subtractions, deduction, taxableIncome,
    baseTax, mhst, bracketDetails,
    exemptionCredits, rentersCredit, caDependentCareCredit,
    seniorHoHCredit, dependentParentCredit, nonrefundableCredits,
    calEITC, yctc, refundableCredits, earnedIncome: facts.earnedIncome,
    qualifyingChildrenForEIC: facts.qualifyingChildren, exemptionCounts: counts,
  };
}

// ─── 540NR: Part-Year / Nonresident Calculator ──────────────────

/**
 * CA 540NR approach for part-year and nonresident filers.
 *
 * Method: Compute tax on ALL income as if full-year resident (Column A),
 * then multiply by CA income ratio (Column B / Column A).
 *
 * MHST is computed on full taxable income, then prorated.
 * Nonrefundable credits are prorated by the same ratio.
 * Refundable credits (CalEITC, YCTC) use CA-source earned income directly.
 */
function calculate540NR(
  taxReturn: TaxReturn,
  federalResult: CalculationResult,
  config: StateReturnConfig,
  tb: TraceBuilder,
  refs: StateFormLineRefs | undefined,
): StateCalculationResult {
  const stateData = config.stateSpecificData || {};
  const originalAGI = stateData._originalFederalAGI as number;
  const ratio = Math.min(1, Math.max(0, (stateData._allocationRatio as number) || 0));
  const allocatedAGI = federalResult.form1040.agi; // Already allocated by index.ts
  const filingKey = getStateFilingKey(taxReturn.filingStatus);

  // Column A: Full-year resident tax on ALL income
  // NOTE: federalResult here is the allocated version from index.ts, but
  // createAllocatedFederalResult() only modifies agi/taxableIncome/totalWages.
  // All other fields (scheduleCNetProfit, taxableInterest, ordinaryDividends,
  // rentalRealEstateIncome, scheduleD, scheduleA, form4562) are preserved at
  // original full-year values via spread. computeCACoreTax() gets the correct
  // full-year values for investment income, SE income, and deductions.
  const fullYear = computeCACoreTax(originalAGI, taxReturn, federalResult, config);

  // Prorated values
  const proratedBaseTax = round2(fullYear.baseTax * ratio);
  const proratedMHST = round2(fullYear.mhst * ratio);
  const proratedNonrefundable = round2(fullYear.nonrefundableCredits * ratio);

  // Refundable credits (FTB 3514 Steps 7 and 9): the full-year credit times the
  // California exemption credit percentage (the 540NR proration); a nonresident
  // of California for half the year or more cannot take them.
  const nonresident = config.residencyType === 'nonresident';
  const calEITC = nonresident ? 0 : round2(fullYear.calEITC * ratio);
  const yctc = nonresident ? 0 : round2(fullYear.yctc * ratio);
  const refundableCredits = calEITC + yctc;

  // Tax calculation (540NR method) — same MHST ordering as resident path:
  // Form 540NR: Line 63 = bracket tax after credits, Line 72 = MHST, Line 74 = total
  // Credits reduce prorated bracket tax only, MHST added after.
  const taxAfterNonrefundable = Math.max(0, round2(proratedBaseTax - proratedNonrefundable));
  const refundableUsedAgainstTax = Math.min(taxAfterNonrefundable, refundableCredits);
  const refundableExcess = refundableCredits - refundableUsedAgainstTax;
  const taxBeforeMHST = Math.max(0, round2(taxAfterNonrefundable - refundableUsedAgainstTax));
  const totalStateTax = round2(taxBeforeMHST + proratedMHST);

  // Traces for 540NR
  const caAGI = fullYear.caAGI;
  tb.trace('state.stateAGI', 'CA AGI (all income, 540NR Column A)', caAGI, {
    formula: 'Full-year AGI for 540NR calculation',
    inputs: [{ lineId: 'form1040.line11', label: 'Original Federal AGI', value: originalAGI }],
  });
  tb.trace('state.540nr.ratio', 'CA Income Ratio', ratio, {
    formula: 'CA-source income ÷ Total income',
    inputs: [
      { lineId: 'state.allocatedAGI', label: 'CA-Source Income', value: allocatedAGI },
      { lineId: 'form1040.line11', label: 'Total Income', value: originalAGI },
    ],
  });
  tb.trace('state.totalTax', 'California Total Tax (540NR)', totalStateTax, {
    formula: '(Bracket Tax × Ratio − Credits) + MHST × Ratio',
    inputs: [
      { lineId: 'state.baseTax', label: 'Full-Year Bracket Tax', value: fullYear.baseTax },
      ...(fullYear.mhst > 0 ? [{ lineId: 'state.mhst', label: 'Full-Year MHST', value: fullYear.mhst }] : []),
      { lineId: 'state.540nr.ratio', label: 'CA Ratio', value: ratio },
      ...(proratedNonrefundable > 0 ? [{ lineId: 'state.credits', label: 'Prorated Credits', value: proratedNonrefundable }] : []),
    ],
  });

  // Payments
  const stateWithholding = getStateWithholding(taxReturn, 'CA');
  const estimatedPayments = getStateEstimatedPayments(config);
  const refundOrOwed = round2(stateWithholding + estimatedPayments - totalStateTax + refundableExcess);

  const effectiveRate = allocatedAGI > 0
    ? Math.round((totalStateTax / allocatedAGI) * 10000) / 10000
    : 0;

  return {
    stateCode: 'CA',
    stateName: getStateName('CA'),
    residencyType: config.residencyType,
    federalAGI: allocatedAGI,
    stateAdditions: fullYear.additions,
    stateSubtractions: fullYear.subtractions,
    stateAGI: round2(caAGI * ratio),
    stateDeduction: round2(fullYear.deduction * ratio),
    stateTaxableIncome: round2(fullYear.taxableIncome * ratio),
    stateExemptions: 0,
    stateIncomeTax: round2(proratedBaseTax + proratedMHST),
    stateCredits: round2(proratedNonrefundable + refundableCredits),
    stateTaxAfterCredits: totalStateTax,
    localTax: 0,
    totalStateTax,
    stateWithholding,
    stateEstimatedPayments: estimatedPayments,
    stateRefundOrOwed: refundOrOwed,
    effectiveStateRate: effectiveRate,
    bracketDetails: fullYear.bracketDetails,
    allocationRatio: ratio,
    allocatedAGI,
    additionalLines: {
      baseTaxBeforeMHST: fullYear.baseTax,
      mentalHealthServicesTax: fullYear.mhst,
      proratedBaseTax,
      proratedMHST,
      proratedNonrefundableCredits: proratedNonrefundable,
      calEITC,
      youngChildTaxCredit: yctc,
      caIncomeRatio: ratio,
      originalFederalAGI: originalAGI,
      // Full-year values for 540NR PDF form lines
      fullYearCAGI: fullYear.caAGI,
      fullYearTaxableIncome: fullYear.taxableIncome,
      fullYearDeduction: fullYear.deduction,
      personalExemptionCredits: fullYear.exemptionCredits,
      rentersCredit: fullYear.rentersCredit,
      caDependentCareCredit: fullYear.caDependentCareCredit,
      seniorHoHCredit: fullYear.seniorHoHCredit,
      dependentParentCredit: fullYear.dependentParentCredit,
    },
    traces: tb.build(),
  };
}

// ─── Main Calculator ────────────────────────────────────────────

export function calculateCalifornia(
  taxReturn: TaxReturn,
  federalResult: CalculationResult,
  config: StateReturnConfig,
): StateCalculationResult {
  const f = federalResult.form1040;
  const filingKey = getStateFilingKey(taxReturn.filingStatus);
  const federalAGI = f.agi;
  const tb = new TraceBuilder();
  const refs = STATE_FORM_REFS['CA'];

  // ── 540NR: Part-year / Nonresident ─────────────
  const stateData = config.stateSpecificData || {};
  if (config.residencyType !== 'resident' && stateData._originalFederalAGI != null) {
    return calculate540NR(taxReturn, federalResult, config, tb, refs);
  }

  // ── Compute core tax using helper ───────────
  const core = computeCACoreTax(federalAGI, taxReturn, federalResult, config);
  const {
    caAGI, additions, subtractions, deduction, taxableIncome,
    baseTax, mhst, bracketDetails,
    exemptionCredits, rentersCredit, caDependentCareCredit,
    seniorHoHCredit, dependentParentCredit, nonrefundableCredits,
    calEITC, yctc, refundableCredits, earnedIncome, qualifyingChildrenForEIC,
  } = core;
  const numDependents = taxReturn.dependents?.length || 0;

  // ── Trace: CA AGI ──
  tb.trace(
    'state.stateAGI', 'California Adjusted Gross Income',
    caAGI, {
      authority: refs?.agiLine,
      formula: additions > 0 && subtractions > 0
        ? 'Federal AGI + Additions − Subtractions'
        : subtractions > 0 ? 'Federal AGI − Subtractions'
        : additions > 0 ? 'Federal AGI + Additions' : 'Federal AGI',
      inputs: [
        { lineId: 'form1040.line11', label: 'Federal AGI', value: federalAGI },
        ...(additions > 0 ? [{ lineId: 'state.additions', label: 'CA Additions', value: additions }] : []),
        ...(subtractions > 0 ? [{ lineId: 'state.subtractions', label: 'CA Subtractions', value: subtractions }] : []),
      ],
    },
  );

  // ── Trace: Taxable Income ──
  tb.trace(
    'state.taxableIncome', 'California Taxable Income',
    taxableIncome, {
      authority: refs?.taxableIncomeLine,
      formula: 'CA AGI − Deduction',
      inputs: [
        { lineId: 'state.stateAGI', label: 'CA AGI', value: caAGI },
        ...(deduction > 0 ? [{ lineId: 'state.deduction', label: 'Deduction', value: deduction }] : []),
      ],
    },
  );

  // ── Trace: Income Tax with bracket children + MHST ──
  const stateIncomeTax = baseTax + mhst;
  const bracketTraceChildren: CalculationTrace[] = bracketDetails
    .filter(b => b.taxAtRate > 0)
    .map(b => ({
      lineId: `state.bracket.${(b.rate * 100).toFixed(1)}pct`,
      label: `${(b.rate * 100).toFixed(1)}% bracket`,
      value: b.taxAtRate,
      formula: `${b.taxableAtRate.toLocaleString()} × ${(b.rate * 100).toFixed(1)}%`,
      inputs: [{ lineId: 'state.bracket.taxableAtRate', label: `Income at ${(b.rate * 100).toFixed(1)}%`, value: b.taxableAtRate }],
    }));
  if (mhst > 0) {
    bracketTraceChildren.push({
      lineId: 'state.mhst', label: '1.0% Mental Health Services Tax', value: mhst,
      formula: `(${taxableIncome.toLocaleString()} − ${CA_MHST_THRESHOLD.toLocaleString()}) × ${(CA_MHST_RATE * 100).toFixed(1)}%`,
      inputs: [{ lineId: 'state.taxableIncome', label: 'Taxable Income', value: taxableIncome }],
    });
  }
  tb.trace(
    'state.incomeTax', 'California Income Tax',
    stateIncomeTax, {
      authority: refs?.incomeTaxLine,
      formula: mhst > 0 ? 'Bracket Tax + MHST' : `Progressive brackets (CA)`,
      inputs: [{ lineId: 'state.taxableIncome', label: 'Taxable Income', value: taxableIncome }],
      children: bracketTraceChildren.length > 0 ? bracketTraceChildren : undefined,
    },
  );

  // ── Trace: Credits with children ──
  const creditChildren: CalculationTrace[] = [];
  if (exemptionCredits > 0) {
    creditChildren.push({
      lineId: 'state.credits.exemption', label: 'Personal Exemption Credits', value: exemptionCredits,
      formula: `${core.exemptionCounts.personal} personal + ${core.exemptionCounts.blind} blind + ${core.exemptionCounts.senior} senior + ${numDependents} dependent(s)`,
      inputs: [],
    });
  }
  if (rentersCredit > 0) {
    creditChildren.push({
      lineId: 'state.credits.renters', label: "Renter's Credit", value: rentersCredit,
      formula: `CA renter's credit`,
      inputs: [],
    });
  }
  if (caDependentCareCredit > 0) {
    creditChildren.push({
      lineId: 'state.credits.dependentCare', label: 'CA Dependent Care Credit', value: caDependentCareCredit,
      formula: 'Form 3506',
      inputs: [],
    });
  }
  if (seniorHoHCredit > 0) {
    creditChildren.push({
      lineId: 'state.credits.seniorHoH', label: 'Senior Head of Household Credit', value: seniorHoHCredit,
      formula: '2% of taxable income (code 163)',
      inputs: [],
    });
  }
  if (dependentParentCredit > 0) {
    creditChildren.push({
      lineId: 'state.credits.dependentParent', label: 'Dependent Parent Credit', value: dependentParentCredit,
      formula: '30% of Form 540 line 35 (code 173)',
      inputs: [],
    });
  }
  if (calEITC > 0) {
    creditChildren.push({
      lineId: 'state.credits.calEITC', label: 'CalEITC (Form 3514)', value: calEITC,
      formula: `FTB 3514 EITC Table (${qualifyingChildrenForEIC} qualifying child${qualifyingChildrenForEIC !== 1 ? 'ren' : ''})`,
      inputs: [{ lineId: 'state.earnedIncome', label: 'Earned Income', value: earnedIncome }],
    });
  }
  if (yctc > 0) {
    creditChildren.push({
      lineId: 'state.credits.yctc', label: 'Young Child Tax Credit', value: yctc,
      formula: 'YCTC (Form 3514 Part IV)',
      inputs: [{ lineId: 'state.earnedIncome', label: 'Earned Income', value: earnedIncome }],
    });
  }
  const totalCredits = tb.trace(
    'state.credits', 'California Credits',
    nonrefundableCredits + refundableCredits, {
      formula: creditChildren.length > 1
        ? creditChildren.map(c => c.label).join(' + ')
        : 'Exemption Credits',
      inputs: creditChildren.map(c => ({ lineId: c.lineId, label: c.label, value: c.value })),
      children: creditChildren.length > 0 ? creditChildren : undefined,
    },
  );

  // ── Step 7: Tax After Credits ────────────────
  // Form 540 ordering: credits reduce BRACKET tax only, NOT MHST.
  // Line 31: baseTax (bracket tax)
  // Line 32-47: subtract credits from baseTax
  // Line 48: taxAfterCredits = max(0, baseTax - nonrefundableCredits)
  // Line 62: MHST added here (never reduced by credits)
  // Line 64: totalTax = taxAfterCredits + MHST - refundable credits applied
  const taxAfterNonrefundable = Math.max(0, baseTax - nonrefundableCredits);
  const refundableUsedAgainstTax = Math.min(taxAfterNonrefundable, refundableCredits);
  const refundableExcess = refundableCredits - refundableUsedAgainstTax;

  // Total tax: bracket tax after credits + MHST (MHST never reduced by credits)
  const taxBeforeMHST = Math.max(0, taxAfterNonrefundable - refundableUsedAgainstTax);
  const totalStateTax = tb.trace(
    'state.totalTax', 'California Total Tax',
    taxBeforeMHST + mhst, {
      authority: refs?.totalTaxLine,
      formula: mhst > 0
        ? 'Tax After Credits + MHST'
        : totalCredits > 0 ? 'Income Tax − Credits' : 'Income Tax',
      inputs: [
        { lineId: 'state.baseTax', label: 'Bracket Tax', value: baseTax },
        ...(nonrefundableCredits > 0 ? [{ lineId: 'state.credits.exemption', label: 'Nonrefundable Credits', value: nonrefundableCredits }] : []),
        ...(refundableUsedAgainstTax > 0 ? [{ lineId: 'state.credits.calEITC', label: 'Refundable Credits (applied)', value: refundableUsedAgainstTax }] : []),
        ...(mhst > 0 ? [{ lineId: 'state.mhst', label: 'Mental Health Services Tax', value: mhst }] : []),
      ],
    },
  );

  // ── Step 8: Payments ─────────────────────────
  // CA has no separate local income tax (unlike NY/NYC)
  const localTax = 0;

  const stateWithholding = getStateWithholding(taxReturn, 'CA');
  const estimatedPayments = getStateEstimatedPayments(config);
  const totalPayments = stateWithholding + estimatedPayments;

  const refundOrOwedRaw = totalPayments - totalStateTax + refundableExcess;
  const refundOrOwed = tb.trace(
    'state.refundOrOwed',
    refundOrOwedRaw >= 0 ? 'California Refund' : 'California Amount Owed',
    refundOrOwedRaw, {
      authority: refs?.refundLine,
      formula: 'Withholding − Total Tax' + (refundableExcess > 0 ? ' + Refundable Credits' : ''),
      inputs: [
        { lineId: 'state.totalTax', label: 'Total State Tax', value: totalStateTax },
        ...(stateWithholding > 0 ? [{ lineId: 'state.withholding', label: 'Withholding', value: stateWithholding }] : []),
        ...(estimatedPayments > 0 ? [{ lineId: 'state.estimatedPayments', label: 'Estimated Payments', value: estimatedPayments }] : []),
        ...(refundableExcess > 0 ? [{ lineId: 'state.refundableExcess', label: 'Refundable Credits', value: refundableExcess }] : []),
      ],
    },
  );

  const effectiveRate = federalAGI > 0
    ? Math.round((totalStateTax / federalAGI) * 10000) / 10000
    : 0;

  return {
    stateCode: 'CA',
    stateName: getStateName('CA'),
    residencyType: config.residencyType,
    federalAGI,
    stateAdditions: additions,
    stateSubtractions: subtractions,
    stateAGI: caAGI,
    stateDeduction: deduction,
    stateTaxableIncome: taxableIncome,
    stateExemptions: 0, // CA uses exemption credits, not exemption amounts
    stateIncomeTax,
    stateCredits: totalCredits,
    stateTaxAfterCredits: taxAfterNonrefundable,
    localTax,
    totalStateTax,
    stateWithholding,
    stateEstimatedPayments: estimatedPayments,
    stateRefundOrOwed: refundOrOwed,
    effectiveStateRate: effectiveRate,
    bracketDetails,
    additionalLines: {
      baseTaxBeforeMHST: baseTax,
      mentalHealthServicesTax: mhst,
      personalExemptionCredits: exemptionCredits,
      blindExemptions: core.exemptionCounts.blind,
      seniorExemptions: core.exemptionCounts.senior,
      earnedIncomeForCalEITC: earnedIncome,
      rentersCredit,
      caDependentCareCredit,
      seniorHoHCredit,
      dependentParentCredit,
      calEITC,
      youngChildTaxCredit: yctc,
      taxBeforeCredits: stateIncomeTax,
    },
    traces: tb.build(),
  };
}
