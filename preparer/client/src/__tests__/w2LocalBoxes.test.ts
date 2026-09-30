/**
 * W-2 boxes 18-20 (local wages, local income tax, locality name) read from a
 * digital W-2's text layer, applied to the return, and used by Indiana's county
 * tax as IT-40 line 2 county withholding. Fixtures are official IRS W-2 Copy B
 * PDFs filled with synthetic values (local-ai/gauntlet/cases).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { applyExtractionToDocument, registerDroppedDocument } from '../services/documentIngestion';
import { extractFromPDF } from '../services/pdfImporter';
import { applyExtraction } from '../services/returnApplier';

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

describe('W-2 boxes 18-20 from the text layer', () => {
  it('reads the local wages, local income tax and locality name by column', async () => {
    const indiana = await extractFromPDF(pdf('w2-indiana-local.pdf'));
    expect(indiana.extractedData).toMatchObject({ state: 'IN', stateWages: 57500, stateTaxWithheld: 1725, localWages: 57500, localTaxWithheld: 1161.5, localityName: 'MARION' });
    // Blank local boxes stay absent.
    const louisiana = await extractFromPDF(pdf('w2-basic-single.pdf'));
    expect(louisiana.extractedData).toMatchObject({ state: 'LA', stateWages: 52431.18, stateTaxWithheld: 1420.55 });
    expect(louisiana.extractedData).not.toHaveProperty('localTaxWithheld');
  });

  describe('on a case', () => {
    beforeEach(() => {
      installMemoryLocalStorage();
      clearReturnCache();
      clearRecordCache();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it("puts box 19 on the W-2, and Indiana counts it as county tax withheld without asking", async () => {
      const id = createReturn(2025).id;
      updateReturn(id, {
        firstName: 'Jordan', lastName: 'Testpayer', filingStatus: FilingStatus.Single, addressState: 'IN',
        stateReturns: [{ stateCode: 'IN', residencyType: 'resident', stateSpecificData: { inCounty: '49' } }],
      } as never);
      const file = pdf('w2-indiana-local.pdf');
      const { document } = await registerDroppedDocument({ returnId: id, file });
      const applied = applyExtractionToDocument({ returnId: id, taxYear: 2025, document, extracted: await extractFromPDF(file) });
      applyExtraction(id, applied);

      expect(getReturn(id).w2Income?.[0]).toMatchObject({ state: 'IN', localWages: 57500, localTaxWithheld: 1161.5, localityName: 'MARION' });
      const result = calculateForm1040(getReturn(id));
      expect((result.unsupported ?? []).filter((u) => u.itemId === 'county-withheld')).toEqual([]);
      // IT-40 line 2: state $1,725 + county $1,161.50.
      expect(result.stateResults?.find((s) => s.stateCode === 'IN')).toMatchObject({ stateWithholding: 2886.5, additionalLines: expect.objectContaining({ countyTaxWithheld: 1161.5 }) });
    });
  });
});
