/**
 * Washington capital gains tax (chapter 82.87 RCW; TY2025 corpus TAX-003).
 * Amounts are worked by hand from RCW 82.87.040 (7%, and from 2025 another
 * 2.9% over $1,000,000) and the Department of Revenue's updated amounts table
 * (standard deduction $278,000 for 2025, $270,000 for 2024; donations over
 * $278,000 deductible up to $111,000 for 2025).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { assessWashingtonCapitalGains } from '../src/engine/state/wa.js';
import { stateQuestions } from '../src/engine/unsupported.js';
import { FilingStatus, type Income1099B, type StateReturnConfig, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'wa-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer', addressState: 'WA',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 80000, federalTaxWithheld: 9000 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const sale = (gain: number, o: Partial<Income1099B> = {}): Income1099B =>
  ({ id: `b${gain}`, brokerName: 'Broker', description: 'Stock', dateSold: '2025-06-01', proceeds: gain + 10000, costBasis: 10000, isLongTerm: true, basisReportedToIRS: true, ...o });

const wa = (answers: Record<string, unknown> = {}, residencyType: StateReturnConfig['residencyType'] = 'resident'): StateReturnConfig =>
  ({ stateCode: 'WA', residencyType, stateSpecificData: answers } as StateReturnConfig);

/** A resident who has confirmed none of the items the return cannot show apply. */
const confirmed = (answers: Record<string, unknown> = {}) => wa({ waSpecialItems: false, ...answers });

function run(overrides: Partial<TaxReturn>) {
  const result = calculateForm1040(makeTaxReturn(overrides));
  return {
    result,
    state: result.stateResults?.find((s) => s.stateCode === 'WA'),
    findings: (result.unsupported ?? []).filter((u) => u.jurisdiction === 'WA'),
  };
}

describe('the Washington capital gains tax', () => {
  it('taxes 7% of long-term gains over the standard deduction, and 2.9% more over $1,000,000 (2025)', () => {
    const { state, findings } = run({ stateReturns: [confirmed()], income1099B: [sale(1500000)] });
    // $1,500,000 − $278,000 = $1,222,000. 7% = $85,540; 2.9% × $222,000 = $6,438.
    expect(findings).toEqual([]);
    expect(state).toMatchObject({
      stateAGI: 1500000, stateDeduction: 278000, stateTaxableIncome: 1222000,
      stateIncomeTax: 91978, totalStateTax: 91978, stateRefundOrOwed: -91978,
      bracketDetails: [
        { rate: 0.07, taxableAtRate: 1222000, taxAtRate: 85540 },
        { rate: 0.029, taxableAtRate: 222000, taxAtRate: 6438 },
      ],
    });
    expect(state?.unsupported).toBeUndefined();
  });

  it('uses the 2024 deduction ($270,000) and the flat 7%', () => {
    const { state } = run({ taxYear: 2024, stateReturns: [confirmed()], income1099B: [sale(1500000, { dateSold: '2024-06-01' })] });
    // $1,230,000 × 7% = $86,100; no additional tax before 2025.
    expect(state).toMatchObject({ stateDeduction: 270000, stateTaxableIncome: 1230000, totalStateTax: 86100 });
  });

  it('does not let a short-term loss offset long-term gains', () => {
    const { state } = run({ stateReturns: [confirmed()], income1099B: [sale(300000), sale(-100000, { id: 'st', isLongTerm: false })] });
    // $300,000 − $278,000 = $22,000 × 7% = $1,540.
    expect(state).toMatchObject({ stateAGI: 300000, totalStateTax: 1540 });
  });

  it('counts capital gain distributions and long-term crypto sales', () => {
    const dist = run({ stateReturns: [confirmed()], income1099DIV: [{ id: 'd', payerName: 'Fund', ordinaryDividends: 0, qualifiedDividends: 0, capitalGainDistributions: 290000 }] as TaxReturn['income1099DIV'] });
    expect(dist.state).toMatchObject({ stateAGI: 290000, totalStateTax: 840 });
    const crypto = run({
      stateReturns: [confirmed()],
      income1099DA: [{ id: 'c', brokerName: 'Exchange', tokenName: 'Bitcoin', dateSold: '2025-05-01', proceeds: 300000, costBasis: 20000, isLongTerm: true }] as TaxReturn['income1099DA'],
    });
    expect(crypto.state).toMatchObject({ stateAGI: 280000, totalStateTax: 140 });
  });

  it('leaves out a home sale: real estate is exempt', () => {
    const { state, findings } = run({
      stateReturns: [wa()], income1099B: [sale(100000)],
      homeSale: { salePrice: 1500000, costBasis: 300000, ownedMonths: 60, usedAsResidenceMonths: 60 },
    });
    expect(findings).toEqual([]);
    expect(state).toMatchObject({ stateAGI: 100000, totalStateTax: 0 });
  });

  it('asks nothing when the gains are within the standard deduction', () => {
    const { state, findings } = run({ stateReturns: [wa()], income1099B: [sale(278000)] });
    expect(findings).toEqual([]);
    expect(state).toMatchObject({ stateAGI: 278000, stateTaxableIncome: 0, totalStateTax: 0 });
  });

  it("does not allocate a nonresident's stock gains to Washington, and gives no other-state credit", () => {
    expect(run({ addressState: 'OR', stateReturns: [wa({}, 'nonresident')], income1099B: [sale(1000000)] }).state).toMatchObject({ totalStateTax: 0 });
    const both = run({ stateReturns: [confirmed(), { stateCode: 'OR', residencyType: 'nonresident' } as StateReturnConfig], income1099B: [sale(300000)] });
    expect(both.state).toMatchObject({ stateCredits: 0, totalStateTax: 1540 });
  });
});

describe('what the return does not settle is asked, or stops the return', () => {
  it('asks about the items the return cannot show when tax may be owed', () => {
    const { state, findings } = run({ stateReturns: [wa()], income1099B: [sale(300000)] });
    expect(findings).toEqual([{
      ruleId: 'TAX-003', jurisdiction: 'WA', section: 'state', itemId: 'special-items',
      message: expect.stringContaining('Washington capital gains tax: the long-term gains may be over the standard deduction'),
      question: { stateCode: 'WA', key: 'waSpecialItems', kind: 'yes_no', prompt: expect.stringContaining('privately held business') },
    }]);
    expect(state?.unsupported).toEqual([findings[0]!.message]);
    expect(run({ stateReturns: [wa({ waSpecialItems: true })], income1099B: [sale(300000)] }).findings)
      .toEqual([expect.objectContaining({ itemId: 'special-items', message: expect.stringContaining('outside HA Tax') })]);
    expect(run({ stateReturns: [wa({ waSpecialItems: true })], income1099B: [sale(300000)] }).findings[0]!.question).toBeUndefined();
  });

  it('stops a Washington address with no Washington state return', () => {
    expect(run({ income1099B: [sale(100000)] }).findings).toEqual([]);
    const { findings } = run({ income1099B: [sale(300000)] });
    expect(findings.map((f) => f.itemId)).toEqual(['state-return']);
    expect(findings[0]!.question).toBeUndefined();
  });

  it('asks a separate filer whether both spouses together are within the deduction', () => {
    const mfs = { filingStatus: FilingStatus.MarriedFilingSeparately, income1099B: [sale(10000)] };
    expect(run({ ...mfs, stateReturns: [wa()] }).findings).toEqual([expect.objectContaining({
      itemId: 'separate-return', question: expect.objectContaining({ key: 'waSpousesWithinDeduction', kind: 'yes_no' }),
    })]);
    expect(run({ ...mfs, stateReturns: [wa({ waSpousesWithinDeduction: true })] })).toMatchObject({ findings: [], state: { totalStateTax: 0 } });
    const over = run({ ...mfs, stateReturns: [wa({ waSpousesWithinDeduction: false })] }).findings;
    expect(over).toEqual([expect.objectContaining({ itemId: 'separate-return', message: expect.stringContaining('outside HA Tax') })]);
    expect(over[0]!.question).toBeUndefined();
  });

  it('asks whether collectibles are allocated to Washington', () => {
    const items = [sale(250000), sale(50000, { id: 'coin', description: 'Gold coins', isCollectible: true })];
    expect(run({ stateReturns: [confirmed()], income1099B: items }).findings.map((f) => [f.itemId, f.question?.key]))
      .toEqual([['collectibles', 'waCollectiblesAllocated']]);
    // Not allocated: $250,000 is within the deduction.
    expect(run({ stateReturns: [confirmed({ waCollectiblesAllocated: false })], income1099B: items })).toMatchObject({ findings: [], state: { totalStateTax: 0 } });
    // Allocated: $300,000 − $278,000 = $22,000 × 7% = $1,540.
    expect(run({ stateReturns: [confirmed({ waCollectiblesAllocated: true })], income1099B: items })).toMatchObject({ findings: [], state: { totalStateTax: 1540 } });
  });

  it('asks for the part of the long-term carryover from Washington sales', () => {
    const base = { income1099B: [sale(400000)], capitalLossCarryforwardST: 0, capitalLossCarryforwardLT: 100000 };
    expect(run({ ...base, stateReturns: [confirmed()] }).findings.map((f) => [f.itemId, f.question?.key])).toEqual([['carryover', 'waCarryoverLoss']]);
    // $400,000 − $60,000 = $340,000; − $278,000 = $62,000 × 7% = $4,340.
    expect(run({ ...base, stateReturns: [confirmed({ waCarryoverLoss: 60000 })] })).toMatchObject({ findings: [], state: { stateAGI: 340000, totalStateTax: 4340 } });
    expect(run({ ...base, stateReturns: [confirmed({ waCarryoverLoss: 150000 })] }).findings[0]!.message).toContain('The amount entered ($150,000) is not between $0 and the carryover');
  });

  it('asks for the Washington part of K-1 long-term gain', () => {
    const base = {
      income1099B: [sale(200000)],
      incomeK1: [{ id: 'k', entityName: 'Fund LP', entityType: 'partnership', longTermCapitalGain: 200000 }] as TaxReturn['incomeK1'],
    };
    const asked = run({ ...base, stateReturns: [confirmed()] }).findings;
    expect(asked.map((f) => [f.itemId, f.question?.key, f.question?.allowNegative])).toEqual([['other-gains', 'waOtherGain', true]]);
    expect(asked[0]!.message).toContain('K-1 long-term gain of $200,000');
    // $200,000 + $150,000 = $350,000; − $278,000 = $72,000 × 7% = $5,040.
    expect(run({ ...base, stateReturns: [confirmed({ waOtherGain: 150000 })] })).toMatchObject({ findings: [], state: { stateAGI: 350000, totalStateTax: 5040 } });
    expect(run({ ...base, stateReturns: [confirmed({ waOtherGain: 250000 })] }).findings[0]!.message).toContain('is outside what these items can be');
  });

  it('counts a capital asset installment gain once: asked with the other gains, not as a sale of securities', () => {
    // Land sold on installments: $40,000 of gain this year reaches Schedule D line 11.
    const land = { id: 'land', description: 'Land', dateAcquired: '2015-03-01', dateOfSale: '2025-06-15', propertyKind: 'capital_asset' as const, relatedParty: false,
      sellingPrice: 400000, costOrBasis: 200000, paymentsReceivedThisYear: 80000 };
    const base = { income1099B: [sale(300000)], installmentSales: [land] };
    expect(run({ ...base, stateReturns: [confirmed()] }).findings.map((f) => f.question?.key)).toEqual(['waOtherGain']);
    // Real estate is not Washington's: answered $0, only the $300,000 of securities.
    // $300,000 − $278,000 = $22,000 × 7% = $1,540.
    expect(run({ ...base, stateReturns: [confirmed({ waOtherGain: 0 })] })).toMatchObject({ findings: [], state: { stateAGI: 300000, totalStateTax: 1540 } });
  });

  it('asks for donations to Washington charities when donations are over the threshold', () => {
    const base = {
      income1099B: [sale(1000000)], deductionMethod: 'itemized' as const,
      itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0, mortgageInsurancePremiums: 0, charitableCash: 400000, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 },
    };
    expect(run({ ...base, stateReturns: [confirmed()] }).findings.map((f) => [f.itemId, f.question?.key])).toEqual([['donations', 'waQualifiedDonations']]);
    // $1,000,000 − $278,000 = $722,000; donations $350,000 − $278,000 = $72,000 (under the $111,000 cap).
    // $650,000 × 7% = $45,500.
    expect(run({ ...base, stateReturns: [confirmed({ waQualifiedDonations: 350000 })] }))
      .toMatchObject({ findings: [], state: { stateDeduction: 350000, stateTaxableIncome: 650000, totalStateTax: 45500 } });
    // The deduction is capped at $111,000.
    expect(run({ ...base, stateReturns: [confirmed({ waQualifiedDonations: 400000 })] }).state).toMatchObject({ stateTaxableIncome: 611000 });
  });

  it('stops a year whose deduction is not published, and a part-year resident, when tax may be owed', () => {
    expect(run({ taxYear: 2026, stateReturns: [wa()], income1099B: [sale(200000)] }).findings).toEqual([]);
    expect(run({ taxYear: 2026, stateReturns: [wa()], income1099B: [sale(300000)] }).findings.map((f) => f.itemId)).toEqual(['year']);
    const partYear = run({ stateReturns: [wa({}, 'part_year')], income1099B: [sale(300000)] }).findings;
    expect(partYear.map((f) => f.itemId)).toEqual(['part-year']);
    expect(partYear[0]!.question).toBeUndefined();
  });

  it('keeps an answered question listed, so the answer can be changed', () => {
    const items = [sale(250000), sale(50000, { id: 'coin', isCollectible: true })];
    const listed = (answers: Record<string, unknown>) => {
      const tr = makeTaxReturn({ stateReturns: [wa(answers)], income1099B: items });
      return stateQuestions(tr, calculateForm1040(tr)).map((q) => q.key);
    };
    expect(listed({})).toEqual(['waCollectiblesAllocated', 'waSpecialItems']);
    // Not allocated: no tax can be owed and nothing is asked, but both answers stay listed.
    expect(listed({ waCollectiblesAllocated: false, waSpecialItems: false })).toEqual(['waCollectiblesAllocated', 'waSpecialItems']);
    expect(listed({ waCollectiblesAllocated: false })).toEqual(['waCollectiblesAllocated']);
  });

  it('assesses without a Washington connection as not applying', () => {
    const tr = makeTaxReturn({ addressState: 'OR', income1099B: [sale(5000000)] });
    expect(assessWashingtonCapitalGains(tr, calculateForm1040(tr))).toMatchObject({ applies: false, findings: [], tax: 0 });
  });
});
