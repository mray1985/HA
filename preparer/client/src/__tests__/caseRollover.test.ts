/**
 * Starting this year's case from last year's (work order §14): identity
 * carried, dependents and filing status as evidence to confirm, carryovers
 * only from an approved case, and the refund account only when confirmed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { loadAudit, loadReviewRecord, saveReviewRecord } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview, returnFingerprint } from '../services/caseReview';
import { applyLastYearsAccount, carryoversFrom, nextYearToStart, startNextYear } from '../services/caseRollover';
import { loadTaxFacts } from '../services/preparerTaxFacts';

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

const FAMILY: Partial<TaxReturn> = {
  firstName: 'Maya', lastName: 'Lee', ssn: '123-45-6789', dateOfBirth: '1985-03-02', occupation: 'Nurse',
  spouseFirstName: 'Sam', spouseLastName: 'Lee', spouseSsn: '987-65-4321', spouseDateOfBirth: '1984-07-19',
  addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802',
  filingStatus: FilingStatus.MarriedFilingJointly,
  ipPin: '123456',
  dependents: [{ id: 'd1', firstName: 'Leo', lastName: 'Lee', ssn: '111-22-3333', dateOfBirth: '2016-05-01', relationship: 'son', monthsLivedWithYou: 12 }],
  stateReturns: [{ stateCode: 'LA', residencyType: 'resident' }],
  directDeposit: { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
  w2Income: [{ id: 'w', employerName: 'Ochsner Health', wages: 90000, federalTaxWithheld: 9000 }],
  // A $10,000 short-term loss: $3,000 deducted, $7,000 carried (Schedule D line 21, Capital Loss Carryover Worksheet).
  income1099B: [{ id: 'b', brokerName: 'Fidelity', description: '100 sh XYZ', dateAcquired: '2025-01-10', dateSold: '2025-06-10', proceeds: 5000, costBasis: 15000, isLongTerm: false }],
};

let prior = '';

function approve(id: string) {
  saveReviewRecord(id, { resolutions: {}, approval: { approvedAt: '2026-03-01T00:00:00.000Z', returnFingerprint: returnFingerprint(getReturn(id)) } });
}

describe('starting next year from last year’s case', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prior = createReturn(2025).id;
    updateReturn(prior, FAMILY);
  });

  it('offers the next supported year once, for a client with an identity', () => {
    expect(nextYearToStart(getReturn(prior))).toBe(2026);
    startNextYear(prior);
    expect(nextYearToStart(getReturn(prior))).toBeNull();
    const anonymous = createReturn(2025);
    expect(nextYearToStart(anonymous)).toBeNull();
    const latest = createReturn(2026);
    updateReturn(latest.id, { ssn: '555-44-3333' });
    expect(nextYearToStart(getReturn(latest.id))).toBeNull();
  });

  it('carries identity and address, never the IP PIN, amounts or documents', () => {
    const next = startNextYear(prior);
    expect(next).toMatchObject({
      taxYear: 2026, firstName: 'Maya', lastName: 'Lee', ssn: '123-45-6789', dateOfBirth: '1985-03-02', occupation: 'Nurse',
      spouseFirstName: 'Sam', spouseSsn: '987-65-4321', addressStreet: '815 Magnolia Ave', addressZip: '70802',
      priorYearSummary: { source: 'hatax-case', taxYear: 2025 },
    });
    expect(next.ipPin).toBeUndefined();
    expect(next.w2Income).toEqual([]);
    expect(next.income1099B).toEqual([]);
    expect(next.dependents).toEqual([]);
    // Filing status and refund account wait for the preparer.
    expect(next.filingStatus).toBeUndefined();
    expect(next.directDeposit).toBeUndefined();
    expect(listReturns().map((r) => r.taxYear).sort()).toEqual([2025, 2026]);
  });

  it('records dependents, filing status and residency as evidence to confirm', () => {
    const next = startNextYear(prior);
    const facts = loadTaxFacts(next.id);
    expect(facts.find((f) => f.factType === 'FILING_STATUS_CANDIDATE')).toMatchObject({ value: 'married_filing_jointly', sourceFileName: '2025 case' });
    const review = buildCaseReview({ taxReturn: getReturn(next.id), facts, documents: [], record: loadReviewRecord(next.id) });
    // Leo waits for this year's months at home; the filing status is one click.
    expect(review.items.find((i) => i.group === 'dependents' && i.action?.kind === 'dependent')).toMatchObject({ action: { firstName: 'Leo', missing: ['monthsLivedWithYou'] } });
    expect(review.items.find((i) => i.action?.kind === 'filing_status')).toMatchObject({ action: { status: FilingStatus.MarriedFilingJointly } });
    expect(getReturn(next.id).stateReturns).toEqual([expect.objectContaining({ stateCode: 'LA', residencyType: 'resident' })]);
    expect(review.items.find((i) => i.id === 'rollover:confirm:identity')).toMatchObject({ category: 'REVIEW', group: 'personal' });
  });

  it('carries no carryovers from a case that was not approved', () => {
    const next = startNextYear(prior);
    expect(next.capitalLossCarryforwardST).toBeUndefined();
    expect(next.priorYearTax).toBeUndefined();
    const review = buildCaseReview({ taxReturn: getReturn(next.id), facts: loadTaxFacts(next.id), documents: [], record: loadReviewRecord(next.id) });
    expect(review.items.find((i) => i.id === 'rollover:not-approved')).toMatchObject({ category: 'REVIEW' });
  });

  it('carries the capital loss and prior-year tax from an approved case', () => {
    approve(prior);
    const calc = calculateForm1040(getReturn(prior));
    expect(calc.scheduleD).toMatchObject({ capitalLossCarryforwardST: 7000, capitalLossCarryforwardLT: 0 });
    const next = startNextYear(prior);
    expect(next.capitalLossCarryforwardST).toBe(7000);
    expect(next.capitalLossCarryforwardLT).toBeUndefined();
    // Form 2210 line 8: tax after credits, with excess social security as a payment (none here).
    expect(next.priorYearTax).toBe(calc.form1040.taxAfterCredits);
    const review = buildCaseReview({ taxReturn: getReturn(next.id), facts: loadTaxFacts(next.id), documents: [], record: loadReviewRecord(next.id) });
    expect(review.items.find((i) => i.id === 'rollover:carried')?.message).toContain('capital loss carryover $7,000.00 short-term');
    expect(review.items.find((i) => i.id === 'rollover:not-approved')).toBeUndefined();
    expect(loadAudit(next.id).at(-1)).toMatchObject({ kind: 'decision', subject: 'Started from the 2025 case' });
  });

  it('lists a capital loss for the worksheet when taxable income was zero', () => {
    const calc = calculateForm1040({ ...getReturn(prior), w2Income: [] });
    const carry = carryoversFrom({ ...getReturn(prior), w2Income: [] }, calc);
    expect(carry.patch.capitalLossCarryforwardST).toBeUndefined();
    expect(carry.manual.map((m) => m.id)).toContain('capital-loss');
  });

  it("uses last year's refund account only when the preparer confirms it", () => {
    const next = startNextYear(prior);
    const review = () => buildCaseReview({ taxReturn: getReturn(next.id), facts: loadTaxFacts(next.id), documents: [], record: loadReviewRecord(next.id) });
    expect(review().items.find((i) => i.id === 'rollover:bank')).toMatchObject({ category: 'REVIEW', action: { kind: 'use_bank', label: 'checking account ending 6789' } });
    expect(applyLastYearsAccount(next.id)).toEqual({ ok: true });
    expect(getReturn(next.id).directDeposit).toEqual(FAMILY.directDeposit);
    expect(review().items.find((i) => i.id === 'rollover:bank')).toBeUndefined();
  });
});
