/**
 * Washington capital gains tax (chapter 82.87 RCW): a tax on an individual's
 * long-term capital gains. Washington has no income tax.
 *
 * Amounts by tax year come from the Department of Revenue's updated amounts
 * table ("Do you owe capital gains tax?", dor.wa.gov). The department adjusts
 * them each year for inflation (RCW 82.87.150).
 */

export interface WaCapitalGainsAmounts {
  /** RCW 82.87.060(1): per individual, married couple or domestic partnership. */
  standardDeduction: number;
  /** RCW 82.87.080(1): donations over this amount are deductible. */
  charitableThreshold: number;
  /** RCW 82.87.080(2): the most the charitable deduction can be. */
  charitableMaxDeduction: number;
}

export const WA_CAPITAL_GAINS_AMOUNTS: Record<number, WaCapitalGainsAmounts> = {
  2024: { standardDeduction: 270_000, charitableThreshold: 270_000, charitableMaxDeduction: 108_000 },
  2025: { standardDeduction: 278_000, charitableThreshold: 278_000, charitableMaxDeduction: 111_000 },
};

/**
 * The latest standard deduction published (2025). RCW 82.87.150(1) never
 * lowers it, so a later year's deduction is at least this much.
 */
export const WA_LATEST_STANDARD_DEDUCTION = 278_000;

/** RCW 82.87.040(1)(a): 7% of Washington capital gains, from January 1, 2022. */
export const WA_CAPITAL_GAINS_RATE = 0.07;
export const WA_CAPITAL_GAINS_FIRST_YEAR = 2022;

/**
 * RCW 82.87.040(1)(b) (2025 c 421): another 2.9% of the part of Washington
 * capital gains over $1,000,000, from tax year 2025.
 */
export const WA_CAPITAL_GAINS_ADDITIONAL = { rate: 0.029, over: 1_000_000, fromYear: 2025 } as const;
