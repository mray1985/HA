/**
 * Charitable contributions from 2026 (P.L. 119-21):
 * - IRC §170(b)(1)(I): itemized contributions count only above 0.5% of AGI,
 *   taken first from capital gain property, then ordinary income property, then
 *   cash; §170(d)(1)(C): what the floor disallows carries forward only in a
 *   category with an excess over its percentage limit this year;
 * - IRC §170(p), §63(b)(4): a return that does not itemize deducts cash given to
 *   public charities, up to $1,000 ($2,000 joint), from taxable income.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateScheduleA } from '../src/engine/scheduleA.js';
import { FilingStatus, type ItemizedDeductions, type TaxReturn } from '../src/types/index.js';

const deductions = (o: Partial<ItemizedDeductions>): ItemizedDeductions => ({
  medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0,
  mortgageInsurancePremiums: 0, charitableCash: 0, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0,
  ...o,
});
const single = FilingStatus.Single;

describe('the 0.5% floor (2026)', () => {
  it('allows itemized contributions only above 0.5% of AGI', () => {
    // AGI $100,000: floor $500. Cash $5,000 → $4,500.
    const a = calculateScheduleA(deductions({ charitableCash: 5000 }), 100000, single, 2026);
    expect(a.charitableDeduction).toBe(4500);
    expect(a.charitableFloorReduction).toBe(500);
    // Not over any limit, so the $500 is not carried.
    expect(a.charitableExcessCarryforward).toBeUndefined();
    // 2025 has no floor.
    expect(calculateScheduleA(deductions({ charitableCash: 5000 }), 100000, single, 2025).charitableDeduction).toBe(5000);
  });

  it('takes the floor from capital gain property before cash', () => {
    // Non-cash $2,000 (capital gain property) and cash $5,000: the $500 floor comes off the non-cash.
    const a = calculateScheduleA(deductions({ charitableCash: 5000, charitableNonCash: 2000 }), 100000, single, 2026);
    expect(a.charitableDeduction).toBe(6500);
    expect(a.charitableFloorReduction).toBe(500);
  });

  it('carries what the floor disallows only from a year over the percentage limit', () => {
    // AGI $50,000: cash limit $30,000 (60%), so $10,000 is carried. The floor ($250) comes off
    // the cash, which has an excess: the carryover is $10,250 (§170(d)(1)(C)).
    const over = calculateScheduleA(deductions({ charitableCash: 40000 }), 50000, single, 2026);
    expect(over.charitableDeduction).toBe(29750);
    expect(over.charitableExcessCarryforward).toBe(10250);
    // Within the limit, the $250 is lost.
    const under = calculateScheduleA(deductions({ charitableCash: 5000 }), 50000, single, 2026);
    expect(under.charitableDeduction).toBe(4750);
    expect(under.charitableExcessCarryforward).toBeUndefined();
  });
});

describe('the deduction for a return that does not itemize (2026)', () => {
  function makeReturn(o: Partial<TaxReturn>): TaxReturn {
    return {
      id: 'c', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: single,
      dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 60000, federalTaxWithheld: 6000 }], income1099NEC: [],
      income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [],
      incomeK1: [], income1099SA: [], income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [],
      otherIncome: 0, businesses: [], expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {},
      createdAt: '', updatedAt: '',
      ...o,
    } as TaxReturn;
  }
  const taxable = (o: Partial<TaxReturn>) => calculateForm1040(makeReturn(o)).form1040;

  it('deducts up to $1,000 ($2,000 joint) from taxable income, not AGI', () => {
    const base = taxable({});
    const gave = taxable({ nonItemizerCharitableCash: 1500 });
    expect(gave.nonItemizerCharitableDeduction).toBe(1000);
    expect(gave.agi).toBe(base.agi);
    expect(gave.taxableIncome).toBe(base.taxableIncome - 1000);
    expect(taxable({ filingStatus: FilingStatus.MarriedFilingJointly, nonItemizerCharitableCash: 2500 }).nonItemizerCharitableDeduction).toBe(2000);
    expect(taxable({ nonItemizerCharitableCash: 400 }).nonItemizerCharitableDeduction).toBe(400);
  });

  it('is not taken when itemizing, or before 2026', () => {
    expect(taxable({
      nonItemizerCharitableCash: 1500, deductionMethod: 'itemized',
      itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 30000, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0, mortgageInsurancePremiums: 0, charitableCash: 1500, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 },
    }).nonItemizerCharitableDeduction).toBe(0);
    expect(taxable({ taxYear: 2025, nonItemizerCharitableCash: 1500 }).nonItemizerCharitableDeduction).toBe(0);
  });
});
