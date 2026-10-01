/**
 * California depreciation (FTB 3885A, 2025 instructions): no IRC §168(k)
 * special depreciation, IRC §179 limited to $25,000 (reduced over $200,000 of
 * §179 property), and the California basis reduced by the California §179. The
 * federal Form 4562 less California's is a Schedule CA addition, or a
 * subtraction in the later years of an asset whose federal basis went to bonus.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { findUnsupportedPatterns } from '../src/engine/unsupported.js';
import { FilingStatus, type DepreciationAsset, type TaxReturn } from '../src/types/index.js';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'ca', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [], income1099NEC: [{ id: 'n', payerName: 'Client', amount: 100000 }], income1099K: [], income1099INT: [],
    income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
    income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [],
    expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
    stateReturns: [{ stateCode: 'CA', residencyType: 'resident' }],
    ...overrides,
  } as TaxReturn;
}

const computer: DepreciationAsset = {
  id: 'pc', description: 'Computer', cost: 10000, dateInService: '2025-03-15', acquisitionDate: '2025-03-01',
  propertyClass: 5, businessUsePercent: 100,
} as DepreciationAsset;

const ca = (tr: TaxReturn) => {
  const federal = calculateForm1040(tr);
  return { federal, state: federal.stateResults!.find((s) => s.stateCode === 'CA')! };
};

describe('California depreciation adjustment', () => {
  it('adds back federal bonus depreciation, net of California MACRS, in the first year', () => {
    const { federal, state } = ca(makeReturn({ depreciationAssets: [computer] }));
    // Federal: 100% special depreciation, $10,000 (acquired after January 19, 2025).
    expect(federal.form4562).toMatchObject({ bonusDepreciationTotal: 10000, totalDepreciation: 10000 });
    // California: 5-year MACRS, half-year convention, 20% = $2,000. Addition: $8,000.
    expect(state.stateAdditions).toBe(8000);
    expect(state.stateSubtractions).toBe(0);
  });

  it('subtracts California MACRS in a later year, when federal bonus took most of the basis', () => {
    // Placed in service in 2024: 60% special depreciation federally ($6,000) and
    // 20% of the other $4,000 ($800): $6,800 before 2025.
    const placed2024 = { ...computer, dateInService: '2024-03-15', acquisitionDate: '2024-03-01', priorDepreciation: 6800 };
    const { federal, state } = ca(makeReturn({ depreciationAssets: [placed2024] }));
    // 2025, year 2 of 5-year MACRS (32%): federal on $4,000 = $1,280; California on $10,000 = $3,200.
    expect(federal.form4562?.totalDepreciation).toBe(1280);
    expect(state.stateSubtractions).toBe(1920);
    expect(state.stateAdditions).toBe(0);
  });

  it("limits §179 to California's $25,000 and depreciates the rest of the California basis", () => {
    const press: DepreciationAsset = {
      id: 'press', description: 'Press', cost: 50000, dateInService: '2025-06-01', acquisitionDate: '2025-05-01',
      propertyClass: 7, businessUsePercent: 100, section179Election: 50000,
    } as DepreciationAsset;
    const { federal, state } = ca(makeReturn({ depreciationAssets: [press] }));
    expect(federal.form4562).toMatchObject({ section179Deduction: 50000, totalDepreciation: 50000 });
    // California: §179 $25,000; basis $25,000 × 14.29% (7-year, year 1) = $3,572.50; total $28,572.50.
    expect(state.stateAdditions).toBe(21427.5);
  });

  it("holds what it cannot settle: an earlier year's §179 beyond California's limit, and a vehicle", () => {
    const old: DepreciationAsset = {
      id: 'old', description: 'Loader', cost: 60000, dateInService: '2024-02-01', acquisitionDate: '2024-01-15',
      propertyClass: 7, businessUsePercent: 100, priorSection179: 60000, priorDepreciation: 60000,
    } as DepreciationAsset;
    const held = (tr: TaxReturn) => findUnsupportedPatterns(tr, calculateForm1040(tr)).filter((u) => u.ruleId === 'CA.DEPRECIATION').map((u) => u.message);
    expect(held(makeReturn({ depreciationAssets: [old] }))).toEqual([expect.stringContaining('the 2024 federal §179 expense')]);
    expect(held(makeReturn({ depreciationAssets: [{ ...old, priorSection179: 20000, cost: 20000 }] }))).toEqual([]);
    expect(held(makeReturn({ vehicle: { method: 'actual', businessMiles: 9000, totalMiles: 10000, vehicleCost: 40000, dateInService: '2025-02-01', acquisitionDate: '2025-01-25' } })))
      .toEqual([expect.stringContaining('California depreciation of the vehicle')]);
    const software = { ...computer, id: 'sw', description: 'Accounting software', isSoftware: true, dateInService: '2024-03-15', acquisitionDate: '2024-03-01' } as DepreciationAsset;
    expect(held(makeReturn({ depreciationAssets: [software] }))).toEqual([expect.stringContaining('California amortization of software placed in service in an earlier year (Accounting software)')]);
    // Without California on the return, nothing is held.
    expect(held(makeReturn({ stateReturns: [], vehicle: { method: 'actual', businessMiles: 9000, totalMiles: 10000, vehicleCost: 40000, dateInService: '2025-02-01', acquisitionDate: '2025-01-25' } }))).toEqual([]);
  });
});
