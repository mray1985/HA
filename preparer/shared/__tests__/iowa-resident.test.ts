/**
 * Iowa full-year residents (TY2025 corpus TAX-007): the IA 1040 lines through
 * the school district / EMS surtax. Amounts are worked by hand from the 2025
 * IA 1040 (3.8%), the 2024 Tax Calculation Worksheet (41-026), the exemption
 * credits, Schedule 1, and table 41-027 (Polk 1350 Collins-Maxwell 4%, Polk
 * 0472 Ballard 2%, Cass 0914 CAM 10% in 2024 and 11% in 2025 with Cass's EMS
 * surtax).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { assessIowa } from '../src/engine/state/ia.js';
import { FilingStatus, type StateReturnConfig, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'ia-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer', addressState: 'IA', dateOfBirth: '1985-05-01',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 60000, federalTaxWithheld: 6000, state: 'IA', stateTaxWithheld: 1800 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const iowa = (answers: Record<string, unknown> = {}, residencyType: StateReturnConfig['residencyType'] = 'resident'): StateReturnConfig =>
  ({ stateCode: 'IA', residencyType, stateSpecificData: { iaOtherItems: false, ...answers } } as StateReturnConfig);
const polk = (district = '1350') => ({ iaCounty: '77', iaSchoolDistrict: district });

function run(overrides: Partial<TaxReturn>) {
  const result = calculateForm1040(makeTaxReturn(overrides));
  return {
    result,
    state: result.stateResults?.find((s) => s.stateCode === 'IA'),
    findings: (result.unsupported ?? []).filter((u) => u.jurisdiction === 'IA'),
  };
}

describe('the IA 1040 for a full-year resident', () => {
  it('taxes federal taxable income at 3.8%, takes the exemption credit, and adds the school district surtax (2025)', () => {
    const { state, findings } = run({ stateReturns: [iowa(polk())] });
    // Line 2: $60,000 − $15,750 = $44,250. Line 5: 3.8% = $1,681.50. Line 8: $40. Line 18: $1,641.50.
    // Line 19: 4% = $65.66. Line 20: $1,707.16. Withheld $1,800: refund $92.84.
    expect(findings).toEqual([]);
    expect(state).toMatchObject({
      stateAGI: 44250, stateTaxableIncome: 44250, stateIncomeTax: 1681.5, stateCredits: 40, stateTaxAfterCredits: 1641.5,
      localTax: 65.66, totalStateTax: 1707.16, stateWithholding: 1800, stateRefundOrOwed: 92.84,
      additionalLines: expect.objectContaining({ surtaxRate: 0.04, line19Surtax: 65.66 }),
    });
  });

  it('uses the 2024 tax brackets and the 2024 surtax table', () => {
    const { state } = run({ taxYear: 2024, stateReturns: [iowa({ iaCounty: '15', iaSchoolDistrict: '0914' })] });
    // Line 2: $60,000 − $14,600 = $45,400. Tax: $1,470.53 + 5.7% × $14,350 = $2,288.48. Less $40: $2,248.48.
    // Cass 0914 CAM 2024: 10% = $224.85.
    expect(state).toMatchObject({ stateTaxableIncome: 45400, stateIncomeTax: 2288.48, stateTaxAfterCredits: 2248.48, localTax: 224.85, totalStateTax: 2473.33 });
    // 2025: Cass is an EMS county, so CAM is 11%.
    expect(run({ stateReturns: [iowa({ iaCounty: '15', iaSchoolDistrict: '0914' })] }).state?.additionalLines?.surtaxRate).toBe(0.11);
  });

  it('excludes the retirement income of a recipient 55 or older', () => {
    const { state } = run({
      dateOfBirth: '1965-03-01',
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 30000, federalTaxWithheld: 3000, state: 'IA' }],
      income1099R: [{ id: 'r', payerName: 'Pension Plan', grossDistribution: 50000, taxableAmount: 50000, distributionCode: '7' }] as TaxReturn['income1099R'],
      stateReturns: [iowa(polk('0472'))],
    });
    // Line 2: $80,000 − $15,750 = $64,250. Line 3: −$50,000. Line 4: $14,250. Tax $541.50 − $40 = $501.50. Ballard 2%: $10.03.
    expect(state).toMatchObject({ stateSubtractions: 50000, stateTaxableIncome: 14250, stateIncomeTax: 541.5, stateTaxAfterCredits: 501.5, localTax: 10.03, totalStateTax: 511.53 });
  });

  it('asks whether a recipient under 55 was disabled or a qualifying survivor', () => {
    const base = {
      income1099R: [{ id: 'r', payerName: 'Pension Plan', grossDistribution: 20000, taxableAmount: 20000, distributionCode: '7' }] as TaxReturn['income1099R'],
    };
    expect(run({ ...base, stateReturns: [iowa(polk())] }).findings.map((f) => [f.itemId, f.question?.key])).toEqual([['retirement:you', 'iaRetirementEligible']]);
    expect(run({ ...base, stateReturns: [iowa({ ...polk(), iaRetirementEligible: true })] }).state).toMatchObject({ stateSubtractions: 20000 });
    expect(run({ ...base, stateReturns: [iowa({ ...polk(), iaRetirementEligible: false })] }).state).toMatchObject({ stateSubtractions: 0 });
  });

  it('owes nothing under the low-income exemption, surtax included', () => {
    const { result, state } = run({ w2Income: [{ id: 'w', employerName: 'Acme', wages: 8000, federalTaxWithheld: 0, state: 'IA', stateTaxWithheld: 100 }], stateReturns: [iowa(polk())] });
    // Refund: the $100 withheld plus the Iowa EITC (15% of the federal credit this worker gets).
    const iowaEitc = Math.round(result.credits.eitcCredit * 0.15 * 100) / 100;
    expect(iowaEitc).toBeGreaterThan(0);
    expect(state).toMatchObject({ totalStateTax: 0, localTax: 0, stateRefundOrOwed: Math.round((100 + iowaEitc) * 100) / 100, additionalLines: expect.objectContaining({ lowIncomeExemption: 1 }) });
  });

  it('adds taxable municipal interest, and subtracts U.S. obligation interest', () => {
    const income1099INT = [{ id: 'i', payerName: 'Broker', amount: 2000, usBondInterest: 500, taxExemptInterest: 1000 }] as TaxReturn['income1099INT'];
    expect(run({ income1099INT, stateReturns: [iowa(polk())] }).findings.map((f) => f.question?.key)).toEqual(['iaExemptIowaBondInterest']);
    // $1,000 exempt interest, $200 from exempt Iowa bonds: +$800; U.S. interest −$500. Line 4: $46,250 + $300.
    const { state } = run({ income1099INT, stateReturns: [iowa({ ...polk(), iaExemptIowaBondInterest: 200 })] });
    expect(state).toMatchObject({ stateAdditions: 800, stateSubtractions: 500, stateAGI: 46250, stateTaxableIncome: 46550 });
  });

  it("deducts a 65-year-old's post-tax health premiums under $100,000", () => {
    const base = { dateOfBirth: '1958-01-01' };
    expect(run({ ...base, stateReturns: [iowa(polk())] }).findings.map((f) => f.question?.key)).toEqual(['iaHealthInsurance']);
    const without = run({ ...base, stateReturns: [iowa({ ...polk(), iaHealthInsurance: 0 })] }).state!;
    const withPremiums = run({ ...base, stateReturns: [iowa({ ...polk(), iaHealthInsurance: 3000 })] }).state!;
    expect(withPremiums.stateSubtractions).toBe(3000);
    expect(withPremiums.stateTaxableIncome).toBe(without.stateTaxableIncome - 3000);
  });

  it('gives the tuition and textbook credit, the Iowa EITC and the child care credit', () => {
    const { result, state, findings } = run({
      filingStatus: FilingStatus.HeadOfHousehold,
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 20000, federalTaxWithheld: 0, state: 'IA', stateTaxWithheld: 0 }],
      dependents: [{ id: 'kid', firstName: 'Ava', lastName: 'Payer', relationship: 'Daughter', dateOfBirth: '2016-04-01', monthsLivedWithYou: 12 }],
      stateReturns: [iowa({ ...polk(), 'iaTuition:kid': 2400 })],
    });
    expect(findings).toEqual([]);
    const eitc = result.credits.eitcCredit;
    expect(eitc).toBeGreaterThan(0);
    // Line 8: 2 personal credits (head of household) + 1 dependent = $120. Line 9: 25% of $2,000 = $500.
    expect(state).toMatchObject({
      stateCredits: 620, totalStateTax: 0,
      additionalLines: expect.objectContaining({ line8ExemptionCredit: 120, line9TuitionCredit: 500, line25EarnedIncomeCredit: Math.round(eitc * 0.15 * 100) / 100 }),
    });
    expect(state?.stateRefundOrOwed).toBe(Math.round(eitc * 0.15 * 100) / 100);
  });

  it('gives the child care credit at the rate for Iowa taxable income', () => {
    const { result, state } = run({
      filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Pat', spouseDateOfBirth: '1986-01-01',
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 70000, federalTaxWithheld: 5000, state: 'IA', stateTaxWithheld: 2000 }],
      dependents: [{ id: 'kid', firstName: 'Ava', lastName: 'Payer', relationship: 'Daughter', dateOfBirth: '2022-04-01', monthsLivedWithYou: 12 }],
      dependentCare: { totalExpenses: 3000, qualifyingPersons: 1 },
      stateReturns: [iowa(polk())],
    } as Partial<TaxReturn>);
    const federalLine9c = result.dependentCare?.credit ?? 0;
    expect(federalLine9c).toBeGreaterThan(0);
    // Line 4: $70,000 − $31,500 = $38,500, under $40,000: 40%.
    expect(state).toMatchObject({ stateTaxableIncome: 38500, additionalLines: expect.objectContaining({ line24ChildCareCredit: Math.round(federalLine9c * 0.4 * 100) / 100 }) });
  });
});

describe('what the IA 1040 needs from the preparer', () => {
  it('asks the county and the school district, and the items the return cannot show', () => {
    const tr = makeTaxReturn({ stateReturns: [{ stateCode: 'IA', residencyType: 'resident' } as StateReturnConfig] });
    const asked = assessIowa(tr, calculateForm1040(tr));
    expect(asked.findings.map((f) => [f.itemId, f.question?.key, f.question?.kind])).toEqual([
      ['other-items', 'iaOtherItems', 'yes_no'],
      ['county', 'iaCounty', 'choice'],
    ]);
    expect(asked.findings[1]!.question?.options).toHaveLength(99);
    // The districts offered are the county's.
    const inPolk = assessIowa({ ...tr, stateReturns: [iowa({ iaCounty: '77' })] }, calculateForm1040(tr));
    const district = inPolk.findings.find((f) => f.itemId === 'school-district')!;
    expect(district.question?.options).toContainEqual({ value: '1350', label: '1350 Collins-Maxwell' });
    expect(district.question?.options).not.toContainEqual(expect.objectContaining({ value: '0914' }));
  });

  it('stops the return when an item it does not figure applies, and for a year not built', () => {
    expect(run({ stateReturns: [iowa({ ...polk(), iaOtherItems: true })] }).findings).toEqual([expect.objectContaining({ itemId: 'other-items', message: expect.stringContaining('outside HA Tax') })]);
    expect(run({ taxYear: 2026, stateReturns: [iowa(polk())] }).findings.map((f) => f.itemId)).toEqual(['year']);
  });

  it('leaves part-year and nonresident returns to TAX-008', () => {
    const findings = run({ stateReturns: [{ ...iowa({}, 'part_year'), daysLivedInState: 100 } as StateReturnConfig] }).findings;
    expect(findings.map((f) => f.ruleId)).toEqual(['TAX-008']);
  });
});
