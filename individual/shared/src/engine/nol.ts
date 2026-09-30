import { round2 } from './utils.js';

export interface CurrentYearNOLInput {
  /** AGI before the NOL deduction. May be negative. */
  agi: number;
  /** Standard or itemized deduction. */
  deductionAmount: number;
  /** Schedule 1-A deductions. Nonbusiness. */
  schedule1ADeduction: number;
  /** §1211(b) capital-loss deduction already inside AGI. */
  capitalLossDeduction: number;
  /** Wages, interest, dividends, retirement, and other nonbusiness income. */
  nonbusinessIncome: number;
  /**
   * Nonbusiness deductions other than the standard/itemized deduction and
   * Schedule 1-A. Those two are passed separately and included here.
   */
  otherNonbusinessDeductions: number;
}

/**
 * IRC §172. A current-year net operating loss is the excess of deductions
 * over income, with two modifications: capital losses are allowed only to
 * the extent of capital gains, and nonbusiness deductions are allowed only
 * to the extent of nonbusiness income.
 *
 * The NOL is not deducted on the return that generates it. A prior-year
 * carryforward entered on the return is a separate deduction.
 */
export function figureCurrentYearNOL(input: CurrentYearNOLInput): number {
  const schedule1A = Math.max(0, input.schedule1ADeduction || 0);
  const deduction = Math.max(0, input.deductionAmount || 0);
  const preNol = round2(input.agi - deduction - schedule1A);
  if (preNol >= 0) return 0;

  const negativeAmount = round2(-preNol);
  const nonbusinessDeductions = round2(deduction + schedule1A + Math.max(0, input.otherNonbusinessDeductions || 0));
  const excessNonbusiness = round2(Math.max(0, nonbusinessDeductions - Math.max(0, input.nonbusinessIncome || 0)));
  const capitalLoss = Math.max(0, input.capitalLossDeduction || 0);
  return round2(Math.max(0, negativeAmount - capitalLoss - excessNonbusiness));
}
