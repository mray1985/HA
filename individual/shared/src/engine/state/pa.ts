/**
 * Pennsylvania, full-year residents (PA-40; TY2025 corpus TAX-002): the eight
 * classes of income, each figured on its own, for 2025 (PA-40 IN 04-25).
 * Part-year and nonresident returns stop at TAX-008; another year stops here.
 *
 * Line 1a compensation: W-2 box 16 when it is PA wages; otherwise the PA
 *         compensation the preparer figures (PA-40 W-2 RW). 1099-R: codes 3, 4,
 *         6, 7 and rollovers (G, H) are not taxable; code D is interest; any
 *         other distribution's PA-taxable part (cost recovery) is asked.
 * Line 2  interest: 1099-INT box 1 (box 3, U.S. obligations, is exempt), and
 *         box 8 except from Pennsylvania obligations; annuities (code D).
 * Line 3  dividends and capital gain distributions (1099-DIV boxes 1a, 2a).
 * Line 4  business, Line 6 rents and royalties: the preparer's PA Schedule C,
 *         F and E figures (PA depreciation and other differences), by spouse.
 * Line 5  gains: 1099-B and 1099-DA proceeds less basis, long and short term
 *         alike (PA taxes QSBS gain; no capital loss carryover).
 * Line 8  gambling and lottery winnings (W-2G) less gambling losses.
 * Line 9  only the positive classes; a loss in one class never reduces another,
 *         and on a joint return one spouse's loss never reduces the other's.
 * Line 10 HSA and student loan interest (up to $2,500) deductions, and 529 /
 *         PA ABLE contributions asked.
 * Line 12 3.07%. Line 21 tax forgiveness (Schedule SP).
 *
 * What the return cannot show is asked once; a yes stops the return.
 */

import type {
  CalculationResult, CalculationTrace, Dependent, StateCalculationResult, StateQuestion, StateReturnConfig, TaxReturn, UnsupportedPattern,
} from '../../types/index.js';
import { FilingStatus } from '../../types/index.js';
import { getStateWithholding } from './index.js';
import { round2 } from '../utils.js';
import type { StateCalculator } from './stateRegistry.js';

/** The answers kept in the Pennsylvania state return's stateSpecificData. */
export const PA_ANSWER = {
  /** Followed by the W-2's id. */
  compensation: 'paCompensation:',
  /** Followed by the 1099-R's id. */
  retirementTaxable: 'paRetirementTaxable:',
  exemptPaInterest: 'paExemptPaInterest',
  businessIncome: 'paBusinessIncome',
  spouseBusinessIncome: 'paSpouseBusinessIncome',
  rentsIncome: 'paRentsIncome',
  spouseRentsIncome: 'paSpouseRentsIncome',
  gainsOneOwner: 'paGainsOneOwner',
  contributed529: 'paContributed529',
  deduction529: 'paDeduction529',
  otherEligibilityIncome: 'paOtherEligibilityIncome',
  spouseEligibilityIncome: 'paSpouseEligibilityIncome',
  otherItems: 'paOtherItems',
} as const;

const PA_YEAR = 2025;
const RATE = 0.0307;
const STUDENT_LOAN_INTEREST_CAP = 2500;
/** Schedule SP: 100% up to the base, then 10 points less for each $250 more (Eligibility Income Tables 1 and 2). */
const SP = { unmarried: 6500, married: 13000, perDependent: 9500, step: 250, steps: 9 };
/** States with a reciprocal compensation agreement with Pennsylvania. */
const RECIPROCAL = new Set(['IN', 'MD', 'NJ', 'OH', 'VA', 'WV']);
const OUTSIDE = 'Prepare the Pennsylvania return outside HATax.';
/** 1099-R codes that are not PA-taxable (booklet 1099-R filing tips; code D makes it interest). */
const NOT_TAXABLE_CODES = new Set(['3', '4', '6', '7', 'G', 'H']);
/** A dependent child for Schedule SP: a child, stepchild, grandchild or foster child. */
const SP_CHILD = /^(son|daughter|step ?son|step ?daughter|child|step ?child|foster ?child|grandchild|grand ?son|grand ?daughter)$/i;

type Question = Omit<StateQuestion, 'stateCode'>;

function answerOf(config: StateReturnConfig | undefined, key: string): unknown {
  return config?.stateSpecificData?.[key];
}

function amountAnswer(config: StateReturnConfig, key: string, allowNegative = false): number | undefined {
  const v = answerOf(config, key);
  return typeof v === 'number' && Number.isFinite(v) && (allowNegative || v >= 0) ? v : undefined;
}

function residentConfig(taxReturn: TaxReturn): StateReturnConfig | undefined {
  return (taxReturn.stateReturns ?? []).find((s) => s.stateCode.toUpperCase() === 'PA' && s.residencyType === 'resident');
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export interface PennsylvaniaLines {
  line1a: number; line2: number; line3: number; line4: number; line5: number; line6: number; line7: number; line8: number;
  line9: number; line10: number; line11: number; line12: number;
  eligibilityIncome?: number; forgivenessRate: number; line21: number;
  losses: { line4: boolean; line5: boolean; line6: boolean };
}

export interface PennsylvaniaAssessment {
  applies: boolean;
  findings: UnsupportedPattern[];
  /** Every question this return asks, answered or not. */
  questions: StateQuestion[];
  lines?: PennsylvaniaLines;
}

/** The PA-40 lines of a full-year resident, and what the return does not settle. */
export function assessPennsylvania(taxReturn: TaxReturn, federal?: CalculationResult | null): PennsylvaniaAssessment {
  const year = taxReturn.taxYear || 2025;
  const config = residentConfig(taxReturn);
  if (!config) return { applies: false, findings: [], questions: [] };

  const findings: UnsupportedPattern[] = [];
  const asked: Question[] = [];
  const relevant: Question[] = [];
  const find = (itemId: string, message: string, question?: Question) => {
    findings.push({
      ruleId: 'TAX-002', jurisdiction: 'PA', section: 'state', itemId, message,
      ...(question ? { question: { stateCode: 'PA', ...question } } : {}),
    });
    if (question) asked.push(question);
  };
  const ask = (q: Question) => { relevant.push(q); return q; };
  const done = (lines?: PennsylvaniaLines): PennsylvaniaAssessment => ({
    applies: true, findings, lines,
    questions: relevant
      .filter((q) => asked.some((a) => a.key === q.key) || answerOf(config, q.key) !== undefined)
      .map((q) => ({ stateCode: 'PA', ...q })),
  });

  if (year !== PA_YEAR) {
    find('year', `Pennsylvania ${year}: the PA-40 income classes are built for ${PA_YEAR} only. ${OUTSIDE}`);
    return done();
  }

  // ── What no answer here settles ──
  if ((taxReturn.incomeK1 ?? []).length > 0) {
    find('k1', `Pennsylvania classifies partnership, S corporation, estate and trust income from its own schedules (PA RK-1, NRK-1, PA-41 RK-1); HATax does not. ${OUTSIDE}`);
  }
  const otherStateTax = (taxReturn.w2Income ?? []).filter((w) => w.state && w.state.toUpperCase() !== 'PA' && !RECIPROCAL.has(w.state.toUpperCase()) && (w.stateTaxWithheld ?? 0) > 0);
  if (otherStateTax.length > 0) {
    find('resident-credit', `Pennsylvania resident credit (Schedule G-L): wages were taxed by ${[...new Set(otherStateTax.map((w) => w.state!.toUpperCase()))].join(', ')}, and HATax does not figure the credit for tax paid to another state. ${OUTSIDE}`);
  }
  const miscOther = (taxReturn.income1099MISC ?? []).reduce((s, m) => s + Math.max(0, m.otherIncome || 0), 0);
  if (miscOther > 0 || (taxReturn.otherIncome ?? 0) > 0 || (taxReturn.income1099C ?? []).length > 0) {
    find('other-income', `Pennsylvania classifies other income, prizes and cancelled debt into its income classes by their facts; HATax does not. ${OUTSIDE}`);
  }
  if ((taxReturn.income1099B ?? []).some((t) => (t.washSaleLossDisallowed ?? 0) > 0) || (taxReturn.income1099DA ?? []).some((t) => (t.washSaleLossDisallowed ?? 0) > 0)) {
    find('wash-sales', `Pennsylvania gains (line 5): a sale has a wash sale adjustment, and HATax does not figure its Pennsylvania treatment. ${OUTSIDE}`);
  }
  if ((taxReturn.form4797Properties ?? []).length > 0 || (taxReturn.installmentSales ?? []).length > 0 || (taxReturn.rentalProperties ?? []).some((r) => r.disposedDuringYear)) {
    find('property-sales', `Pennsylvania gains (line 5): sales of business, rental or installment property use Pennsylvania basis and PA Schedule D-1; HATax does not figure them. ${OUTSIDE}`);
  }

  const otherQ = ask({
    key: PA_ANSWER.otherItems, kind: 'yes_no',
    prompt: 'Do any of these apply: unreimbursed employee business expenses (PA Schedule UE); income from a Pennsylvania lottery noncash prize; exempt-interest dividends from a fund, or dividends from a fund attributable to U.S. or Pennsylvania obligations; an employer retirement distribution before you qualified to retire; restricted credits (PA Schedule OC or DC); use tax owed on purchases; or income earned while a resident of another state?',
  });
  const other = answerOf(config, otherQ.key);
  if (other === true) find('other-items', `Pennsylvania: an item HATax does not figure applies. ${OUTSIDE}`);
  else if (other !== false) find('other-items', 'Pennsylvania: some PA-40 items depend on facts the return does not hold.', otherQ);

  const joint = taxReturn.filingStatus === FilingStatus.MarriedFilingJointly;
  const married = joint || taxReturn.filingStatus === FilingStatus.MarriedFilingSeparately;

  // ── Line 1a: compensation ──
  let compensation = 0;
  let ownCompensation = { you: 0, spouse: 0 };
  for (const w of taxReturn.w2Income ?? []) {
    let amount: number | undefined;
    if (w.state?.toUpperCase() === 'PA' && typeof w.stateWages === 'number') amount = Math.max(0, w.stateWages);
    else {
      const q = ask({
        key: `${PA_ANSWER.compensation}${w.id}`, kind: 'amount',
        prompt: `Pennsylvania compensation from the ${w.employerName} W-2: box 1 plus elective deferrals (401(k), 403(b), 457), less items Pennsylvania excludes (PA-40 W-2 Reconciliation Worksheet)`,
      });
      amount = amountAnswer(config, q.key);
      if (amount === undefined) find(`compensation:${w.id}`, `Pennsylvania compensation (line 1a): the ${w.employerName} W-2 does not show Pennsylvania wages in box 16.`, q);
    }
    if (amount !== undefined) {
      compensation += amount;
      if (w.isSpouse) ownCompensation.spouse += amount; else ownCompensation.you += amount;
    }
  }
  // 1099-R distributions.
  let annuityInterest = 0;
  for (const r of taxReturn.income1099R ?? []) {
    const code = (r.distributionCode || '').toUpperCase().replace(/\s/g, '');
    if (code.includes('D')) { annuityInterest += Math.max(0, r.taxableAmount || 0); continue; }
    if (code.length > 0 && [...code].every((c) => NOT_TAXABLE_CODES.has(c))) continue;
    const q = ask({
      key: `${PA_ANSWER.retirementTaxable}${r.id}`, kind: 'amount',
      prompt: `Pennsylvania-taxable part of the ${r.payerName} distribution (code ${code || 'not entered'}): the amount over your contributions (cost recovery), or $0 from an eligible employer plan after retiring, an IRA at 59½ or older, or a rollover`,
    });
    const a = amountAnswer(config, q.key);
    if (a === undefined) find(`retirement:${r.id}`, `Pennsylvania taxes this distribution (code ${code || 'not entered'}) only in part, by rules that depend on the plan and your retirement (PA-40 line 1a; 1099-R filing tips).`, q);
    else {
      compensation += a;
      if (r.isSpouse) ownCompensation.spouse += a; else ownCompensation.you += a;
    }
  }
  compensation = round2(compensation);
  ownCompensation = { you: round2(ownCompensation.you), spouse: round2(ownCompensation.spouse) };

  // ── Line 2: interest ──
  const interest1 = (taxReturn.income1099INT ?? []).reduce((s, i) => s + Math.max(0, i.amount || 0), 0);
  const usInterest = (taxReturn.income1099INT ?? []).reduce((s, i) => s + Math.max(0, i.usBondInterest || 0), 0);
  const exemptInterest = round2((taxReturn.income1099INT ?? []).reduce((s, i) => s + Math.max(0, i.taxExemptInterest || 0), 0));
  let otherStatesInterest = 0;
  let paExemptInterest = 0;
  if (exemptInterest > 0) {
    const q = ask({
      key: PA_ANSWER.exemptPaInterest, kind: 'amount',
      prompt: `Of the ${usd(exemptInterest)} tax-exempt interest, the part from obligations of Pennsylvania and its political subdivisions ($0 if none; other states' bond interest is taxed by Pennsylvania)`,
    });
    const a = amountAnswer(config, q.key);
    if (a === undefined || a > exemptInterest) find('exempt-interest', 'Pennsylvania taxes interest from other states\' obligations (line 2), but not from Pennsylvania\'s.', q);
    else { paExemptInterest = a; otherStatesInterest = round2(exemptInterest - a); }
  }
  const line2 = round2(interest1 + otherStatesInterest + annuityInterest);

  // ── Line 3: dividends and capital gain distributions ──
  const line3 = round2((taxReturn.income1099DIV ?? []).reduce((s, d) => s + Math.max(0, d.ordinaryDividends || 0) + Math.max(0, d.capitalGainDistributions || 0), 0));

  // ── Lines 4 and 6: the preparer's PA schedules, by spouse ──
  const hasBusiness = (who: 'you' | 'spouse') => {
    const businesses = taxReturn.businesses ?? [];
    if (businesses.length > 0) return businesses.some((b) => (b.isSpouse === true) === (who === 'spouse'));
    return who === 'you' && ((taxReturn.income1099NEC ?? []).length > 0 || (taxReturn.income1099K ?? []).length > 0);
  };
  const classByPerson = (people: Array<{ who: 'you' | 'spouse'; has: boolean; key: string; label: string; federal: string }>, line: string) => {
    let total = 0;
    let loss = false;
    for (const p of people) {
      if (!p.has) continue;
      const q = ask({ key: p.key, kind: 'amount', allowNegative: true, prompt: p.label });
      const a = amountAnswer(config, q.key, true);
      if (a === undefined) find(`${line}:${p.who}`, `Pennsylvania ${line === 'line4' ? 'business income (line 4)' : 'rents and royalties (line 6)'}: Pennsylvania figures ${p.who === 'you' ? 'this' : "the spouse's"} net income on its own schedule, with Pennsylvania depreciation and other differences from the federal return${p.federal}.`, q);
      else if (a < 0) loss = true;
      else total += a;
    }
    return { total: round2(total), loss };
  };
  const federalBusiness = federal?.scheduleC ? ` (federal Schedule C net profit: ${usd(federal.scheduleC.netProfit)})` : '';
  const line4 = classByPerson([
    { who: 'you', has: hasBusiness('you'), key: PA_ANSWER.businessIncome, federal: federalBusiness, label: `${joint ? 'Your' : 'The'} net income or loss from business or farm on PA Schedule C or F` },
    ...(joint ? [{ who: 'spouse' as const, has: hasBusiness('spouse'), key: PA_ANSWER.spouseBusinessIncome, federal: '', label: "Your spouse's net income or loss from business or farm on PA Schedule C or F" }] : []),
  ], 'line4');
  const hasRents = (taxReturn.rentalProperties ?? []).length > 0
    || (taxReturn.income1099MISC ?? []).some((m) => (m.rents ?? 0) > 0 || (m.royalties ?? 0) > 0);
  const line6 = classByPerson([
    { who: 'you', has: hasRents, key: PA_ANSWER.rentsIncome, federal: '', label: `${joint ? 'Your' : 'The'} net income or loss from rents and royalties on PA Schedule E${joint ? ' (half of what you own jointly)' : ''}` },
    ...(joint ? [{ who: 'spouse' as const, has: hasRents, key: PA_ANSWER.spouseRentsIncome, federal: '', label: "Your spouse's net income or loss from rents and royalties on PA Schedule E (half of what you own jointly)" }] : []),
  ], 'line6');

  // ── Line 5: gains ──
  const sales = [...(taxReturn.income1099B ?? []), ...(taxReturn.income1099DA ?? [])];
  const results = sales.map((t) => round2((t.proceeds || 0) - (t.costBasis || 0)));
  let net5 = round2(results.reduce((s, g) => s + g, 0));
  const home = taxReturn.homeSale;
  let excludedHomeGain = 0;
  if (home && home.salePrice > 0) {
    const gain = round2(home.salePrice - home.costBasis - (home.sellingExpenses || 0));
    if (home.ownedMonths >= 24 && home.usedAsResidenceMonths >= 24) excludedHomeGain = Math.max(0, gain);
    else find('home-sale', `Pennsylvania gains (line 5): the home does not meet the two-of-five-years test, and a nonqualifying sale uses PA Schedule 19; HATax does not figure it. ${OUTSIDE}`);
  }
  if (joint && results.some((g) => g > 0) && results.some((g) => g < 0)) {
    const q = ask({
      key: PA_ANSWER.gainsOneOwner, kind: 'yes_no',
      prompt: 'Were all these sales from accounts you and your spouse own jointly, or all from accounts one of you owns alone?',
    });
    const a = answerOf(config, q.key);
    if (a === false) find('gains-owners', `Pennsylvania gains (line 5): one spouse's loss cannot reduce the other's gain, and HATax does not split the sales by owner. ${OUTSIDE}`);
    else if (a !== true) find('gains-owners', "Pennsylvania gains (line 5): on a joint return one spouse's loss cannot reduce the other spouse's gain.", q);
  }
  const line5Loss = net5 < 0;
  const line5 = Math.max(0, net5);
  net5 = line5;

  // ── Line 7: estate or trust income (K-1s stop the return above) ──
  const line7 = 0;

  // ── Line 8: gambling and lottery winnings ──
  const winnings = (taxReturn.incomeW2G ?? []).reduce((s, g) => s + Math.max(0, g.grossWinnings || 0), 0);
  const gamblingLosses = Math.max(0, taxReturn.gamblingLosses || 0);
  if (joint && winnings > 0 && gamblingLosses > 0) {
    find('gambling', `Pennsylvania gambling winnings (line 8): spouses report winnings and losses separately, and HATax does not split them by spouse. ${OUTSIDE}`);
  }
  const line8 = round2(Math.max(0, winnings - gamblingLosses));

  // ── Line 9 ──
  const line1c = compensation;
  const line9 = round2(Math.max(0, line1c) + line2 + line3 + line4.total + line5 + line6.total + line7 + line8);

  // ── Line 10: Schedule O ──
  const hsa = Math.max(0, federal?.form1040.hsaDeduction ?? 0);
  const studentLoan = Math.min(STUDENT_LOAN_INTEREST_CAP, Math.max(0, taxReturn.studentLoanInterest || 0));
  const contributedQ = ask({ key: PA_ANSWER.contributed529, kind: 'yes_no', prompt: `Did you${married ? ' or your spouse' : ''} contribute to a 529 college savings plan or a Pennsylvania ABLE account in ${year}?` });
  const contributed = answerOf(config, contributedQ.key);
  let deduction529 = 0;
  if (contributed === true) {
    const q = ask({ key: PA_ANSWER.deduction529, kind: 'amount', prompt: 'Deductible 529 and PA ABLE contributions on PA Schedule O: up to $19,000 per beneficiary for each contributor' });
    const a = amountAnswer(config, q.key);
    if (a === undefined) find('529', 'Pennsylvania deducts 529 and PA ABLE contributions (line 10).', q);
    else deduction529 = a;
  } else if (contributed !== false) {
    find('529', 'Pennsylvania deducts 529 and PA ABLE contributions (line 10).', contributedQ);
  }
  const deductions = round2(hsa + studentLoan + deduction529);
  if (joint && deductions > 0 && Math.min(ownCompensation.you, ownCompensation.spouse) < deductions) {
    find('deductions', `Pennsylvania deductions (line 10) on a joint return cannot exceed each spouse's own income, and HATax does not assign the ${usd(deductions)} of deductions to a spouse. ${OUTSIDE}`);
  }
  const line10 = Math.min(deductions, line9);
  const line11 = round2(line9 - line10);
  const line12 = round2(line11 * RATE);

  // ── Line 21: tax forgiveness (Schedule SP) ──
  const spChildren = (taxReturn.dependents ?? []).filter((d: Dependent) => SP_CHILD.test((d.relationship ?? '').trim())).length;
  const base = (married ? SP.married : SP.unmarried) + SP.perDependent * spChildren;
  const ceiling = base + SP.step * SP.steps;
  const survivorAnnuity = (taxReturn.income1099R ?? []).filter((r) => (r.distributionCode || '').toUpperCase().includes('4')).reduce((s, r) => s + Math.max(0, r.grossDistribution || 0), 0);
  const knownEligibility = round2(line9 + usInterest + paExemptInterest + survivorAnnuity + Math.max(0, taxReturn.alimonyReceived?.totalReceived ?? 0) + excludedHomeGain);
  let forgivenessRate = 0;
  let eligibilityIncome: number | undefined;
  const dependentOfAnother = taxReturn.canBeClaimedAsDependent === true || taxReturn.isClaimedAsDependent === true;
  if (line12 > 0 && knownEligibility <= ceiling) {
    if (dependentOfAnother) {
      find('forgiveness', `Pennsylvania tax forgiveness (Schedule SP): a dependent may qualify only through the parents' Schedule SP; HATax does not figure it. ${OUTSIDE}`);
    } else {
      const q = ask({
        key: PA_ANSWER.otherEligibilityIncome, kind: 'amount',
        prompt: 'Other eligibility income for Pennsylvania tax forgiveness not on this return (Schedule SP lines 2-10): gifts and support from outside the household, pre-tax cafeteria plan payments for health insurance, insurance proceeds and inheritances, nontaxable scholarships and grants, nontaxable military pay, foster care payments ($0 if none)',
      });
      const a = amountAnswer(config, q.key);
      let spouse = 0;
      let spouseKnown = true;
      if (taxReturn.filingStatus === FilingStatus.MarriedFilingSeparately) {
        const sq = ask({ key: PA_ANSWER.spouseEligibilityIncome, kind: 'amount', prompt: "Your spouse's total eligibility income (their Schedule SP, Section III, line 11): separate filers combine them" });
        const s = amountAnswer(config, sq.key);
        if (s === undefined) { spouseKnown = false; find('forgiveness-spouse', 'Pennsylvania tax forgiveness: married taxpayers filing separately combine both spouses\' eligibility income.', sq); }
        else spouse = s;
      }
      if (a === undefined) find('forgiveness', `Pennsylvania tax forgiveness (Schedule SP) may apply: eligibility income from the return is ${usd(knownEligibility)}, within the ${usd(ceiling)} limit.`, q);
      else if (spouseKnown) {
        eligibilityIncome = round2(knownEligibility + a + spouse);
        if (eligibilityIncome <= base) forgivenessRate = 1;
        else {
          const over = Math.ceil((eligibilityIncome - base) / SP.step);
          forgivenessRate = over <= SP.steps ? Math.round((1 - 0.1 * over) * 10) / 10 : 0;
        }
      }
    }
  }
  const line21 = round2(line12 * forgivenessRate);

  return done({
    line1a: compensation, line2, line3, line4: line4.total, line5: net5, line6: line6.total, line7, line8,
    line9, line10, line11, line12, eligibilityIncome, forgivenessRate, line21,
    losses: { line4: line4.loss, line5: line5Loss, line6: line6.loss },
  });
}

/**
 * Pennsylvania's calculator: the PA-40 for a full-year resident in 2025;
 * otherwise the flat-tax calculator (whose result TAX-002 or TAX-008 stops).
 */
export function withPennsylvaniaResident(calculator: StateCalculator | null): StateCalculator | null {
  if (!calculator) return null;
  return {
    calculate(taxReturn, federalResult, config): StateCalculationResult {
      if (config.residencyType !== 'resident') return calculator.calculate(taxReturn, federalResult, config);
      const { lines } = assessPennsylvania(taxReturn, federalResult);
      if (!lines) return calculator.calculate(taxReturn, federalResult, config);
      const withholding = getStateWithholding(taxReturn, 'PA');
      const estimated = 0; // State estimated payments are not entered in this app.
      const tax = round2(lines.line12 - lines.line21);
      const agi = federalResult.form1040.agi;
      const trace = (lineId: string, label: string, value: number, formula: string, inputs: CalculationTrace['inputs'] = []): CalculationTrace =>
        ({ lineId, label, value, formula, authority: 'PA-40', inputs });
      return {
        stateCode: 'PA',
        stateName: 'Pennsylvania',
        residencyType: config.residencyType,
        federalAGI: agi,
        stateAdditions: 0,
        stateSubtractions: 0,
        stateAGI: lines.line9,
        stateDeduction: lines.line10,
        stateTaxableIncome: lines.line11,
        stateExemptions: 0,
        stateIncomeTax: lines.line12,
        stateCredits: lines.line21,
        stateTaxAfterCredits: tax,
        localTax: 0,
        totalStateTax: tax,
        stateWithholding: withholding,
        stateEstimatedPayments: estimated,
        stateRefundOrOwed: round2(withholding + estimated - tax),
        effectiveStateRate: agi > 0 ? Math.round((tax / agi) * 10000) / 10000 : 0,
        bracketDetails: lines.line11 > 0 ? [{ rate: RATE, taxableAtRate: lines.line11, taxAtRate: lines.line12 }] : [],
        additionalLines: {
          line1aCompensation: lines.line1a,
          line2Interest: lines.line2,
          line3Dividends: lines.line3,
          line4Business: lines.line4,
          line5Gains: lines.line5,
          line6Rents: lines.line6,
          line7EstateTrust: lines.line7,
          line8Gambling: lines.line8,
          line9TotalTaxable: lines.line9,
          line21TaxForgiveness: lines.line21,
          ...(lines.eligibilityIncome !== undefined ? { eligibilityIncome: lines.eligibilityIncome, forgivenessRate: lines.forgivenessRate } : {}),
          ...(lines.losses.line4 ? { line4NetLoss: 1 } : {}),
          ...(lines.losses.line5 ? { line5NetLoss: 1 } : {}),
          ...(lines.losses.line6 ? { line6NetLoss: 1 } : {}),
        },
        traces: [
          trace('state.stateAGI', 'Total PA taxable income (line 9)', lines.line9, 'Positive classes only: lines 1c, 2, 3, 4, 5, 6, 7 and 8', [
            { lineId: 'pa.line1c', label: 'Compensation', value: lines.line1a },
            { lineId: 'pa.line2', label: 'Interest', value: lines.line2 },
            { lineId: 'pa.line3', label: 'Dividends and capital gain distributions', value: lines.line3 },
            { lineId: 'pa.line4', label: 'Business', value: lines.line4 },
            { lineId: 'pa.line5', label: 'Gains', value: lines.line5 },
            { lineId: 'pa.line6', label: 'Rents and royalties', value: lines.line6 },
            { lineId: 'pa.line8', label: 'Gambling and lottery winnings', value: lines.line8 },
          ]),
          trace('state.taxableIncome', 'Adjusted PA taxable income (line 11)', lines.line11, 'Line 9 − line 10'),
          trace('state.incomeTax', 'PA tax liability (line 12)', lines.line12, 'Line 11 × 3.07%'),
          trace('state.totalTax', 'PA tax after tax forgiveness', tax, 'Line 12 − line 21'),
          trace('state.refundOrOwed', withholding + estimated - tax >= 0 ? 'Pennsylvania Refund' : 'Pennsylvania Amount Owed', round2(withholding + estimated - tax), 'Withholding + estimated payments − tax'),
        ],
      };
    },
  };
}
