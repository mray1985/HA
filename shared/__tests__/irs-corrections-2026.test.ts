/**
 * Corrections against Revenue Procedure 2025-32, the 2025 Schedule 1-A,
 * the 2025 Schedule D 28% Rate Gain Worksheet, and the 2024 Form 8962.
 */
import { describe, it, expect } from 'vitest';
import { FilingStatus } from '../src/types/index.js';
import { getTaxBrackets, getQbi, getLtcPremiumLimits, getDependentStandardDeduction, getTaxConstants, getSepIra, getSolo401k } from '../src/constants/taxConstants.js';
import { calculateSchedule1A } from '../src/engine/schedule1A.js';
import { calculateScheduleD } from '../src/engine/scheduleD.js';
import { calculateQBIDeduction } from '../src/engine/qbi.js';
import { calculateSEPIRALimits, calculateSolo401kLimits } from '../src/engine/solo401k.js';

describe('Rev. Proc. 2025-32 corrections', () => {
  it('ends the 2026 head-of-household 24% bracket at $201,750', () => {
    const hoh = getTaxBrackets(2026)[FilingStatus.HeadOfHousehold];
    const band24 = hoh.find((b) => b.rate === 0.24);
    const band32 = hoh.find((b) => b.rate === 0.32);
    expect(band24?.max).toBe(201750);
    expect(band32?.min).toBe(201750);
  });

  it('keeps the 2026 single 24% bracket at $201,775', () => {
    const single = getTaxBrackets(2026)[FilingStatus.Single];
    expect(single.find((b) => b.rate === 0.24)?.max).toBe(201775);
  });

  it('uses $201,750 for 2026 single and head of household QBI, and $201,775 for married filing separately', () => {
    const qbi = getQbi(2026);
    expect(qbi.THRESHOLD_SINGLE).toBe(201750);
    expect(qbi.THRESHOLD_MFS).toBe(201775);
    expect(qbi.THRESHOLD_MFJ).toBe(403500);

    const sstbQbi = 100000;
    const taxable = 201760;
    const single = calculateQBIDeduction(sstbQbi, taxable, FilingStatus.Single, true, 0, 0, 0, 2026);
    const mfs = calculateQBIDeduction(sstbQbi, taxable, FilingStatus.MarriedFilingSeparately, true, 0, 0, 0, 2026);
    expect(mfs).toBe(20000);
    expect(single).toBeLessThan(20000);
  });

  it('uses the 2026 long-term care premium caps from Rev. Proc. 2025-32 §4.27', () => {
    const limits = getLtcPremiumLimits(2026);
    expect(limits.AGE_40_OR_UNDER).toBe(500);
    expect(limits.AGE_41_TO_50).toBe(930);
    expect(limits.AGE_51_TO_60).toBe(1860);
    expect(limits.AGE_61_TO_70).toBe(4960);
    expect(limits.AGE_71_AND_OVER).toBe(6200);
  });

  it('caps 2026 retirement compensation at $360,000', () => {
    expect(getSolo401k(2026).COMPENSATION_CAP).toBe(360000);
    expect(getSepIra(2026).COMPENSATION_CAP).toBe(360000);
    const sep = calculateSEPIRALimits({
      scheduleCNetProfit: 500000,
      seDeductibleHalf: 0,
      desiredContribution: 80000,
    }, 2026);
    expect(sep.maxContribution).toBe(72000);
  });

  it('sets the 2026 dependent standard-deduction floor at $1,350', () => {
    expect(getDependentStandardDeduction(2026).MIN_AMOUNT).toBe(1350);
  });

  it('uses the 2024 Form 8962 Alaska and Hawaii poverty increments', () => {
    const ptc = getTaxConstants(2024).PREMIUM_TAX_CREDIT;
    expect(ptc.FPL_INCREMENT_AK).toBe(6430);
    expect(ptc.FPL_INCREMENT_HI).toBe(5910);
  });

  it('does not give a 2024 filer the 2025 age 60-63 super catch-up', () => {
    const result = calculateSolo401kLimits({
      scheduleCNetProfit: 100000,
      seDeductibleHalf: 0,
      age: 62,
    }, 2024);
    expect(result.catchUpAmount).toBe(7500);
    expect(result.superCatchUpEligible).toBe(false);
  });
});

describe('Schedule 1-A senior deduction', () => {
  it('reduces the combined senior deduction by 6% of the excess once', () => {
    // MAGI $200,000, joint threshold $150,000, excess $50,000.
    // 6% × $50,000 = $3,000. Two people: $12,000 − $3,000 = $9,000.
    const result = calculateSchedule1A(
      {}, 200000, FilingStatus.MarriedFilingJointly, true, true,
    );
    expect(result.seniorPhaseOutReduction).toBe(3000);
    expect(result.seniorDeduction).toBe(9000);
  });

  it('uses the $75,000 threshold for a qualifying surviving spouse', () => {
    const result = calculateSchedule1A(
      {}, 100000, FilingStatus.QualifyingSurvivingSpouse, true, false,
    );
    expect(result.seniorPhaseOutReduction).toBe(1500);
    expect(result.seniorDeduction).toBe(4500);
  });
});

describe('Schedule D 28% rate gain worksheet', () => {
  it('reduces collectibles gain by a net short-term loss', () => {
    const result = calculateScheduleD(
      [
        {
          id: 'art',
          brokerName: 'Gallery',
          description: 'Painting',
          dateSold: '2025-06-01',
          proceeds: 10000,
          costBasis: 0,
          isLongTerm: true,
          isCollectible: true,
        },
        {
          id: 'stock',
          brokerName: 'Broker',
          description: 'Stock',
          dateSold: '2025-06-01',
          proceeds: 0,
          costBasis: 4000,
          isLongTerm: false,
        },
      ],
      0,
      FilingStatus.Single,
    );
    expect(result.netShortTerm).toBe(-4000);
    expect(result.collectiblesGain).toBe(6000);
  });

  it('reduces collectibles gain by a long-term capital-loss carryover', () => {
    const result = calculateScheduleD(
      [
        {
          id: 'art',
          brokerName: 'Gallery',
          description: 'Painting',
          dateSold: '2025-06-01',
          proceeds: 10000,
          costBasis: 0,
          isLongTerm: true,
          isCollectible: true,
        },
        {
          id: 'fund',
          brokerName: 'Broker',
          description: 'Fund',
          dateSold: '2025-06-01',
          proceeds: 20000,
          costBasis: 0,
          isLongTerm: true,
        },
      ],
      0,
      FilingStatus.Single,
      0,
      8000,
    );
    expect(result.netLongTerm).toBe(22000);
    expect(result.collectiblesGain).toBe(2000);
  });
});
