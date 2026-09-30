import { describe, expect, it } from 'vitest';
import { runReturnDiagnostics, DIAGNOSTIC_CATEGORIES, getReturnWarnings } from '../src/diagnostics/index.js';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { FilingStatus, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'test',
    taxYear: 2026,
    status: 'in_progress',
    currentStep: 0,
    currentSection: 'review',
    dependents: [],
    w2Income: [],
    income1099NEC: [],
    income1099K: [],
    income1099INT: [],
    income1099DIV: [],
    income1099R: [],
    income1099G: [],
    income1099MISC: [],
    income1099B: [],
    incomeK1: [],
    income1099SA: [],
    rentalProperties: [],
    otherIncome: 0,
    expenses: [],
    deductionMethod: 'standard',
    educationCredits: [],
    incomeDiscovery: {},
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const COMPLETE = {
  firstName: 'Maya',
  lastName: 'Testpayer',
  ssn: '000123456',
  filingStatus: FilingStatus.Single,
  addressStreet: '815 Magnolia Ave',
  addressCity: 'Baton Rouge',
  addressState: 'LA',
  addressZip: '70802',
  dateOfBirth: '1988-04-02',
} as Partial<TaxReturn>;

describe('runReturnDiagnostics', () => {
  it('blocks a return that is missing required identity information', () => {
    const d = runReturnDiagnostics(makeTaxReturn());
    const blocking = d.filter((x) => x.category === 'BLOCKING' && x.source === 'readiness');
    expect(blocking.map((x) => x.message)).toEqual(expect.arrayContaining(['First name is required.', 'Last name is required.']));
    expect(blocking.every((x) => x.section.length > 0)).toBe(true);
  });

  it('requires taxpayer, joint-spouse and dependent identification numbers', () => {
    const tr = makeTaxReturn({
      ...COMPLETE,
      ssn: '12345',
      filingStatus: FilingStatus.MarriedFilingJointly,
      spouseFirstName: 'Sam',
      spouseLastName: 'Testpayer',
      dependents: [{ id: 'd1', firstName: 'Jordan', lastName: 'Testpayer', relationship: 'son', monthsLivedWithYou: 12 }],
    });
    const messages = runReturnDiagnostics(tr).filter((x) => x.category === 'BLOCKING').map((x) => x.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Social Security number must be 9 digits.',
      'Spouse Social Security number is required for Married Filing Jointly.',
      'Jordan Testpayer: a 9-digit SSN, ITIN or ATIN is required to claim this dependent.',
    ]));
  });

  it('blocks a W-2 entered without its required wages', () => {
    const tr = makeTaxReturn({
      ...COMPLETE,
      w2Income: [{ id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 0, federalTaxWithheld: 0 } as TaxReturn['w2Income'][number]],
    });
    const d = runReturnDiagnostics(tr).find((x) => x.source === 'inventory');
    expect(d).toMatchObject({ category: 'BLOCKING', section: 'w2_income', itemLabel: expect.stringContaining('Riverbend') });
    expect(d!.message).toContain('Wages (Box 1)');
  });

  it('reports an engine filing-status rule the return breaks as an error', () => {
    const tr = makeTaxReturn({ ...COMPLETE, filingStatus: FilingStatus.HeadOfHousehold });
    const d = runReturnDiagnostics(tr, calculateForm1040(tr));
    expect(d.some((x) => x.category === 'ERROR' && x.source === 'filing_status' && x.field === 'filingStatus')).toBe(true);
  });

  it('orders findings by severity and gives each a stable id', () => {
    const tr = makeTaxReturn({ ...COMPLETE, filingStatus: FilingStatus.HeadOfHousehold, firstName: '' });
    const first = runReturnDiagnostics(tr, calculateForm1040(tr));
    const ranks = first.map((x) => DIAGNOSTIC_CATEGORIES.indexOf(x.category));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(runReturnDiagnostics(tr, calculateForm1040(tr)).map((x) => x.id)).toEqual(first.map((x) => x.id));
    expect(new Set(first.map((x) => x.id)).size).toBe(first.length);
  });
});

describe('return warnings use the return\'s own tax year', () => {
  const sale = (dateSold: string) => ({
    id: 'b1', brokerName: 'Broker', description: '10 sh XYZ', dateAcquired: '2020-01-02', dateSold, proceeds: 1000, costBasis: 800, isLongTerm: true,
  });

  it('does not flag a 2026 sale on a 2026 return (HATax\'s client copy was fixed at 2025)', () => {
    const w = getReturnWarnings(makeTaxReturn({ income1099B: [sale('2026-03-02')] }));
    expect(w.filter((x) => x.field.includes('dateSold'))).toEqual([]);
  });

  it('flags a sale from another year', () => {
    const w = getReturnWarnings(makeTaxReturn({ income1099B: [sale('2025-03-02')] }));
    expect(w.find((x) => x.field === 'income1099B[0].dateSold')?.message).toContain('tax year 2026');
  });
});

describe('what the engine cannot compute is BLOCKING (fail closed)', () => {
  it('blocks a state return the engine does not calculate to its rules', () => {
    const tr = makeTaxReturn({ taxYear: 2025, stateReturns: [{ stateCode: 'CA', residencyType: 'part_year', daysLivedInState: 100 }] } as Partial<TaxReturn>);
    const found = runReturnDiagnostics(tr, calculateForm1040(tr)).filter((d) => d.source === 'unsupported');
    expect(found).toEqual([expect.objectContaining({ id: 'unsupported:TAX-008:CA', category: 'BLOCKING', section: 'state_ca', message: expect.stringContaining('California part-year return') })]);
  });
});
