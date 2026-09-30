import { FilingStatus, EstimatedTaxPenaltyResult, AnnualizedIncomeInfo, QuarterlyPenaltyDetail } from '../types/index.js';
import { getEstimatedTaxPenalty } from '../constants/taxConstants.js';
import { round2 } from './utils.js';

/**
 * Calculate Estimated Tax Penalty (Form 2210).
 *
 * You may owe a penalty if you didn't pay enough tax through withholding
 * and estimated payments during the year.
 *
 * Safe harbors (no penalty if):
 *   1. Tax owed after withholding/payments < $1,000
 *   2. Payments ≥ 90% of current year tax
 *   3. Payments ≥ 100% of prior year tax (110% if AGI > $150k/$75k MFS)
 *
 * Penalty is computed using the per-quarter day-count method (Form 2210 Part IV):
 *   For each quarter's underpayment, penalty = underpayment × rate × days / 365
 *   where days are broken out by IRS rate period boundaries.
 *
 * When annualized income data is provided, also computes the annualized
 * income installment method (Schedule AI) and returns the lesser penalty.
 *
 * @authority
 *   IRC: Section 6654 — failure by individual to pay estimated income tax
 *   IRC: Section 6654(d)(2) — annualized income installment method
 *   IRC: Section 6621(a)(2) — underpayment rate = federal short-term rate + 3%
 *   Form: Form 2210
 *   Form: Form 2210, Schedule AI
 * With a payment schedule, the regular method follows Form 2210 Part IV: each
 * estimated payment counts from the day it was made and goes to the earliest
 * unpaid installment, and withholding counts as paid in equal parts on the
 * installment due dates (IRC §6654(g)(1)). Without one, payments are spread
 * evenly over the installments.
 *
 * @scope Estimated tax penalty with safe harbors, dated payments, and annualized income
 * @limitations
 *   Withholding is always treated as paid evenly (the actual-dates election is not modeled)
 *   Annualized method does not model itemized deduction variations by period
 */
export function calculateEstimatedTaxPenalty(
  currentYearTax: number,
  totalPayments: number,      // Withholding + estimated payments
  priorYearTax: number | undefined,  // undefined = unknown (no prior year safe harbor)
  agi: number,
  filingStatus: FilingStatus,
  annualizedIncome?: AnnualizedIncomeInfo,
  taxYear: number = 2025,
  schedule?: PaymentSchedule,
): EstimatedTaxPenaltyResult {
  const c = getEstimatedTaxPenalty(taxYear);

  const zero: EstimatedTaxPenaltyResult = {
    requiredAnnualPayment: 0,
    totalPaymentsMade: round2(totalPayments),
    underpaymentAmount: 0,
    penalty: 0,
  };

  const taxOwed = round2(currentYearTax - totalPayments);

  // Safe harbor 1: Tax owed < $1,000
  if (taxOwed < c.MINIMUM_PENALTY_THRESHOLD) return zero;

  // Determine required payment (lesser of 90% current or 100%/110% prior)
  const currentYearRequired = round2(currentYearTax * c.REQUIRED_ANNUAL_PAYMENT_RATE);

  // When prior year tax is unknown (undefined), only the 90% current-year test applies.
  // When prior year tax is known and > 0, use lesser of 90% current or 100%/110% prior.
  let requiredAnnualPayment: number;
  if (priorYearTax !== undefined && priorYearTax > 0) {
    // MFS uses half the high-income threshold
    const highIncomeThreshold = filingStatus === FilingStatus.MarriedFilingSeparately
      ? c.HIGH_INCOME_THRESHOLD / 2
      : c.HIGH_INCOME_THRESHOLD;
    const priorYearRate = agi > highIncomeThreshold
      ? c.PRIOR_YEAR_SAFE_HARBOR_HIGH_INCOME
      : c.PRIOR_YEAR_SAFE_HARBOR;
    const priorYearRequired = round2(priorYearTax * priorYearRate);
    requiredAnnualPayment = Math.min(currentYearRequired, priorYearRequired);
  } else {
    // Unknown or zero prior year: use 90% of current year only
    requiredAnnualPayment = currentYearRequired;
  }

  // Safe harbor check: did payments meet the required amount?
  if (totalPayments >= requiredAnnualPayment) return { ...zero, requiredAnnualPayment };

  // Underpayment = required - paid
  const underpaymentAmount = round2(Math.max(0, requiredAnnualPayment - totalPayments));

  // ─── Regular method (Form 2210 Part IV) ──
  const regularResult = schedule
    ? calculateScheduledPenalty(requiredAnnualPayment, schedule, taxYear)
    : calculateDayCountPenalty(round2(requiredAnnualPayment / 4), round2(totalPayments / 4), taxYear);
  const regularPenalty = regularResult.totalPenalty;

  // ─── Annualized Income Installment Method (Schedule AI) ──
  // IRC §6654(d)(2): Taxpayers with seasonal/uneven income can compute required
  // installments based on annualized income through each quarter.
  // The taxpayer uses whichever method produces the lower penalty.
  if (annualizedIncome && annualizedIncome.cumulativeIncome) {
    const annualizedPenalty = calculateAnnualizedPenalty(
      annualizedIncome,
      currentYearTax,
      requiredAnnualPayment,
      totalPayments,
      taxYear,
    );

    if (annualizedPenalty < regularPenalty) {
      return {
        requiredAnnualPayment,
        totalPaymentsMade: round2(totalPayments),
        underpaymentAmount,
        penalty: annualizedPenalty,
        usedAnnualizedMethod: true,
        regularPenalty,
        annualizedPenalty,
        quarterlyDetail: regularResult.quarterlyDetail,
      };
    }
  }

  return {
    requiredAnnualPayment,
    totalPaymentsMade: round2(totalPayments),
    underpaymentAmount,
    penalty: regularPenalty,
    usedAnnualizedMethod: false,
    regularPenalty,
    annualizedPenalty: undefined,
    quarterlyDetail: regularResult.quarterlyDetail,
  };
}

/** When the year's payments were made (Form 2210 Part IV). */
export interface PaymentSchedule {
  /** Withholding for the year, treated as paid in four equal parts on the installment due dates (IRC §6654(g)(1)). */
  withholding: number;
  /** Estimated tax payments, each on the date it was made (YYYY-MM-DD). */
  estimatedPayments: ReadonlyArray<{ date: string; amount: number }>;
}

const DAY_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Third Monday of January (Martin Luther King Jr. Day). */
function mlkDay(year: number): string {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  return isoOf(Date.UTC(year, 0, 1 + ((8 - jan1) % 7) + 14));
}

/** DC Emancipation Day (April 16), as observed: Saturday → Friday, Sunday → Monday. */
function emancipationDay(year: number): string {
  const day = new Date(Date.UTC(year, 3, 16)).getUTCDay();
  return isoOf(Date.UTC(year, 3, day === 6 ? 15 : day === 0 ? 17 : 16));
}

/**
 * Form 1040-ES installment due dates for a tax year: April 15, June 15,
 * September 15 and January 15 (IRC §6654(c)(2)), each moved to the next
 * business day when it falls on a weekend or legal holiday (IRC §7503).
 */
export function installmentDueDates(taxYear: number): [string, string, string, string] {
  const holidays = new Set([emancipationDay(taxYear), mlkDay(taxYear + 1)]);
  const next = (y: number, m: number, d: number) => {
    let ms = Date.UTC(y, m, d);
    while ([0, 6].includes(new Date(ms).getUTCDay()) || holidays.has(isoOf(ms))) ms += DAY_MS;
    return isoOf(ms);
  };
  return [next(taxYear, 3, 15), next(taxYear, 5, 15), next(taxYear, 8, 15), next(taxYear + 1, 0, 15)];
}

/**
 * Rate period of a day (Form 2210 penalty worksheet): 0 April–June, 1 July–
 * September, 2 October–December of the tax year, 3 January–April 15 after it.
 */
function ratePeriod(dayMs: number, taxYear: number): number {
  const d = new Date(dayMs);
  if (d.getUTCFullYear() > taxYear) return 3;
  const month = d.getUTCMonth();
  return month < 6 ? 0 : month < 9 ? 1 : 2;
}

/** Penalty on an amount unpaid from the day after `due` through `paid` (or April 15 after the year). */
function accrue(amount: number, due: string, paid: string, taxYear: number, rates: readonly number[]): number {
  const end = Math.min(utc(paid), utc(`${taxYear + 1}-04-15`));
  let penalty = 0;
  for (let day = utc(due) + DAY_MS; day <= end; day += DAY_MS) {
    penalty += amount * rates[ratePeriod(day, taxYear)]! / 365;
  }
  return penalty;
}

/**
 * Regular-method penalty from dated payments (Form 2210 Part IV). Each
 * installment is 25% of the required annual payment. Payments are applied in
 * date order to the earliest unpaid installment; an installment's unpaid part
 * accrues from its due date until paid, or until April 15 after the year.
 *
 * @authority IRC §6654(a), (c), (d)(1), (g)(1); IRC §7503; Form 2210 Part IV
 */
export function calculateScheduledPenalty(
  requiredAnnualPayment: number,
  schedule: PaymentSchedule,
  taxYear: number,
): { totalPenalty: number; quarterlyDetail: QuarterlyPenaltyDetail[] } {
  const rates = getEstimatedTaxPenalty(taxYear).PERIOD_RATES;
  const due = installmentDueDates(taxYear);
  const required = round2(requiredAnnualPayment * 0.25);
  const installments = due.map((date) => ({ date, remaining: required, applied: 0, unpaidAtDue: 0, penalty: 0 }));

  const withheld = round2(schedule.withholding / 4);
  const payments = [
    ...due.map((date) => ({ date, amount: withheld })),
    ...schedule.estimatedPayments.filter((p) => p.amount > 0),
  ].sort((a, b) => a.date.localeCompare(b.date));

  // What each installment still owed on its due date: payments made by then.
  const paidBy = (date: string) => payments.filter((p) => p.date <= date).reduce((s, p) => s + p.amount, 0);
  due.forEach((date, i) => {
    installments[i]!.unpaidAtDue = round2(Math.max(0, required * (i + 1) - paidBy(date)));
  });

  for (const payment of payments) {
    let left = payment.amount;
    for (const inst of installments) {
      if (left <= 0) break;
      if (inst.remaining <= 0) continue;
      const portion = Math.min(left, inst.remaining);
      if (payment.date > inst.date) inst.penalty += accrue(portion, inst.date, payment.date, taxYear, rates);
      inst.remaining = round2(inst.remaining - portion);
      inst.applied = round2(inst.applied + portion);
      left = round2(left - portion);
    }
  }
  // Never paid during the year: accrues to April 15 (paid with the return).
  for (const inst of installments) {
    if (inst.remaining > 0) inst.penalty += accrue(inst.remaining, inst.date, `${taxYear + 1}-04-15`, taxYear, rates);
  }

  const quarterlyDetail: QuarterlyPenaltyDetail[] = installments.map((inst) => ({
    requiredInstallment: required,
    paymentMade: inst.applied,
    underpayment: Math.min(required, inst.unpaidAtDue),
    penalty: round2(inst.penalty),
  }));
  return { totalPenalty: round2(quarterlyDetail.reduce((s, q) => s + q.penalty, 0)), quarterlyDetail };
}

/**
 * Calculate penalty using per-quarter day-count method (Form 2210 Part IV).
 *
 * For each quarter:
 *   1. Compute underpayment = max(0, required installment - payment)
 *   2. For each rate period the underpayment spans:
 *      penalty += underpayment × period_rate × days_in_period / 365
 *   3. Overpayments from earlier quarters carry forward
 *
 * The day-count matrix (DAYS_MATRIX) and period rates (PERIOD_RATES) are
 * defined in tax2025.ts constants, making it easy to update for future years
 * when rates change mid-year.
 *
 * @authority IRC §6654(a), Form 2210 Part IV
 */
function calculateDayCountPenalty(
  quarterlyRequired: number,
  quarterlyPayment: number,
  taxYear: number,
): { totalPenalty: number; quarterlyDetail: QuarterlyPenaltyDetail[] } {
  const c = getEstimatedTaxPenalty(taxYear);
  const daysMatrix = c.DAYS_MATRIX;
  const periodRates = c.PERIOD_RATES;

  let totalPenalty = 0;
  let carryoverCredit = 0;  // Overpayment from prior quarters carries forward
  const quarterlyDetail: QuarterlyPenaltyDetail[] = [];

  for (let q = 0; q < 4; q++) {
    // Available payment = this quarter's payment + carryover from prior quarters
    const availablePayment = round2(quarterlyPayment + carryoverCredit);
    const underpayment = round2(Math.max(0, quarterlyRequired - availablePayment));

    // Carryover excess to next quarter
    carryoverCredit = round2(Math.max(0, availablePayment - quarterlyRequired));

    // Calculate penalty for this quarter's underpayment using day-count method
    let quarterPenalty = 0;
    if (underpayment > 0) {
      for (let p = 0; p < 4; p++) {
        const days = daysMatrix[q][p];
        if (days > 0) {
          // Penalty = underpayment × annual_rate × days / 365
          quarterPenalty += underpayment * periodRates[p] * days / 365;
        }
      }
      quarterPenalty = round2(quarterPenalty);
    }

    totalPenalty = round2(totalPenalty + quarterPenalty);

    quarterlyDetail.push({
      requiredInstallment: quarterlyRequired,
      paymentMade: quarterlyPayment,
      underpayment,
      penalty: quarterPenalty,
    });
  }

  return { totalPenalty, quarterlyDetail };
}

/**
 * Calculate penalty using the annualized income installment method.
 *
 * For each quarter:
 *   1. Annualize cumulative income: income × annualization factor
 *   2. Compute tax on annualized income
 *   3. Required installment = annualized tax × cumulative installment %
 *   4. Credit for prior-quarter overpayments
 *   5. Underpayment per quarter = max(0, required - paid for quarter)
 *   6. Penalty per quarter using day-count method
 *
 * Annualization factors: [4, 2.4, 1.5, 1] (3, 5, 8, 12 months)
 * Required installment %: [25%, 50%, 75%, 100%] cumulative
 *
 * @authority IRC §6654(d)(2), Form 2210 Schedule AI
 */
function calculateAnnualizedPenalty(
  annualizedIncome: AnnualizedIncomeInfo,
  currentYearTax: number,
  requiredAnnualPayment: number,
  totalPayments: number,
  taxYear: number,
): number {
  const c = getEstimatedTaxPenalty(taxYear);
  const factors = c.ANNUALIZATION_FACTORS;
  const installPcts = c.QUARTERLY_INSTALLMENT_PERCENTAGES;
  const daysMatrix = c.DAYS_MATRIX;
  const periodRates = c.PERIOD_RATES;

  // Distribute total payments equally across quarters (simplified)
  // unless quarterly withholding is provided
  const cw = annualizedIncome.cumulativeWithholding;
  const quarterlyPayments: number[] = cw
    ? [
        cw[0] || 0,
        (cw[1] || 0) - (cw[0] || 0),
        (cw[2] || 0) - (cw[1] || 0),
        (cw[3] || 0) - (cw[2] || 0),
      ]
    : [totalPayments / 4, totalPayments / 4, totalPayments / 4, totalPayments / 4];

  let totalPenalty = 0;
  let carryoverCredit = 0; // Overpayment from prior quarters carries forward

  for (let q = 0; q < 4; q++) {
    const cumulativeIncome = annualizedIncome.cumulativeIncome[q] || 0;

    // Step 1: Annualize the cumulative income
    const annualizedAmt = round2(cumulativeIncome * factors[q]);

    // Step 2: Compute tax on annualized income (proportional to current year)
    // Simplified: use ratio of annualized to actual income × actual tax
    const fullYearIncome = annualizedIncome.cumulativeIncome[3] || 0;
    const annualizedTax = fullYearIncome > 0
      ? round2(currentYearTax * (annualizedAmt / fullYearIncome))
      : 0;

    // Step 3: Required installment for this quarter
    // = annualized tax × cumulative installment % minus prior quarters' required amounts
    const cumulativeRequired = round2(annualizedTax * installPcts[q]);
    const priorCumulativeRequired = q > 0
      ? round2(annualizedTax * installPcts[q - 1])
      : 0;
    // But cap at the regular required installment for this quarter
    const regularQuarterlyRequired = round2(requiredAnnualPayment * 0.25);

    // The required installment is the lesser of annualized or regular method
    const annualizedQuarterlyRequired = round2(Math.max(0, cumulativeRequired - priorCumulativeRequired));
    const quarterRequired = Math.min(annualizedQuarterlyRequired, regularQuarterlyRequired);

    // Step 4: Apply payment and carryover
    const availablePayment = round2(quarterlyPayments[q] + carryoverCredit);
    const underpayment = round2(Math.max(0, quarterRequired - availablePayment));

    // Carryover excess payment to next quarter
    carryoverCredit = round2(Math.max(0, availablePayment - quarterRequired));

    // Step 5: Per-quarter penalty using day-count method
    if (underpayment > 0) {
      let quarterPenalty = 0;
      for (let p = 0; p < 4; p++) {
        const days = daysMatrix[q][p];
        if (days > 0) {
          quarterPenalty += underpayment * periodRates[p] * days / 365;
        }
      }
      totalPenalty = round2(totalPenalty + round2(quarterPenalty));
    }
  }

  return round2(totalPenalty);
}
