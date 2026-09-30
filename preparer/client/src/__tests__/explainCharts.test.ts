import { describe, expect, it } from 'vitest';
import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { amtWaterfall, creditItems, deductionsFlow, estimatedPayments, incomeItems, selfEmploymentFlow } from '../services/explainCharts';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'r', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [],
    income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
    rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

const W2 = { id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 } as TaxReturn['w2Income'][number];
const INT = { id: 'i1', payerName: 'First Harbor Bank', amount: 1284.66 } as TaxReturn['income1099INT'][number];

describe('explain chart data', () => {
  const tr = makeReturn({ w2Income: [W2], income1099INT: [INT] });
  const calc = calculateForm1040(tr);

  it('breaks income down by source as the engine counted it, each tied to its return section', () => {
    expect(incomeItems(calc)).toEqual([
      { label: 'W-2 wages', value: 52431.18, stepId: 'w2_income' },
      { label: 'Interest', value: 1284.66, stepId: '1099int_income' },
    ]);
  });

  it('follows income down to taxable income with the standard deduction', () => {
    const flow = deductionsFlow(tr, calc);
    expect(flow).toMatchObject({ isItemized: false, deductionLabel: 'Standard deduction', totalIncome: calc.form1040.totalIncome, agi: calc.form1040.agi });
    expect(flow.taxableIncome).toBe(calc.form1040.taxableIncome);
    expect(flow.deductions).toEqual([]);
  });

  it('shows no business, estimate or credit charts for a return without them', () => {
    expect(selfEmploymentFlow(calc)).toBeNull();
    expect(estimatedPayments(tr, calc)).toBeNull();
    expect(creditItems(calc)).toEqual([]);
  });

  it('shows Schedule C and quarterly estimates when the return has them', () => {
    const se = makeReturn({
      income1099NEC: [{ id: 'n1', payerName: 'Bayou Events Catering Inc', amount: 24000 } as TaxReturn['income1099NEC'][number]],
      expenses: [{ id: 'e1', scheduleCLine: 18, category: 'office', amount: 1200 }],
      estimatedQuarterlyPayments: [1000, 1000, 0, 0],
    });
    const seCalc = calculateForm1040(se);
    const business = selfEmploymentFlow(seCalc)!;
    expect(business.grossReceipts).toBe(24000);
    expect(business.expenses.some((e) => e.amount === 1200)).toBe(true);
    expect(estimatedPayments(se, seCalc)?.quarters).toEqual([1000, 1000, 0, 0]);
  });

  it('gives the AMT waterfall the engine\'s AMT figures', () => {
    const amt = amtWaterfall(calc);
    expect(amt === null || amt.taxableIncome === calc.amt!.line1_taxableIncome).toBe(true);
  });
});
