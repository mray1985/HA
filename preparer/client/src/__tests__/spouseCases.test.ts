/**
 * Married couples whose documents started two cases (each spouse's W-2 names
 * only that spouse), a spouse from the client's words, and a business expense
 * the preparer gives its Schedule C line.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { ingestBatch } from '../services/caseIntake';
import { loadDocuments } from '../services/documentIngestion';
import { recordEvidence } from '../services/recordTools';
import { joinSpouseCase, spouseCaseCandidates } from '../services/spouseCases';

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
