/**
 * IRC §68 from 2026 (P.L. 119-21 §70111): itemized deductions are reduced by
 * 2/37 of the lesser of the itemized deductions or the taxable income (without
 * §68, plus the itemized deductions) over the start of the 37% bracket
 * ($640,600 single, Rev. Proc. 2025-32). $37,000 of itemized deductions keeps
 * the arithmetic exact: 2/37 of all of it is $2,000.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';

function makeReturn(wages: number, taxYear = 2026): TaxReturn {
  return {
    id: 's68', taxYear, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages, federalTaxWithheld: 0 }], income1099NEC: [], income1099K: [],
    income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [],
    income1099SA: [], income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0,
    businesses: [], expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
    deductionMethod: 'itemized',
    itemizedDeductions: {
      medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 37000,
      mortgageInsurancePremiums: 0, charitableCash: 0, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0,
    },
  } as TaxReturn;
}
const f = (wages: number, year?: number) => calculateForm1040(makeReturn(wages, year)).form1040;

describe('IRC §68 limitation on itemized deductions (2026)', () => {
  it('takes 2/37 of the itemized deductions when income is well past the 37% bracket', () => {
    // $900,000 − $37,000 = $863,000; + $37,000 = $900,000, $259,400 over $640,600: 2/37 × $37,000 = $2,000.
    const r = f(900000);
    expect(r.itemizedDeductionLimitation).toBe(2000);
    expect(r.itemizedDeduction).toBe(35000);
    expect(r.taxableIncome).toBe(865000);
  });

  it('takes 2/37 of the excess when it is less than the itemized deductions', () => {
    // $659,100 − $37,000 = $622,100; + $37,000 = $659,100, $18,500 over $640,600: 2/37 × $18,500 = $1,000.
    const r = f(659100);
    expect(r.itemizedDeductionLimitation).toBe(1000);
    expect(r.itemizedDeduction).toBe(36000);
    expect(r.taxableIncome).toBe(623100);
  });

  it('does not apply under the 37% bracket, or before 2026', () => {
    expect(f(600000).itemizedDeductionLimitation).toBe(0);
    expect(f(900000, 2025)).toMatchObject({ itemizedDeductionLimitation: 0, itemizedDeduction: 37000 });
  });
});
