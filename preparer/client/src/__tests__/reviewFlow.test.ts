/**
 * The review flow's speed-ups: missing return fields filled in place, and the
 * case queue the dashboard and "Next case" share.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus, type TaxReturn } from '@hatax/engine';
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
