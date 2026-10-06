import { describe, expect, it } from 'vitest';
import {
  assertImportedValuesHaveSource,
  createIngestedDocument,
  documentIdFromHash,
  factsHaveDocumentSource,
  findDocumentByHash,
  gapsWithPieceIndex,
  type DocumentBoxGap,
  MAX_INGEST_BYTES,
  screenDocument,
} from '../src/documentIngestion.js';
import { addW2, invokeTaxTool } from '../src/taxTools.js';
import type { TaxFact } from '../src/taxFact.js';

const HASH =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';

describe('document ingestion (work-order step 3)', () => {
  it('assigns a stable document ID from the content hash', () => {
    expect(documentIdFromHash(HASH)).toBe(`DOC-${HASH.slice(0, 32)}`);
    expect(documentIdFromHash(HASH.toUpperCase())).toBe(`DOC-${HASH.slice(0, 32)}`);
  });

  it('screens empty, oversized, and wrong-type files', () => {
    expect(screenDocument({ fileName: 'a.pdf', mimeType: 'application/pdf', byteLength: 0 }).ok).toBe(
      false,
    );
    expect(
      screenDocument({
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        byteLength: MAX_INGEST_BYTES + 1,
      }).ok,
    ).toBe(false);
    expect(
      screenDocument({ fileName: 'notes.txt', mimeType: 'text/plain', byteLength: 12 }).ok,
    ).toBe(false);
    expect(
      screenDocument({ fileName: 'notes.txt', mimeType: '', byteLength: 12 }).ok,
    ).toBe(false);
    expect(
      screenDocument({ fileName: 'w2.pdf', mimeType: 'application/pdf', byteLength: 1200 }).ok,
    ).toBe(true);
    expect(
      screenDocument({ fileName: 'scan.PNG', mimeType: '', byteLength: 800 }).ok,
    ).toBe(true);
    expect(
      screenDocument({ fileName: 'photo.jpg', mimeType: '', byteLength: 800 }).ok,
    ).toBe(true);
  });

  it('rejects content hashes that are not exactly 64 hex characters', () => {
    expect(() => documentIdFromHash('abcd')).toThrow(/64 hex/);
    expect(() => documentIdFromHash('0'.repeat(63))).toThrow(/64 hex/);
    expect(() => documentIdFromHash('0'.repeat(65))).toThrow(/64 hex/);
    expect(() =>
      createIngestedDocument({
        returnId: 'ret-1',
        meta: {
          fileName: 'w2.pdf',
          mimeType: 'application/pdf',
          byteLength: 10,
          contentHash: 'not-a-real-hash',
        },
      }),
    ).toThrow(/64 hex/);
  });

  it('detects duplicate documents by content hash', () => {
    const doc = createIngestedDocument({
      returnId: 'ret-1',
      meta: {
        fileName: 'w2.pdf',
        mimeType: 'application/pdf',
        byteLength: 2048,
        contentHash: HASH,
        ingestedAt: '2026-01-15T12:00:00.000Z',
      },
    });
    expect(doc.documentId).toBe(`DOC-${HASH.slice(0, 32)}`);
    expect(doc.status).toBe('registered');
    expect(findDocumentByHash([doc], HASH)?.documentId).toBe(doc.documentId);
    expect(findDocumentByHash([doc], '0'.repeat(64))).toBeUndefined();
  });

  it('keeps missing wages omitted and explicit zero through the tool path with document source', () => {
    const documentId = documentIdFromHash(HASH);
    const result = addW2(
      {
        employerName: 'Acme',
        wages: undefined,
        federalTaxWithheld: null,
        socialSecurityWages: 0,
      },
      {
        returnId: 'ret-1',
        taxYear: 2025,
        sourceDocumentId: documentId,
        sourceFileName: 'w2.pdf',
        extractor: 'local-pdf',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
    });
    expect(result.fields).not.toHaveProperty('wages');

    const wages = result.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('unknown');
    expect(wages && 'value' in wages).toBe(false);

    const ss = result.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    expect(ss?.sourceDocumentId).toBe(documentId);

    const check = assertImportedValuesHaveSource(result.facts, documentId);
    expect(check.ok).toBe(true);
    expect(factsHaveDocumentSource(result.facts.filter((f) => f.status === 'extracted'), documentId)).toBe(
      true,
    );
  });

  it('routes W-2 and listed 1099s through the tax-tool API with source on every imported value', () => {
    const documentId = documentIdFromHash(HASH);
    const ctx = {
      returnId: 'ret-1',
      taxYear: 2025,
      sourceDocumentId: documentId,
      sourceFileName: 'forms.pdf',
      extractor: 'local-pdf',
    };

    const cases: Array<{ tool: 'add_w2' | 'add_1099_int' | 'add_1099_div' | 'add_1099_nec' | 'add_1099_r'; args: Record<string, unknown> }> = [
      { tool: 'add_w2', args: { wages: 100, employerName: 'A' } },
      { tool: 'add_1099_int', args: { amount: 12.5, payerName: 'Bank' } },
      { tool: 'add_1099_div', args: { ordinaryDividends: 0, payerName: 'Broker' } },
      { tool: 'add_1099_nec', args: { amount: 500, payerName: 'Client' } },
      { tool: 'add_1099_r', args: { grossDistribution: 1000, qcdAmount: 0 } },
    ];

    for (const item of cases) {
      const result = invokeTaxTool({ tool: item.tool, args: item.args, context: ctx });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const extracted = result.facts.filter((f) => f.status === 'extracted');
      expect(extracted.length).toBeGreaterThan(0);
      expect(assertImportedValuesHaveSource(result.facts, documentId).ok).toBe(true);
      for (const fact of extracted) {
        expect(fact.sourceDocumentId).toBe(documentId);
        expect(fact.sourceFileName).toBe('forms.pdf');
        expect(fact.extractor).toBe('local-pdf');
      }
    }
  });

  it('rejects imported values that lack document provenance', () => {
    const bad: TaxFact = {
      factId: 'x',
      returnId: 'ret-1',
      taxYear: 2025,
      factType: 'W2_wages',
      status: 'extracted',
      value: 1,
      sourceDocumentId: 'OTHER',
      sourceFileName: 'w2.pdf',
      sourceField: 'wages',
      rawText: '1',
      confidence: null,
      extractor: 'local-pdf',
      verified: false,
    };
    expect(assertImportedValuesHaveSource([bad], documentIdFromHash(HASH)).ok).toBe(false);
  });
});

describe('gapsWithPieceIndex', () => {
  const gap = (formType: string | null, boxes: number): DocumentBoxGap => ({
    formType,
    declared: boxes ? 3 : 0,
    read: 0,
    boxes: Array.from({ length: boxes }, (_, i) => ({
      box: String(i + 1),
      label: `Box ${i + 1}`,
      state: 'unread' as const,
    })),
  });

  it('keeps a later form on its own piece when an earlier form has nothing outstanding', () => {
    // This is the defect this exists for. Piece 0 (the first form in the file) has
    // nothing outstanding and piece 1 does. Filtering first and numbering what is
    // left would call the second form piece 0, so a value typed into its box 7
    // would be recorded against the first form - the wrong employer, or the
    // wrong income item where both forms carry the field.
    const gaps = gapsWithPieceIndex([gap('W-2', 0), gap('1099-NEC', 1)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.piece).toBe(1);
    expect(gaps[0]!.gap.formType).toBe('1099-NEC');
  });

  it('numbers every gap by its own position, not by its place among the gaps', () => {
    const gaps = gapsWithPieceIndex([
      gap('W-2', 2),
      gap('1099-NEC', 0),
      gap('1099-INT', 1),
      gap('K-1', 3),
    ]);
    expect(gaps.map((g) => [g.gap.formType, g.piece])).toEqual([
      ['W-2', 0],
      ['1099-INT', 2],
      ['K-1', 3],
    ]);
  });

  it('treats a form with no outstanding boxes as no gap at all', () => {
    expect(gapsWithPieceIndex([gap('W-2', 0)])).toEqual([]);
    expect(gapsWithPieceIndex(undefined)).toEqual([]);
    expect(gapsWithPieceIndex([])).toEqual([]);
  });

  it('reports the piece index a fact would be filed under', () => {
    // The gap's piece index is what becomes the form key `document#piece`, and it
    // has to agree with the piece index on the facts the reader wrote.
    const result = invokeTaxTool({
      tool: 'add_w2',
      args: { employerName: 'SECOND EMPLOYER LLC', wages: 100 },
      context: { returnId: 'r', taxYear: 2025, sourceDocumentId: 'DOC-X', sourceFormIndex: 1, sourceFileName: 'two.pdf', extractor: 'test' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fact: TaxFact | undefined = result.facts[0];
    expect(fact?.sourceFormIndex).toBe(1);
    // So the second form in a two-form file is piece 1, which is what the gap
    // above must report.
    expect(gapsWithPieceIndex([gap('W-2', 0), gap('W-2', 1)])[0]!.piece).toBe(fact?.sourceFormIndex);
  });
});