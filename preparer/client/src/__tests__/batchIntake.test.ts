/**
 * Batch intake for any clients (work order §12, §49): each file goes to the
 * case of the person it names, new clients get a new case, and a file that
 * names no one with confidence waits for the preparer.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyIdentity } from '@hatax/local-ai';
import type { TaxReturn } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { caseForIdentity, ingestBatch, placeUnmatched } from '../services/caseIntake';
import { loadDocuments } from '../services/documentIngestion';

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

describe('matching a form to a case', () => {
  const cases = [
    { id: 'maya', ssn: '000-12-3456', lastName: 'Testpayer', spouseSsn: '000987654', spouseLastName: 'Testpayer' },
    { id: 'lee', ssn: '111223456', lastName: 'Lee' },
  ] as unknown as TaxReturn[];

  it('matches a confirmed SSN, the taxpayer’s or the spouse’s', () => {
    expect(caseForIdentity({ formType: 'W-2', tin: { raw: '', confirmed: true, value: '000123456' } }, cases)?.id).toBe('maya');
    expect(caseForIdentity({ formType: 'W-2', tin: { raw: '', confirmed: true, value: '000987654' } }, cases)?.id).toBe('maya');
    // An SSN no second reader confirmed places nothing.
    expect(caseForIdentity({ formType: 'W-2', tin: { raw: '', confirmed: false, value: '000123456' } }, cases)).toBeNull();
  });

  it('matches a masked TIN only with the last name, and only when one case fits', () => {
    const int = (last: string): PartyIdentity => ({ formType: '1099-INT', tinLastFour: '3456', name: { raw: '', confirmed: true, value: { first: 'X', last } } });
    expect(caseForIdentity(int('Testpayer'), cases)?.id).toBe('maya');
    expect(caseForIdentity(int('Lee'), cases)?.id).toBe('lee');
    expect(caseForIdentity(int('Smith'), cases)).toBeNull();
    expect(caseForIdentity({ formType: '1099-INT', tinLastFour: '3456' }, cases)).toBeNull();
  });
});

describe('a batch for any clients', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no server'); }));
  });

  it("places a client's W-2 on their case, starts a case for a new client, and holds what names no one", async () => {
    const maya = createReturn(2025).id;
    updateReturn(maya, { ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer' });
    createReturn(2024);

    const result = await ingestBatch([pdf('w2-basic-single.pdf'), pdf('w2-indiana-local.pdf'), pdf('1099q-529.pdf')], 2025);
    expect(result.failures).toEqual([]);
    expect(result.placed).toEqual([
      { returnId: maya, name: 'Maya Testpayer', created: false, files: ['w2-basic-single.pdf'] },
      { returnId: expect.any(String), name: 'Jordan Testpayer', created: true, files: ['w2-indiana-local.pdf'] },
    ]);
    // The new client's case is the 2025 one, with the identity from the W-2.
    const jordan = getReturn(result.placed[1]!.returnId);
    expect(jordan).toMatchObject({ taxYear: 2025, ssn: '000456789', firstName: 'Jordan', lastName: 'Testpayer', addressCity: 'INDIANAPOLIS' });
    expect(jordan.w2Income).toEqual([expect.objectContaining({ employerName: 'CIRCLE CITY MACHINING INC', wages: 57500 })]);
    expect(getReturn(maya).w2Income).toEqual([expect.objectContaining({ employerName: 'RIVERBEND LOGISTICS LLC' })]);

    // The 1099-Q's recipient may be the student: it waits for the preparer.
    expect(result.unmatched.map((r) => r.file.name)).toEqual(['1099q-529.pdf']);
    const placed = await placeUnmatched(maya, result.unmatched[0]!);
    expect(placed).toEqual({ read: 1, skipped: 0, failures: [] });
    expect(loadDocuments(maya).map((d) => d.fileName)).toEqual(['w2-basic-single.pdf', '1099q-529.pdf']);

    // Dropping the same files again reads nothing twice.
    const again = await ingestBatch([pdf('w2-basic-single.pdf')], 2025);
    expect(again.placed).toEqual([{ returnId: maya, name: 'Maya Testpayer', created: false, files: [] }]);
    expect(listReturns().filter((r) => r.taxYear === 2025)).toHaveLength(2);
  });
});
