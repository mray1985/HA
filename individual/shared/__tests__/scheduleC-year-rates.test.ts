/**
 * Schedule C's vehicle and home office use the return's own year:
 * - 2026 standard mileage: 72.5 cents a mile (Notice 2026-10), 76 cents for
 *   business miles driven on or after July 1, 2026 (Announcement 2026-11,
 *   2026-29 I.R.B.); the return is held until the miles from July 1 are known;
 * - Form 8829 line 8 is Schedule C line 29 — the tentative profit after car
 *   expenses and depreciation (Form 8829 instructions, 2025);
 * - home office depreciation is 39-year nonresidential real property: 2.564% a
 *   year after the first (Form 8829 line 41), so a home first used for business
 *   in 2025 is not in its first year on a 2026 return.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateScheduleC } from '../src/engine/scheduleC.js';
import { findUnsupportedPatterns } from '../src/engine/unsupported.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'c', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'income', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [],
    income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [], income1099DA: [], income1099C: [],
    income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], expenses: [], deductionMethod: 'standard',
    educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

const nec = [{ id: '1', payerName: 'Client', amount: 60000 }];

describe('2026 standard mileage', () => {
  it('takes 72.5 cents before July 1 and 76 cents from July 1', () => {
    const tr = makeTaxReturn({ income1099NEC: nec, vehicle: { method: 'standard_mileage', businessMiles: 10000, businessMilesFromJuly1: 4000 } });
    // 6,000 × $0.725 = $4,350; 4,000 × $0.76 = $3,040.
    expect(calculateScheduleC(tr).vehicleDeduction).toBe(7390);
    expect(findUnsupportedPatterns(tr, calculateForm1040(tr)).map((u) => u.ruleId)).not.toContain('FED.VEHICLE.STANDARD_MILEAGE_SPLIT');
  });

  it('holds the return until the miles from July 1 are entered, at the earlier rate meanwhile', () => {
    const tr = makeTaxReturn({ income1099NEC: nec, vehicle: { method: 'standard_mileage', businessMiles: 10000 } });
    expect(calculateScheduleC(tr).vehicleDeduction).toBe(7250);
    const finding = findUnsupportedPatterns(tr, calculateForm1040(tr)).find((u) => u.ruleId === 'FED.VEHICLE.STANDARD_MILEAGE_SPLIT');
    expect(finding?.message).toContain('enter the business miles driven on or after July 1');
    const over = makeTaxReturn({ income1099NEC: nec, vehicle: { method: 'standard_mileage', businessMiles: 100, businessMilesFromJuly1: 150 } });
    expect(findUnsupportedPatterns(over, calculateForm1040(over)).find((u) => u.ruleId === 'FED.VEHICLE.STANDARD_MILEAGE_SPLIT')?.message)
      .toContain('more than the year');
  });

  it('keeps one rate for 2025 (Notice 2025-5): 70 cents, nothing to split', () => {
    const tr = makeTaxReturn({ taxYear: 2025, income1099NEC: nec, vehicle: { method: 'standard_mileage', businessMiles: 10000 } });
    expect(calculateScheduleC(tr).vehicleDeduction).toBe(7000);
    expect(findUnsupportedPatterns(tr, calculateForm1040(tr)).map((u) => u.ruleId)).not.toContain('FED.VEHICLE.STANDARD_MILEAGE_SPLIT');
  });
});

describe('home office on Schedule C', () => {
  it('limits the home office to Schedule C line 29, after car expenses', () => {
    // 2025: $12,000 of receipts, 16,000 miles × $0.70 = $11,200 of car expenses: line 29 is $800.
    const tr = makeTaxReturn({
      taxYear: 2025,
      income1099NEC: [{ id: '1', payerName: 'Client', amount: 12000 }],
      vehicle: { method: 'standard_mileage', businessMiles: 16000 },
      homeOffice: { method: 'simplified', squareFeet: 300 },
    });
    const c = calculateScheduleC(tr);
    expect(c.vehicleDeduction).toBe(11200);
    // The $1,500 simplified deduction is limited to the $800 left.
    expect(c.homeOfficeDeduction).toBe(800);
    expect(c.netProfit).toBe(0);
  });

  it("depreciates a home first used for business in 2025 at 2.564% on the 2026 return", () => {
    const homeOffice = {
      method: 'actual' as const, squareFeet: 200, totalHomeSquareFeet: 1000, insurance: 100,
      homeCostOrValue: 300000, landValue: 50000, dateFirstUsedForBusiness: '2025-07-01',
    };
    // Business basis $50,000: in 2025 the July rate, 1.177% ($588.50); in 2026, 2.564% ($1,282).
    expect(calculateScheduleC(makeTaxReturn({ taxYear: 2025, income1099NEC: nec, homeOffice })).homeOfficeResult?.depreciationComputed).toBe(588.5);
    expect(calculateScheduleC(makeTaxReturn({ income1099NEC: nec, homeOffice })).homeOfficeResult?.depreciationComputed).toBe(1282);
  });

  it('holds the return when the date first used for business is missing or before May 13, 1993', () => {
    const homeOffice = { method: 'actual' as const, squareFeet: 200, totalHomeSquareFeet: 1000, homeCostOrValue: 300000, landValue: 50000, insurance: 100 };
    const missing = makeTaxReturn({ income1099NEC: nec, homeOffice });
    expect(findUnsupportedPatterns(missing, calculateForm1040(missing)).find((u) => u.ruleId === 'FED.FORM8829.LINE41')?.message).toContain('enter the date the home was first used for business');
    const old = makeTaxReturn({ income1099NEC: nec, homeOffice: { ...homeOffice, dateFirstUsedForBusiness: '1990-02-01' } });
    expect(findUnsupportedPatterns(old, calculateForm1040(old)).find((u) => u.ruleId === 'FED.FORM8829.LINE41')?.message).toContain('before May 13, 1993');
    const ok = makeTaxReturn({ income1099NEC: nec, homeOffice: { ...homeOffice, dateFirstUsedForBusiness: '2020-01-01' } });
    expect(findUnsupportedPatterns(ok, calculateForm1040(ok)).map((u) => u.ruleId)).not.toContain('FED.FORM8829.LINE41');
  });
});
