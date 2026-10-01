/**
 * Form 2210 on the return (2025 instructions):
 * - line 6 counts excess social security tax withheld (Schedule 3, line 11)
 *   as withholding — it is not a line 3 refundable credit;
 * - the 110% prior-year test uses the preceding year's AGI (IRC §6654(d)(1)(C)).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'p', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [],
    income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [], income1099DA: [], income1099C: [],
    income1099Q: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], expenses: [], deductionMethod: 'standard',
    educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

describe('Form 2210 inputs', () => {
  it('counts excess social security tax withheld as a payment, not a credit', () => {
    // Two employers, $120,000 each: 2 × $7,440 social security tax, over the 2025
    // maximum of $10,918.20 ($176,100 × 6.2%) by $3,961.80.
    const w2 = (id: string) => ({ id, employerName: id, wages: 120000, federalTaxWithheld: 2000, socialSecurityWages: 120000, socialSecurityTax: 7440 });
    const result = calculateForm1040(makeTaxReturn({ w2Income: [w2('A'), w2('B')] }));
    expect(result.credits.excessSSTaxCredit).toBe(3961.8);
    const penalty = result.estimatedTaxPenalty!;
    expect(penalty.totalPaymentsMade).toBe(result.form1040.totalPayments + 3961.8);
    // Line 4 (tax) includes it back; line 9 is 90% of it.
    expect(penalty.requiredAnnualPayment).toBe(Math.round((result.form1040.taxAfterCredits + 3961.8) * 0.9 * 100) / 100);
  });

  it("uses last year's AGI for the 110% prior-year test", () => {
    const base = { w2Income: [{ id: 'w', employerName: 'Acme', wages: 100000, federalTaxWithheld: 0 }], priorYearTax: 8000 };
    // This year's AGI is $100,000; last year's was $200,000, over $150,000: 110% of $8,000.
    const high = calculateForm1040(makeTaxReturn({
      ...base,
      priorYearSummary: { source: 'hatax-json', taxYear: 2024, agi: 200000, totalIncome: 200000, taxableIncome: 185400, deductionAmount: 14600, totalTax: 8000, totalCredits: 0, totalPayments: 8000, refundAmount: 0, amountOwed: 0, effectiveTaxRate: 0.04 },
    }));
    expect(high.estimatedTaxPenalty!.requiredAnnualPayment).toBe(8800);
    // Without last year's AGI, this year's ($100,000) stands in: 100%.
    expect(calculateForm1040(makeTaxReturn(base)).estimatedTaxPenalty!.requiredAnnualPayment).toBe(8000);
  });
});
