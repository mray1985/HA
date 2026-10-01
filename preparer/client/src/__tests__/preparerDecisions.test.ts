import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTaxTool, type DocumentToolName, type TaxToolSuccess } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn } from '../api/client';
import { loadAudit } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { completeDependent, correctFormField, recordChoice } from '../services/preparerDecisions';
import { appendTaxFacts, loadTaxFacts } from '../services/preparerTaxFacts';
import { recordPriorYearDependents } from '../services/recordTools';
import { applyToolResult, SOURCE_FORM_KEY } from '../services/returnApplier';

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

function readDocument(tool: DocumentToolName, args: Record<string, unknown>, documentId: string) {
  const result = invokeTaxTool({ tool, args, context: { returnId, taxYear: 2025, sourceDocumentId: documentId, sourceFileName: `${documentId}.pdf`, extractor: 'test' } });
  if (!result.ok) throw new Error(result.error);
  appendTaxFacts(returnId, (result as TaxToolSuccess).facts);
  return applyToolResult(returnId, result as TaxToolSuccess, { documentId });
}

const review = () => buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [] });

describe('preparer decisions from the review list', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('enters a 1099-Q once its qualified expenses are decided, and follows a changed answer', () => {
    readDocument('add_1099_q', { payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200, basisReturn: 6800, recipientNotDesignatedBeneficiary: true }, 'DOC-Q');
    expect(review().items.find((i) => i.id === 'document:qtp-expenses:DOC-Q#0')?.action).toEqual({ kind: 'choice', tool: 'add_1099_q', formKey: 'DOC-Q#0', missing: ['qualifiedExpenses'] });

    expect(recordChoice(returnId, 'DOC-Q#0', 'add_1099_q', { qualifiedExpenses: -5 })).toMatchObject({ ok: false });
    expect(recordChoice(returnId, 'DOC-Q#0', 'add_1099_q', { qualifiedExpenses: 5000 })).toMatchObject({ ok: true, outcome: { kind: 'decided' } });
    expect(getReturn(returnId).income1099Q).toEqual([expect.objectContaining({ qualifiedExpenses: 5000, distributionType: 'non_qualified', recipientType: 'accountOwner', [SOURCE_FORM_KEY]: 'DOC-Q#0' })]);
    expect(review().items.some((i) => i.id === 'document:qtp-expenses:DOC-Q#0')).toBe(false);

    recordChoice(returnId, 'DOC-Q#0', 'add_1099_q', { qualifiedExpenses: 9000 });
    expect(getReturn(returnId).income1099Q).toEqual([expect.objectContaining({ qualifiedExpenses: 9000, distributionType: 'qualified' })]);
    expect(loadTaxFacts(returnId).filter((f) => f.sourceField === 'qualifiedExpenses')).toHaveLength(1);
    expect(loadAudit(returnId).at(-1)).toMatchObject({ kind: 'decision', detail: 'qualifiedExpenses=9000' });
  });

  it('withdraws a home sale when the preparer says it was not the main home', () => {
    readDocument('add_1099_s', { filerName: 'MAGNOLIA TITLE', grossProceeds: 310000 }, 'DOC-S');
    recordChoice(returnId, 'DOC-S#0', 'add_1099_s', { mainHome: true, costBasis: 180000, ownedMonths: 60, usedAsResidenceMonths: 60, priorExclusionUsedWithin2Years: false });
    expect(getReturn(returnId).homeSale).toMatchObject({ salePrice: 310000, costBasis: 180000, [SOURCE_FORM_KEY]: 'DOC-S#0' });

    recordChoice(returnId, 'DOC-S#0', 'add_1099_s', { mainHome: false });
    expect(getReturn(returnId).homeSale).toBeUndefined();
    const item = review().items.find((i) => i.id === 'document:home-sale:DOC-S#0');
    expect(item?.message).toMatch(/Not the main home/);
    expect(item?.action).toBeUndefined();
  });

  it('applies a held 1099-B once the preparer gives its term and basis', () => {
    expect(readDocument('add_1099_b', { brokerName: 'SUMMIT BROKERAGE', proceeds: 12500 }, 'DOC-B')).toMatchObject({ kind: 'held' });
    const held = review().items.find((i) => i.id === 'document:held:DOC-B#0');
    expect(held?.action).toEqual({ kind: 'fix', tool: 'add_1099_b', formKey: 'DOC-B#0', fields: ['costBasis', 'isLongTerm'] });

    expect(correctFormField(returnId, 'DOC-B#0', 'isLongTerm', true)).toMatchObject({ ok: true, outcome: { kind: 'held' } });
    expect(correctFormField(returnId, 'DOC-B#0', 'costBasis', 9100.5)).toMatchObject({ ok: true, outcome: { kind: 'income_item' } });
    expect(getReturn(returnId).income1099B).toEqual([expect.objectContaining({ proceeds: 12500, costBasis: 9100.5, isLongTerm: true, [SOURCE_FORM_KEY]: 'DOC-B#0' })]);
    expect(review().items.some((i) => i.id === 'document:held:DOC-B#0')).toBe(false);
    expect(loadAudit(returnId).at(-1)).toMatchObject({ kind: 'correction', field: 'DOC-B.pdf costBasis', from: 'not read', to: 9100.5 });
  });

  it('completes a prior-year dependent with the months the preparer enters', () => {
    recordPriorYearDependents(returnId, [{ firstName: 'Maya', lastName: 'Lee', ssnLastFour: '4321', relationship: 'Daughter' }], 2024);
    expect(review().items.find((i) => i.group === 'dependents')?.action).toEqual({ kind: 'dependent', firstName: 'Maya', lastName: 'Lee', missing: ['monthsLivedWithYou'] });
    expect(completeDependent(returnId, { firstName: 'Maya', lastName: 'Lee' }, { monthsLivedWithYou: 12 })).toMatchObject({ ok: true, outcome: { kind: 'dependent', applied: true } });
    expect(getReturn(returnId).dependents).toEqual([expect.objectContaining({ firstName: 'Maya', monthsLivedWithYou: 12, relationship: 'Daughter' })]);
  });
});
