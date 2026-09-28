import { FilingStatus, Income1099B } from '../types/index.js';
import { round2 } from './utils.js';

export interface Section1202Result {
  /** Gain removed from gross income. */
  excludedGain: number;
  /** Eligible gain that stays in income and is taxed at a maximum of 28%. */
  rateGain: number;
  /** 7% of the excluded gain on 50% and 75% stock. Zero for 100% stock. */
  amtPreference: number;
  /** True when the return has at least one QSBS disposition, even if none is excluded. */
  hadDisposition: boolean;
}

const TEN_MILLION = 10_000_000;
const FIVE_MILLION = 5_000_000;

/**
 * Exclusion percentage by acquisition date.
 * Stock acquired after August 10, 1993 and on or before February 17, 2009: 50%.
 * After February 17, 2009 and on or before September 27, 2010: 75%.
 * After September 27, 2010: 100%.
 *
 * Stock acquired after July 4, 2025 uses the post-OBBBA holding-period schedule.
 * No sale in 2024–2026 can satisfy that schedule, so those lots are not excluded here.
 */
export function qsbsExclusionRate(dateAcquired: string): number {
  if (dateAcquired > '2025-07-04') return 0;
  if (dateAcquired > '2010-09-27') return 1;
  if (dateAcquired > '2009-02-17') return 0.75;
  if (dateAcquired > '1993-08-10') return 0.5;
  return 0;
}

export function heldMoreThanFiveYears(dateAcquired: string | undefined, dateSold: string | undefined): boolean {
  if (!dateAcquired || !dateSold) return false;
  const acquired = new Date(`${dateAcquired}T00:00:00`);
  const sold = new Date(`${dateSold}T00:00:00`);
  if (Number.isNaN(acquired.getTime()) || Number.isNaN(sold.getTime())) return false;
  const fiveYearsLater = new Date(acquired);
  fiveYearsLater.setFullYear(fiveYearsLater.getFullYear() + 5);
  return sold > fiveYearsLater;
}

interface Lot {
  issuer: string;
  gain: number;
  basis: number;
  rate: number;
  priorEligible: number;
  eligible: boolean;
}

/**
 * IRC §1202. Per issuer, eligible gain is limited to the greater of
 * $10 million ($5 million if married filing separately), reduced by eligible
 * gain already taken into account, or 10 times the basis of that issuer's
 * stock disposed of this year. The exclusion percentage then applies.
 * The non-excluded eligible gain is section 1202 gain taxed at 28%.
 */
export function applySection1202(
  transactions: Income1099B[],
  filingStatus: FilingStatus,
): Section1202Result {
  const lots: Lot[] = [];
  for (const t of transactions) {
    if (!t.isQSBS) continue;
    const proceeds = Number(t.proceeds) || 0;
    const basis = Math.max(0, Number(t.costBasis) || 0);
    const gain = round2(proceeds - basis);
    const issuer = (t.qsbsIssuer || t.description || 'QSBS').trim() || 'QSBS';
    const eligible = gain > 0 && heldMoreThanFiveYears(t.dateAcquired, t.dateSold) && qsbsExclusionRate(t.dateAcquired || '') > 0;
    lots.push({
      issuer,
      gain: Math.max(0, gain),
      basis,
      rate: qsbsExclusionRate(t.dateAcquired || ''),
      priorEligible: Math.max(0, t.qsbsPriorEligibleGain || 0),
      eligible,
    });
  }

  const byIssuer = new Map<string, Lot[]>();
  for (const lot of lots) {
    const group = byIssuer.get(lot.issuer) || [];
    group.push(lot);
    byIssuer.set(lot.issuer, group);
  }

  const dollarCap = filingStatus === FilingStatus.MarriedFilingSeparately ? FIVE_MILLION : TEN_MILLION;
  let excludedGain = 0;
  let rateGain = 0;
  let amtPreference = 0;

  for (const group of byIssuer.values()) {
    const basisDisposed = group.reduce((sum, lot) => sum + lot.basis, 0);
    const prior = Math.max(...group.map(lot => lot.priorEligible));
    let remaining = Math.max(0, dollarCap - prior, round2(10 * basisDisposed));
    for (const lot of group) {
      if (!lot.eligible || remaining <= 0) continue;
      const eligibleGain = round2(Math.min(lot.gain, remaining));
      remaining = round2(remaining - eligibleGain);
      const excluded = round2(eligibleGain * lot.rate);
      const included = round2(eligibleGain - excluded);
      excludedGain = round2(excludedGain + excluded);
      rateGain = round2(rateGain + included);
      if (lot.rate < 1) {
        amtPreference = round2(amtPreference + excluded * 0.07);
      }
    }
  }

  return { excludedGain, rateGain, amtPreference, hadDisposition: lots.length > 0 };
}
