import { FilingStatus, BracketDetail, CalculationTrace } from '../types/index.js';
import { getTaxBrackets } from '../constants/taxConstants.js';
import { round2 } from './utils.js';

/**
 * Calculate progressive federal income tax for a given taxable income and filing status.
 * Returns both the total tax and a breakdown by bracket.
 *
 * @authority
 *   IRC: Section 1(a)-(d), (j) — tax rate tables by filing status
 *   Rev. Proc: 2024-40, Section 3.01 — inflation-adjusted bracket thresholds
 *   Form: Form 1040, Line 16
 * @scope Progressive tax bracket computation
 * @limitations None
 */
export function calculateProgressiveTax(
  taxableIncome: number,
  filingStatus: FilingStatus,
  taxYear: number = 2025,
): { tax: number; brackets: BracketDetail[]; marginalRate: number } {
  const brackets = getTaxBrackets(taxYear)[filingStatus];
  if (!brackets) {
    throw new Error(`Unknown filing status: ${filingStatus}`);
  }

  const income = Math.max(0, taxableIncome);
  const details: BracketDetail[] = [];
  let totalTax = 0;
  let marginalRate = 0;

  for (const bracket of brackets) {
    if (income <= bracket.min) break;

    const taxableAtRate = Math.min(income, bracket.max) - bracket.min;
    const taxAtRate = round2(taxableAtRate * bracket.rate);

    details.push({
      rate: bracket.rate,
      taxableAtRate,
      taxAtRate,
    });

    totalTax += taxAtRate;
    marginalRate = bracket.rate;
  }

  return {
    tax: round2(totalTax),
    brackets: details,
    marginalRate,
  };
}

/** Taxable income from which the Tax Computation Worksheet replaces the Tax Table. */
export const TAX_TABLE_LIMIT = 100_000;

/**
 * The Tax Table row a taxable income falls in: $0–$5, $5–$15, $15–$25, then
 * $25 rows to $3,000 and $50 rows to $100,000. Null from $100,000.
 */
export function taxTableRow(taxableIncome: number): { atLeast: number; lessThan: number } | null {
  const income = Math.max(0, taxableIncome);
  if (income >= TAX_TABLE_LIMIT) return null;
  if (income < 5) return { atLeast: 0, lessThan: 5 };
  if (income < 15) return { atLeast: 5, lessThan: 15 };
  if (income < 25) return { atLeast: 15, lessThan: 25 };
  const width = income < 3_000 ? 25 : 50;
  const atLeast = Math.floor(income / width) * width;
  return { atLeast, lessThan: atLeast + width };
}

/**
 * Tax on an amount as Form 1040 line 16 and the worksheets that refer to it
 * figure it: from the Tax Table below $100,000, from the Tax Computation
 * Worksheet (the rate schedule, to the cent) from $100,000. The Tax Table
 * gives the tax at the middle of the row, rounded to the dollar (half up);
 * checked against every value of the 2025 Tax Table, Publication 1040 (2025).
 *
 * @authority
 *   Form: Form 1040 Instructions, Line 16 — Tax Table if taxable income is less than $100,000
 *   Form: Qualified Dividends and Capital Gain Tax Worksheet, lines 22 and 24; Schedule D Tax Worksheet
 *   Publication: Publication 1040 (2025), Tax Table
 * @scope Tax on ordinary income at Form 1040 line 16
 * @limitations None
 */
export function calculateTaxTableTax(
  taxableIncome: number,
  filingStatus: FilingStatus,
  taxYear: number = 2025,
): { tax: number; marginalRate: number; row: { atLeast: number; lessThan: number } | null } {
  const exact = calculateProgressiveTax(taxableIncome, filingStatus, taxYear);
  const row = taxTableRow(taxableIncome);
  if (!row || taxableIncome <= 0) return { tax: exact.tax, marginalRate: exact.marginalRate, row };
  const atMidpoint = calculateProgressiveTax((row.atLeast + row.lessThan) / 2, filingStatus, taxYear);
  return { tax: Math.floor(atMidpoint.tax + 0.5 + 1e-9), marginalRate: exact.marginalRate, row };
}

/**
 * Get the marginal tax rate for a given taxable income.
 *
 * @authority
 *   IRC: Section 1(a)-(d), (j) — tax rate tables by filing status
 *   Rev. Proc: 2024-40, Section 3.01 — inflation-adjusted bracket thresholds
 *   Form: Form 1040, Line 16
 * @scope Progressive tax bracket computation
 * @limitations None
 */
export function getMarginalRate(taxableIncome: number, filingStatus: FilingStatus, taxYear: number = 2025): number {
  const brackets = getTaxBrackets(taxYear)[filingStatus];
  const income = Math.max(0, taxableIncome);

  for (let i = brackets.length - 1; i >= 0; i--) {
    if (income > brackets[i].min) return brackets[i].rate;
  }
  return brackets[0].rate;
}

/**
 * Calculate progressive tax with a trace tree for each bracket.
 * Used when tracing is enabled to provide per-bracket audit trail.
 *
 * Inspired by IRS Direct File Fact Graph's StepwiseMultiply CompNode.
 */
export function traceProgressiveTax(
  taxableIncome: number,
  filingStatus: FilingStatus,
  taxYear: number = 2025,
): { tax: number; brackets: BracketDetail[]; marginalRate: number; traces: CalculationTrace[] } {
  const result = calculateProgressiveTax(taxableIncome, filingStatus, taxYear);
  const bracketTraces: CalculationTrace[] = result.brackets
    .filter((b) => b.taxAtRate > 0)
    .map((b) => ({
      lineId: `bracket.${(b.rate * 100).toFixed(0)}pct`,
      label: `${(b.rate * 100).toFixed(0)}% bracket`,
      value: b.taxAtRate,
      formula: `$${b.taxableAtRate.toLocaleString()} × ${(b.rate * 100).toFixed(0)}%`,
      authority: 'IRC §1(a)-(d)',
      inputs: [
        { lineId: 'bracket.taxableAtRate', label: `Income taxed at ${(b.rate * 100).toFixed(0)}%`, value: b.taxableAtRate },
      ],
    }));
  return { ...result, traces: bracketTraces };
}
