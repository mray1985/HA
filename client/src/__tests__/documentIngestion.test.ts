/**
 * Client document-ingestion wiring: facts from extraction keep document source,
 * missing amounts stay omitted, explicit 0 stays 0, W-2/1099s use the tool API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentIdFromHash,
  type IngestedDocument,
} from '@hatax/engine';
import {
  applyExtractionToDocument,
  deleteAllDocuments,
  deleteDocuments,
  loadDocuments,
  registerDroppedDocument,
  saveDocuments,
} from '../services/documentIngestion';
import { loadTaxFacts, saveTaxFacts } from '../services/preparerTaxFacts';
import { DOCUMENT_KEY_PREFIX, documentStorageKey } from '../services/storageScope';
import type { PDFExtractResult, SupportedFormType } from '../services/pdfExtractHelpers';

const HASH =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const memory = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', memory);
}

function mockFile(name: string, bytes: number[], type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function baseDoc(overrides: Partial<IngestedDocument> = {}): IngestedDocument {
  return {
    documentId: documentIdFromHash(HASH),
    returnId: 'ret-1',
    fileName: 'w2.pdf',
    mimeType: 'application/pdf',
    byteLength: 32,
    contentHash: HASH,
    ingestedAt: '2026-01-15T12:00:00.000Z',
    status: 'registered',
    ...overrides,
  };
}

describe('documentIngestion client pipeline', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async (_algo: string, data: ArrayBuffer) => {
          const src = new Uint8Array(data);
          const out = new Uint8Array(32);
          for (let i = 0; i < 32; i++) {
            out[i] = src[i % Math.max(src.length, 1)] ^ ((i * 17 + src.length) & 0xff);
          }
          if (src.length === 8 && src[0] === 0xaa) {
            const known = HASH.match(/.{2}/g)!.map((h) => parseInt(h, 16));
            return new Uint8Array(known).buffer;
          }
          return out.buffer;
        },
      },
    });
  });

  it('registers a dropped PDF with hash-based document id and stores provenance', async () => {
    const file = mockFile('Acme-W2.pdf', [0xaa, 1, 2, 3, 4, 5, 6, 7], 'application/pdf');
    const result = await registerDroppedDocument({ returnId: 'ret-1', file });
    expect(result.rejected).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.document.documentId).toBe(documentIdFromHash(HASH));
    expect(result.document.contentHash).toBe(HASH);
    expect(loadDocuments('ret-1')).toHaveLength(1);
    expect(loadDocuments('ret-1')[0].fileName).toBe('Acme-W2.pdf');
  });

  it('rejects non-PDF/non-image files without storing them', async () => {
    const file = mockFile('notes.txt', [1, 2, 3], 'text/plain');
    const result = await registerDroppedDocument({ returnId: 'ret-1', file });
    expect(result.rejected).toBe(true);
    expect(loadDocuments('ret-1')).toHaveLength(0);
  });

  it('rejects empty MIME with unsupported extension', async () => {
    const file = mockFile('notes.txt', [1, 2, 3], '');
    const result = await registerDroppedDocument({ returnId: 'ret-1', file });
    expect(result.rejected).toBe(true);
    expect(loadDocuments('ret-1')).toHaveLength(0);
  });

  it('accepts empty MIME when extension is a supported image/PDF type', async () => {
    const file = mockFile('scan.PNG', [0xaa, 1, 2, 3, 4, 5, 6, 7], '');
    const result = await registerDroppedDocument({ returnId: 'ret-1', file });
    expect(result.rejected).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(loadDocuments('ret-1')).toHaveLength(1);
  });

  it('allows retry when prior record is only registered (incomplete)', async () => {
    const bytes = [0xaa, 1, 2, 3, 4, 5, 6, 7];
    const file = mockFile('w2.pdf', bytes, 'application/pdf');
    const first = await registerDroppedDocument({ returnId: 'ret-1', file });
    expect(first.duplicate).toBe(false);
    expect(first.document.status).toBe('registered');

    const again = await registerDroppedDocument({
      returnId: 'ret-1',
      file: mockFile('w2-retry.pdf', bytes, 'application/pdf'),
    });
    expect(again.duplicate).toBe(false);
    expect(again.rejected).toBe(false);
    expect(again.document.documentId).toBe(first.document.documentId);
    expect(again.document.status).toBe('registered');
    expect(loadDocuments('ret-1')).toHaveLength(1);
  });

  it('treats successful extracted duplicate as already ingested and keeps status', async () => {
    const bytes = [0xaa, 1, 2, 3, 4, 5, 6, 7];
    saveDocuments('ret-1', [
      baseDoc({
        status: 'extracted',
        extractor: 'local-pdf',
        formTypes: ['W-2'],
      }),
    ]);
    const again = await registerDroppedDocument({
      returnId: 'ret-1',
      file: mockFile('w2-copy.pdf', bytes, 'application/pdf'),
    });
    expect(again.duplicate).toBe(true);
    expect(again.document.status).toBe('extracted');
    expect(again.document.extractor).toBe('local-pdf');
    expect(loadDocuments('ret-1')).toHaveLength(1);
    expect(loadDocuments('ret-1')[0].status).toBe('extracted');
  });

  it('removes document metadata for one return and all current-app keys', () => {
    saveDocuments('ret-1', [baseDoc()]);
    saveDocuments('ret-2', [baseDoc({ returnId: 'ret-2', documentId: 'DOC-other' })]);
    // Other app's document key must survive wipe of the current app prefix.
    const otherAppKey = DOCUMENT_KEY_PREFIX.startsWith('hatax-preparer:')
      ? 'hatax:documents:other-1'
      : 'hatax-preparer:documents:other-1';
    localStorage.setItem(otherAppKey, JSON.stringify([baseDoc({ returnId: 'other-1' })]));

    deleteDocuments('ret-1');
    expect(localStorage.getItem(documentStorageKey('ret-1'))).toBeNull();
    expect(loadDocuments('ret-2')).toHaveLength(1);

    deleteAllDocuments();
    expect(localStorage.getItem(documentStorageKey('ret-2'))).toBeNull();
    // Only keys with the current app prefix are removed.
    const remaining: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) remaining.push(key);
    }
    expect(remaining.some((k) => k.startsWith(DOCUMENT_KEY_PREFIX))).toBe(false);
    expect(localStorage.getItem(otherAppKey)).not.toBeNull();
  });

  it('stores W-2 tool facts with source; omits missing wages; keeps explicit 0; stamps tax year', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: undefined,
        federalTaxWithheld: null,
        socialSecurityWages: 0,
        medicareWages: 41000,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 10,
      ocrUsed: false,
      ocrAvailable: false,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 10,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2024,
      document: baseDoc(),
      extracted,
    });

    expect(applied.provenanceError).toBeUndefined();
    expect(applied.pieces[0].toolError).toBeUndefined();
    expect(applied.pieces[0].toolFields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
      medicareWages: 41000,
    });
    expect(applied.pieces[0].toolFields).not.toHaveProperty('wages');
    expect(applied.pieces[0].incomeType).toBe('w2');

    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('unknown');

    const ss = applied.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    expect(ss?.sourceDocumentId).toBe(documentIdFromHash(HASH));
    expect(ss?.taxYear).toBe(2024);

    for (const fact of applied.facts.filter((f) => f.status === 'extracted')) {
      expect(fact.sourceDocumentId).toBe(documentIdFromHash(HASH));
      expect(fact.sourceFileName).toBe('w2.pdf');
      expect(fact.extractor.length).toBeGreaterThan(0);
      expect(fact.taxYear).toBe(2024);
    }

    expect(loadTaxFacts('ret-1').length).toBe(applied.facts.length);
    expect(loadDocuments('ret-1')[0].status).toBe('extracted');
  });

  it('does not write negative wages to toolFields while keeping a valid field on the same form', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: -500,
        federalTaxWithheld: 1200,
        socialSecurityWages: 50_000,
        socialSecurityTax: 3_100,
        medicareWages: 50_000,
        medicareTax: 725,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 10,
      ocrUsed: false,
      ocrAvailable: false,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 10,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc(),
      extracted,
    });

    expect(applied.pieces[0].validation.ready).toBe(false);
    expect(
      applied.pieces[0].validation.issues.some((i) => i.code === 'NEGATIVE_AMOUNT'),
    ).toBe(true);
    // Invalid wages are not applied to the return path; valid fields remain.
    expect(applied.pieces[0].toolFields).not.toHaveProperty('wages');
    expect(applied.pieces[0].toolFields.federalTaxWithheld).toBe(1200);
    expect(applied.pieces[0].toolFields.employerName).toBe('Acme');
    // Fact keeps the observed negative — not rewritten to zero or another value.
    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(-500);
  });

  it('keeps one document\'s valid wages ready when another document has negative wages', () => {
    saveTaxFacts('ret-1', []);
    const badDoc = baseDoc({ documentId: 'DOC-bad', fileName: 'bad-w2.pdf' });
    const goodDoc = baseDoc({ documentId: 'DOC-good', fileName: 'good-w2.pdf' });
    saveDocuments('ret-1', [badDoc, goodDoc]);

    const badExtracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { employerName: 'BadCo', wages: -100, federalTaxWithheld: 10 },
      incomeType: 'w2',
      payerName: 'BadCo',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: false,
      ocrAvailable: false,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'bad',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };
    const goodExtracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'GoodCo',
        wages: 40_000,
        federalTaxWithheld: 4_000,
        socialSecurityWages: 40_000,
        socialSecurityTax: 2_480,
        medicareWages: 40_000,
        medicareTax: 580,
      },
      incomeType: 'w2',
      payerName: 'GoodCo',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: false,
      ocrAvailable: false,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'good',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };

    const badApplied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: badDoc,
      extracted: badExtracted,
    });
    const goodApplied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: goodDoc,
      extracted: goodExtracted,
    });

    expect(badApplied.pieces[0].toolFields).not.toHaveProperty('wages');
    expect(badApplied.pieces[0].validation.ready).toBe(false);
    expect(goodApplied.pieces[0].toolFields.wages).toBe(40_000);
    expect(goodApplied.pieces[0].validation.ready).toBe(true);
  });

  it('flags negative grossWinnings on a generic classified form and omits them from toolFields', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc({ fileName: 'w2g.pdf' })]);
    const extracted: PDFExtractResult = {
      formType: 'W-2G',
      extractedData: {
        payerName: 'Casino',
        grossWinnings: -100,
        federalTaxWithheld: 25,
      },
      incomeType: 'w2g',
      payerName: 'Casino',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 6,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: `
        Form W-2G Certain Gambling Winnings
        Reportable winnings
        Federal income tax withheld
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2G',
          confidence: 'high',
          matchedKeywords: ['certain gambling winnings', 'reportable winnings'],
          reasoning: 'Matched W-2G markers',
        },
        fields: [],
        summary: 'w2g',
        textBlockCount: 6,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc({ fileName: 'w2g.pdf' }),
      extracted,
    });

    expect(applied.pieces[0].validation.ready).toBe(false);
    expect(applied.pieces[0].toolFields).not.toHaveProperty('grossWinnings');
    expect(applied.pieces[0].toolFields.federalTaxWithheld).toBe(25);
    expect(applied.facts.find((f) => f.sourceField === 'grossWinnings')?.value).toBe(-100);
  });

  it('normalizes printed W-2 money and keeps an unreadable box unknown', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        medicareWages: '12O.00',
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      ocrUsed: true,
      ocrAvailable: true,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc(),
      extracted,
    });

    expect(applied.pieces[0].toolError).toBeUndefined();
    expect(applied.pieces[0].toolFields).toEqual({
      employerName: 'Acme',
      wages: 61482.17,
      federalTaxWithheld: 0,
    });
    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(61482.17);
    expect(wages?.rawText).toBe('$61,482.17');
    const medicare = applied.facts.find((f) => f.sourceField === 'medicareWages');
    expect(medicare?.status).toBe('unknown');
    expect(medicare?.rawText).toBe('12O.00');
    expect(medicare && 'value' in medicare).toBe(false);
  });

  it('preserves extractor raw tokens after numeric coercion', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    // Real import path: extractBoxValue already coerced to numbers / undefined,
    // and fieldRawTokens carries the original OCR tokens.
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 61482.17,
        federalTaxWithheld: 0,
        medicareWages: undefined,
        socialSecurityWages: undefined,
      },
      fieldRawTokens: {
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        medicareWages: '12O.00',
      },
      fieldSourceLocations: {
        wages: { page: 1, box: { x: 417, y: 75, width: 50, height: 7 } },
        federalTaxWithheld: { page: 1, box: { x: 540, y: 75, width: 25, height: 7 } },
        medicareWages: { page: 1, box: { x: 418, y: 123, width: 34, height: 7 } },
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      ocrUsed: true,
      ocrAvailable: true,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'wages, tips'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc(),
      extracted,
    });

    expect(applied.pieces[0].toolFields).toEqual({
      employerName: 'Acme',
      wages: 61482.17,
      federalTaxWithheld: 0,
    });
    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.rawText).toBe('$61,482.17');
    expect(wages?.rawText).not.toBe('61482.17');
    expect(wages?.sourcePage).toBe(1);
    expect(wages?.sourceBox).toEqual({ x: 417, y: 75, width: 50, height: 7 });
    const withheld = applied.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.value).toBe(0);
    expect(withheld?.rawText).toBe('$0.00');
    expect(withheld?.sourcePage).toBe(1);
    expect(withheld?.sourceBox).toEqual({ x: 540, y: 75, width: 25, height: 7 });
    const medicare = applied.facts.find((f) => f.sourceField === 'medicareWages');
    expect(medicare?.status).toBe('unknown');
    expect(medicare?.rawText).toBe('12O.00');
    expect(medicare?.sourcePage).toBe(1);
    expect(medicare?.sourceBox).toEqual({ x: 418, y: 123, width: 34, height: 7 });
    const ss = applied.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('unknown');
    expect(ss?.sourcePage).toBeUndefined();
    expect(ss?.sourceBox).toBeUndefined();
  });

  it('routes listed 1099 income types through the tool API with provenance', () => {
    const cases: Array<{
      incomeType: string;
      formType: SupportedFormType;
      data: Record<string, unknown>;
    }> = [
      { incomeType: '1099int', formType: '1099-INT', data: { payerName: 'Bank', amount: 12 } },
      { incomeType: '1099div', formType: '1099-DIV', data: { payerName: 'Broker', ordinaryDividends: 0 } },
      { incomeType: '1099nec', formType: '1099-NEC', data: { payerName: 'Client', amount: 500 } },
      { incomeType: '1099r', formType: '1099-R', data: { grossDistribution: 1000, qcdAmount: 0 } },
    ];

    const markers: Record<string, string[]> = {
      '1099int': ['1099-int', 'interest income', 'payer', 'interest'],
      '1099div': ['1099-div', 'dividends and distributions', 'ordinary dividends', 'qualified dividends'],
      '1099nec': ['1099-nec', 'nonemployee compensation', 'payer', 'compensation'],
      '1099r': ['1099-r', 'distributions from pensions', 'gross distribution', 'taxable amount'],
    };

    for (const item of cases) {
      saveTaxFacts('ret-1', []);
      const extracted: PDFExtractResult = {
        formType: item.formType,
        extractedData: item.data,
        incomeType: item.incomeType,
        payerName: String(item.data.payerName ?? 'Payer'),
        confidence: 'high',
        warnings: [],
        errors: [],
        textBlockCount: 4,
        ocrUsed: false,
        ocrAvailable: false,
        trace: {
          formDetection: {
            detectedType: item.formType,
            confidence: 'high',
            matchedKeywords: markers[item.incomeType] ?? [],
            reasoning: `Matched ${item.formType} markers`,
          },
          fields: [],
          summary: 'test',
          textBlockCount: 4,
          pagesScanned: 1,
        },
      };
      const applied = applyExtractionToDocument({
        returnId: 'ret-1',
        taxYear: 2026,
        document: baseDoc({ fileName: `${item.incomeType}.pdf` }),
        extracted,
      });
      expect(applied.pieces[0].toolError).toBeUndefined();
      expect(applied.pieces[0].incomeType).toBe(item.incomeType);
      const extractedFacts = applied.facts.filter((f) => f.status === 'extracted');
      expect(extractedFacts.length).toBeGreaterThan(0);
      for (const fact of extractedFacts) {
        expect(fact.sourceDocumentId).toBe(documentIdFromHash(HASH));
        expect(fact.taxYear).toBe(2026);
      }
    }
  });

  it('leaves unrecognized extracts unclassified and does not create income facts', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const extracted: PDFExtractResult = {
      formType: null,
      extractedData: { wages: 50000 },
      incomeType: null,
      payerName: '',
      confidence: 'low',
      warnings: [],
      errors: ['Could not determine the form type.'],
      textBlockCount: 2,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: 'Meeting notes. Bring snacks. No tax form here.',
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc(),
      extracted,
    });

    expect(applied.unclassified).toBe(true);
    expect(applied.facts).toEqual([]);
    expect(applied.pieces[0].toolFields).toEqual({});
    expect(applied.document.status).toBe('unclassified');
    expect(applied.document.classification?.status).toBe('unclassified');
    expect(applied.classification?.reason).toMatch(/No primary form markers/i);
    expect(loadTaxFacts('ret-1')).toEqual([]);
  });

  it('does not classify from a bare formType label without markers', () => {
    saveTaxFacts('ret-1', []);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { wages: 100 },
      incomeType: 'w2',
      payerName: 'Guess',
      confidence: 'medium',
      warnings: [],
      errors: [],
      textBlockCount: 1,
      ocrUsed: false,
      ocrAvailable: false,
      // No rawOCRText and no matchedKeywords — bare label is not enough.
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc(),
      extracted,
    });

    expect(applied.unclassified).toBe(true);
    expect(applied.facts).toEqual([]);
    expect(loadTaxFacts('ret-1')).toEqual([]);
    expect(applied.document.status).toBe('unclassified');
  });

  it('caps stored classification confidence when OCR confidence is low', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 50000,
        socialSecurityWages: 50000,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      // OCR path explicitly caps extract confidence at low.
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: true,
      ocrAvailable: true,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'OCR matched W-2 markers',
        },
        fields: [],
        summary: 'ocr',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc(),
      extracted,
    });

    expect(applied.unclassified).toBeUndefined();
    expect(applied.pieces[0].classification.status).toBe('classified');
    expect(applied.pieces[0].classification.confidence).toBe('low');
    expect(applied.document.classification?.confidence).toBe('low');
    expect(applied.document.classifications?.[0]?.confidence).toBe('low');
    expect(applied.facts.some((f) => f.status === 'extracted')).toBe(true);
    expect(applied.document.extractor).toBe('local-ocr');
  });

  it('does not create income when OCR text is empty or unreadable', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc({ fileName: 'blank-scan.png' })]);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { wages: 99999 },
      incomeType: 'w2',
      payerName: 'Ghost',
      confidence: 'low',
      warnings: [],
      errors: ['OCR could not extract any text from this image.'],
      textBlockCount: 0,
      ocrUsed: true,
      ocrAvailable: true,
      rawOCRText: '   ',
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement'],
          reasoning: 'stale label must not invent income',
        },
        fields: [],
        summary: 'empty ocr',
        textBlockCount: 0,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'blank-scan.png' }),
      extracted,
    });

    expect(applied.unclassified).toBe(true);
    expect(applied.facts).toEqual([]);
    expect(applied.pieces[0].toolFields).toEqual({});
    expect(applied.document.status).toBe('unclassified');
    expect(loadTaxFacts('ret-1')).toEqual([]);
  });

  it('OCR path keeps explicit 0 and omits missing boxes', () => {
    saveTaxFacts('ret-1', []);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: undefined,
        federalTaxWithheld: null,
        socialSecurityWages: 0,
        medicareWages: 41000,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: true,
      ocrAvailable: true,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'OCR W-2',
        },
        fields: [],
        summary: 'ocr zeros',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'scan-w2.png' }),
      extracted,
    });

    expect(applied.pieces[0].classification.confidence).toBe('low');
    expect(applied.pieces[0].toolFields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
      medicareWages: 41000,
    });
    expect(applied.pieces[0].toolFields).not.toHaveProperty('wages');
    const ss = applied.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    expect(ss?.extractor).toBe('local-ocr');
    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('unknown');
  });

  it('keeps high classification confidence for a digital PDF with strong markers', () => {
    saveTaxFacts('ret-1', []);
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { employerName: 'Acme', wages: 41000 },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 10,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'digital',
        textBlockCount: 10,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc(),
      extracted,
    });

    expect(applied.pieces[0].classification.confidence).toBe('high');
    expect(applied.document.classification?.confidence).toBe('high');
  });

  it('persists classification reason and markers for every piece in a multi-form file', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc({ fileName: 'packet.pdf' })]);

    const w2Piece: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 50000,
        socialSecurityWages: 0,
        medicareWages: 50000,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'w2',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };

    const intPiece: PDFExtractResult = {
      formType: '1099-INT',
      extractedData: { payerName: 'Bank', amount: 12 },
      incomeType: '1099int',
      payerName: 'Bank',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: 'Form 1099-INT Interest Income Payer name Interest income Early withdrawal penalty',
      trace: {
        formDetection: {
          detectedType: '1099-INT',
          confidence: 'high',
          matchedKeywords: ['1099-int', 'interest income', 'payer', 'interest'],
          reasoning: 'Matched 1099-INT markers',
        },
        fields: [],
        summary: 'int',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const extracted: PDFExtractResult = {
      ...w2Piece,
      additionalResults: [intPiece],
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'packet.pdf' }),
      extracted,
    });

    expect(applied.pieces).toHaveLength(2);
    expect(applied.pieces[0].classification.status).toBe('classified');
    expect(applied.pieces[0].classification.formType).toBe('W-2');
    expect(applied.pieces[0].classification.reason).toMatch(/W-2/);
    expect(applied.pieces[0].classification.matchedMarkers.some((m) => /w-2|wage and tax/i.test(m))).toBe(true);

    expect(applied.pieces[1].classification.status).toBe('classified');
    expect(applied.pieces[1].classification.formType).toBe('1099-INT');
    expect(applied.pieces[1].classification.reason).toMatch(/1099-INT/);
    expect(applied.pieces[1].classification.matchedMarkers.some((m) => /1099-int|interest/i.test(m))).toBe(true);

    // Stored provenance keeps every piece — not only the first / primary.
    const stored = loadDocuments('ret-1')[0];
    expect(stored.classifications).toHaveLength(2);
    expect(stored.classifications?.[0]?.formType).toBe('W-2');
    expect(stored.classifications?.[0]?.reason).toMatch(/W-2/);
    expect(stored.classifications?.[0]?.matchedMarkers.length).toBeGreaterThan(0);
    expect(stored.classifications?.[1]?.formType).toBe('1099-INT');
    expect(stored.classifications?.[1]?.reason).toMatch(/1099-INT/);
    expect(stored.classifications?.[1]?.matchedMarkers.length).toBeGreaterThan(0);
    // Summary field remains the first classified piece.
    expect(stored.classification?.formType).toBe('W-2');

    // Explicit 0 from the W-2 piece is preserved; both pieces wrote income.
    const ss = applied.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    expect(applied.facts.filter((f) => f.status === 'extracted').length).toBeGreaterThan(1);
  });

  it('multi-form OCR keeps secondary classification and income when the piece has OCR text', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc({ fileName: 'scan-packet.pdf' })]);

    const w2Piece: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 50000,
        socialSecurityWages: 0,
        medicareWages: 50000,
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 8,
      ocrUsed: true,
      ocrAvailable: true,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'OCR matched W-2 markers',
        },
        fields: [],
        summary: 'ocr w2',
        textBlockCount: 8,
        pagesScanned: 1,
      },
    };

    const intPiece: PDFExtractResult = {
      formType: '1099-INT',
      extractedData: { payerName: 'Bank', amount: 12 },
      incomeType: '1099int',
      payerName: 'Bank',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      ocrUsed: true,
      ocrAvailable: true,
      // Per-piece OCR text must be present (or missing text must not wipe markers).
      rawOCRText: 'Form 1099-INT Interest Income Payer name Interest income Early withdrawal penalty',
      trace: {
        formDetection: {
          detectedType: '1099-INT',
          confidence: 'low',
          matchedKeywords: ['1099-int', 'interest income', 'payer', 'interest'],
          reasoning: 'OCR matched 1099-INT markers',
        },
        fields: [],
        summary: 'ocr int',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'scan-packet.pdf' }),
      extracted: { ...w2Piece, additionalResults: [intPiece] },
    });

    expect(applied.unclassified).toBeUndefined();
    expect(applied.pieces).toHaveLength(2);
    expect(applied.pieces[0].classification.status).toBe('classified');
    expect(applied.pieces[0].classification.formType).toBe('W-2');
    expect(applied.pieces[0].classification.confidence).toBe('low');
    expect(applied.pieces[0].classification.matchedMarkers.length).toBeGreaterThan(0);

    expect(applied.pieces[1].classification.status).toBe('classified');
    expect(applied.pieces[1].classification.formType).toBe('1099-INT');
    expect(applied.pieces[1].classification.confidence).toBe('low');
    expect(applied.pieces[1].classification.matchedMarkers.some((m) => /1099-int|interest/i.test(m))).toBe(true);
    expect(applied.pieces[1].facts.some((f) => f.status === 'extracted')).toBe(true);

    const stored = loadDocuments('ret-1')[0];
    expect(stored.classifications).toHaveLength(2);
    expect(stored.classifications?.[1]?.formType).toBe('1099-INT');
    expect(stored.classifications?.[1]?.matchedMarkers.length).toBeGreaterThan(0);
    expect(stored.extractor).toBe('local-ocr');
    expect(applied.facts.filter((f) => f.status === 'extracted').length).toBeGreaterThan(1);
  });

  it('multi-form OCR still classifies a secondary piece when rawOCRText was omitted', () => {
    // Regression for the producer bug: additionalResults set ocrUsed without rawOCRText.
    saveTaxFacts('ret-1', []);
    const w2Piece: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { employerName: 'Acme', wages: 41000, socialSecurityWages: 0 },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 6,
      ocrUsed: true,
      ocrAvailable: true,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'low',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'OCR W-2',
        },
        fields: [],
        summary: 'ocr w2',
        textBlockCount: 6,
        pagesScanned: 1,
      },
    };
    const intPieceMissingText: PDFExtractResult = {
      formType: '1099-INT',
      extractedData: { payerName: 'Bank', amount: 12 },
      incomeType: '1099int',
      payerName: 'Bank',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      ocrUsed: true,
      ocrAvailable: true,
      // Intentionally omit rawOCRText — markers must survive.
      trace: {
        formDetection: {
          detectedType: '1099-INT',
          confidence: 'low',
          matchedKeywords: ['1099-int', 'interest income', 'payer', 'interest'],
          reasoning: 'OCR 1099-INT',
        },
        fields: [],
        summary: 'ocr int missing text',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'scan-multi.pdf' }),
      extracted: { ...w2Piece, additionalResults: [intPieceMissingText] },
    });

    expect(applied.pieces[1].classification.status).toBe('classified');
    expect(applied.pieces[1].classification.formType).toBe('1099-INT');
    expect(applied.pieces[1].classification.matchedMarkers.length).toBeGreaterThan(0);
    expect(applied.pieces[1].facts.some((f) => f.status === 'extracted')).toBe(true);
  });

  it('skips unclassified pieces in a multi-form file without inventing income for them', () => {
    saveTaxFacts('ret-1', []);
    const classified: PDFExtractResult = {
      formType: 'W-2',
      extractedData: { employerName: 'Acme', wages: 100 },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 6,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: `
        Form W-2 Wage and Tax Statement
        Employer Wages Federal income tax withheld Social security
      `,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
          reasoning: 'Matched W-2',
        },
        fields: [],
        summary: 'w2',
        textBlockCount: 6,
        pagesScanned: 1,
      },
    };
    const junk: PDFExtractResult = {
      formType: null,
      extractedData: { amount: 999 },
      incomeType: null,
      payerName: '',
      confidence: 'low',
      warnings: [],
      errors: [],
      textBlockCount: 1,
      ocrUsed: false,
      ocrAvailable: false,
      rawOCRText: 'Cover letter. Please find enclosed forms. Bring snacks.',
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2026,
      document: baseDoc({ fileName: 'mixed.pdf' }),
      extracted: { ...classified, additionalResults: [junk] },
    });

    expect(applied.pieces).toHaveLength(2);
    expect(applied.pieces[0].classification.status).toBe('classified');
    expect(applied.pieces[1].classification.status).toBe('unclassified');
    expect(applied.pieces[1].toolFields).toEqual({});
    expect(applied.pieces[1].facts).toEqual([]);
    expect(applied.document.classifications).toHaveLength(2);
    expect(applied.document.classifications?.[1]?.status).toBe('unclassified');
    expect(applied.document.classifications?.[1]?.reason).toMatch(/No primary form markers/i);
    // Only the classified piece creates income facts.
    expect(applied.facts.every((f) => f.sourceField !== 'amount' || f.status === 'unknown')).toBe(true);
    expect(applied.unclassified).toBeUndefined();
  });

  it('drops stale source box when an AI override changes the value', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const wagesBox = { x: 417, y: 75, width: 50, height: 7 };
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 62000, // AI changed from 61482.17
        federalTaxWithheld: 0,
      },
      fieldRawTokens: {
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        employerName: 'Acme',
      },
      fieldSourceLocations: {
        wages: { page: 1, box: wagesBox },
        federalTaxWithheld: { page: 1, box: { x: 540, y: 75, width: 25, height: 7 } },
        employerName: { page: 1, box: { x: 39, y: 100, width: 80, height: 7 } },
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      aiEnhanced: true,
      ocrUsed: true,
      ocrAvailable: true,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc(),
      extracted,
    });

    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.value).toBe(62000);
    expect(wages?.rawText).not.toBe('$61,482.17');
    expect(wages?.sourcePage).toBeUndefined();
    expect(wages?.sourceBox).toBeUndefined();

    // Unchanged printed 0 still keeps its source
    const withheld = applied.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.value).toBe(0);
    expect(withheld?.rawText).toBe('$0.00');
    expect(withheld?.sourcePage).toBe(1);
    expect(withheld?.sourceBox).toEqual({ x: 540, y: 75, width: 25, height: 7 });

    // Employer name still agrees with its token — keep the box
    const employer = applied.facts.find((f) => f.sourceField === 'employerName');
    expect(employer?.value).toBe('Acme');
    expect(employer?.sourcePage).toBe(1);
    expect(employer?.sourceBox).toEqual({ x: 39, y: 100, width: 80, height: 7 });
  });

  it('keeps source box when an AI override leaves the same text', () => {
    saveTaxFacts('ret-1', []);
    saveDocuments('ret-1', [baseDoc()]);
    const wagesBox = { x: 417, y: 75, width: 50, height: 7 };
    const extracted: PDFExtractResult = {
      formType: 'W-2',
      extractedData: {
        employerName: 'Acme',
        wages: 61482.17,
        federalTaxWithheld: 0,
      },
      fieldRawTokens: {
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        employerName: 'Acme',
      },
      fieldSourceLocations: {
        wages: { page: 1, box: wagesBox },
        federalTaxWithheld: { page: 1, box: { x: 540, y: 75, width: 25, height: 7 } },
        employerName: { page: 1, box: { x: 39, y: 100, width: 80, height: 7 } },
      },
      incomeType: 'w2',
      payerName: 'Acme',
      confidence: 'high',
      warnings: [],
      errors: [],
      textBlockCount: 4,
      aiEnhanced: true,
      ocrUsed: true,
      ocrAvailable: true,
      trace: {
        formDetection: {
          detectedType: 'W-2',
          confidence: 'high',
          matchedKeywords: ['wage and tax statement'],
          reasoning: 'Matched W-2 markers',
        },
        fields: [],
        summary: 'test',
        textBlockCount: 4,
        pagesScanned: 1,
      },
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
      document: baseDoc(),
      extracted,
    });

    const wages = applied.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.value).toBe(61482.17);
    expect(wages?.rawText).toBe('$61,482.17');
    expect(wages?.sourcePage).toBe(1);
    expect(wages?.sourceBox).toEqual(wagesBox);
  });
});
