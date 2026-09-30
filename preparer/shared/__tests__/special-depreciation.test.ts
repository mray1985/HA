/**
 * Special depreciation (IRC §168(k)) by the year placed in service and the
 * date acquired — TY2025 corpus TAX-001 / FED.BONUS_DEPRECIATION.168K.
 * Expected amounts are worked from the Form 4562 instructions (2025: line 14,
 * "Certain qualified property acquired after January 19, 2025" and "...before
 * January 20, 2025"; 2024: 60%, 80% for long production period property).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm4562, specialDepreciationRate } from '../src/engine/form4562.js';
import { findUnsupportedPatterns } from '../src/engine/unsupported.js';
import type { DepreciationAsset, TaxReturn } from '../src/types/index.js';

function asset(overrides: Partial<DepreciationAsset> = {}): DepreciationAsset {
  return { id: 'a1', description: 'Machine', cost: 10000, dateInService: '2025-02-01', propertyClass: 5, businessUsePercent: 100, ...overrides };
}

describe('the special depreciation rate', () => {
  it.each([
    ['2025, acquired after January 19, 2025', { acquisitionDate: '2025-01-20' }, 2025, 1.0],
    ['2025, acquired before January 20, 2025', { acquisitionDate: '2024-12-15' }, 2025, 0.4],
    ['2025, long production period, acquired before', { acquisitionDate: '2024-12-15', longProductionPeriod: true }, 2025, 0.6],
    ['2025, acquired after, 40% elected', { acquisitionDate: '2025-03-01', electReducedBonus: true }, 2025, 0.4],
    ['2025, elected out', { acquisitionDate: '2025-03-01', electOutOfBonus: true }, 2025, 0],
    ['2025, 50% business use', { acquisitionDate: '2025-03-01', businessUsePercent: 50 }, 2025, 0],
    ['2026, acquired after January 19, 2025', { acquisitionDate: '2025-11-01' }, 2026, 1.0],
    ['2024', {}, 2024, 0.6],
    ['2024, long production period', { longProductionPeriod: true }, 2024, 0.8],
    ['2023', {}, 2023, 0.8],
    ['2022', {}, 2022, 1.0],
  ] as const)('%s', (_, overrides, placedYear, rate) => {
    expect(specialDepreciationRate(asset(overrides), placedYear)).toEqual({ rate });
  });

  it('is not settled without the date acquired, or for rules not built', () => {
    expect(specialDepreciationRate(asset(), 2025)).toEqual({ rate: 1.0, unsettled: expect.stringContaining('the date it was acquired is not entered') });
    expect(specialDepreciationRate(asset({ acquisitionDate: '2024-06-01' }), 2026).unsettled).toContain('acquired before January 20, 2025 and placed in service in 2026');
    expect(specialDepreciationRate(asset({ acquisitionDate: '2017-09-01' }), 2018).unsettled).toContain('before September 28, 2017');
  });
});

describe('Form 4562 with the rate', () => {
  it('takes 40% for property acquired before January 20, 2025, then MACRS on the rest', () => {
    const r = calculateForm4562([asset({ acquisitionDate: '2024-12-15' })], 100000);
    // Line 14: 40% × $10,000 = $4,000. Line 19: 5-year half-year 20% × $6,000 = $1,200.
    expect(r.assetDetails[0]).toMatchObject({ bonusDepreciation: 4000, macrsDepreciation: 1200, totalDepreciation: 5200 });
  });

  it('takes 100% for property acquired after January 19, 2025', () => {
    const r = calculateForm4562([asset({ acquisitionDate: '2025-01-25' })], 100000);
    expect(r.assetDetails[0]).toMatchObject({ bonusDepreciation: 10000, macrsDepreciation: 0 });
  });

  it("figures a later year's MACRS on the basis left after the first year's special depreciation", () => {
    // Placed in service in 2024: 60% ($6,000) then; 2025 is year 2 of 5-year half-year, 32% of $4,000.
    const r = calculateForm4562([asset({ dateInService: '2024-03-01', priorDepreciation: 6800 })], 100000);
    expect(r.assetDetails[0]).toMatchObject({ yearIndex: 1, macrsDepreciation: 1280, depreciableRemaining: 1920 });
  });

  it('gives off-the-shelf software special depreciation, and amortizes the rest over 36 months', () => {
    const software = (o: Partial<DepreciationAsset>) => asset({ cost: 3600, propertyClass: 3, isSoftware: true, ...o });
    const after = calculateForm4562([software({ acquisitionDate: '2025-02-01' })], 100000).assetDetails[0];
    expect(after).toMatchObject({ bonusDepreciation: 3600, macrsDepreciation: 0, totalDepreciation: 3600 });
    // Acquired before the cutover: 40% ($1,440); $2,160 / 36 = $60 a month, February to December.
    const before = calculateForm4562([software({ acquisitionDate: '2025-01-10' })], 100000).assetDetails[0];
    expect(before).toMatchObject({ bonusDepreciation: 1440, macrsDepreciation: 660, totalDepreciation: 2100 });
    // A year later, the 2024 software that took 60% amortizes $1,440 / 36 = $40 a month.
    const later = calculateForm4562([software({ dateInService: '2024-07-01', priorDepreciation: 2400 })], 100000).assetDetails[0];
    expect(later).toMatchObject({ macrsDepreciation: 480 });
  });
});

describe('an unsettled rate is not supported (fail closed)', () => {
  const ret = (assets: DepreciationAsset[], taxYear = 2025) => ({ taxYear, depreciationAssets: assets } as unknown as TaxReturn);

  it('asks for the date acquired of an asset placed in service in 2025', () => {
    expect(findUnsupportedPatterns(ret([asset({ id: 'x', description: 'CNC router' })]))).toEqual([{
      ruleId: 'FED.BONUS_DEPRECIATION.168K', jurisdiction: 'US', section: 'depreciation', itemId: 'x',
      message: expect.stringMatching(/^CNC router \(placed in service 2025-02-01\): special depreciation cannot be figured — the date it was acquired is not entered.*Enter the date it was acquired/),
    }]);
    expect(findUnsupportedPatterns(ret([asset({ acquisitionDate: '2025-01-05' })]))).toEqual([]);
    expect(findUnsupportedPatterns(ret([asset({ electOutOfBonus: true })]))).toEqual([]);
  });

  it('asks about a vehicle placed in service in 2025 under actual expenses', () => {
    const vehicle = { method: 'actual', dateInService: '2025-05-01', businessMiles: 9000, totalMiles: 10000 };
    expect(findUnsupportedPatterns({ taxYear: 2025, vehicle } as unknown as TaxReturn).map((u) => u.ruleId)).toEqual(['FED.BONUS_DEPRECIATION.168K']);
    expect(findUnsupportedPatterns({ taxYear: 2025, vehicle: { ...vehicle, acquisitionDate: '2025-04-01' } } as unknown as TaxReturn)).toEqual([]);
  });
});

describe("Schedule C figures Form 4562 for the return's own tax year", () => {
  it('treats a 2024 asset on a 2024 return as placed in service this year (60%)', async () => {
    const { calculateForm1040 } = await import('../src/engine/form1040.js');
    const tr = {
      id: 'r', taxYear: 2024, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: 1,
      firstName: 'Sam', lastName: 'Park', dependents: [], w2Income: [], income1099NEC: [{ id: 'n', payerName: 'Client', amount: 80000 }],
      income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [],
      income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [], income1099SA: [], incomeW2G: [], rentalProperties: [],
      otherIncome: 0, businesses: [{ id: 'b', businessName: 'Park Studio', principalBusinessCode: '541430', accountingMethod: 'cash' }],
      deductionMethod: 'standard', expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2024-01-01', updatedAt: '2024-01-01',
      depreciationAssets: [asset({ dateInService: '2024-05-01' })],
    } as unknown as TaxReturn;
    const detail = calculateForm1040(tr).scheduleC?.form4562Result?.assetDetails[0];
    // 60% × $10,000 = $6,000; 5-year half-year 20% × $4,000 = $800.
    expect(detail).toMatchObject({ yearIndex: 0, bonusDepreciation: 6000, macrsDepreciation: 800 });
  });
});
