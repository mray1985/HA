/**
 * Washington capital gains tax (chapter 82.87 RCW; TY2025 corpus TAX-003).
 *
 * Washington has no income tax, but it taxes an individual's long-term capital
 * gains: 7% of Washington capital gains, and from 2025 another 2.9% of the part
 * over $1,000,000 (RCW 82.87.040). Washington capital gains are the federal net
 * long-term capital gain less exempt gains and gains not allocated to
 * Washington (RCW 82.87.020(1)), less the standard deduction and the
 * charitable deduction (RCW 82.87.060, 82.87.080). Short-term results do not
 * enter it.
 *
 * What the return settles:
 *   - Long-term sales on 1099-B and 1099-DA, and capital gain distributions, are
 *     intangible property: Washington's for a Washington domiciliary
 *     (RCW 82.87.100(1)(b); the Department of Revenue's FAQ for
 *     cryptocurrency and fund distributions). Gain excluded under IRC §1202 is
 *     not in the federal net gain, so it is not here either.
 *   - A home sale and rental property dispositions are real estate, which is
 *     exempt (RCW 82.87.050(1)). They are not in the Schedule D net used here.
 * What is asked, or cannot be settled (fail closed), when the tax could be owed:
 *   collectibles (tangible property, allocated by where it was), the long-term
 *   loss carryover (only the part from Washington sales made in 2022 or later
 *   counts), K-1, Form 4797 and installment gains (real estate and depreciable
 *   business property are exempt), donations over the threshold (only those to
 *   organizations managed in Washington count), a separate return (spouses
 *   share one deduction), a part-year resident, and what the return cannot
 *   show: a private business interest, timber, a sale subject to B&O tax, a gain
 *   taxed elsewhere, a registered domestic partnership.
 *
 * Nothing is asked when the most the gains could be is within the standard
 * deduction: no tax can be owed then.
 */

import type {
  CalculationResult, StateCalculationResult, StateQuestion, StateReturnConfig, TaxReturn, UnsupportedPattern,
} from '../../types/index.js';
import { FilingStatus } from '../../types/index.js';
import {
  WA_CAPITAL_GAINS_ADDITIONAL, WA_CAPITAL_GAINS_AMOUNTS, WA_CAPITAL_GAINS_FIRST_YEAR, WA_CAPITAL_GAINS_RATE,
  WA_LATEST_STANDARD_DEDUCTION, type WaCapitalGainsAmounts,
} from '../../constants/states/wa.js';
import { calculateForm6252 } from '../form6252.js';
import { carryforwardByCharacter, transactionGainOrLoss } from '../scheduleD.js';
import { TraceBuilder } from '../traceBuilder.js';
import { round2 } from '../utils.js';

/** The answers kept in the Washington state return's stateSpecificData. */
export const WA_ANSWER = {
  collectiblesAllocated: 'waCollectiblesAllocated',
  carryoverLoss: 'waCarryoverLoss',
  otherGain: 'waOtherGain',
  qualifiedDonations: 'waQualifiedDonations',
  spousesWithinDeduction: 'waSpousesWithinDeduction',
  specialItems: 'waSpecialItems',
} as const;

export interface WashingtonCapitalGains {
  /** A Washington state return, or a Washington address. */
  applies: boolean;
  /** Why the tax cannot be settled; empty when it is. */
  findings: UnsupportedPattern[];
  /**
   * Every question this return asks: the ones a finding asks now and the ones
   * already answered, so an answer can be seen and changed.
   */
  questions: StateQuestion[];
  /** The most the gains could be is within the standard deduction: no tax. */
  noTaxPossible: boolean;
  amounts?: WaCapitalGainsAmounts;
  /** Long-term sales of intangible property and capital gain distributions, net. */
  intangibleGain: number;
  /** Collectibles gain or loss allocated to Washington (as answered). */
  collectiblesGain: number;
  /** The part of the long-term loss carryover that counts (as answered). */
  carryoverLoss: number;
  /** K-1, Form 4797 and installment gain that is Washington's (as answered). */
  otherGain: number;
  /** RCW 82.87.020(1). */
  adjustedCapitalGain: number;
  standardDeduction: number;
  charitableDeduction: number;
  /** RCW 82.87.020(16): after the deductions, not below zero. */
  washingtonCapitalGains: number;
  baseTax: number;
  additionalTax: number;
  tax: number;
}

const RULE = 'TAX-003';
const OUTSIDE = 'Prepare the Washington capital gains return outside HATax.';
const usd = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

type Question = Omit<StateQuestion, 'stateCode'>;
const QUESTION = {
  spouses: (deduction: number): Question => ({
    key: WA_ANSWER.spousesWithinDeduction, kind: 'yes_no',
    prompt: `Are both spouses' Washington long-term capital gains together ${usd(deduction)} or less?`,
  }),
  collectibles: {
    key: WA_ANSWER.collectiblesAllocated, kind: 'yes_no',
    prompt: 'Is the long-term gain or loss on the collectibles allocated to Washington?',
  } as Question,
  carryover: {
    key: WA_ANSWER.carryoverLoss, kind: 'amount',
    prompt: 'The part of the long-term loss carryover from Washington sales made in 2022 or later (not real estate or other exempt assets)',
  } as Question,
  other: {
    key: WA_ANSWER.otherGain, kind: 'amount', allowNegative: true,
    prompt: 'Washington long-term gain (or loss) from K-1s, Form 4797 and installment sales: the part not from real estate or depreciable business property, allocated to Washington',
  } as Question,
  donations: {
    key: WA_ANSWER.qualifiedDonations, kind: 'amount',
    prompt: 'Donations made this year to organizations principally directed and managed in Washington',
  } as Question,
  special: {
    key: WA_ANSWER.specialItems, kind: 'yes_no',
    prompt: "Do any of these apply to this year's long-term gains: the sale of an interest in a privately held business or entity (including a family-owned small business); timber, timberland or a timber REIT distribution; commercial fishing privileges, livestock, auto dealership goodwill or a condemnation; a sale also subject to Washington B&O tax; a gain also taxed by another state or country; or a state registered domestic partnership?",
  } as Question,
};

function isWashington(code: string | undefined): boolean {
  return code?.toUpperCase() === 'WA';
}

/** Donations made this year: Schedule A cash and non-cash gifts and K-1 box 13 gifts. */
function donationsMade(taxReturn: TaxReturn, federal: CalculationResult): number {
  const d = taxReturn.itemizedDeductions;
  const nonCash = d?.nonCashDonations?.length
    ? d.nonCashDonations.reduce((s, item) => s + Math.max(0, item.fairMarketValue || 0), 0)
    : Math.max(0, d?.charitableNonCash || 0);
  const k1 = (federal.k1Routing?.charitableCash || 0) + (federal.k1Routing?.charitableNonCash || 0);
  return round2(Math.max(0, d?.charitableCash || 0) + nonCash + Math.max(0, k1));
}

function answerOf(config: StateReturnConfig | undefined, key: string): unknown {
  return config?.stateSpecificData?.[key];
}

export function assessWashingtonCapitalGains(taxReturn: TaxReturn, federal: CalculationResult): WashingtonCapitalGains {
  const year = taxReturn.taxYear || 2025;
  const config = (taxReturn.stateReturns ?? []).find((s) => isWashington(s.stateCode));
  const amounts = WA_CAPITAL_GAINS_AMOUNTS[year];
  const none: WashingtonCapitalGains = {
    applies: Boolean(config) || isWashington(taxReturn.addressState),
    findings: [], questions: [], noTaxPossible: true, amounts,
    intangibleGain: 0, collectiblesGain: 0, carryoverLoss: 0, otherGain: 0, adjustedCapitalGain: 0,
    standardDeduction: 0, charitableDeduction: 0, washingtonCapitalGains: 0, baseTax: 0, additionalTax: 0, tax: 0,
  };
  if (!none.applies || year < WA_CAPITAL_GAINS_FIRST_YEAR) return none;

  const residency = config?.residencyType ?? 'resident';
  const findings: UnsupportedPattern[] = [];
  const find = (itemId: string, message: string, question?: Question) => findings.push({
    ruleId: RULE, jurisdiction: 'WA', section: 'state', itemId, message: `Washington capital gains tax: ${message}`,
    ...(question && config ? { question: { stateCode: 'WA', ...question } } : {}),
  });
  // The range the adjusted capital gain could be in, from what is not settled.
  let unsettledGain = 0;

  // ── Long-term sales of intangible property and capital gain distributions ──
  const sd = federal.scheduleD;
  const { longTerm: federalCarryover } = carryforwardByCharacter(
    taxReturn.capitalLossCarryforward, taxReturn.capitalLossCarryforwardST, taxReturn.capitalLossCarryforwardLT,
  );
  const collectibles = round2((taxReturn.income1099B ?? [])
    .filter((t) => t.isLongTerm && t.isCollectible)
    .reduce((s, t) => s + transactionGainOrLoss(t), 0));
  // Schedule D's long-term net holds the carryover as a loss, the collectibles,
  // the K-1 long-term gain (line 12) and capital-asset installment gain (line
  // 11): each is taken separately below.
  const k1InScheduleD = federal.k1Routing?.longTermCapitalGain || 0;
  const installmentInScheduleD = round2((federal.form6252 ?? [])
    .filter((r) => r.disposition === 'long_term_capital')
    .reduce((s, r) => s + r.totalReportableIncome, 0));
  const securities = sd ? round2(sd.netLongTerm + federalCarryover - collectibles - k1InScheduleD - installmentInScheduleD) : 0;
  let intangibleGain = 0;
  if (residency === 'resident') {
    intangibleGain = securities;
  } else if (residency === 'part_year') {
    // Washington's only for sales made while domiciled in Washington (RCW 82.87.100(1)(b)).
    unsettledGain += Math.max(0, securities);
  }
  // A nonresident's intangible gains are not allocated to Washington.

  // ── Collectibles: tangible property (RCW 82.87.100(1)(a)) ──
  let collectiblesGain = 0;
  const collectiblesAnswer = answerOf(config, WA_ANSWER.collectiblesAllocated);
  const collectiblesUnsettled = collectibles !== 0 && typeof collectiblesAnswer !== 'boolean';
  if (collectiblesAnswer === true) collectiblesGain = collectibles;
  if (collectiblesUnsettled) unsettledGain += Math.max(0, collectibles);

  // ── The long-term loss carryover (RCW 82.87.020(1)(c)-(e), 82.87.040(3)) ──
  let carryoverLoss = 0;
  const carryoverAnswer = answerOf(config, WA_ANSWER.carryoverLoss);
  const carryoverValid = typeof carryoverAnswer === 'number' && carryoverAnswer >= 0 && carryoverAnswer <= federalCarryover;
  const carryoverUnsettled = federalCarryover > 0 && !carryoverValid;
  if (federalCarryover > 0 && carryoverValid) carryoverLoss = carryoverAnswer;

  // ── K-1, Form 4797 and installment gains ──
  const k1LongTerm = federal.k1Routing?.longTermCapitalGain || 0;
  const has1231 = (taxReturn.form4797Properties?.length ?? 0) > 0 || (federal.k1Routing?.netSection1231Gain || 0) !== 0;
  const section1231 = has1231 ? Math.max(0, federal.section1231LongTermGain || 0) : 0;
  const installment = round2((taxReturn.installmentSales ?? []).reduce((s, sale) => s + calculateForm6252(sale, year).installmentSaleIncome, 0));
  const otherUpper = round2(Math.max(0, k1LongTerm) + section1231 + Math.max(0, installment));
  const otherLower = round2(Math.min(0, k1LongTerm));
  let otherGain = 0;
  const otherAnswer = answerOf(config, WA_ANSWER.otherGain);
  const hasOther = otherUpper !== 0 || otherLower !== 0;
  const otherValid = typeof otherAnswer === 'number' && otherAnswer <= otherUpper && otherAnswer >= otherLower;
  const otherUnsettled = hasOther && !otherValid;
  if (hasOther && otherValid) otherGain = otherAnswer;
  if (otherUnsettled) unsettledGain += otherUpper;

  const adjustedCapitalGain = round2(intangibleGain + collectiblesGain - carryoverLoss + otherGain);

  const fullDeduction = amounts?.standardDeduction ?? WA_LATEST_STANDARD_DEDUCTION;
  const separate = taxReturn.filingStatus === FilingStatus.MarriedFilingSeparately;
  const donated = donationsMade(taxReturn, federal);
  const relevant: Question[] = [
    ...(separate ? [QUESTION.spouses(fullDeduction)] : []),
    ...(collectibles !== 0 ? [QUESTION.collectibles] : []),
    ...(federalCarryover > 0 ? [QUESTION.carryover] : []),
    ...(hasOther ? [QUESTION.other] : []),
    ...(amounts && donated > amounts.charitableThreshold ? [QUESTION.donations] : []),
    QUESTION.special,
  ];
  const done = (r: WashingtonCapitalGains): WashingtonCapitalGains => ({
    ...r,
    questions: config
      ? relevant
        .filter((q) => r.findings.some((f) => f.question?.key === q.key) || answerOf(config, q.key) !== undefined)
        .map((q) => ({ stateCode: 'WA', ...q }))
      : [],
  });

  // ── Could any tax be owed? ──
  const settled = { intangibleGain, collectiblesGain, carryoverLoss, otherGain, adjustedCapitalGain };
  const mostGain = round2(adjustedCapitalGain + unsettledGain);
  const spousesAnswer = answerOf(config, WA_ANSWER.spousesWithinDeduction);
  // On a separate return the other spouse may have used the whole deduction (RCW 82.87.120(4)).
  if (mostGain <= (separate ? 0 : fullDeduction) || (separate && spousesAnswer === true)) {
    return done({ ...none, ...settled });
  }
  const blocked = (itemId: string, message: string): WashingtonCapitalGains => {
    find(itemId, message);
    return done({ ...none, ...settled, findings, noTaxPossible: false });
  };

  // What no answer here settles.
  if (!config) {
    return blocked('state-return', 'the address is in Washington and the long-term gains may be over the standard deduction, but the return has no Washington state return. Add Washington as a state so the tax is figured.');
  }
  if (separate) {
    if (spousesAnswer === false) {
      return blocked('separate-return', `the spouses' Washington long-term gains together are over the standard deduction. On separate returns the spouses allocate their gains and the one deduction between them (RCW 82.87.120(4)); HATax does not make that allocation. ${OUTSIDE}`);
    }
    find('separate-return', "spouses share one standard deduction and the $1,000,000 threshold, even on separate returns (RCW 82.87.120(4)). HATax cannot see the other spouse's gains.", QUESTION.spouses(fullDeduction));
    return done({ ...none, ...settled, findings, noTaxPossible: false });
  }
  if (!amounts) {
    return blocked('year', `the ${year} standard deduction is not built in HATax (the Department of Revenue publishes each year's amounts by October 31), and the long-term gains may be over the latest one published (${usd(WA_LATEST_STANDARD_DEDUCTION)}). ${OUTSIDE}`);
  }
  if (residency === 'part_year') {
    return blocked('part-year', `a part-year resident's gains on stocks and other intangible property are Washington's only for sales made while domiciled in Washington (RCW 82.87.100). HATax does not source sales by date. ${OUTSIDE}`);
  }
  const special = answerOf(config, WA_ANSWER.specialItems);
  if (special === true) {
    return blocked('special-items', `an exemption, deduction or credit that HATax does not figure applies to the gains. ${OUTSIDE}`);
  }

  // What an answer settles.
  if (collectiblesUnsettled) {
    find('collectibles', `${usd(collectibles)} of long-term ${collectibles >= 0 ? 'gain' : 'loss'} on collectibles is Washington's only if the property was in Washington when sold, or was in Washington this year or last year and no other state or country taxes the gain (RCW 82.87.100(1)(a)).`, QUESTION.collectibles);
  }
  if (carryoverUnsettled) {
    find('carryover', `of the ${usd(federalCarryover)} long-term capital loss carryover, only the part from sales allocated to Washington, not exempt, and made in 2022 or later reduces Washington capital gains (RCW 82.87.020(1), 82.87.040(3)).${typeof carryoverAnswer === 'number' ? ` The amount entered (${usd(carryoverAnswer)}) is not between $0 and the carryover.` : ''}`, QUESTION.carryover);
  }
  if (otherUnsettled) {
    const parts = [
      k1LongTerm !== 0 ? `K-1 long-term ${k1LongTerm > 0 ? 'gain' : 'loss'} of ${usd(k1LongTerm)}` : '',
      section1231 > 0 ? `section 1231 gain of ${usd(section1231)}` : '',
      installment > 0 ? `installment sale gain of ${usd(installment)}` : '',
    ].filter(Boolean);
    find('other-gains', `the ${parts.join(', ')} may be Washington capital gains, except gain from real estate or depreciable business property (RCW 82.87.050) and gain not allocated to Washington.${typeof otherAnswer === 'number' ? ` The amount entered (${otherAnswer < 0 ? '-' : ''}${usd(otherAnswer)}) is outside what these items can be.` : ''}`, QUESTION.other);
  }

  // ── Deductions (RCW 82.87.060) ──
  const standardDeduction = Math.min(amounts.standardDeduction, Math.max(0, adjustedCapitalGain));
  const afterStandard = round2(Math.max(0, adjustedCapitalGain - amounts.standardDeduction));
  let charitableDeduction = 0;
  if (donated > amounts.charitableThreshold) {
    const answer = answerOf(config, WA_ANSWER.qualifiedDonations);
    if (typeof answer === 'number' && answer >= 0 && answer <= donated) {
      charitableDeduction = round2(Math.min(afterStandard, amounts.charitableMaxDeduction, Math.max(0, answer - amounts.charitableThreshold)));
    } else {
      find('donations', `donations of ${usd(donated)} are over the ${usd(amounts.charitableThreshold)} threshold. Donations to organizations principally directed and managed in Washington, over the threshold, are deductible up to ${usd(amounts.charitableMaxDeduction)} (RCW 82.87.080).${typeof answer === 'number' ? ` The amount entered (${usd(answer)}) is not between $0 and the donations on the return.` : ''}`, QUESTION.donations);
    }
  }
  const washingtonCapitalGains = round2(Math.max(0, afterStandard - charitableDeduction));

  // ── What the return cannot show ──
  if (special !== false) {
    find('special-items', 'the long-term gains may be over the standard deduction. Some exemptions, deductions and credits depend on facts the return does not hold (RCW 82.87.050-.070, 82.87.100(2), 82.87.120, 82.87.160).', QUESTION.special);
  }

  // ── Tax (RCW 82.87.040) ──
  const baseTax = round2(washingtonCapitalGains * WA_CAPITAL_GAINS_RATE);
  const additionalTax = year >= WA_CAPITAL_GAINS_ADDITIONAL.fromYear
    ? round2(Math.max(0, washingtonCapitalGains - WA_CAPITAL_GAINS_ADDITIONAL.over) * WA_CAPITAL_GAINS_ADDITIONAL.rate)
    : 0;
  return done({
    applies: true, findings, questions: [], noTaxPossible: false, amounts,
    intangibleGain, collectiblesGain, carryoverLoss, otherGain, adjustedCapitalGain,
    standardDeduction, charitableDeduction, washingtonCapitalGains,
    baseTax, additionalTax, tax: round2(baseTax + additionalTax),
  });
}

/** The Washington state result: the capital gains tax. */
export function calculateWashington(
  taxReturn: TaxReturn,
  federal: CalculationResult,
  config: StateReturnConfig,
  payments: { withholding: number; estimated: number },
): StateCalculationResult {
  const wa = assessWashingtonCapitalGains(taxReturn, federal);
  const tb = new TraceBuilder();
  const agi = federal.form1040.agi;
  tb.trace('state.stateAGI', 'Washington adjusted capital gain', wa.adjustedCapitalGain, {
    authority: 'RCW 82.87.020(1)',
    formula: 'Long-term gains allocated to Washington, less exempt gains',
    inputs: [
      { lineId: 'wa.intangibleGain', label: 'Long-term sales of intangible property and capital gain distributions', value: wa.intangibleGain },
      { lineId: 'wa.collectiblesGain', label: 'Collectibles allocated to Washington', value: wa.collectiblesGain },
      { lineId: 'wa.carryoverLoss', label: 'Long-term loss carryover from Washington sales', value: -wa.carryoverLoss },
      { lineId: 'wa.otherGain', label: 'K-1, Form 4797 and installment gains allocated to Washington', value: wa.otherGain },
    ],
  });
  tb.trace('state.deduction', 'Washington deductions', round2(wa.standardDeduction + wa.charitableDeduction), {
    authority: 'RCW 82.87.060, 82.87.080',
    inputs: [
      { lineId: 'wa.standardDeduction', label: 'Standard deduction', value: wa.standardDeduction },
      { lineId: 'wa.charitableDeduction', label: 'Charitable donation deduction', value: wa.charitableDeduction },
    ],
  });
  tb.trace('state.taxableIncome', 'Washington capital gains', wa.washingtonCapitalGains, { authority: 'RCW 82.87.020(16)', inputs: [] });
  tb.trace('state.incomeTax', 'Washington capital gains tax', wa.tax, {
    authority: 'RCW 82.87.040',
    formula: wa.additionalTax > 0 ? '7% of Washington capital gains + 2.9% of the part over $1,000,000' : '7% of Washington capital gains',
    inputs: [{ lineId: 'state.taxableIncome', label: 'Washington capital gains', value: wa.washingtonCapitalGains }],
  });

  const paid = round2(payments.withholding + payments.estimated);
  return {
    stateCode: 'WA',
    stateName: 'Washington',
    residencyType: config.residencyType,
    federalAGI: agi,
    stateAdditions: 0,
    stateSubtractions: 0,
    stateAGI: wa.adjustedCapitalGain,
    stateDeduction: round2(wa.standardDeduction + wa.charitableDeduction),
    stateTaxableIncome: wa.washingtonCapitalGains,
    stateExemptions: 0,
    stateIncomeTax: wa.tax,
    stateCredits: 0,
    stateTaxAfterCredits: wa.tax,
    localTax: 0,
    totalStateTax: wa.tax,
    stateWithholding: payments.withholding,
    stateEstimatedPayments: payments.estimated,
    stateRefundOrOwed: round2(paid - wa.tax),
    effectiveStateRate: agi > 0 ? Math.round((wa.tax / agi) * 10000) / 10000 : 0,
    bracketDetails: wa.washingtonCapitalGains > 0 ? [
      { rate: WA_CAPITAL_GAINS_RATE, taxableAtRate: wa.washingtonCapitalGains, taxAtRate: wa.baseTax },
      ...(wa.additionalTax > 0 ? [{ rate: WA_CAPITAL_GAINS_ADDITIONAL.rate, taxableAtRate: round2(wa.washingtonCapitalGains - WA_CAPITAL_GAINS_ADDITIONAL.over), taxAtRate: wa.additionalTax }] : []),
    ] : [],
    additionalLines: {
      capitalGainsTax: 1,
      adjustedCapitalGain: wa.adjustedCapitalGain,
      standardDeduction: wa.standardDeduction,
      charitableDeduction: wa.charitableDeduction,
      washingtonCapitalGains: wa.washingtonCapitalGains,
    },
    traces: tb.build(),
  };
}
