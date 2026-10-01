/**
 * California 2026 (FTB Tax News, October 2026, "2026 Indexing"): the rate
 * schedules, standard deduction, exemption credits and renter's credit limits
 * the FTB has published; what it publishes in late December is held where it
 * can matter. Every figure below is worked by hand from the published tables.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { getStateCalculator } from '../src/engine/state/stateRegistry.js';
import { FilingStatus, type Dependent, type TaxReturn } from '../src/types/index.js';

function makeReturn(o: Partial<TaxReturn> & { wages?: number; caData?: Record<string, unknown> } = {}): TaxReturn {
  const { wages = 0, caData, ...rest } = o;
  return {
    id: 'ca26', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: wages > 0 ? [{ id: 'w', employerName: 'Acme', wages, federalTaxWithheld: 0, state: 'CA', stateTaxWithheld: 0 }] : [],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [],
    income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [], income1099SA: [], incomeW2G: [],
    rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard', expenses: [], educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
    stateReturns: [{ stateCode: 'CA', residencyType: 'resident', ...(caData ? { stateSpecificData: caData } : {}) }],
    ...rest,
  } as TaxReturn;
}
const run = (tr: TaxReturn) => {
  const result = calculateForm1040(tr);
  return { ca: result.stateResults!.find((s) => s.stateCode === 'CA')!, held: (result.unsupported ?? []).filter((u) => u.ruleId === 'CA.YEAR.UNPUBLISHED').map((u) => u.message) };
};
const child = (id: string, dateOfBirth: string): Dependent => ({
  id, firstName: 'Kid', lastName: 'Test', relationship: 'son', dateOfBirth, monthsLivedWithYou: 12,
} as Dependent);

describe('California 2026', () => {
  it('is calculated for 2026', () => {
    expect(getStateCalculator('CA', 2026)).not.toBeNull();
    expect(getStateCalculator('CA', 2027)).toBeNull();
  });

  it('single: Schedule X, $5,900 standard deduction, $158 exemption credit', () => {
    // CA AGI $80,000 − $5,900 = $74,100; Schedule X: $2,054.96 + 8% × ($74,100 − $59,498) = $3,223.12; − $158 = $3,065.12.
    const { ca, held } = run(makeReturn({ wages: 80000 }));
    expect(ca.stateTaxableIncome).toBe(74100);
    expect(ca.totalStateTax).toBeCloseTo(3065.12, 2);
    expect(held).toEqual([]);
  });

  it('joint: Schedule Y (its fifth row starts at $118,996), $316 + $491 a dependent', () => {
    // $130,000 − $11,800 = $118,200: $2,113.48 + 6% × ($118,200 − $85,722) = $4,062.16. Credits $316 + 2 × $491 = $1,298 → $2,764.16.
    const kids = [child('a', '2014-03-01'), child('b', '2016-05-01')];
    const { ca, held } = run(makeReturn({ wages: 130000, filingStatus: FilingStatus.MarriedFilingJointly, dependents: kids }));
    expect(ca.stateTaxableIncome).toBe(118200);
    expect(ca.totalStateTax).toBeCloseTo(2764.16, 2);
    expect(held).toEqual([]);
    // Over $118,996 the 8% rate starts: $140,000 − $11,800 = $128,200 → $4,109.92 + 8% × $9,204 = $4,846.24 − $1,298.
    expect(run(makeReturn({ wages: 140000, filingStatus: FilingStatus.MarriedFilingJointly, dependents: kids })).ca.totalStateTax).toBeCloseTo(3548.24, 2);
  });

  it("head of household: Schedule Z; the renter's credit to $111,660", () => {
    // $60,000 − $11,800 = $48,200: $229.27 + 2% × ($48,200 − $22,927) = $734.73; − $158 − $491 − $120 renter's credit = −$34.27 → $0.
    const { ca } = run(makeReturn({ wages: 60000, filingStatus: FilingStatus.HeadOfHousehold, dependents: [child('a', '2014-03-01')], caData: { isRenter: true } }));
    expect(ca.stateTaxableIncome).toBe(48200);
    expect(ca.additionalLines?.rentersCredit).toBe(120);
    expect(ca.totalStateTax).toBe(0);
  });

  it('holds what the FTB has not published, where it can matter', () => {
    // AGI over 2025's $252,203 threshold: the 2026 phase-out may apply.
    expect(run(makeReturn({ wages: 300000 })).held).toEqual([expect.stringContaining('exemption credit phase-out')]);
    // Earned income within the 2025 CalEITC limit ($32,900) recomputed by 3.4% ($34,100 rounded up).
    expect(run(makeReturn({ wages: 20000 })).held).toEqual([expect.stringContaining('CalEITC')]);
    expect(run(makeReturn({ wages: 34100 })).held).toEqual([expect.stringContaining('CalEITC')]);
    expect(run(makeReturn({ wages: 34200 })).held).toEqual([]);
    // YCTC needs no earned income: a child under 6 and only interest income.
    const yctc = run(makeReturn({ dependents: [child('a', '2023-01-01')], income1099INT: [{ id: 'i', payerName: 'Bank', amount: 5000 }] }));
    expect(yctc.held).toEqual([expect.stringContaining('Young Child Tax Credit')]);
    // 2025 has its tables: nothing held.
    expect(run(makeReturn({ taxYear: 2025, wages: 20000 })).held).toEqual([]);
  });

  it('itemizes without the federal 0.5% charitable floor, which California has not adopted', () => {
    // Federal: $10,000 cash − 0.5% × $200,000 = $9,000. California: $10,000, plus $10,000 property tax and $20,000 mortgage interest.
    const itemized = makeReturn({
      wages: 200000, deductionMethod: 'itemized',
      itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 10000, personalPropertyTax: 0, mortgageInterest: 20000, mortgageInsurancePremiums: 0, charitableCash: 10000, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 },
    });
    expect(calculateForm1040(itemized).scheduleA?.charitableDeduction).toBe(9000);
    expect(run(itemized).ca.stateDeduction).toBe(40000);
  });
});
