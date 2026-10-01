/**
 * Form 1099-DIV box 2b (unrecaptured section 1250 gain) and box 2d
 * (collectibles, 28% gain), parts of the box 2a capital gain distributions
 * (Schedule D instructions, line 13): box 2b goes on line 11 of the
 * Unrecaptured Section 1250 Gain Worksheet, box 2d on line 4 of the 28% Rate
 * Gain Worksheet. $800,000 of wages puts every gain past the 20% threshold
 * ($533,400 taxable, single, 2025), so the 25% and 28% rates apply in full.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type Income1099DIV, type TaxReturn } from '../src/types/index.js';

function makeReturn(div: Partial<Income1099DIV>): TaxReturn {
  return {
    id: 'd', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 800000, federalTaxWithheld: 0 }], income1099NEC: [],
    income1099K: [], income1099INT: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [],
    income1099DIV: [{ id: 'div', payerName: 'Fund', ordinaryDividends: 0, qualifiedDividends: 0, ...div }],
    incomeK1: [], income1099SA: [], income1099DA: [], income1099C: [], income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0,
    businesses: [], expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
  } as TaxReturn;
}
const tax = (div: Partial<Income1099DIV>) => calculateForm1040(makeReturn(div)).form1040.incomeTax;
const round = (n: number) => Math.round(n * 100) / 100;

describe('Form 1099-DIV boxes 2b and 2d', () => {
  it('taxes box 2d collectibles gain at 28%, not 20%', () => {
    expect(round(tax({ capitalGainDistributions: 50000, collectiblesGain: 20000 }) - tax({ capitalGainDistributions: 50000 }))).toBe(1600); // $20,000 × 8%
  });

  it('taxes box 2b unrecaptured section 1250 gain at 25% (worksheet line 11, directly)', () => {
    expect(round(tax({ capitalGainDistributions: 50000, unrecapturedSection1250Gain: 30000 }) - tax({ capitalGainDistributions: 50000 }))).toBe(1500); // $30,000 × 5%
  });
});
