/**
 * Fail closed (TY2025 rule corpus, Bible §13): what the engine cannot compute
 * to the official rules is reported on the calculation and on the state
 * result it concerns — never silently approximated.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { findUnsupportedPatterns } from '../src/engine/unsupported.js';
import { FilingStatus, type StateReturnConfig, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'unsupported-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 80000, federalTaxWithheld: 9000 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const state = (stateCode: string, residencyType: StateReturnConfig['residencyType'] = 'resident'): StateReturnConfig =>
  ({ stateCode, residencyType } as StateReturnConfig);

const rules = (tr: TaxReturn) => (calculateForm1040(tr).unsupported ?? []).map((u) => `${u.ruleId}:${u.jurisdiction}`);

describe('what the engine cannot compute is reported, not approximated', () => {
  it('reports nothing for a return it computes to the rules', () => {
    expect(rules(makeTaxReturn())).toEqual([]);
    expect(rules(makeTaxReturn({ stateReturns: [state('CA')] }))).toEqual([]);
    expect(rules(makeTaxReturn({ stateReturns: [state('UT')] }))).toEqual([]);
  });

  it('stops part-year and nonresident returns, which would prorate all income by days (TAX-008)', () => {
    expect(rules(makeTaxReturn({ stateReturns: [{ ...state('CA', 'part_year'), daysLivedInState: 120 } as StateReturnConfig, state('NY')] }))).toEqual(['TAX-008:CA']);
    expect(rules(makeTaxReturn({ stateReturns: [state('NY', 'nonresident'), state('NJ')] }))).toEqual(['TAX-008:NY']);
    // A state with no income tax has nothing to source.
    expect(rules(makeTaxReturn({ stateReturns: [state('TX', 'part_year'), state('CA')] }))).toEqual([]);
  });

  it('stops Indiana (county tax), Iowa residents (school surtax) and Pennsylvania (eight classes)', () => {
    expect(rules(makeTaxReturn({ stateReturns: [state('IN')] }))).toEqual(['TAX-006:IN']);
    expect(rules(makeTaxReturn({ stateReturns: [state('IA')] }))).toEqual(['TAX-007:IA']);
    expect(rules(makeTaxReturn({ stateReturns: [state('PA')] }))).toEqual(['TAX-002:PA']);
  });

  it("stops DC itemizers, whose DC deductions are not calculated", () => {
    expect(rules(makeTaxReturn({ stateReturns: [state('DC')] }))).toEqual([]);
    const itemizer = makeTaxReturn({
      stateReturns: [state('DC')], deductionMethod: 'itemized',
      itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 9000, realEstateTax: 6000, personalPropertyTax: 0, mortgageInterest: 14000, mortgageInsurancePremiums: 0, charitableCash: 0, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 },
    });
    expect(rules(itemizer)).toEqual(['DC.ITEMIZED:DC']);
  });

  it("stops Utah for a year whose credit amounts are not checked in, and a state with no calculator for the year", () => {
    expect(rules(makeTaxReturn({ taxYear: 2026, stateReturns: [state('UT')] }))).toContain('UT.TC40.TAXPAYER_CREDIT:UT');
    // The engine gives such a state a $0 result marked unavailable: that zero is not a figure to rely on.
    const noTable = calculateForm1040(makeTaxReturn({ taxYear: 2024, stateReturns: [state('MN')] }));
    expect(noTable.unsupported?.map((u) => u.ruleId)).toEqual(['STATE.YEAR.NOT_SUPPORTED']);
    expect(noTable.stateResults?.[0]?.unsupported).toEqual(['Minnesota tax for 2024 is not calculated by HATax. Prepare this return outside HATax, or remove the state, until it is supported.']);
  });

  it('stops Washington residents with long-term gains over $278,000 (TAX-003)', () => {
    const gains = (amount: number) => [{ id: 'b', description: 'Stock', proceeds: amount + 10000, costBasis: 10000, isLongTerm: true, basisReportedToIRS: true }];
    expect(rules(makeTaxReturn({ addressState: 'WA', income1099B: gains(100000) } as Partial<TaxReturn>))).toEqual([]);
    expect(rules(makeTaxReturn({ addressState: 'WA', income1099B: gains(300000) } as Partial<TaxReturn>))).toEqual(['TAX-003:WA']);
    expect(rules(makeTaxReturn({ stateReturns: [state('WA')], income1099B: gains(300000) } as Partial<TaxReturn>))).toEqual(['TAX-003:WA']);
  });

  it("marks the state's own result", () => {
    const result = calculateForm1040(makeTaxReturn({ stateReturns: [state('PA'), state('NJ')] }));
    expect(result.stateResults?.find((s) => s.stateCode === 'PA')?.unsupported).toEqual([expect.stringContaining('Pennsylvania taxes eight classes')]);
    expect(result.stateResults?.find((s) => s.stateCode === 'NJ')?.unsupported).toBeUndefined();
  });

  it('works without a calculation for the checks that need none', () => {
    expect(findUnsupportedPatterns(makeTaxReturn({ stateReturns: [state('PA')] })).map((u) => u.ruleId)).toEqual(['TAX-002']);
  });
});
