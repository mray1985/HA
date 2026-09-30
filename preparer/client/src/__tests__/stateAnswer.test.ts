import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { loadAudit } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { recordStateAnswer } from '../services/preparerDecisions';

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

let id = '';
const review = () => {
  const tr = getReturn(id);
  return buildCaseReview({ taxReturn: tr, calculation: calculateForm1040(tr), facts: [], documents: [] });
};
const waItems = () => review().items.filter((i) => i.id.startsWith('unsupported:TAX-003:'));

describe('the Washington capital gains tax asks the preparer what the return does not hold (TAX-003)', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    id = createReturn(2025).id;
    updateReturn(id, {
      firstName: 'Ana', lastName: 'Ruiz', filingStatus: FilingStatus.Single, addressState: 'WA',
      stateReturns: [{ stateCode: 'WA', residencyType: 'resident' }],
      income1099B: [
        { id: 's', brokerName: 'Broker', description: 'Stock', dateSold: '2025-06-01', proceeds: 410000, costBasis: 10000, isLongTerm: true, basisReportedToIRS: true },
        { id: 'c', brokerName: 'Dealer', description: 'Gold coins', dateSold: '2025-07-01', proceeds: 60000, costBasis: 10000, isLongTerm: true, isCollectible: true },
      ],
    } as never);
  });

  it('blocks the case with a question for each fact', () => {
    expect(waItems().map((i) => [i.id, i.category, i.action])).toEqual([
      ['unsupported:TAX-003:collectibles', 'BLOCKING', { kind: 'state_answer', question: expect.objectContaining({ stateCode: 'WA', key: 'waCollectiblesAllocated', kind: 'yes_no' }) }],
      ['unsupported:TAX-003:special-items', 'BLOCKING', { kind: 'state_answer', question: expect.objectContaining({ key: 'waSpecialItems', kind: 'yes_no' }) }],
    ]);
  });

  it('keeps the answers on the Washington return, audited, and then figures the tax', () => {
    expect(recordStateAnswer(id, { stateCode: 'WA', key: 'waCollectiblesAllocated', kind: 'yes_no', prompt: 'Allocated?' }, true)).toMatchObject({ ok: true });
    expect(recordStateAnswer(id, { stateCode: 'WA', key: 'waSpecialItems', kind: 'yes_no', prompt: 'Any apply?' }, false)).toMatchObject({ ok: true });
    expect(getReturn(id).stateReturns?.[0]?.stateSpecificData).toEqual({ waCollectiblesAllocated: true, waSpecialItems: false });
    expect(loadAudit(id).filter((e) => e.kind === 'correction').map((e) => e.kind === 'correction' && [e.field, e.from, e.to]))
      .toEqual([['WA: Allocated?', 'not answered', true], ['WA: Any apply?', 'not answered', false]]);
    expect(waItems()).toEqual([]);
    // The answers stay in the review, not blocking, and can be changed.
    expect(review().items.filter((i) => i.id.startsWith('state-answer:')).map((i) => [i.id, i.category, i.message, i.action])).toEqual([
      ['state-answer:WA:waCollectiblesAllocated', 'INFORMATIONAL', 'Washington: Is the long-term gain or loss on the collectibles allocated to Washington? Yes.',
        { kind: 'state_answer', question: expect.objectContaining({ key: 'waCollectiblesAllocated' }), current: true }],
      ['state-answer:WA:waSpecialItems', 'INFORMATIONAL', expect.stringMatching(/^Washington: Do any of these apply.*\? No\.$/),
        { kind: 'state_answer', question: expect.objectContaining({ key: 'waSpecialItems' }), current: false }],
    ]);
    // $400,000 + $50,000 = $450,000; − $278,000 = $172,000 × 7% = $12,040.
    expect(calculateForm1040(getReturn(id)).stateResults?.find((s) => s.stateCode === 'WA')).toMatchObject({ totalStateTax: 12040 });
  });

  it('refuses an answer of the wrong kind, or for a state not on the return', () => {
    expect(recordStateAnswer(id, { stateCode: 'WA', key: 'waSpecialItems', kind: 'yes_no', prompt: 'p' }, 'no')).toMatchObject({ ok: false });
    expect(recordStateAnswer(id, { stateCode: 'WA', key: 'waCarryoverLoss', kind: 'amount', prompt: 'p' }, -5)).toMatchObject({ ok: false });
    expect(recordStateAnswer(id, { stateCode: 'OR', key: 'x', kind: 'yes_no', prompt: 'p' }, true)).toMatchObject({ ok: false });
  });
});
