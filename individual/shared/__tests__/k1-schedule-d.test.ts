/**
 * Schedule K-1 capital gains on Schedule D (2025 Schedule D instructions):
 * box 8 (net short-term gain or loss) is line 5 and box 9a (net long-term) is
 * line 12. They net with the other sales and are under the §1211(b) loss limit
 * and §1212(b) carryover, and reach Form 1040 line 7 — once.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { getStandardDeduction } from '../src/constants/taxConstants.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'k1', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 80000, federalTaxWithheld: 9000 }], income1099NEC: [],
    income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [],
    incomeK1: [], income1099SA: [], income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [],
    otherIncome: 0, businesses: [], expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {},
    createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

const k1 = (shortTermCapitalGain: number, longTermCapitalGain: number) => [{ id: 'k', entityName: 'Fund LP', entityType: 'partnership' as const, shortTermCapitalGain, longTermCapitalGain }];

describe('K-1 capital gains on Schedule D', () => {
  it('reports a K-1 long-term gain on Schedule D line 12 and Form 1040 line 7, once', () => {
    const base = calculateForm1040(makeReturn());
    const result = calculateForm1040(makeReturn({ incomeK1: k1(0, 10000) as TaxReturn['incomeK1'] }));
    expect(result.scheduleD).toMatchObject({ longTermGain: 10000, netLongTerm: 10000 });
    expect(result.form1040.capitalGainOrLoss).toBe(10000);
    expect(result.form1040.totalIncome).toBe(base.form1040.totalIncome + 10000);
    // At the 15% rate, not ordinary rates.
    expect(result.form1040.incomeTax - base.form1040.incomeTax).toBe(1500);
  });

  it('limits a K-1 short-term loss to $3,000 and carries the rest', () => {
    const base = calculateForm1040(makeReturn());
    const result = calculateForm1040(makeReturn({ incomeK1: k1(-20000, 0) as TaxReturn['incomeK1'] }));
    expect(result.scheduleD).toMatchObject({ capitalLossDeduction: 3000, capitalLossCarryforwardST: 17000, capitalLossCarryforwardLT: 0 });
    expect(result.form1040.capitalGainOrLoss).toBe(-3000);
    expect(result.form1040.agi).toBe(base.form1040.agi - 3000);
  });

  it('nets a K-1 long-term gain against a short-term sale loss', () => {
    const result = calculateForm1040(makeReturn({
      incomeK1: k1(0, 10000) as TaxReturn['incomeK1'],
      income1099B: [{ id: 'b', brokerName: 'Broker', description: 'Stock', dateSold: '2025-06-01', proceeds: 0, costBasis: 15000, isLongTerm: false }],
    }));
    // -$15,000 short-term + $10,000 long-term = -$5,000: $3,000 deducted, $2,000 short-term carried.
    expect(result.scheduleD).toMatchObject({ netShortTerm: -15000, netLongTerm: 10000, capitalLossDeduction: 3000, capitalLossCarryforwardST: 2000 });
    expect(result.form1040.capitalGainOrLoss).toBe(-3000);
    expect(result.form1040.agi).toBe(80000 - 3000);
    const standard = getStandardDeduction(2025)[FilingStatus.Single];
    expect(result.form1040.taxableIncome).toBe(80000 - 3000 - standard);
  });
});
