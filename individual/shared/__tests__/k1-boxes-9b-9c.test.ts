/**
 * Schedule K-1 box 9b (collectibles, 28% gain) and box 9c (unrecaptured
 * section 1250 gain), by the 2025 Schedule D instructions:
 * - 28% Rate Gain Worksheet line 4: collectibles gain from a K-1;
 * - Unrecaptured Section 1250 Gain Worksheet line 5: a partnership's or S
 *   corporation's K-1 amount, with the section 1231 part and limited by the net
 *   section 1231 gain (Form 4797 line 7); line 11: an estate's or trust's K-1
 *   amount, directly.
 * The rates are maximums: $800,000 of wages puts every gain past the 20% threshold
 * ($533,400 taxable, single, 2025), so the 28% and 25% rates apply in full.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { findUnsupportedPatterns } from '../src/engine/unsupported.js';
import { FilingStatus, type IncomeK1, type TaxReturn } from '../src/types/index.js';

function makeReturn(incomeK1: Partial<IncomeK1>[]): TaxReturn {
  return {
    id: 'k', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 800000, federalTaxWithheld: 0 }], income1099NEC: [],
    income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [],
    incomeK1: incomeK1.map((k, i) => ({ id: `k${i}`, entityName: 'Fund', entityType: 'partnership', ...k })) as IncomeK1[],
    income1099SA: [], income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0,
    businesses: [], expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
  } as TaxReturn;
}

const tax = (k1: Partial<IncomeK1>[]) => calculateForm1040(makeReturn(k1)).form1040.incomeTax;

describe('K-1 boxes 9b and 9c', () => {
  it('taxes box 9b collectibles gain at 28%, not 20%', () => {
    // $50,000 long-term, $20,000 of it collectibles; the rest at 20%.
    const plain = tax([{ longTermCapitalGain: 50000 }]);
    const withCollectibles = tax([{ longTermCapitalGain: 50000, collectiblesGain28: 20000 }]);
    expect(round(withCollectibles - plain)).toBe(1600); // $20,000 × (28% − 20%)
  });

  it("takes a partnership's box 9c with its section 1231 gain, at 25%", () => {
    // Box 10: $40,000 net section 1231 gain (long-term); $30,000 of it unrecaptured section 1250 gain.
    const plain = tax([{ netSection1231Gain: 40000 }]);
    const with1250 = tax([{ netSection1231Gain: 40000, unrecapturedSection1250Gain: 30000 }]);
    expect(round(with1250 - plain)).toBe(1500); // $30,000 × (25% − 20%)
    // Worksheet line 7: no net section 1231 gain, no 25% amount from line 5.
    expect(round(tax([{ longTermCapitalGain: 30000, unrecapturedSection1250Gain: 30000 }]) - tax([{ longTermCapitalGain: 30000 }]))).toBe(0);
  });

  it("takes an estate's or trust's box 4c directly, at 25%", () => {
    const trust = (o: Partial<IncomeK1>) => [{ entityType: 'trust' as const, ...o }];
    const plain = tax(trust({ longTermCapitalGain: 30000 }));
    const with1250 = tax(trust({ longTermCapitalGain: 30000, unrecapturedSection1250Gain: 30000 }));
    expect(round(with1250 - plain)).toBe(1500);
  });

  it('blocks box 9c on a K-1 whose kind is not known', () => {
    const unknown = makeReturn([{ entityType: undefined as unknown as IncomeK1['entityType'], longTermCapitalGain: 30000, unrecapturedSection1250Gain: 30000 }]);
    expect(findUnsupportedPatterns(unknown, calculateForm1040(unknown)).map((f) => f.ruleId)).toContain('FED.K1.ENTITY_TYPE');
    const known = makeReturn([{ longTermCapitalGain: 30000, unrecapturedSection1250Gain: 30000 }]);
    expect(findUnsupportedPatterns(known, calculateForm1040(known)).map((f) => f.ruleId)).not.toContain('FED.K1.ENTITY_TYPE');
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
