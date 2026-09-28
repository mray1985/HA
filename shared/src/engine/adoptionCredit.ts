import { AdoptionCarryforwardYear, AdoptionCreditInfo, AdoptionCreditResult } from '../types/index.js';
import { getAdoptionCredit } from '../constants/taxConstants.js';
import { round2 } from './utils.js';

/**
 * Calculate Adoption Credit (Form 8839).
 *
 * For 2025: up to $17,280 per eligible child for qualified adoption expenses.
 * Special needs adoptions get the full credit regardless of actual expenses.
 *
 * AGI phase-out: begins at $259,190, eliminated over $40,000 range.
 *
 * The credit is non-refundable but can be carried forward for up to 5 years.
 *
 * @authority
 *   IRC: Section 23 — adoption expenses
 *   Rev. Proc: 2024-40, Section 3.35 — adoption credit amounts and phase-outs
 *   Form: Form 8839
 * @scope Adoption credit with AGI phase-out ($17,280 max)
 * @limitations The tax-liability limit and five-year carryforward are applied by the Form 1040 orchestrator.
 */
export function calculateAdoptionCredit(
  info: AdoptionCreditInfo,
  agi: number,
  taxYear: number = 2025,
): AdoptionCreditResult {
  const zero: AdoptionCreditResult = {
    expensesBasis: 0, credit: 0, creditAvailable: 0, carryforward: 0, carryforwardByYear: [], expired: 0,
  };

  if (!info) return zero;

  const c = getAdoptionCredit(taxYear);
  const numChildren = Math.max(1, info.numberOfChildren || 1);

  // Expenses basis: actual expenses or max per child for special needs
  let expensesBasis: number;
  if (info.isSpecialNeeds) {
    expensesBasis = round2(c.MAX_CREDIT * numChildren);
  } else {
    expensesBasis = round2(Math.min(info.qualifiedExpenses || 0, c.MAX_CREDIT * numChildren));
  }

  if (expensesBasis <= 0 && !(info.priorCarryforwards || []).some(year => year.amount > 0)) return zero;

  // AGI phase-out
  let credit = expensesBasis;
  if (agi >= c.PHASE_OUT_START + c.PHASE_OUT_RANGE) {
    credit = 0;
  } else if (agi > c.PHASE_OUT_START) {
    const phaseOutFraction = (agi - c.PHASE_OUT_START) / c.PHASE_OUT_RANGE;
    credit = round2(expensesBasis * (1 - phaseOutFraction));
  }

  const currentYearCredit = round2(Math.max(0, credit));
  const available = round2(currentYearCredit + (info.priorCarryforwards || [])
    .filter(year => year.taxYear >= taxYear - CARRYFORWARD_YEARS && year.taxYear < taxYear)
    .reduce((sum, year) => sum + Math.max(0, year.amount || 0), 0));
  return {
    expensesBasis,
    credit: currentYearCredit,
    creditAvailable: available,
    carryforward: 0,
    carryforwardByYear: [],
    expired: 0,
  };
}

const CARRYFORWARD_YEARS = 5;

/**
 * IRC §23(c). The credit is nonrefundable. Unused credit, oldest first,
 * carries forward five years. A year older than that expires.
 */
export function limitAdoptionCredit(
  info: AdoptionCreditInfo,
  currentYearCredit: number,
  taxYear: number,
  taxCapacity: number,
): Pick<AdoptionCreditResult, 'credit' | 'creditAvailable' | 'carryforward' | 'carryforwardByYear' | 'expired'> {
  const oldestUsable = taxYear - CARRYFORWARD_YEARS;
  let expired = 0;
  const buckets: AdoptionCarryforwardYear[] = [];
  for (const year of info.priorCarryforwards || []) {
    const amount = round2(Math.max(0, year.amount || 0));
    if (amount <= 0) continue;
    if (year.taxYear < oldestUsable || year.taxYear >= taxYear) {
      expired = round2(expired + amount);
      continue;
    }
    buckets.push({ taxYear: year.taxYear, amount });
  }
  buckets.sort((a, b) => a.taxYear - b.taxYear);
  if (currentYearCredit > 0) {
    buckets.push({ taxYear, amount: round2(currentYearCredit) });
  }

  const creditAvailable = round2(buckets.reduce((sum, year) => sum + year.amount, 0));
  let remaining = round2(Math.max(0, taxCapacity));
  const credit = round2(Math.min(creditAvailable, remaining));
  for (const bucket of buckets) {
    const used = Math.min(bucket.amount, remaining);
    bucket.amount = round2(bucket.amount - used);
    remaining = round2(remaining - used);
  }
  const carryforwardByYear = buckets.filter(year => year.amount > 0);
  return {
    credit,
    creditAvailable,
    carryforward: round2(carryforwardByYear.reduce((sum, year) => sum + year.amount, 0)),
    carryforwardByYear,
    expired,
  };
}
