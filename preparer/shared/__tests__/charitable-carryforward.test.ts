/**
 * Charitable contributions entered as lump sums follow the same AGI limits and
 * carryforward rules as itemized non-cash gifts (IRC §170(b), §170(d)(1)): a
 * prior-year carryforward is deducted within the limits, and this year's
 * contributions over the limits carry to the next five years.
 */

import { describe, expect, it } from 'vitest';
import { calculateScheduleA } from '../src/engine/scheduleA.js';
import { FilingStatus, type ItemizedDeductions } from '../src/types/index.js';

const deductions = (o: Partial<ItemizedDeductions>): ItemizedDeductions => ({
  medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0,
  mortgageInsurancePremiums: 0, charitableCash: 0, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0,
  ...o,
});

const single = FilingStatus.Single;

describe('lump-sum charitable contributions', () => {
  it('deducts a prior-year carryforward within the limit', () => {
    const a = calculateScheduleA(deductions({ charitableCash: 10000, charitableCarryforward: [{ year: 2023, amount: 5000, category: 'cash' }] }), 100000, single, 2025);
    expect(a.charitableDeduction).toBe(15000);
    expect(a.charitableCarryforwardUsed).toBe(5000);
    expect(a.charitableExcessCarryforward).toBeUndefined();
    // A lump sum lists no Form 8283 items.
    expect(a.form8283).toBeUndefined();
  });

  it('carries cash over 60% of AGI forward', () => {
    const a = calculateScheduleA(deductions({ charitableCash: 40000 }), 50000, single, 2025);
    expect(a.charitableDeduction).toBe(30000);
    expect(a.charitableExcessCarryforward).toBe(10000);
  });

  it('holds a non-cash lump sum to 30% of AGI, as before, and carries the rest', () => {
    const a = calculateScheduleA(deductions({ charitableNonCash: 40000 }), 100000, single, 2025);
    expect(a.charitableDeduction).toBe(30000);
    expect(a.charitableExcessCarryforward).toBe(10000);
  });

  it('does not use a carryforward more than five years old', () => {
    // A 2019 contribution carries to 2020-2024; on a 2025 return it has expired.
    const a = calculateScheduleA(deductions({ charitableCash: 1000, charitableCarryforward: [{ year: 2019, amount: 5000, category: 'cash' }] }), 100000, single, 2025);
    expect(a.charitableDeduction).toBe(1000);
    expect(a.charitableCarryforwardUsed).toBeUndefined();
  });

  it('leaves a lump sum within the limits as it was', () => {
    const a = calculateScheduleA(deductions({ charitableCash: 5000, charitableNonCash: 2000 }), 100000, single, 2025);
    expect(a.charitableDeduction).toBe(7000);
    expect(a.charitableCarryforwardUsed).toBeUndefined();
    expect(a.charitableExcessCarryforward).toBeUndefined();
  });
});
