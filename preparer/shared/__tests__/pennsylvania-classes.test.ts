/**
 * Pennsylvania full-year residents (TY2025 corpus TAX-002): the PA-40's eight
 * income classes, each figured on its own. Amounts are worked by hand from the
 * 2025 PA-40 and its instructions (PA-40 IN 04-25): 3.07%, positive classes
 * only on line 9, and the Schedule SP eligibility income tables.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type Income1099B, type StateReturnConfig, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'pa-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer', addressState: 'PA', dateOfBirth: '1985-05-01',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 58000, federalTaxWithheld: 6000, state: 'PA', stateWages: 62000, stateTaxWithheld: 1903.4 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const pa = (answers: Record<string, unknown> = {}, residencyType: StateReturnConfig['residencyType'] = 'resident'): StateReturnConfig =>
  ({ stateCode: 'PA', residencyType, stateSpecificData: { paOtherItems: false, paContributed529: false, ...answers } } as StateReturnConfig);
const sale = (id: string, gain: number, o: Partial<Income1099B> = {}): Income1099B =>
  ({ id, brokerName: 'Broker', description: 'Stock', dateSold: '2025-06-01', proceeds: 10000 + gain, costBasis: 10000, isLongTerm: true, ...o });

function run(overrides: Partial<TaxReturn>) {
  const result = calculateForm1040(makeTaxReturn(overrides));
  return {
    result,
    state: result.stateResults?.find((s) => s.stateCode === 'PA'),
    findings: (result.unsupported ?? []).filter((u) => u.jurisdiction === 'PA'),
  };
}

describe('the PA-40 income classes', () => {
  it('taxes each class on its own, and never lets a loss reduce another class', () => {
    const { state, findings } = run({
      income1099INT: [{ id: 'i', payerName: 'Bank', amount: 500, usBondInterest: 200 }] as TaxReturn['income1099INT'],
      income1099DIV: [{ id: 'd', payerName: 'Fund', ordinaryDividends: 300, qualifiedDividends: 300, capitalGainDistributions: 100 }] as TaxReturn['income1099DIV'],
      income1099B: [sale('a', 2000), sale('b', -3000)],
      stateReturns: [pa()],
    });
    // Line 1a: box 16, $62,000. Line 2: $500 (U.S. obligation interest is exempt). Line 3: $300 + $100.
    // Line 5: $2,000 − $3,000 = a $1,000 loss, reported as zero. Line 9: $62,900. Line 12: 3.07% = $1,931.03.
    expect(findings).toEqual([]);
    expect(state).toMatchObject({
      stateAGI: 62900, stateTaxableIncome: 62900, stateIncomeTax: 1931.03, totalStateTax: 1931.03,
      stateWithholding: 1903.4, stateRefundOrOwed: -27.63,
      additionalLines: expect.objectContaining({ line1aCompensation: 62000, line2Interest: 500, line3Dividends: 400, line5Gains: 0, line5NetLoss: 1 }),
    });
  });

  it("keeps one spouse's business loss from reducing the other's income", () => {
    const { state } = run({
      filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Pat',
      businesses: [{ id: 'b1', businessName: 'Shop', accountingMethod: 'cash', didStartThisYear: false }, { id: 'b2', businessName: 'Studio', accountingMethod: 'cash', didStartThisYear: false, isSpouse: true }],
      income1099NEC: [{ id: 'n', payerName: 'Client', amount: 12000, businessId: 'b1' }],
      stateReturns: [pa({ paBusinessIncome: 10000, paSpouseBusinessIncome: -4000 })],
    });
    // Line 4: $10,000 (the spouse's $4,000 loss is not netted). Line 9: $62,000 + $10,000.
    expect(state).toMatchObject({ stateAGI: 72000, additionalLines: expect.objectContaining({ line4Business: 10000, line4NetLoss: 1 }) });
  });

  it('treats retirement distributions by their code', () => {
    const r = (id: string, code: string, taxable: number) => ({ id, payerName: `Plan ${id}`, grossDistribution: taxable, taxableAmount: taxable, distributionCode: code });
    const base = { income1099R: [r('pension', '7', 20000), r('annuity', '7D', 1500), r('early', '1', 8000)] as TaxReturn['income1099R'] };
    expect(run({ ...base, stateReturns: [pa()] }).findings.map((f) => f.question?.key)).toEqual(['paRetirementTaxable:early']);
    const { state } = run({ ...base, stateReturns: [pa({ 'paRetirementTaxable:early': 3000 })] });
    // Code 7: not taxable. Code 7D: $1,500 interest. Code 1: $3,000 over contributions, compensation.
    expect(state).toMatchObject({ additionalLines: expect.objectContaining({ line1aCompensation: 65000, line2Interest: 1500 }) });
  });

  it('deducts HSA contributions and up to $2,500 of student loan interest', () => {
    const { state } = run({ studentLoanInterest: 3000, stateReturns: [pa()] });
    // Line 10: $2,500. Line 11: $62,000 − $2,500 = $59,500. Line 12: $1,826.65.
    expect(state).toMatchObject({ stateDeduction: 2500, stateTaxableIncome: 59500, stateIncomeTax: 1826.65 });
  });

  it('asks the 529 contributions, and deducts them', () => {
    expect(run({ stateReturns: [pa({ paContributed529: undefined })] }).findings.map((f) => f.question?.key)).toEqual(['paContributed529']);
    expect(run({ stateReturns: [pa({ paContributed529: true })] }).findings.map((f) => f.question?.key)).toEqual(['paDeduction529']);
    expect(run({ stateReturns: [pa({ paContributed529: true, paDeduction529: 5000 })] }).state).toMatchObject({ stateDeduction: 5000, stateTaxableIncome: 57000 });
  });

  it('nets gambling losses against winnings', () => {
    const { state } = run({ incomeW2G: [{ id: 'g', payerName: 'Casino', grossWinnings: 5000 }] as TaxReturn['incomeW2G'], gamblingLosses: 2000, stateReturns: [pa()] });
    expect(state).toMatchObject({ additionalLines: expect.objectContaining({ line8Gambling: 3000 }), stateAGI: 65000 });
  });

  it('forgives tax by the Schedule SP eligibility income tables', () => {
    const low = {
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 15000, federalTaxWithheld: 0, state: 'PA', stateWages: 15000, stateTaxWithheld: 460.5 }],
      dependents: [{ id: 'k', firstName: 'Ava', lastName: 'Payer', relationship: 'Daughter', dateOfBirth: '2016-04-01', monthsLivedWithYou: 12 }],
    };
    // Line 12: 3.07% × $15,000 = $460.50. One child: 100% up to $16,000, 90% to $16,250, 80% to $16,500 ...
    expect(run({ ...low, stateReturns: [pa()] }).findings.map((f) => f.question?.key)).toEqual(['paOtherEligibilityIncome']);
    expect(run({ ...low, stateReturns: [pa({ paOtherEligibilityIncome: 0 })] }).state).toMatchObject({ stateIncomeTax: 460.5, stateCredits: 460.5, totalStateTax: 0, stateRefundOrOwed: 460.5 });
    // $16,500 is $500 over: 80% forgiven, $368.40. Tax $92.10.
    expect(run({ ...low, stateReturns: [pa({ paOtherEligibilityIncome: 1500 })] }).state).toMatchObject({ stateCredits: 368.4, totalStateTax: 92.1 });
    // No question once income is over the table's last column.
    expect(run({ stateReturns: [pa()] }).findings).toEqual([]);
  });
});

describe('the Working Pennsylvanians Tax Credit (not on the 2025 PA-40)', () => {
  it('estimates 10% of the federal EITC without changing the PA-40', () => {
    const w2Income = [{ id: 'w', employerName: 'Acme', wages: 18000, federalTaxWithheld: 0, state: 'PA', stateWages: 18000, stateTaxWithheld: 552.6 }];
    const dependents = [{ id: 'k', firstName: 'Ava', lastName: 'Payer', relationship: 'Daughter', dateOfBirth: '2016-04-01', monthsLivedWithYou: 12 }];
    const { result, state } = run({ filingStatus: FilingStatus.HeadOfHousehold, w2Income, dependents, stateReturns: [pa({ paOtherEligibilityIncome: 5000 })] } as Partial<TaxReturn>);
    const eitc = result.credits.eitcCredit;
    expect(eitc).toBeGreaterThan(0);
    expect(state?.additionalLines?.workingPennsylvaniansCreditEstimate).toBe(Math.round(eitc * 0.1 * 100) / 100);
    // The PA-40 figures do not include it: 3.07% × $18,000 = $552.60, less tax forgiveness.
    expect(state?.stateIncomeTax).toBe(552.6);
    expect(state?.stateRefundOrOwed).toBe(Math.round((552.6 - (state?.totalStateTax ?? 0)) * 100) / 100);
  });
});

describe('what the PA-40 needs, or cannot figure', () => {
  it('asks for Pennsylvania compensation when box 16 is not Pennsylvania wages', () => {
    const { findings } = run({ w2Income: [{ id: 'nj', employerName: 'Jersey Co', wages: 50000, federalTaxWithheld: 5000, state: 'NJ', stateWages: 50000, stateTaxWithheld: 900 }], stateReturns: [pa()] });
    expect(findings.map((f) => [f.itemId, f.question?.key])).toEqual([['compensation:nj', 'paCompensation:nj']]);
  });

  it("stops wages another state taxed (resident credit), K-1 income, and a year not built", () => {
    const ny = { w2Income: [{ id: 'ny', employerName: 'NY Co', wages: 50000, federalTaxWithheld: 5000, state: 'NY', stateWages: 50000, stateTaxWithheld: 2500 }] };
    expect(run({ ...ny, stateReturns: [pa({ 'paCompensation:ny': 50000 })] }).findings.map((f) => f.itemId)).toEqual(['resident-credit']);
    expect(run({ incomeK1: [{ id: 'k', entityName: 'LP', entityType: 'partnership', ordinaryBusinessIncome: 1000 }] as TaxReturn['incomeK1'], stateReturns: [pa()] }).findings.map((f) => f.itemId)).toEqual(['k1']);
    expect(run({ taxYear: 2024, stateReturns: [pa()] }).findings.map((f) => f.itemId)).toEqual(['year']);
  });

  it("asks a joint return whether gains and losses belong to one owner", () => {
    const joint = { filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Pat', income1099B: [sale('a', 5000), sale('b', -2000)] };
    expect(run({ ...joint, stateReturns: [pa()] }).findings.map((f) => f.question?.key)).toEqual(['paGainsOneOwner']);
    expect(run({ ...joint, stateReturns: [pa({ paGainsOneOwner: true })] }).state).toMatchObject({ additionalLines: expect.objectContaining({ line5Gains: 3000 }) });
    expect(run({ ...joint, stateReturns: [pa({ paGainsOneOwner: false })] }).findings[0]!.message).toContain('outside HATax');
  });

  it('leaves part-year and nonresident returns to TAX-008', () => {
    const findings = run({ stateReturns: [{ ...pa({}, 'part_year'), daysLivedInState: 100 } as StateReturnConfig] }).findings;
    expect(findings.map((f) => f.ruleId)).toEqual(['TAX-008']);
  });
});
