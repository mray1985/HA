import { FilingStatus } from '../types/index.js';
import { getTaxConstants } from '../constants/taxConstants.js';
import { calculateProgressiveTax } from './brackets.js';
import { round2 } from './utils.js';

/**
 * Calculate income tax with preferential rates for qualified dividends and LTCG,
 * including the 25% rate zone for unrecaptured Section 1250 gain and the 28%
 * maximum rate on collectibles gain.
 *
 * Implements the IRS Schedule D Tax Worksheet logic:
 *   1. Compute "special" tax:
 *      - Progressive rates on ordinary income
 *      - 25% on unrecaptured §1250 gain (stacked on top of ordinary)
 *      - 28% on collectibles gain (stacked after §1250)
 *      - 0%/15%/20% on remaining LTCG + qualified dividends
 *   2. Compute "regular" tax: all progressive rates on taxable income
 *   3. Tax = min(special, regular)
 *
 * This ensures the preferential computation never results in MORE tax than
 * the regular computation (IRC §1(h) is a maximum rate provision).
 *
 * Collectibles gain is the long-term gain already identified on the return
 * (1099-B `isCollectible`). It is removed from the 0%/15%/20% bucket and
 * taxed at the 28% maximum. Section 1202 gain that was not excluded is included
 * in that 28% amount by Schedule D.
 *
 * @authority
 *   IRC: Section 1(h) — maximum capital gains rate
 *   IRC: Section 1(h)(1)(E) — 25% rate on unrecaptured Section 1250 gain
 *   IRC: Section 1(h)(1)(F), Section 1(h)(4) — 28% maximum rate on collectibles gain
 *   Rev. Proc: 2024-40, Section 3.12 — inflation-adjusted rate thresholds
 *   Form: Form 1040, Qualified Dividends and Capital Gain Tax Worksheet
 *   Form: Schedule D Tax Worksheet (when Section 1250 or 28% rate gain is present)
 * @scope Preferential rate tax for qualified dividends and LTCG (0%/15%/20%), 25% Section 1250 zone, and 28% collectibles
 * @limitations None
 */
export function calculatePreferentialRateTax(
  taxableIncome: number,
  qualifiedDividends: number,
  longTermCapitalGains: number,
  filingStatus: FilingStatus,
  unrecapturedSection1250Gain: number = 0,
  taxYear: number = 2025,
  collectiblesGain: number = 0,
): {
  ordinaryTax: number;
  preferentialTax: number;
  section1250Tax: number;
  collectiblesTax: number;
  totalTax: number;
  marginalRate: number;
} {
  if (taxableIncome <= 0) {
    return { ordinaryTax: 0, preferentialTax: 0, section1250Tax: 0, collectiblesTax: 0, totalTax: 0, marginalRate: 0 };
  }

  // Cap unrecaptured 1250 gain to actual LTCG (can't exceed the long-term gains)
  // and to taxable income
  const effective1250 = Math.min(
    Math.max(0, unrecapturedSection1250Gain),
    Math.max(0, longTermCapitalGains),
    taxableIncome,
  );

  // Collectibles (28% rate gain) are part of LTCG. They stack after §1250 and
  // cannot also occupy the 0%/15%/20% bucket.
  const ltcgAfter1250 = Math.max(0, longTermCapitalGains - effective1250);
  const effectiveCollectibles = Math.min(
    Math.max(0, collectiblesGain),
    ltcgAfter1250,
    taxableIncome,
  );

  // Total preferential = QD + LTCG, capped at taxable income
  // (LTCG already includes the 1250 gain and collectibles — we carve them out below)
  const totalPreferential = Math.min(
    round2(qualifiedDividends + longTermCapitalGains),
    taxableIncome,
  );

  // Regular tax: all at progressive rates (the baseline comparison)
  const regularResult = calculateProgressiveTax(taxableIncome, filingStatus, taxYear);
  const regularTax = regularResult.tax;

  // If no preferential income, fall back to normal progressive calculation
  if (totalPreferential <= 0) {
    return {
      ordinaryTax: regularTax,
      preferentialTax: 0,
      section1250Tax: 0,
      collectiblesTax: 0,
      totalTax: regularTax,
      marginalRate: regularResult.marginalRate,
    };
  }

  // ─── "Special" computation per Schedule D Tax Worksheet ───

  // Ordinary portion = taxable income minus all preferential income
  const ordinaryTaxableIncome = round2(taxableIncome - totalPreferential);

  // Tax on ordinary income at progressive rates
  const ordinaryResult = calculateProgressiveTax(ordinaryTaxableIncome, filingStatus, taxYear);
  const ordinaryTax = ordinaryResult.tax;

  const rates = getTaxConstants(taxYear).CAPITAL_GAINS_RATES;

  // ── Section 1250 gain (25% zone) ──────────────────────
  // Stacks on top of ordinary income, before the 28% and 0%/15%/20% zones
  // Per Schedule D Tax Worksheet Line 36: flat 25% rate
  const section1250Tax = round2(effective1250 * rates.RATE_25);

  // ── Collectibles gain (28% maximum) ───────────────────
  // IRC §1(h)(4). Stacks after §1250 and before adjusted net capital gain.
  const collectiblesTax = round2(effectiveCollectibles * rates.RATE_28);

  // ── Remaining preferential income (0%/15%/20% zones) ──
  // The non-1250, non-collectibles preferential income stacks last
  const remainingPreferential = round2(totalPreferential - effective1250 - effectiveCollectibles);

  let preferentialTax = 0;

  if (remainingPreferential > 0) {
    const threshold0 = rates.THRESHOLD_0[filingStatus];
    const threshold15 = rates.THRESHOLD_15[filingStatus];

    // Remaining preferential starts after ordinary + 1250 + collectibles
    const prefStart = round2(ordinaryTaxableIncome + effective1250 + effectiveCollectibles);
    const prefEnd = taxableIncome; // = ordinaryTaxableIncome + totalPreferential

    // Portion in 0% zone: from prefStart to min(prefEnd, threshold0)
    const in0Zone = Math.max(0, Math.min(prefEnd, threshold0) - prefStart);
    // Portion in 15% zone: from max(prefStart, threshold0) to min(prefEnd, threshold15)
    const in15Zone = Math.max(0, Math.min(prefEnd, threshold15) - Math.max(prefStart, threshold0));
    // Portion in 20% zone: from max(prefStart, threshold15) to prefEnd
    const in20Zone = Math.max(0, prefEnd - Math.max(prefStart, threshold15));

    preferentialTax = round2(
      in0Zone * rates.RATE_0 +
      in15Zone * rates.RATE_15 +
      in20Zone * rates.RATE_20,
    );
  }

  // Special tax = ordinary + 25% on 1250 + 28% on collectibles + preferential rates on rest
  const specialTax = round2(ordinaryTax + section1250Tax + collectiblesTax + preferentialTax);

  // IRC §1(h): take the lesser of special vs regular tax
  // This ensures preferential rates never INCREASE total tax
  const totalTax = Math.min(specialTax, regularTax);

  // If regular tax is lower (meaning a maximum rate exceeds the ordinary bracket rate),
  // allocate the reduction to the 28% slice first, then the 25% slice.
  if (totalTax < specialTax && specialTax > 0) {
    let highRateRoom = round2(Math.max(0, totalTax - ordinaryTax - preferentialTax));
    const effectiveCollectiblesTax = round2(Math.min(collectiblesTax, highRateRoom));
    highRateRoom = round2(highRateRoom - effectiveCollectiblesTax);
    const effectiveSection1250Tax = round2(Math.min(section1250Tax, Math.max(0, highRateRoom)));
    return {
      ordinaryTax,
      preferentialTax,
      section1250Tax: effectiveSection1250Tax,
      collectiblesTax: effectiveCollectiblesTax,
      totalTax,
      marginalRate: regularResult.marginalRate,
    };
  }

  return {
    ordinaryTax,
    preferentialTax,
    section1250Tax,
    collectiblesTax,
    totalTax,
    marginalRate: regularResult.marginalRate,
  };
}
