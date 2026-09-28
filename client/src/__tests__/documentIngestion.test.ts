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
  loadDocuments,
  registerDroppedDocument,
  saveDocuments,
} from '../services/documentIngestion';
import { loadTaxFacts, saveTaxFacts } from '../services/preparerTaxFacts';
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

  it('detects duplicate content by hash', async () => {
    const bytes = [0xaa, 1, 2, 3, 4, 5, 6, 7];
    const file = mockFile('w2.pdf', bytes, 'application/pdf');
    await registerDroppedDocument({ returnId: 'ret-1', file });
    const again = await registerDroppedDocument({
      returnId: 'ret-1',
      file: mockFile('w2-copy.pdf', bytes, 'application/pdf'),
    });
    expect(again.duplicate).toBe(true);
    expect(loadDocuments('ret-1')).toHaveLength(1);
  });

  it('stores W-2 tool facts with source; omits missing wages; keeps explicit 0', () => {
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
    };

    const applied = applyExtractionToDocument({
      returnId: 'ret-1',
      taxYear: 2025,
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

    for (const fact of applied.facts.filter((f) => f.status === 'extracted')) {
      expect(fact.sourceDocumentId).toBe(documentIdFromHash(HASH));
      expect(fact.sourceFileName).toBe('w2.pdf');
      expect(fact.extractor.length).toBeGreaterThan(0);
    }

    expect(loadTaxFacts('ret-1').length).toBe(applied.facts.length);
    expect(loadDocuments('ret-1')[0].status).toBe('extracted');
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
      };
      const applied = applyExtractionToDocument({
        returnId: 'ret-1',
        taxYear: 2025,
        document: baseDoc({ fileName: `${item.incomeType}.pdf` }),
        extracted,
      });
      expect(applied.pieces[0].toolError).toBeUndefined();
      expect(applied.pieces[0].incomeType).toBe(item.incomeType);
      const extractedFacts = applied.facts.filter((f) => f.status === 'extracted');
      expect(extractedFacts.length).toBeGreaterThan(0);
      for (const fact of extractedFacts) {
        expect(fact.sourceDocumentId).toBe(documentIdFromHash(HASH));
      }
    }
  });
});
