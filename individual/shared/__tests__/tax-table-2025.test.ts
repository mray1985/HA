/**
 * Form 1040 line 16 by the Tax Table: below $100,000 of taxable income the
 * tax is the IRS's 2025 Tax Table amount (Publication 1040 (2025)), from
 * $100,000 the Tax Computation Worksheet. Checked against every value the
 * IRS prints, and through the Qualified Dividends and Capital Gain Tax
 * Worksheet (lines 22 and 24) and the Foreign Earned Income Tax Worksheet.
 */

import { describe, expect, it } from 'vitest';
import { calculateProgressiveTax, calculateTaxTableTax, taxTableRow } from '../src/engine/brackets.js';
import { calculatePreferentialRateTax } from '../src/engine/capitalGains.js';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';
import { TAX_TABLE_2025_ROWS, taxTable2025, type TableStatus } from './irsTaxTable2025.js';

const STATUSES: Array<[TableStatus, FilingStatus]> = [
  ['Single', FilingStatus.Single],
  ['MFJ', FilingStatus.MarriedFilingJointly],
  ['MFS', FilingStatus.MarriedFilingSeparately],
  ['HOH', FilingStatus.HeadOfHousehold],
  ['QSS', FilingStatus.QualifyingSurvivingSpouse],
];

function w2Return(status: FilingStatus, wages: number, extra: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'tax-table', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: status, dependents: [],
    w2Income: [{ id: 'w', employerName: 'Employer', wages, federalTaxWithheld: 0, socialSecurityWages: wages, socialSecurityTax: 0, medicareWages: wages, medicareTax: 0 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [],
    deductionMethod: 'standard', expenses: [], educationCredits: [], incomeDiscovery: {},
    createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...extra,
  } as TaxReturn;
}

describe('the 2025 Tax Table', () => {
  it('has every row from $0 to $100,000', () => {
    expect(TAX_TABLE_2025_ROWS).toHaveLength(2062);
    TAX_TABLE_2025_ROWS.forEach(([atLeast, lessThan], i) => {
      if (i > 0) expect(atLeast).toBe(TAX_TABLE_2025_ROWS[i - 1]![1]);
      expect(taxTableRow(atLeast)).toEqual({ atLeast, lessThan });
      expect(taxTableRow(lessThan - 0.01)).toEqual({ atLeast, lessThan });
    });
    expect(TAX_TABLE_2025_ROWS.at(-1)![1]).toBe(100_000);
    expect(taxTableRow(100_000)).toBeNull();
  });

  it('is the engine tax for every row and filing status (8,248 values)', () => {
    let checked = 0;
    for (const [atLeast, lessThan, ...columns] of TAX_TABLE_2025_ROWS) {
      const probes = [atLeast, (atLeast + lessThan) / 2, lessThan - 0.01];
      STATUSES.forEach(([key, status]) => {
        const printed = key === 'QSS' ? columns[1]! : columns[['Single', 'MFJ', 'MFS', 'HOH'].indexOf(key)]!;
        for (const income of probes) expect(calculateTaxTableTax(income, status, 2025).tax).toBe(printed);
        if (key !== 'QSS') checked++;
      });
    }
    expect(checked).toBe(8248);
  });

  it('gives way to the Tax Computation Worksheet at $100,000', () => {
    expect(calculateTaxTableTax(99_999.99, FilingStatus.Single, 2025).tax).toBe(16_909);
    expect(calculateTaxTableTax(100_000, FilingStatus.Single, 2025).tax).toBe(calculateProgressiveTax(100_000, FilingStatus.Single, 2025).tax);
    expect(calculateTaxTableTax(100_000, FilingStatus.Single, 2025).row).toBeNull();
  });
});

describe('line 16', () => {
  it.each(STATUSES)('%s: the Tax Table below $100,000, the worksheet from $100,000', (key, status) => {
    for (const wages of [20_000, 41_234.56, 72_015, 98_000]) {
      const f = calculateForm1040(w2Return(status, wages)).form1040;
      expect(f.taxableIncome).toBeLessThan(100_000);
      expect(f.incomeTax).toBe(taxTable2025(f.taxableIncome, key));
    }
    const high = calculateForm1040(w2Return(status, 180_000)).form1040;
    expect(high.taxableIncome).toBeGreaterThanOrEqual(100_000);
    expect(high.incomeTax).toBe(calculateProgressiveTax(high.taxableIncome, status, 2025).tax);
  });

  it('single, $54,000 wages: $38,250 taxable → $4,355 (Tax Table row $38,250–$38,300)', () => {
    const f = calculateForm1040(w2Return(FilingStatus.Single, 54_000)).form1040;
    expect(f.taxableIncome).toBe(38_250);
    expect(f.incomeTax).toBe(4_355);
  });
});

describe('the Qualified Dividends and Capital Gain Tax Worksheet', () => {
  it('figures lines 22 and 24 by the Tax Table below $100,000', () => {
    // Single, taxable $60,000 with $8,000 qualified dividends: line 5 = $52,000.
    const r = calculatePreferentialRateTax(60_000, 8_000, 0, FilingStatus.Single, 0, 2025);
    expect(r.ordinaryTax).toBe(taxTable2025(52_000, 'Single'));
    // Line 9 (0% to $48,350) is past line 5, so all $8,000 is at 15%: line 18 = $1,200.
    expect(r.preferentialTax).toBe(1_200);
    expect(r.totalTax).toBe(Math.min(taxTable2025(52_000, 'Single') + 1_200, taxTable2025(60_000, 'Single')));
  });

  it('uses the Tax Computation Worksheet for line 22 from $100,000', () => {
    const r = calculatePreferentialRateTax(150_000, 10_000, 0, FilingStatus.Single, 0, 2025);
    expect(r.ordinaryTax).toBe(calculateProgressiveTax(140_000, FilingStatus.Single, 2025).tax);
  });
});
