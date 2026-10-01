/**
 * The review flow's speed-ups: missing return fields filled in place, and the
 * case queue the dashboard and "Next case" share.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { clearReturnCache, createReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { caseQueue, nextCase } from '../services/caseQueue';
import { parseReturnField, returnFieldSpec } from '../services/returnFields';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

const PERSON = {
  firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456', filingStatus: FilingStatus.Single,
  addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802', dateOfBirth: '1988-04-02',
} as Partial<TaxReturn>;
const W2 = { id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 };

describe('return fields filled from the review list', () => {
  it('checks each value before it is written, and never writes a blank', () => {
    expect(parseReturnField('tin', '123-45-6789')).toEqual({ ok: true, value: '123456789' });
    expect(parseReturnField('tin', '12345678')).toMatchObject({ ok: false });
    expect(parseReturnField('zip', '70802')).toEqual({ ok: true, value: '70802' });
    expect(parseReturnField('zip', '708021234')).toEqual({ ok: true, value: '70802-1234' });
    expect(parseReturnField('zip', '7080')).toMatchObject({ ok: false });
    expect(parseReturnField('state', 'la')).toEqual({ ok: true, value: 'LA' });
    expect(parseReturnField('filing_status', String(FilingStatus.HeadOfHousehold))).toEqual({ ok: true, value: FilingStatus.HeadOfHousehold });
    expect(parseReturnField('filing_status', '9')).toMatchObject({ ok: false });
    expect(parseReturnField('text', '   ')).toMatchObject({ ok: false });
  });

  it("names a dependent's SSN field by the dependent", () => {
    const tr = { dependents: [{ firstName: 'Leo', lastName: 'Testpayer' }] } as unknown as TaxReturn;
    expect(returnFieldSpec('dependents.0.ssn', tr)).toEqual({ label: "Leo Testpayer's SSN, ITIN or ATIN", kind: 'tin' });
    expect(returnFieldSpec('w2Income.0.wages', tr)).toBeNull();
  });

  it('offers each missing personal field as an action on its review item', () => {
    const tr = {
      id: 'c', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review',
      dependents: [], w2Income: [W2], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [],
      income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
      rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [],
      incomeDiscovery: {}, createdAt: '', updatedAt: '',
    } as unknown as TaxReturn;
    const review = buildCaseReview({ taxReturn: tr, facts: [], documents: [] });
    const fields = review.items.flatMap((i) => (i.action?.kind === 'return_field' ? [i.action.field] : []));
    expect(fields).toEqual(expect.arrayContaining(['firstName', 'lastName', 'ssn', 'filingStatus', 'addressStreet', 'addressCity', 'addressState', 'addressZip']));
    expect(review.items.find((i) => i.action?.kind === 'return_field' && i.action.field === 'ssn')).toMatchObject({ category: 'BLOCKING', group: 'personal' });
  });
});

describe('the case queue', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('puts what needs the preparer first, and moves to the next case that does', () => {
    const waiting = createReturn(2026).id;
    const ready = createReturn(2026).id;
    updateReturn(ready, { ...PERSON, w2Income: [W2] });
    const attention = createReturn(2026).id;
    updateReturn(attention, { firstName: 'Leo', w2Income: [W2] });

    expect(caseQueue().map((r) => [r.id, r.status])).toEqual([
      [attention, 'needs_attention'],
      [ready, 'ready'],
      [waiting, 'waiting_for_documents'],
    ]);
    expect(caseQueue().find((r) => r.id === ready)).toMatchObject({ name: 'Maya Testpayer', refundAmount: expect.any(Number) });
    expect(nextCase(attention)?.id).toBe(ready);
    expect(nextCase(ready)?.id).toBe(attention);
    // A case waiting for documents is not the preparer's to work.
    updateReturn(attention, { ...PERSON });
    expect(nextCase(ready)?.id).toBe(attention);
    expect(nextCase(null)?.id).toBeDefined();
  });
});

describe('engine findings one field settles', () => {
  it('asks for the business miles from July 1, and the date a home was first used for business', () => {
    expect(parseReturnField('count', '4,000')).toEqual({ ok: true, value: 4000 });
    expect(parseReturnField('count', '12.5')).toMatchObject({ ok: false });
    expect(parseReturnField('date', '2025-07-01')).toEqual({ ok: true, value: '2025-07-01' });
    expect(parseReturnField('date', 'July 1')).toMatchObject({ ok: false });
    const tr = {
      id: 'c', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review', ...PERSON,
      dependents: [], w2Income: [], income1099NEC: [{ id: 'n', payerName: 'Client', amount: 60000 }], income1099K: [], income1099INT: [], income1099DIV: [],
      income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
      rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [], businesses: [],
      incomeDiscovery: {}, createdAt: '', updatedAt: '',
      vehicle: { method: 'standard_mileage', businessMiles: 10000 },
      homeOffice: { method: 'actual', squareFeet: 200, totalHomeSquareFeet: 1000, homeCostOrValue: 300000, landValue: 50000, insurance: 100 },
    } as unknown as TaxReturn;
    const fields = buildCaseReview({ taxReturn: tr, calculation: calculateForm1040(tr), facts: [], documents: [] }).items
      .flatMap((i) => (i.action?.kind === 'return_field' ? [i.action.field] : []));
    expect(fields).toEqual(expect.arrayContaining(['vehicle.businessMilesFromJuly1', 'homeOffice.dateFirstUsedForBusiness']));
  });

  it('asks a 2026 client who does not itemize for the cash given to public charities (IRC §170(p))', () => {
    expect(parseReturnField('amount', '$1,250.50')).toEqual({ ok: true, value: 1250.5 });
    expect(parseReturnField('amount', '0')).toEqual({ ok: true, value: 0 });
    expect(parseReturnField('amount', 'about 500')).toMatchObject({ ok: false });
    const tr = (o: Partial<TaxReturn>) => ({
      id: 'c', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review', ...PERSON,
      dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 60000, federalTaxWithheld: 6000 }], income1099NEC: [], income1099K: [],
      income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
      rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [], businesses: [],
      incomeDiscovery: {}, createdAt: '', updatedAt: '',
      itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 0, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0, mortgageInsurancePremiums: 0, charitableCash: 3000, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 },
      ...o,
    } as unknown as TaxReturn);
    const asked = (r: TaxReturn) => buildCaseReview({ taxReturn: r, calculation: calculateForm1040(r), facts: [], documents: [] }).items
      .find((i) => i.action?.kind === 'return_field' && i.action.field === 'nonItemizerCharitableCash');
    expect(asked(tr({}))).toMatchObject({ category: 'BLOCKING' });
    // Answered (0 included), itemizing, or 2025: not asked.
    expect(asked(tr({ nonItemizerCharitableCash: 0 }))).toBeUndefined();
    expect(asked(tr({ taxYear: 2025 }))).toBeUndefined();
    // A K-1 with unrecaptured section 1250 gain and no kind: the review list asks for the kind.
    const k1 = tr({ incomeK1: [{ id: 'k', entityName: 'Fund LP', longTermCapitalGain: 5000, unrecapturedSection1250Gain: 5000 } as never] });
    const kind = buildCaseReview({ taxReturn: k1, calculation: calculateForm1040(k1), facts: [], documents: [] }).items
      .find((i) => i.action?.kind === 'return_field' && i.action.field === 'incomeK1.0.entityType');
    expect(kind).toMatchObject({ category: 'BLOCKING' });
    expect(returnFieldSpec('incomeK1.0.entityType', k1)).toEqual({ label: 'Kind of K-1 (Fund LP)', kind: 'k1_entity' });
    expect(parseReturnField('k1_entity', 'trust')).toEqual({ ok: true, value: 'trust' });
    expect(parseReturnField('k1_entity', 'llc')).toMatchObject({ ok: false });
    expect(asked(tr({ deductionMethod: 'itemized', itemizedDeductions: { medicalExpenses: 0, stateLocalIncomeTax: 30000, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 0, mortgageInsurancePremiums: 0, charitableCash: 3000, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0 } }))).toBeUndefined();
  });
});
