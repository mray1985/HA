import { describe, expect, it } from 'vitest';
import type { IncomeK1, TaxReturn } from '@hatax/engine';
import { applyReviewedPacket, correlateTaxPacket, parsePacketAmount, type PacketBlock } from '../services/taxPacketCorrelation';

function page(lines: string[], documentId = 'base', page = 1): PacketBlock[] {
  return lines.map((text, i) => ({ documentId, fileName: `${documentId}.pdf`, page, text, x: 30, y: 20 + i * 20, width: 500, height: 10 }));
}
const header = ['Schedule K-1 (Form 1065) 2025', 'Entity EIN: 12-3456789', 'Recipient TIN: 000-00-0000', 'Tax year: 2025'];
const tr = { taxYear: 2025, ssn: '000000000', incomeK1: [] } as unknown as TaxReturn;
const entity: IncomeK1 = { id: 'entity', entityName: 'Synthetic Partnership', entityEin: '12-3456789', entityType: 'partnership', ordinaryBusinessIncome: 100 };

describe('positioned text correlation for K-1 / K-3 packets', () => {
  it('preserves negative amounts and distinguishes missing data from zero', () => {
    expect(parsePacketAmount('($1,250.50)')).toBe(-1250.5);
    expect(parsePacketAmount('0')).toBe(0);
    for (const value of ['', 'STMT', '20%', '1.234', 'unknown']) expect(parsePacketAmount(value)).toBeNull();
  });
  it('correlates a separately uploaded QBI statement with the sole issuer and year', () => {
    const r = correlateTaxPacket([...page(header), ...page(['Supplemental Statement', 'Box 20 Code Z', 'Qualified business income (loss): $1,500.00'], 'statement')]);
    const qbi = r.candidates.find(c => c.field === 'section199AQBI')!;
    expect(qbi).toMatchObject({ value: 1500, entityEin: '12-3456789', taxYear: 2025, code: 'Box 20, code Z', supported: true });
    expect(qbi.sources[0]).toMatchObject({ documentId: 'statement', page: 1, y: 60 });
    expect(applyReviewedPacket(tr, entity, r, [qbi.id], true).section199AQBI).toBe(1500);
  });
  it('deduplicates the same base and statement amount and replaces existing data idempotently', () => {
    const r = correlateTaxPacket([...page([...header, 'Ordinary business income (loss): $2,000']), ...page(['Supplemental Statement', 'Ordinary business income (loss): $2,000'], 'statement')]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].sources).toHaveLength(2);
    const applied = applyReviewedPacket(tr, entity, r, [r.candidates[0].id], true);
    expect(applied.ordinaryBusinessIncome).toBe(2000);
    expect(applyReviewedPacket(tr, applied, r, [r.candidates[0].id], true)).toEqual(applied);
  });
  it('does not choose or sum several K-3 columns', () => {
    const r = correlateTaxPacket(page(['Schedule K-3 (Form 1065) 2025', ...header.slice(1), 'Part II Foreign Tax Credit Limitation', 'Country code: CA', 'Passive category General category', 'Interest income: 100 200']));
    const item = r.candidates[0];
    expect(item.value).toBeNull(); expect(item.supported).toBe(false);
    expect(item.categories).toHaveLength(2); expect(item.country).toBe('CA');
    expect(item.sources[0].text).toContain('100 200');
    expect(() => applyReviewedPacket(tr, entity, r, [item.id], true)).toThrow('review only');
  });
  it('keeps K-3 foreign amounts out of K-1 income and out of its conflict set', () => {
    const r = correlateTaxPacket([...page([...header, 'Interest income: $200']), ...page(['Schedule K-3 (Form 1065) 2025', 'Interest income: $100'], 'foreign')]);
    const base = r.candidates.find(c => c.supported)!;
    expect(base.issues.some(i => i.startsWith('Conflicting'))).toBe(false);
    expect(applyReviewedPacket(tr, entity, r, [base.id], true).interestIncome).toBe(200);
    expect(r.candidates.find(c => !c.supported)?.value).toBe(100);
  });
  it('retains conflicting or separate activity values and blocks automatic application', () => {
    const r = correlateTaxPacket([...page([...header, 'Ordinary business income: 2000']), ...page(['Supplemental Statement', 'Ordinary business income: 500'], 'statement')]);
    expect(r.candidates).toHaveLength(2);
    expect(() => applyReviewedPacket(tr, entity, r, [r.candidates[0].id], true)).toThrow('conflicting');
  });
  it('never inherits an issuer when several issuers are in the group', () => {
    const r = correlateTaxPacket([...page(header), ...page(['Schedule K-1 2025', 'Entity EIN: 98-7654321'], 'second'), ...page(['Supplemental Statement', 'Qualified business income: 50'], 'unknown')]);
    expect(r.candidates[0].entityEin).toBeUndefined();
    expect(r.candidates[0].issues).toContain('Entity EIN needs review.');
    expect(r.warnings.join(' ')).toContain('Several entities');
  });
  it('rejects wrong years, entities, recipients, and unconfirmed application', () => {
    const r = correlateTaxPacket(page([...header, 'Ordinary business income: 2000']));
    const ids = [r.candidates[0].id];
    expect(() => applyReviewedPacket(tr, entity, r, ids, false)).toThrow('confirm');
    expect(() => applyReviewedPacket({ ...tr, taxYear: 2026 }, entity, r, ids, true)).toThrow('tax year');
    expect(() => applyReviewedPacket(tr, { ...entity, entityEin: '98-7654321' }, r, ids, true)).toThrow('entity EIN');
    expect(() => applyReviewedPacket({ ...tr, ssn: '999999999' }, entity, r, ids, true)).toThrow('recipient');
  });
  it('flags OCR and does not route unrelated document text into a K-1', () => {
    const r = correlateTaxPacket(page(['Interest income: $100']).map(b => ({ ...b, ocr: true })));
    expect(r.candidates[0].supported).toBe(false);
    expect(r.candidates[0].issues.join(' ')).toContain('OCR');
  });
  it('keeps unreadable pages in the page inventory', () => {
    const r = correlateTaxPacket(page(['']));
    expect(r.pages).toHaveLength(1); expect(r.pages[0].lines).toHaveLength(0);
    expect(r.warnings[0]).toContain('No text read');
  });
  it('does not mistake instructions, percentages, or QBI activity detail for extra taxable income', () => {
    const r = correlateTaxPacket([...page(header), ...page(['Section 199A Supplemental Statement', 'Qualified business income deduction up to 20%', 'Ordinary business income: 1000'], 'statement')]);
    expect(r.candidates.find(c => c.field === 'section199AQBI')?.value).toBeNull();
    expect(r.candidates.find(c => c.field === 'ordinaryBusinessIncome')?.supported).toBe(false);
  });
  it('rejects a source form whose entity type differs from the selected K-1', () => {
    const r = correlateTaxPacket(page([...header, 'Interest income: 100']));
    expect(() => applyReviewedPacket(tr, { ...entity, entityType: 's_corp' }, r, [r.candidates[0].id], true)).toThrow('form type');
  });
  it('preserves separate activities even when their amounts happen to match', () => {
    const r = correlateTaxPacket([...page(header), ...page(['Supplemental Statement', 'Business name: Shop A', 'Qualified business income: 1000', 'Business name: Shop B', 'Qualified business income: 1000'], 'activities')]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map(c => c.activity)).toEqual(['Shop A', 'Shop B']);
    expect(() => applyReviewedPacket(tr, entity, r, [r.candidates[0].id], true)).toThrow('separate activity');
  });
  it('does not mistake the K-3-attached checkbox text on a K-1 for a K-3 page', () => {
    const r = correlateTaxPacket(page([...header, 'Ordinary business income: 1000', 'Schedule K-3 is attached if checked']));
    expect(r.pages[0].kind).toBe('K-1'); expect(r.candidates[0].supported).toBe(true);
  });
});
