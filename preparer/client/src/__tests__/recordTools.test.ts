import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, calculateStateTaxes, FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { loadAudit } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { loadTaxFacts } from '../services/preparerTaxFacts';
import { recordEvidence, recordPriorYearDependents, runReturnChecks, type RecordSource } from '../services/recordTools';
import { SOURCE_FORM_KEY } from '../services/returnApplier';

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

let returnId = '';

const answer = (id: string): RecordSource => ({ documentId: id, label: `Client answer ${id}`, kind: 'client_response', extractor: 'preparer' });
const confirmation = (id: string): RecordSource => ({ documentId: id, label: `${id}.pdf`, kind: 'document', extractor: 'test' });
const review = () => buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [] });
const PRIOR = [
  { firstName: 'Maya', lastName: 'Lee', ssnLastFour: '4321', relationship: 'DAUGHTER' },
  { firstName: 'Sam', lastName: 'Lee', ssnLastFour: '8765', relationship: 'Child' },
];

describe('record tools on a case', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
    updateReturn(returnId, { filingStatus: FilingStatus.HeadOfHousehold, w2Income: [{ id: 'w', employerName: 'Acme', wages: 48000, federalTaxWithheld: 4000 }] });
  });

  it('never puts a prior-year dependent on the return with assumed months at home', () => {
    const results = recordPriorYearDependents(returnId, PRIOR, 2024);
    expect(results.map((r) => r.outcome)).toEqual([
      { kind: 'dependent', applied: false, reason: expect.stringMatching(/Maya Lee .*months lived with the taxpayer/) },
      { kind: 'dependent', applied: false, reason: expect.stringMatching(/Sam Lee .*relationship, months lived/) },
    ]);
    expect(getReturn(returnId).dependents).toEqual([]);
    // The printed "Child" is kept as the source text of an unknown relationship.
    const samRelationship = loadTaxFacts(returnId).find((f) => f.factType === 'DEPENDENT_relationship' && f.sourceFormIndex === 1);
    expect(samRelationship).toMatchObject({ status: 'unknown', rawText: 'Child' });

    const items = review().items.filter((i) => i.group === 'dependents' && i.source === 'document');
    expect(items.map((i) => i.category)).toEqual(['REVIEW', 'REVIEW']);
  });

  it("adds the dependent once the client's answer completes them, and never twice", () => {
    recordPriorYearDependents(returnId, PRIOR, 2024);
    const { outcome } = recordEvidence(returnId, 'add_dependent', { firstName: 'Maya', lastName: 'Lee', monthsLivedWithYou: 12, dateOfBirth: '2014-05-02' }, answer('A1'));
    expect(outcome).toMatchObject({ kind: 'dependent', applied: true });
    const [maya] = getReturn(returnId).dependents;
    expect(maya).toMatchObject({ firstName: 'Maya', lastName: 'Lee', ssnLastFour: '4321', relationship: 'Daughter', monthsLivedWithYou: 12, dateOfBirth: '2014-05-02', [SOURCE_FORM_KEY]: 'prior-year-return:2024#0' });

    // Importing the same prior-year return again, and repeating the answer, keep one Maya with the same id.
    recordPriorYearDependents(returnId, PRIOR, 2024);
    recordEvidence(returnId, 'add_dependent', { firstName: 'Maya', lastName: 'Lee', monthsLivedWithYou: 12, dateOfBirth: '2014-05-02' }, answer('A1'));
    expect(getReturn(returnId).dependents.map((d) => d.id)).toEqual([maya!.id]);
    expect(review().items.filter((i) => i.id.startsWith('record:dependent:')).map((i) => i.message)).toEqual([expect.stringMatching(/^Sam Lee/)]);
  });

  it('does not add a person the preparer already entered by hand', () => {
    updateReturn(returnId, { dependents: [{ id: 'hand', firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter', monthsLivedWithYou: 12 }] });
    const { outcome } = recordEvidence(returnId, 'add_dependent', { firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter', monthsLivedWithYou: 12 }, answer('A1'));
    expect(outcome).toMatchObject({ kind: 'dependent', applied: false, reason: expect.stringMatching(/already on the return, entered by hand/) });
    expect(getReturn(returnId).dependents.map((d) => d.id)).toEqual(['hand']);
  });

  it('writes federal estimated payments by installment and counts them in the return', () => {
    recordEvidence(returnId, 'add_estimated_payment', { jurisdiction: 'federal', amount: 600, datePaid: '2025-04-14' }, confirmation('Q1'));
    recordEvidence(returnId, 'add_estimated_payment', { jurisdiction: 'federal', amount: 600, datePaid: '2025-06-16' }, confirmation('Q2'));
    const { outcome } = recordEvidence(returnId, 'add_estimated_payment', { jurisdiction: 'federal', amount: 600, datePaid: '2025-06-16' }, confirmation('Q2'));
    expect(outcome).toMatchObject({ kind: 'aggregate', target: 'estimatedPayments', applied: true, forms: 2 });
    const tr = getReturn(returnId);
    expect(tr.estimatedQuarterlyPayments).toEqual([600, 600, 0, 0]);
    expect(calculateForm1040(tr).form1040.totalPayments).toBe(5200);
  });

  it('counts state payments once the state return exists, from residency evidence', () => {
    const early = recordEvidence(returnId, 'add_estimated_payment', { jurisdiction: 'CA', amount: 350, datePaid: '2025-04-15' }, confirmation('CA-1'));
    expect(early.outcome).toMatchObject({ applied: false, reason: expect.stringMatching(/no CA state return yet/) });
    expect(review().items.some((i) => i.id === 'record:state-payments:CA')).toBe(true);

    const residency = recordEvidence(returnId, 'set_state_residency', { stateCode: 'CA', residencyType: 'resident' }, answer('A2'));
    expect(residency.outcome).toMatchObject({ kind: 'aggregate', target: 'stateResidency', applied: true });
    const tr = getReturn(returnId);
    expect(tr.stateReturns).toEqual([{ stateCode: 'CA', residencyType: 'resident', estimatedPayments: 350, [SOURCE_FORM_KEY]: 'A2#0' }]);
    expect(calculateStateTaxes(tr, calculateForm1040(tr))[0]!.stateEstimatedPayments).toBe(350);
    expect(review().items.some((i) => i.id === 'record:state-payments:CA')).toBe(false);
  });

  it("keeps the preparer's residency entry and reports evidence that disagrees", () => {
    updateReturn(returnId, { stateReturns: [{ stateCode: 'NY', residencyType: 'resident' }] });
    const { outcome } = recordEvidence(returnId, 'set_state_residency', { stateCode: 'NY', residencyType: 'part_year', daysLivedInState: 120 }, answer('A3'));
    expect(outcome).toMatchObject({ applied: false, reason: expect.stringMatching(/entered by hand.*part-year/) });
    expect(getReturn(returnId).stateReturns).toEqual([{ stateCode: 'NY', residencyType: 'resident' }]);
    expect(review().items.find((i) => i.id === 'record:residency:NY')).toMatchObject({ category: 'REVIEW', group: 'state' });
  });

  it('puts receipts no 1099 reports on Schedule C line 1', () => {
    const { outcome } = recordEvidence(returnId, 'add_schedule_c_income', { description: 'Cash and check sales (ledger)', amount: 9400 }, confirmation('LEDGER'));
    expect(outcome).toMatchObject({ kind: 'income_item', itemType: 'business-receipts' });
    const tr = getReturn(returnId);
    expect(tr.businessReceipts).toEqual([expect.objectContaining({ description: 'Cash and check sales (ledger)', amount: 9400, [SOURCE_FORM_KEY]: 'LEDGER#0' })]);
    expect(calculateForm1040(tr).scheduleC?.grossReceipts).toBe(9400);
  });

  it('audits rejected calls and the return checks, and records nothing for a rejected call', () => {
    const { result, outcome } = recordEvidence(returnId, 'add_dependent', { firstName: 'Maya', monthsLivedWithYou: 14 }, answer('A4'));
    expect(result.ok).toBe(false);
    expect(outcome).toBeUndefined();
    expect(loadTaxFacts(returnId)).toEqual([]);

    const checks = runReturnChecks(returnId);
    expect(checks.summary).toMatch(/^AGI \$48,000\.00/);
    expect(loadAudit(returnId).map((e) => e.kind === 'tool' && `${e.tool}:${e.accepted}`)).toEqual(['add_dependent:false', 'calculate_return:true', 'run_diagnostics:true']);
  });
});
