import { round2 } from './utils.js';

export interface Section1231LookbackYear {
  taxYear: number;
  /** Positive for a net gain, negative for a net loss. */
  netGainOrLoss: number;
}

export interface Section1231LookbackResult {
  /** Gain that stays long-term after the lookback. */
  longTermGain: number;
  /** Current-year gain recharacterized as ordinary income. */
  ordinaryFromGain: number;
  /** Unrecaptured losses left in the five-year window after this year. */
  unrecapturedLoss: number;
}

/**
 * IRC §1231(c). A net section 1231 gain is ordinary to the extent of
 * unrecaptured net section 1231 losses from the five preceding tax years.
 *
 * Prior gains in that window already used the oldest losses. Losses that
 * fall out of the five-year window are not recaptured.
 */
export function applySection1231Lookback(
  currentNet: number,
  lookback: Section1231LookbackYear[] | undefined,
  taxYear: number,
): Section1231LookbackResult {
  const windowStart = taxYear - 5;
  const years = (lookback || [])
    .filter(y => y.taxYear >= windowStart && y.taxYear < taxYear && Number.isFinite(y.netGainOrLoss))
    .sort((a, b) => a.taxYear - b.taxYear);

  const pool: number[] = [];
  for (const year of years) {
    if (year.netGainOrLoss < 0) {
      pool.push(Math.abs(year.netGainOrLoss));
    } else if (year.netGainOrLoss > 0) {
      let remainingGain = year.netGainOrLoss;
      while (remainingGain > 0 && pool.length > 0) {
        const used = Math.min(pool[0], remainingGain);
        pool[0] = round2(pool[0] - used);
        remainingGain = round2(remainingGain - used);
        if (pool[0] <= 0) pool.shift();
      }
    }
  }

  const unrecaptured = round2(pool.reduce((sum, loss) => sum + loss, 0));
  if (currentNet <= 0) {
    return { longTermGain: 0, ordinaryFromGain: 0, unrecapturedLoss: unrecaptured };
  }

  const ordinaryFromGain = round2(Math.min(currentNet, unrecaptured));
  return {
    longTermGain: round2(currentNet - ordinaryFromGain),
    ordinaryFromGain,
    unrecapturedLoss: round2(unrecaptured - ordinaryFromGain),
  };
}
