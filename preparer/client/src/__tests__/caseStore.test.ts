import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { appendAudit, loadAudit, loadReviewRecord } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { flushCaseSave, useCaseStore } from '../store/caseStore';

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

describe('caseStore', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    id = createReturn().id;
    updateReturn(id, {
      firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456', filingStatus: FilingStatus.Single,
      addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802',
      w2Income: [{ id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 }],
    });
    useCaseStore.getState().openCase(id);
  });

  afterEach(() => useCaseStore.getState().closeCase());

  it('opens a case calculated and reviewed', () => {
    const s = useCaseStore.getState();
    expect(s.calculation?.form1040.totalWages).toBe(52431.18);
    expect(s.review?.status).toBe('ready');
  });

  it('recalculates, re-reviews, saves and audits a preparer correction', () => {
    const s = useCaseStore.getState();
    s.updateField('w2Income', [{ id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 60000, federalTaxWithheld: 5873.4 }]);
    const after = useCaseStore.getState();
    expect(after.calculation?.form1040.totalWages).toBe(60000);
    expect(after.audit.at(-1)).toMatchObject({ kind: 'correction', field: 'w2Income' });
    flushCaseSave();
    expect(getReturn(id).w2Income[0]!.wages).toBe(60000);

    s.updateField('ssn', '');
    expect(useCaseStore.getState().review?.status).toBe('needs_attention');
  });

  it('coalesces rapid edits to one field and keeps the value from before the first', () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    appendAudit(id, { kind: 'correction', field: 'addressZip', from: '70802', to: '7080' }, t0);
    appendAudit(id, { kind: 'correction', field: 'addressZip', from: '7080', to: '70803' }, new Date(t0.getTime() + 2000));
    appendAudit(id, { kind: 'correction', field: 'addressZip', from: '70803', to: '70804' }, new Date(t0.getTime() + 60_000));
    const zip = loadAudit(id).filter((e) => e.kind === 'correction' && e.field === 'addressZip');
    expect(zip).toHaveLength(2);
    expect(zip[0]).toMatchObject({ from: '70802', to: '70803' });
  });

  it('records review decisions and approval, and withdraws approval when the return changes', () => {
    const s = useCaseStore.getState();
    s.approve();
    expect(useCaseStore.getState().review?.status).toBe('approved');
    expect(loadReviewRecord(id).approval).toBeDefined();
    expect(useCaseStore.getState().audit.at(-1)).toMatchObject({ kind: 'approval' });

    s.updateField('addressZip', '70803');
    expect(useCaseStore.getState().review?.status).toBe('ready');
  });
});
