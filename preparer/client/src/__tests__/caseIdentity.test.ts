/**
 * The taxpayer's identity from the case's documents (work order §12, §13):
 * empty fields filled from confirmed readings only, and everything else a
 * review item with its one-click answer.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxReturn } from '@hatax/engine';
import type { IngestedDocument, PartyIdentity } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { loadAudit } from '../services/caseAudit';
import { applyAddress, applyIdentityFromDocuments, applyIdentityReading, planIdentity, setPersonOnReturn } from '../services/caseIdentity';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { applyExtractionToDocument, loadDocuments, registerDroppedDocument } from '../services/documentIngestion';
import { extractFromPDF } from '../services/pdfImporter';

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

const HOME = { street: '815 MAGNOLIA AVE', city: 'BATON ROUGE', state: 'LA', zip: '70802' };

function w2(tin: string, first: string, last: string, opts: { confirmed?: boolean; address?: typeof HOME } = {}): PartyIdentity {
  const confirmed = opts.confirmed ?? true;
  return {
    formType: 'W-2',
    tin: { raw: tin, confirmed, value: tin.replace(/-/g, '') },
    ...(confirmed ? { tinLastFour: tin.slice(-4) } : {}),
    name: { raw: `${first} ${last}`.toUpperCase(), confirmed, value: { first, last } },
    address: { raw: 'addr', confirmed, value: opts.address ?? HOME },
  };
}

function doc(id: string, ...identities: Array<PartyIdentity | null>): IngestedDocument {
  return { documentId: id, returnId: 'c', fileName: `${id}.pdf`, mimeType: 'application/pdf', byteLength: 1, contentHash: id, ingestedAt: '', status: 'extracted', identities };
}

const empty = { dependents: [] } as unknown as TaxReturn;

describe('planning the identity', () => {
  it('keeps the confirmed last four of a masked TIN, so later masked forms find the case', () => {
    const masked: PartyIdentity = { formType: '1099-INT', tinLastFour: '3456', name: { raw: 'MAYA TESTPAYER', confirmed: true, value: { first: 'Maya', last: 'Testpayer' } } };
    const plan = planIdentity(empty, [doc('INT', masked)]);
    expect(plan.patch).toMatchObject({ ssnLastFour: '3456', firstName: 'Maya', lastName: 'Testpayer' });
    expect(plan.patch.ssn).toBeUndefined();
  });

  it("fills a new case's taxpayer from a confirmed W-2", () => {
    const plan = planIdentity(empty, [doc('W2', w2('000-12-3456', 'Maya', 'Testpayer'))]);
    expect(plan.patch).toEqual({ ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer', addressStreet: '815 MAGNOLIA AVE', addressCity: 'BATON ROUGE', addressState: 'LA', addressZip: '70802' });
    expect(plan.items).toEqual([]);
  });

  it('never replaces what is on the return, and flags a different last name for the SSN', () => {
    const tr = { ...empty, ssn: '000123456', firstName: 'Maya', lastName: 'Lee', addressStreet: '1 Oak St', addressCity: 'Austin', addressState: 'TX', addressZip: '78701' } as TaxReturn;
    const plan = planIdentity(tr, [doc('W2', w2('000-12-3456', 'Maya', 'Testpayer'))]);
    expect(plan.patch).toEqual({});
    expect(plan.items.map((i) => i.id)).toEqual(['identity:name:tin:000123456']);
    expect(plan.items[0]!.message).toContain('use the name on the client\'s Social Security card');
  });

  it('asks which of two people is the taxpayer, and enters the other as the spouse', () => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    const id = createReturn(2025).id;
    const docs = [doc('W2-A', w2('000-12-3456', 'Maya', 'Testpayer')), doc('W2-B', w2('000-98-7654', 'Sam', 'Testpayer'))];
    const plan = planIdentity(getReturn(id), docs);
    expect(plan.patch).toEqual({});
    expect(plan.items).toEqual([expect.objectContaining({ id: 'identity:choose-taxpayer', action: expect.objectContaining({ kind: 'identity_person', purpose: 'taxpayer' }) })]);

    expect(setPersonOnReturn(id, docs, 'tin:000987654', 'taxpayer')).toEqual({ ok: true });
    expect(getReturn(id)).toMatchObject({ ssn: '000987654', firstName: 'Sam', spouseSsn: '000123456', spouseFirstName: 'Maya', addressZip: '70802' });
    expect(planIdentity(getReturn(id), docs).items).toEqual([]);
    expect(loadAudit(id).at(-1)).toMatchObject({ kind: 'decision', subject: 'Taxpayer identity' });
  });

  it("flags a document for someone who is not on the return, and can enter them as the spouse", () => {
    const tr = { ...empty, ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer' } as TaxReturn;
    const docs = [doc('W2-A', w2('000-12-3456', 'Maya', 'Testpayer')), doc('W2-KID', w2('000-55-1111', 'Leo', 'Testpayer'))];
    const item = planIdentity(tr, docs).items.find((i) => i.id === 'identity:other:tin:000551111');
    expect(item).toMatchObject({ documentId: 'W2-KID', action: { kind: 'identity_person', purpose: 'spouse' } });
    expect(item!.message).toContain('W2-KID.pdf is for Leo Testpayer (SSN ending 1111), who is not the taxpayer on the return');
  });

  it("matches a 1099's masked TIN to the taxpayer by its last four digits", () => {
    const tr = { ...empty, ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer' } as TaxReturn;
    const int: PartyIdentity = { formType: '1099-INT', tinLastFour: '3456', name: { raw: 'MAYA TESTPAYER', confirmed: true, value: { first: 'Maya', last: 'Testpayer' } } };
    expect(planIdentity(tr, [doc('INT', int)]).items).toEqual([]);
    const other: PartyIdentity = { ...int, tinLastFour: '9999' };
    expect(planIdentity(tr, [doc('INT', other)]).items.map((i) => i.id)).toEqual(['identity:other:l4:9999:TESTPAYER']);
  });

  it('offers an unconfirmed reading for the preparer to check, never fills it', () => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    const id = createReturn(2025).id;
    const docs = [doc('SCAN', w2('000-12-3456', 'Maya', 'Testpayer', { confirmed: false }))];
    const plan = planIdentity(getReturn(id), docs);
    expect(plan.patch).toEqual({});
    expect(plan.items.map((i) => i.action?.kind === 'use_identity' ? i.action.part : null)).toEqual(['tin', 'name', 'address']);
    expect(applyIdentityReading(id, docs, 'SCAN', 0, 'tin', 'taxpayer')).toEqual({ ok: true });
    expect(getReturn(id).ssn).toBe('000123456');
    expect(planIdentity(getReturn(id), docs).items.map((i) => i.id)).toEqual(['identity:unconfirmed:SCAN#0:name', 'identity:unconfirmed:SCAN#0:address']);
  });

  it('asks which address to use when the documents disagree', () => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    const id = createReturn(2025).id;
    const docs = [doc('A', w2('000-12-3456', 'Maya', 'Testpayer')), doc('B', w2('000-12-3456', 'Maya', 'Testpayer', { address: { street: '9 ELM ST', city: 'AUSTIN', state: 'TX', zip: '78701' } }))];
    const plan = planIdentity(getReturn(id), docs);
    expect(plan.patch).toMatchObject({ ssn: '000123456', firstName: 'Maya' });
    expect(plan.patch.addressStreet).toBeUndefined();
    const choose = plan.items.find((i) => i.id === 'identity:addresses');
    expect(choose?.action).toMatchObject({ kind: 'choose_address' });
    const option = choose!.action!.kind === 'choose_address' ? choose!.action!.options[1]! : null;
    expect(applyAddress(id, docs, option!.key)).toEqual({ ok: true });
    expect(getReturn(id)).toMatchObject({ addressStreet: '9 ELM ST', addressState: 'TX' });
  });
});

describe('identity from a W-2 on a case', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fills the taxpayer from a digital W-2, and the review no longer asks for it', async () => {
    const id = createReturn(2025).id;
    const file = new File([readFileSync('e2e/fixtures/w2-basic-single.pdf')], 'w2.pdf', { type: 'application/pdf' });
    const { document } = await registerDroppedDocument({ returnId: id, file });
    applyExtractionToDocument({ returnId: id, taxYear: 2025, document, extracted: await extractFromPDF(file) });
    expect(applyIdentityFromDocuments(id, loadDocuments(id))).toEqual(['SSN (w2.pdf)', 'name (w2.pdf)', 'address (w2.pdf)']);
    expect(getReturn(id)).toMatchObject({ ssn: '000123456', firstName: 'Maya', lastName: 'Testpayer', addressStreet: '815 MAGNOLIA AVE', addressCity: 'BATON ROUGE', addressState: 'LA', addressZip: '70802' });
    const review = buildCaseReview({ taxReturn: getReturn(id), facts: [], documents: loadDocuments(id) });
    expect(review.items.map((i) => i.message)).not.toContain('First name is required.');
    expect(review.items.map((i) => i.message)).not.toContain('Social Security number is required.');
    // Nothing the preparer typed is ever replaced.
    updateReturn(id, { firstName: 'Maya-Lynn' });
    expect(applyIdentityFromDocuments(id, loadDocuments(id))).toEqual([]);
    expect(getReturn(id).firstName).toBe('Maya-Lynn');
  });
});
