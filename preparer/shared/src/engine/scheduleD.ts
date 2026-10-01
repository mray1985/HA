import { FilingStatus, Income1099B, ScheduleDResult } from '../types/index.js';
import { getTaxConstants } from '../constants/taxConstants.js';
import { applySection1202 } from './qsbs.js';
import { round2 } from './utils.js';

/**
 * Calculate Schedule D — Capital Gains and Losses.
 *
 * Separates transactions into short-term (held ≤ 1 year) and long-term (held > 1 year).
 * Net capital loss is deductible up to $3,000 ($1,500 MFS) against ordinary income.
 * Excess loss carries forward to future years, preserving ST/LT character.
 *
 * Carryforward from prior year preserves character:
 *   - ST carryforward applied as additional short-term loss
 *   - LT carryforward applied as additional long-term loss
 *
 * For backward compatibility, if only the legacy single `carryforward` value is
 * provided (no ST/LT split), it is treated entirely as short-term.
 *
 * When computing the new carryforward, short-term net losses absorb the deduction
 * first, then long-term net losses. This preserves character for future years.
 *
 * @authority
 *   IRC: Section 1(h) — maximum capital gains rate
 *   IRC: Section 1211(b) — limitation on capital losses for individuals
 *   IRC: Section 1212(b) — capital loss carryforward for individuals
 *   Form: Schedule D (Form 1040)
 *   Pub: Publication 550 — Investment Income and Expenses
 * @scope Capital gains/losses with $3k loss limit and carryforward
 * @limitations Section 1231 gain is netted by the Form 1040 orchestrator, not here.
 */
export function calculateScheduleD(
  transactions: Income1099B[],
  carryforward: number,
  filingStatus: FilingStatus,
  carryforwardST?: number,
  carryforwardLT?: number,
  capitalGainDistributions?: number,
  taxYear: number = 2025,
  /** Form 6252 line 26 for capital assets: Schedule D lines 4 (short term) and 11 (long term). */
  form6252Gains?: { shortTerm: number; longTerm: number },
  /**
   * Schedule K-1 net short-term (box 8) and long-term (box 9a) gain or loss:
   * Schedule D lines 5 and 12, netted with the rest and under the §1211(b) limit.
   * `collectibles` is the K-1 collectibles (28%) gain or loss (box 9b), part of
   * the long-term amount: 28% Rate Gain Worksheet line 4.
   */
  k1Gains?: { shortTerm: number; longTerm: number; collectibles?: number },
): ScheduleDResult {
  let shortTermGain = 0;
  let shortTermLoss = 0;
  let longTermGain = 0;
  let longTermLoss = 0;
  let collectiblesLongTermGain = 0;
  let collectiblesLongTermLoss = 0;

  for (const t of transactions) {
    // Wash sale adjustment (Box 1g): disallowed loss reduces the deductible loss.
    // 1099-B Box 1e always reports the ORIGINAL cost basis.  Box 1g (wash sale
    // disallowed) is a separate adjustment regardless of whether the basis was
    // reported to the IRS.  basisReportedToIRS only determines which Form 8949
    // box (A/D vs B/E) the transaction flows to — it does NOT mean the broker
    // pre-adjusted the basis.  Always apply the wash sale adjustment.
    //
    // IRS Form 8949 column (h) = proceeds − costBasis + washSaleAdj
    // Equivalently: proceeds − (costBasis − washSaleAdj)
    const gainOrLoss = transactionGainOrLoss(t);

    if (t.isLongTerm) {
      if (gainOrLoss >= 0) {
        longTermGain += gainOrLoss;
      } else {
        longTermLoss += Math.abs(gainOrLoss);
      }
      // IRC §1(h)(4): long-term collectibles gain is a 28% rate gain.
      // Short-term collectibles stay in ordinary income.
      if (t.isCollectible) {
        if (gainOrLoss >= 0) {
          collectiblesLongTermGain += gainOrLoss;
        } else {
          collectiblesLongTermLoss += Math.abs(gainOrLoss);
        }
      }
    } else {
      if (gainOrLoss >= 0) {
        shortTermGain += gainOrLoss;
      } else {
        shortTermLoss += Math.abs(gainOrLoss);
      }
    }
  }

  // Apply carryforward — preserve character (ST/LT)
  const { shortTerm: cfST, longTerm: cfLT } = carryforwardByCharacter(carryforward, carryforwardST, carryforwardLT);

  if (cfST > 0) {
    shortTermLoss += cfST;
  }
  if (cfLT > 0) {
    longTermLoss += cfLT;
  }

  // IRC §1202: remove excluded QSBS gain. The non-excluded eligible gain
  // stays in long-term gain and is added to the 28% rate gain below.
  const section1202 = applySection1202(transactions, filingStatus);
  if (section1202.excludedGain > 0) {
    longTermGain = round2(Math.max(0, longTermGain - section1202.excludedGain));
  }

  // Schedule D lines 4 and 11: installment sale gain from Form 6252.
  shortTermGain += Math.max(0, form6252Gains?.shortTerm || 0);
  longTermGain += Math.max(0, form6252Gains?.longTerm || 0);

  // Schedule D lines 5 and 12: K-1 net gain or loss from partnerships, S
  // corporations, estates and trusts.
  const k1ST = k1Gains?.shortTerm || 0;
  const k1LT = k1Gains?.longTerm || 0;
  if (k1ST >= 0) shortTermGain += k1ST; else shortTermLoss += -k1ST;
  if (k1LT >= 0) longTermGain += k1LT; else longTermLoss += -k1LT;

  // Schedule D Line 13: Capital gain distributions from 1099-DIV Box 2a
  // These are always long-term (mutual fund distributions of realized LT gains)
  const capGainDist = Math.max(0, capitalGainDistributions || 0);
  if (capGainDist > 0) {
    longTermGain += capGainDist;
  }

  const netShortTerm = round2(shortTermGain - shortTermLoss);
  const netLongTerm = round2(longTermGain - longTermLoss);
  const netGainOrLoss = round2(netShortTerm + netLongTerm);
  // 2025 Schedule D 28% Rate Gain Worksheet: start from net collectibles,
  // then subtract a net short-term loss and the long-term capital-loss
  // carryover. The result cannot exceed net long-term gain. Section 1231
  // gain is added later and the cap is applied again against that total.
  const netCollectibles = round2(collectiblesLongTermGain - collectiblesLongTermLoss);
  // Combine collectibles with non-excluded §1202 gain, then apply the
  // short-term loss and long-term carryover to that combined 28% amount.
  const collectiblesRateGain = collectibles28RateGain(
    round2(netCollectibles + section1202.rateGain + (k1Gains?.collectibles || 0)),
    netShortTerm,
    cfLT,
  );
  const collectiblesGain = capCollectiblesGain(collectiblesRateGain, netLongTerm);

  const limited = limitCapitalLoss(netShortTerm, netLongTerm, filingStatus, taxYear);

  return {
    shortTermGain: round2(shortTermGain),
    shortTermLoss: round2(shortTermLoss),
    netShortTerm,
    longTermGain: round2(longTermGain),
    longTermLoss: round2(longTermLoss),
    netLongTerm,
    netGainOrLoss,
    collectiblesRateGain,
    collectiblesGain,
    section1202ExcludedGain: section1202.excludedGain,
    section1202RateGain: section1202.rateGain,
    section1202AmtPreference: section1202.amtPreference,
    section1202HadDisposition: section1202.hadDisposition,
    capitalLossDeduction: limited.capitalLossDeduction,
    capitalLossCarryforward: limited.capitalLossCarryforward,
    capitalLossCarryforwardST: limited.capitalLossCarryforwardST,
    capitalLossCarryforwardLT: limited.capitalLossCarryforwardLT,
  };
}

/**
 * The prior-year capital loss carryover by character. Explicit ST/LT values are
 * used when either is given; otherwise the legacy single value is short-term.
 */
export function carryforwardByCharacter(
  carryforward: number | undefined,
  carryforwardST?: number,
  carryforwardLT?: number,
): { shortTerm: number; longTerm: number } {
  const hasSplitCarryforward = carryforwardST !== undefined || carryforwardLT !== undefined;
  return {
    shortTerm: hasSplitCarryforward ? Math.abs(carryforwardST || 0) : Math.abs(carryforward || 0),
    longTerm: hasSplitCarryforward ? Math.abs(carryforwardLT || 0) : 0,
  };
}

/**
 * Gain or loss on one Form 8949 line: proceeds less the cost basis, with the
 * wash sale loss disallowed (box 1g) added back.
 */
export function transactionGainOrLoss(t: Pick<Income1099B, 'proceeds' | 'costBasis' | 'washSaleLossDisallowed'>): number {
  const washSaleAdj = safeNum(t.washSaleLossDisallowed);
  const costBasis = safeNum(t.costBasis);
  const adjustedBasis = washSaleAdj > 0 ? round2(costBasis - washSaleAdj) : round2(costBasis);
  return round2(safeNum(t.proceeds) - adjustedBasis);
}

/**
 * 28% Rate Gain Worksheet amount before the net-long-term cap.
 * `rateGainBeforeLosses` is net collectibles plus non-excluded §1202 gain.
 * A net short-term loss and the long-term carryover are subtracted after that sum.
 */
export function collectibles28RateGain(
  rateGainBeforeLosses: number,
  netShortTerm: number,
  ltCarryover: number,
): number {
  let rateGain = rateGainBeforeLosses;
  if (netShortTerm < 0) {
    rateGain = round2(rateGain - Math.abs(netShortTerm));
  }
  if (ltCarryover > 0) {
    rateGain = round2(rateGain - ltCarryover);
  }
  return Math.max(0, rateGain);
}

/** Cap the 28% rate gain at net long-term gain. Zero when that net is not a gain. */
export function capCollectiblesGain(rateGain: number, netLongTerm: number): number {
  return netLongTerm > 0 ? Math.max(0, Math.min(rateGain, netLongTerm)) : 0;
}

/**
 * IRC §1211(b) / §1212(b). Apply the $3,000 ($1,500 MFS) loss limit to an
 * already-netted short-term and long-term result, and preserve carryforward
 * character. Section 1231 gain is long-term and must be in netLongTerm first.
 */
export function limitCapitalLoss(
  netShortTerm: number,
  netLongTerm: number,
  filingStatus: FilingStatus,
  taxYear: number = 2025,
): Pick<ScheduleDResult, 'capitalLossDeduction' | 'capitalLossCarryforward' | 'capitalLossCarryforwardST' | 'capitalLossCarryforwardLT'> {
  const lossLimit = filingStatus === FilingStatus.MarriedFilingSeparately
    ? getTaxConstants(taxYear).SCHEDULE_D.CAPITAL_LOSS_LIMIT_MFS
    : getTaxConstants(taxYear).SCHEDULE_D.CAPITAL_LOSS_LIMIT;
  const netGainOrLoss = round2(netShortTerm + netLongTerm);

  if (netGainOrLoss >= 0) {
    return {
      capitalLossDeduction: 0,
      capitalLossCarryforward: 0,
      capitalLossCarryforwardST: 0,
      capitalLossCarryforwardLT: 0,
    };
  }

  const totalLoss = Math.abs(netGainOrLoss);
  const capitalLossDeduction = Math.min(totalLoss, lossLimit);
  const capitalLossCarryforward = round2(totalLoss - capitalLossDeduction);
  const stNetLoss = netShortTerm < 0 ? Math.abs(netShortTerm) : 0;
  const ltNetLoss = netLongTerm < 0 ? Math.abs(netLongTerm) : 0;

  let capitalLossCarryforwardST = 0;
  let capitalLossCarryforwardLT = 0;
  if (netShortTerm >= 0 && netLongTerm < 0) {
    capitalLossCarryforwardLT = capitalLossCarryforward;
  } else if (netLongTerm >= 0 && netShortTerm < 0) {
    capitalLossCarryforwardST = capitalLossCarryforward;
  } else {
    let deductionRemaining = capitalLossDeduction;
    const stApplied = Math.min(deductionRemaining, stNetLoss);
    capitalLossCarryforwardST = round2(stNetLoss - stApplied);
    deductionRemaining -= stApplied;
    const ltApplied = Math.min(deductionRemaining, ltNetLoss);
    capitalLossCarryforwardLT = round2(ltNetLoss - ltApplied);
  }

  return {
    capitalLossDeduction,
    capitalLossCarryforward,
    capitalLossCarryforwardST,
    capitalLossCarryforwardLT,
  };
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
