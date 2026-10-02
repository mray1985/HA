/**
 * Married couples whose documents started two cases (each spouse's W-2 names
 * only that spouse), a spouse from the client's words, and a business expense
 * the preparer gives its Schedule C line.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { ingestBatch } from '../services/caseIntake';
import { loadDocuments } from '../services/documentIngestion';
import { recordEvidence } from '../services/recordTools';
import { joinBlockers, joinSpouseCase, spouseCaseCandidates } from '../services/spouseCases';
import { appendAudit, loadAudit, saveReviewRecord } from '../services/caseAudit';
import { backgroundWorkRunning } from '../services/backgroundWork';
import { setActiveKey } from '../services/crypto';
import { loadDocumentFile, setDocumentFileStore, type DocumentFileStore, type StoredDocumentFile } from '../services/documentFiles';

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

const pdf = (name: string) => new File([readFileSync(`e2e/fixtures/${name}`)], name, { type: 'application/pdf' });

describe('a married couple with a case each', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no server'); }));
  });

  it('offers the other case of one household, and joins it as the spouse with its documents', async () => {
    // Maya's and Jordan's W-2s start a case each.
    const batch = await ingestBatch([pdf('w2-basic-single.pdf'), pdf('w2-indiana-local.pdf')], 2025);
    expect(batch.placed.map((p) => p.name)).toEqual(['Maya Testpayer', 'Jordan Testpayer']);
    const [maya, jordan] = batch.placed.map((p) => p.returnId) as [string, string];
    // Different addresses: not one household.
    expect(spouseCaseCandidates(maya)).toEqual([]);
    // They live together: one household, offered both ways.
    updateReturn(jordan, { addressStreet: getReturn(maya).addressStreet, addressCity: getReturn(maya).addressCity, addressZip: getReturn(maya).addressZip });
    expect(spouseCaseCandidates(maya)).toEqual([{ returnId: jordan, name: 'Jordan Testpayer', documents: 1, why: 'household' }]);
    expect(spouseCaseCandidates(jordan).map((c) => c.returnId)).toEqual([maya]);
    // Married filing separately is their choice: not offered.
    updateReturn(jordan, { filingStatus: FilingStatus.MarriedFilingSeparately });
    expect(spouseCaseCandidates(maya)).toEqual([]);
    updateReturn(jordan, { filingStatus: undefined });

    const joined = await joinSpouseCase(maya, jordan);
    expect(joined).toEqual({ ok: true, moved: ['w2-indiana-local.pdf'] });
    const joint = getReturn(maya);
    expect(joint).toMatchObject({ spouseFirstName: 'Jordan', spouseLastName: 'Testpayer', spouseSsn: '000456789' });
    // Both W-2s on the joint return, each the person's its form names.
    expect(joint.w2Income.map((w) => [w.employerName, Boolean(w.isSpouse)])).toEqual([
      ['RIVERBEND LOGISTICS LLC', false],
      ['CIRCLE CITY MACHINING INC', true],
    ]);
    expect(loadDocuments(maya).map((d) => d.fileName)).toEqual(['w2-basic-single.pdf', 'w2-indiana-local.pdf']);
    // Jordan's own case is gone.
    expect(listReturns().map((r) => r.id)).toEqual([maya]);
    expect(spouseCaseCandidates(maya)).toEqual([]);
  });

  it("places a spouse's W-2 on the joint case as the spouse's", async () => {
    const maya = createReturn(2025).id;
    updateReturn(maya, { ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer', spouseFirstName: 'Jordan', spouseLastName: 'Testpayer', spouseSsn: '000456789', filingStatus: FilingStatus.MarriedFilingJointly });
    await ingestBatch([pdf('w2-basic-single.pdf'), pdf('w2-indiana-local.pdf')], 2025);
    expect(getReturn(maya).w2Income.map((w) => Boolean(w.isSpouse))).toEqual([false, true]);
  });

  it("puts the spouse the client's words give on the return, never over another spouse", () => {
    const ben = createReturn(2025).id;
    updateReturn(ben, { firstName: 'Ben', lastName: 'Okafor', ssn: '000315501' });
    const source = { documentId: 'REPLY-1:note', index: 0, label: 'Client reply', kind: 'client_response' as const, extractor: 'test', verified: true };
    const r = recordEvidence(ben, 'set_spouse', { firstName: 'Cara', lastName: 'Okafor', ssn: '000-31-5502', dateOfBirth: '1988-07-19' }, source);
    expect(r.outcome).toEqual({ kind: 'spouse', applied: true });
    expect(getReturn(ben)).toMatchObject({ spouseFirstName: 'Cara', spouseLastName: 'Okafor', spouseSsn: '000315502', spouseDateOfBirth: '1988-07-19' });
    const other = recordEvidence(ben, 'set_spouse', { firstName: 'Dana', ssn: '000-99-9999' }, { ...source, documentId: 'REPLY-2:note' });
    expect(other.outcome).toEqual({ kind: 'spouse', applied: false, reason: 'The return already has a spouse with another SSN.' });
    expect(getReturn(ben).spouseFirstName).toBe('Cara');
  });

  it('enters a business expense only on the Schedule C line the preparer gives it', () => {
    const fay = createReturn(2025).id;
    const source = { documentId: 'REPLY-1:note', index: 0, label: 'Client reply', kind: 'client_response' as const, extractor: 'test', verified: true };
    const waiting = recordEvidence(fay, 'add_business_expense', { amount: 3200, description: 'software and equipment' }, source);
    expect(waiting.outcome).toEqual({ kind: 'held', reason: 'The expense waits for its Schedule C line and category.' });
    expect(getReturn(fay).expenses).toEqual([]);
    const entered = recordEvidence(fay, 'add_business_expense', { amount: 3200, description: 'software and equipment', scheduleCLine: 27, category: 'other' }, source);
    expect(entered.outcome).toMatchObject({ kind: 'income_item', itemType: 'expenses' });
    expect(getReturn(fay).expenses).toEqual([expect.objectContaining({ scheduleCLine: 27, category: 'other', amount: 3200, description: 'software and equipment' })]);
  });
});

function memoryStore(): DocumentFileStore & { entries: Map<string, StoredDocumentFile> } {
  const entries = new Map<string, StoredDocumentFile>();
  return {
    entries,
    put: async (key, value) => { entries.set(key, value); },
    get: async (key) => entries.get(key),
    deletePrefix: async (prefix) => { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k); },
  };
}

describe('joining a spouse case never loses work', () => {
  let files: ReturnType<typeof memoryStore>;

  beforeEach(async () => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no server'); }));
    files = memoryStore();
    setDocumentFileStore(files);
    setActiveKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  });
  afterEach(() => {
    setDocumentFileStore(null);
    setActiveKey(null);
  });

  /** Maya's and Jordan's W-2s start a case each; they live together. */
  async function couple() {
    const batch = await ingestBatch([pdf('w2-basic-single.pdf'), pdf('w2-indiana-local.pdf')], 2025);
    const [maya, jordan] = batch.placed.map((p) => p.returnId) as [string, string];
    updateReturn(jordan, { addressStreet: getReturn(maya).addressStreet, addressCity: getReturn(maya).addressCity, addressZip: getReturn(maya).addressZip });
    return { maya, jordan, jordanDoc: loadDocuments(jordan)[0]!.documentId };
  }

  it('moves the source file, the model runs and the audit trail, as background work', async () => {
    const { maya, jordan, jordanDoc } = await couple();
    expect(files.entries.has(`${jordan}/${jordanDoc}`)).toBe(true);
    // Correcting the person or the address is not lost: the person becomes the spouse, and the joint return keeps its address.
    appendAudit(jordan, { kind: 'correction', field: 'addressStreet', from: 'old', to: 'new' });
    const joining = joinSpouseCase(maya, jordan);
    expect(backgroundWorkRunning()).toBe(true);
    expect(await joining).toEqual({ ok: true, moved: ['w2-indiana-local.pdf'] });
    expect(backgroundWorkRunning()).toBe(false);
    expect(await (await loadDocumentFile(maya, jordanDoc))?.text()).toBe(await pdf('w2-indiana-local.pdf').text());
    expect(loadAudit(maya).some((e) => e.kind === 'correction' && e.field === 'addressStreet')).toBe(true);
    expect(loadAudit(maya).at(-1)).toMatchObject({ kind: 'decision', subject: 'Joint return' });
    expect(listReturns().map((r) => r.id)).toEqual([maya]);
  });

  it('refuses while the other case has work beyond its documents', async () => {
    const { maya, jordan } = await couple();
    recordEvidence(jordan, 'add_business_expense', { amount: 3200, description: 'software' },
      { documentId: 'REPLY-1:note', index: 0, label: 'Client reply', kind: 'client_response', extractor: 'test', verified: true });
    updateReturn(jordan, { income1099INT: [{ id: 'by-hand', payerName: 'Bank', amount: 40 }] as never });
    appendAudit(jordan, { kind: 'correction', field: 'otherIncome', from: 0, to: 500 });
    saveReviewRecord(jordan, { resolutions: { 'some-item': { decision: 'accepted', note: 'Checked.', resolvedAt: '2026-10-01T00:00:00Z' } } });

    const refused = await joinSpouseCase(maya, jordan);
    expect(refused.ok).toBe(false);
    const error = (refused as { error: string }).error;
    expect(error).toMatch(/^Jordan Testpayer's case has \d+ facts? from client replies or notes; 1 item entered by hand; 1 field edited by hand \(otherIncome\); 1 review decision, which joining would lose\./);
    expect(joinBlockers(jordan)).toHaveLength(4);
    // Nothing changed on either case.
    expect(listReturns()).toHaveLength(2);
    expect(getReturn(maya).spouseFirstName).toBeUndefined();
    expect(loadDocuments(maya)).toHaveLength(1);
    expect(loadDocuments(jordan)).toHaveLength(1);
  });

  it('changes neither case when a source file cannot be copied', async () => {
    const { maya, jordan, jordanDoc } = await couple();
    const put = files.put;
    files.put = async (key, value) => {
      if (key.startsWith(`${maya}/`)) throw new Error('storage full');
      return put(key, value);
    };
    const refused = await joinSpouseCase(maya, jordan);
    expect(refused).toEqual({ ok: false, error: 'The source file w2-indiana-local.pdf could not be copied, so the cases are not joined. Unlock HA Tax and try again.' });
    expect(listReturns()).toHaveLength(2);
    expect(getReturn(maya).spouseFirstName).toBeUndefined();
    expect(loadDocuments(maya)).toHaveLength(1);
    expect(files.entries.has(`${jordan}/${jordanDoc}`)).toBe(true);
    expect(files.entries.has(`${maya}/${jordanDoc}`)).toBe(false);
  });
});
