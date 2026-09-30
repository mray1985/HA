/**
 * Form 6252, Installment Sale Income (2025 form and instructions), and where
 * line 26 goes: Schedule D for a capital asset, Form 4797 for trade or business
 * property, with the year-of-sale recapture and unrecaptured section 1250 gain
 * (Schedule D instructions, worksheet line 4). Amounts are worked by hand.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateForm6252 } from '../src/engine/form6252.js';
import { FilingStatus, type InstallmentSaleInfo, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: '6252-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer', dateOfBirth: '1970-01-01',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 50000, federalTaxWithheld: 6000 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const land: InstallmentSaleInfo = {
  id: 'land', description: 'Land', dateAcquired: '2015-03-01', dateOfSale: '2025-06-15', propertyKind: 'capital_asset', relatedParty: false,
  sellingPrice: 100000, costOrBasis: 60000, sellingExpenses: 5000, paymentsReceivedThisYear: 20000,
};

describe('Form 6252 lines', () => {
  it('figures gross profit, contract price and this year’s income for a capital asset', () => {
    // Line 16: $100,000 − ($60,000 + $5,000) = $35,000. Line 18: $100,000. Line 19: .3500. Line 24: $7,000.
    expect(calculateForm6252(land, 2025)).toMatchObject({
      grossProfit: 35000, contractPrice: 100000, grossProfitRatio: 0.35, installmentSaleIncome: 7000,
      totalReportableIncome: 7000, yearOfSale: true, disposition: 'long_term_capital', recaptureThisYear: 0, problems: [],
    });
  });

  it('counts debt the buyer assumed over the seller’s basis as a payment in the year of sale', () => {
    // Line 13: $70,000 + $10,000 = $80,000. Line 14 and 16: $120,000. Line 17: $90,000 − $80,000 = $10,000.
    // Line 18: ($200,000 − $90,000) + $10,000 = $120,000. Line 19: 1.0000. Line 22: $10,000 + $15,000. Line 24: $25,000.
    const r = calculateForm6252({ ...land, sellingPrice: 200000, mortgagesAssumedByBuyer: 90000, costOrBasis: 70000, sellingExpenses: 10000, paymentsReceivedThisYear: 15000 }, 2025);
    expect(r).toMatchObject({ grossProfit: 120000, contractPrice: 120000, grossProfitRatio: 1, installmentSaleIncome: 25000 });
  });

  it('takes section 1245 recapture in full in the year of sale, and the rest as section 1231 gain', () => {
    const equipment: InstallmentSaleInfo = {
      id: 'eq', description: 'Press', dateAcquired: '2020-01-15', dateOfSale: '2025-05-01', propertyKind: 'business_personal', relatedParty: false,
      sellingPrice: 50000, costOrBasis: 40000, depreciationAllowed: 30000, paymentsReceivedThisYear: 10000,
    };
    // Adjusted basis $10,000; total gain $40,000; line 12: the smaller of $30,000 and $40,000.
    // Line 13: $40,000. Line 16: $10,000. Line 19: .2000. Line 24: $2,000 (Form 4797 line 4).
    expect(calculateForm6252(equipment, 2025)).toMatchObject({
      ordinaryIncomeRecapture: 30000, recaptureThisYear: 30000, grossProfit: 10000, grossProfitRatio: 0.2,
      installmentSaleIncome: 2000, disposition: 'section1231',
    });
    // A later year: no recapture, the same percentage.
    const later = calculateForm6252({ ...equipment, dateOfSale: '2024-05-01', paymentsReceivedPriorYears: 10000 }, 2025);
    expect(later).toMatchObject({ yearOfSale: false, recaptureThisYear: 0, installmentSaleIncome: 2000 });
  });

  it('treats a rental’s gain as unrecaptured section 1250 gain first, across the years', () => {
    const rental: InstallmentSaleInfo = {
      id: 'rent', description: 'Duplex', dateAcquired: '2010-06-01', dateOfSale: '2023-07-01', propertyKind: 'business_real', relatedParty: false,
      sellingPrice: 300000, costOrBasis: 200000, depreciationAllowed: 50000, sellingExpenses: 20000,
      paymentsReceivedThisYear: 30000, paymentsReceivedPriorYears: 60000,
    };
    // Total gain $130,000; no section 1250 recapture (straight line). Line 19: 130,000 / 300,000 = .4333.
    // Line 24: $30,000 × .4333 = $12,999. Unrecaptured: $50,000 − (.4333 × $60,000 = $25,998) = $24,002 left; all $12,999 of it.
    expect(calculateForm6252(rental, 2025)).toMatchObject({ grossProfitRatio: 0.4333, installmentSaleIncome: 12999, unrecaptured1250ThisYear: 12999, disposition: 'section1231' });
    // Later, with $90,000 received before: $50,000 − $38,997 = $11,003 of this year's $12,999.
    expect(calculateForm6252({ ...rental, paymentsReceivedPriorYears: 90000 }, 2025).unrecaptured1250ThisYear).toBe(11003);
  });

  it('lists what the facts do not settle', () => {
    const bare = calculateForm6252({ id: 'x', description: 'Lot', dateOfSale: '2025-01-01', sellingPrice: 50000, costOrBasis: 30000, paymentsReceivedThisYear: 10000 }, 2025);
    expect(bare.disposition).toBe('unknown');
    expect(bare.problems).toEqual([
      'Answer whether the property was sold to a related party (line 3).',
      'Enter what was sold: a capital asset, or trade or business property (personal or real).',
      'Enter the date acquired (line 2a), which sets the holding period.',
    ]);
    expect(calculateForm6252({ ...land, sellingPrice: 60000 }, 2025).problems).toContainEqual(expect.stringContaining('no gain'));
    expect(calculateForm6252({ ...land, relatedParty: true }, 2025).problems).toContainEqual(expect.stringContaining('related party'));
    expect(calculateForm6252({ ...land, dateOfSale: '2024-06-15' }, 2025).problems).toContainEqual(expect.stringContaining('prior years (line 23)'));
  });
});

describe('Form 6252 on the return', () => {
  const agi = (sales: InstallmentSaleInfo[]) => calculateForm1040(makeTaxReturn({ installmentSales: sales })).form1040.agi;

  it('puts a capital asset’s gain on Schedule D, not in other income', () => {
    const result = calculateForm1040(makeTaxReturn({ installmentSales: [land] }));
    expect(result.form1040.agi).toBe(agi([]) + 7000);
    expect(result.scheduleD?.longTermGain).toBe(7000);
    expect(result.form6252).toEqual([expect.objectContaining({ disposition: 'long_term_capital', totalReportableIncome: 7000 })]);
    expect(result.unsupported ?? []).toEqual([]);
  });

  it('adds the year-of-sale recapture as ordinary income and the rest as section 1231 gain', () => {
    const equipment: InstallmentSaleInfo = {
      id: 'eq', description: 'Press', dateAcquired: '2020-01-15', dateOfSale: '2025-05-01', propertyKind: 'business_personal', relatedParty: false,
      sellingPrice: 50000, costOrBasis: 40000, depreciationAllowed: 30000, paymentsReceivedThisYear: 10000,
    };
    const result = calculateForm1040(makeTaxReturn({ installmentSales: [equipment] }));
    // $30,000 recapture (ordinary) + $2,000 section 1231 gain (long term).
    expect(result.form1040.agi).toBe(agi([]) + 32000);
    expect(result.section1231LongTermGain).toBe(2000);
  });

  it('keeps a sale whose facts are missing in income, and stops the return', () => {
    const bare: InstallmentSaleInfo = { id: 'x', description: 'Lot', dateOfSale: '2025-01-01', sellingPrice: 50000, costOrBasis: 30000, paymentsReceivedThisYear: 10000 };
    const result = calculateForm1040(makeTaxReturn({ installmentSales: [bare] }));
    // Line 19: .4000; line 24: $4,000.
    expect(result.form1040.agi).toBe(agi([]) + 4000);
    expect(result.unsupported).toEqual([expect.objectContaining({ ruleId: 'FED.FORM6252', itemId: 'x', section: 'federal' })]);
  });

  it('stops sales over $150,000 with more than $5,000,000 still owed (section 453A interest)', () => {
    const big: InstallmentSaleInfo = { ...land, sellingPrice: 8000000, costOrBasis: 2000000, sellingExpenses: 0, paymentsReceivedThisYear: 1000000 };
    const result = calculateForm1040(makeTaxReturn({ installmentSales: [big] }));
    expect(result.unsupported?.map((u) => u.ruleId)).toEqual(['FED.453A']);
  });
});
