/**
 * Form 8615 in the interview: the step a young filer with unearned income
 * sees, and where a Form 8615 or kiddie tax finding sends them before export.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { checkExportReadiness } from '../services/exportReadiness';
import { useTaxReturnStore } from '../store/taxReturnStore';

function child(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'child', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Ava', lastName: 'Lee', ssn: '123456789', dateOfBirth: '2010-05-01',
    canBeClaimedAsDependent: true, addressStreet: '1 Elm St', addressCity: 'Springfield', addressState: 'IL', addressZip: '62701',
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [{ id: 'i', payerName: 'Bank', amount: 10000 }],
    income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [],
    income1099Q: [], rentalProperties: [], incomeK1: [], income1099SA: [], incomeW2G: [], businesses: [], otherIncome: 0,
    expenses: [], deductionMethod: 'standard', educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

/** As the app shows it: the step list from the return and its live calculation. */
const visible = (tr: TaxReturn) => {
  useTaxReturnStore.setState({ taxReturn: tr, calculation: calculateForm1040(tr) });
  return useTaxReturnStore.getState().getVisibleSteps().map((s) => s.id).includes('form_8615');
};

const PARENT = {
  applies: true, parentName: 'Sam Lee', parentSsn: '987654321', parentFilingStatus: FilingStatus.MarriedFilingJointly,
  parentTaxableIncome: 80000, parentTax: 9126, parentQualifiedDividends: 0, parentNetCapitalGain: 0,
  otherChildrenNetUnearnedIncome: 0, parentSpecialComputation: false,
};

describe('the Form 8615 step', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    });
  });

  it('appears whenever the engine has Form 8615 for the return, whatever the unearned income is', () => {
    expect(visible(child())).toBe(true);
    // Gambling winnings alone (W-2G): no list of income kinds decides it.
    expect(visible(child({ income1099INT: [], incomeW2G: [{ id: 'g', payerName: 'Casino', grossWinnings: 9000, federalTaxWithheld: 0 }] } as Partial<TaxReturn>))).toBe(true);
    expect(visible(child({ dateOfBirth: undefined }))).toBe(true);
    expect(visible(child({ dateOfBirth: undefined, canBeClaimedAsDependent: false }))).toBe(false);
    expect(visible(child({ dateOfBirth: '1990-01-01' }))).toBe(false);
    expect(visible(child({ filingStatus: FilingStatus.MarriedFilingJointly }))).toBe(false);
    expect(visible(child({ income1099INT: [] }))).toBe(false);
    expect(visible(child({ income1099INT: [{ id: 'i', payerName: 'Bank', amount: 2700 }] }))).toBe(false);
    // An answer already given keeps it in the interview.
    expect(visible(child({ dateOfBirth: '1990-01-01', form8615: { applies: false } }))).toBe(true);
  });

  it('holds export until it is answered, sending the filer to the step', () => {
    const asked = child();
    expect(checkExportReadiness(asked, calculateForm1040(asked)).blockers)
      .toContainEqual(expect.objectContaining({ stepId: 'form_8615', message: expect.stringContaining('Say whether Form 8615 applies') }));
    const missing = child({ form8615: { applies: true } });
    expect(checkExportReadiness(missing, calculateForm1040(missing)).blockers.filter((b) => b.stepId === 'form_8615')).toHaveLength(9);
    const done = child({ form8615: PARENT });
    const calc = calculateForm1040(done);
    expect(calc.form1040.incomeTax).toBe(1012);
    expect(checkExportReadiness(done, calc).blockers.filter((b) => b.stepId === 'form_8615')).toEqual([]);
  });

  it('sends a kiddie tax entry on a parent\'s return to the dependents step', () => {
    const parent = child({
      dateOfBirth: '1980-01-01', canBeClaimedAsDependent: false, income1099INT: [],
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 75000, federalTaxWithheld: 9000 }],
      kiddieTaxEntries: [{ id: 'k', childName: 'Ava', childUnearnedIncome: 8000, childAge: 14 }],
    });
    const calc = calculateForm1040(parent);
    expect(calc.form1040.kiddieTaxAmount).toBe(0);
    expect(checkExportReadiness(parent, calc).blockers).toContainEqual(expect.objectContaining({ stepId: 'dependents', message: expect.stringContaining('Form 8814') }));
  });
});
