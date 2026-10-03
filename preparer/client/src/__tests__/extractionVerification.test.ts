import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFromPDF } from '../services/pdfImporter';
import { verifyExtractedValues } from '../services/extractionVerification';
import { factsForExtraction } from '../services/preparerTaxFacts';
import type { TextBlock } from '../services/pdfExtractHelpers';

const STRESS = '../local-ai/gauntlet/stress/docs';
const E2E = 'e2e/fixtures';

async function read(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  return extractFromPDF(new File([bytes], file.split('/').pop()!, { type: 'application/pdf' }));
}

const block = (text: string): TextBlock =>
  ({ text, x: 0, y: 0, width: text.length, height: 10, page: 1 }) as TextBlock;

describe('the deterministic gate: nothing is written the page does not print', () => {
  describe('rejects reads the page does not support', () => {
    it('holds a number that appears nowhere on the page', () => {
      const out = verifyExtractedValues('1098-T', { tuitionPaid: 4200 }, [block('$ 7.00'), block('1 Payments received')]);
      expect(out.data).toEqual({});
      expect(out.rejected[0]!.reason).toBe('not-printed');
    });

    it('holds the tax year read into an amount box', () => {
      const out = verifyExtractedValues('1099-MISC', { royalties: 2025 }, [block('Royalties $ 2025')]);
      expect(out.data).toEqual({});
      expect(out.rejected[0]!.reason).toBe('only-a-tax-year');
    });

    it("holds the form's own label read as a value", () => {
      const out = verifyExtractedValues(
        '1099-C',
        { payerName: "CREDITOR'S TIN" },
        [block("CREDITOR'S TIN"), block('Date of cancellation')],
      );
      expect(out.data).toEqual({});
      expect(out.rejected[0]!.reason).toBe('label-read-as-value');
    });

    it('holds form furniture: OMB codes, URLs, copy marks', () => {
      const out = verifyExtractedValues(
        '1099-C',
        { a: 'OMB No. 1545-1424', b: 'www.irs.gov/Form1099C', c: 'Copy A' },
        [block('OMB No. 1545-1424 www.irs.gov/Form1099C Copy A')],
      );
      expect(out.data).toEqual({});
      expect(out.rejected).toHaveLength(3);
      expect(out.rejected.every((r) => r.reason === 'form-furniture-read-as-value')).toBe(true);
    });

    it('holds half of the printed year graphic read into an amount box', () => {
      // The year renders as two tokens on one line: "20" then "25".
      const year = (text: string, x: number, y: number) =>
        ({ text, x, y, width: 20, height: 12, page: 1 }) as TextBlock;
      const out = verifyExtractedValues(
        '1098-T',
        { scholarships: 25 },
        [year('20', 400, 700), year('25', 428, 700), year('2027', 500, 640), year('5 Scholarships or grants', 400, 640)],
      );
      expect(out.data).toEqual({});
      expect(out.rejected[0]!.reason).toBe('not-an-amount');
    });

    it("keeps a genuine bare amount that is nowhere near a printed year", () => {
      // A 1099-NEC prints box 1a with no currency at all.
      const out = verifyExtractedValues('1099-NEC', { amount: 78702 }, [block('1a 78702'), block('2 28,400.00'), block('2025')]);
      expect(out.data).toEqual({ amount: 78702 });
    });
  });

  describe('never holds a value the page really does print', () => {
    it('keeps a comma-grouped amount', () => {
      const out = verifyExtractedValues('W-2', { wages: 52431.18 }, [block('$ 52,431.18')]);
      expect(out.data).toEqual({ wages: 52431.18 });
      expect(out.rejected).toEqual([]);
    });

    it('keeps a whole-dollar amount printed without cents', () => {
      const out = verifyExtractedValues('1099-G', { unemploymentCompensation: 3600 }, [block('3,600.00'), block('$')]);
      expect(out.data).toEqual({ unemploymentCompensation: 3600 });
    });

    it('keeps an amount that carries only a dollar sign', () => {
      const out = verifyExtractedValues('1098', { mortgageInterest: 7 }, [block('$7')]);
      expect(out.data).toEqual({ mortgageInterest: 7 });
    });

    it('keeps a real payer name that merely resembles a label word', () => {
      const out = verifyExtractedValues('1099-INT', { payerName: 'CHASE' }, [block('CHASE'), block('Payer name')]);
      expect(out.data).toEqual({ payerName: 'CHASE' });
    });

    it('leaves non-amount numbers alone', () => {
      const out = verifyExtractedValues('W-2C', { taxYearCorrected: 2025 }, [block('2025')]);
      expect(out.data).toEqual({ taxYearCorrected: 2025 });
    });
  });
});

describe('the 1098-T that started this: box 5 is empty and must stay empty', () => {
  it('reaches the return with the tuition and without the year graphic', async () => {
    const res = await read(`${STRESS}/dana-1098t.pdf`);

    // Nothing is written from a read the page does not print. The check runs at
    // the write boundary, so this is where the guarantee is asserted.
    const built = factsForExtraction({
      returnId: 'case-1',
      taxYear: 2025,
      documentId: 'doc-1',
      fileName: 'dana-1098t.pdf',
      extracted: res,
    });

    expect(built.toolFields.tuitionPaid).toBe(4200);
    expect(built.toolFields).not.toHaveProperty('scholarships');
    expect(res.warnings.some((w) => w.includes('scholarships'))).toBe(true);
  });
});

describe('real forms keep every amount they legitimately carry', () => {
  const expected: Array<[string, Record<string, number>]> = [
    [`${STRESS}/dana-w2.pdf`, { wages: 39750, federalTaxWithheld: 2310, socialSecurityWages: 39750, socialSecurityTax: 2464.5, medicareWages: 39750, medicareTax: 576.38, stateWages: 39750, stateTaxWithheld: 1220.33 }],
    [`${STRESS}/dana-1099g.pdf`, { unemploymentCompensation: 3600, federalTaxWithheld: 360 }],
    [`${STRESS}/eli-1099div.pdf`, { ordinaryDividends: 3120, qualifiedDividends: 2880, capitalGainDistributions: 640 }],
    [`${STRESS}/eli-1099int.pdf`, { amount: 2310.4 }],
    [`${STRESS}/eli-1099r.pdf`, { grossDistribution: 24000, taxableAmount: 24000, federalTaxWithheld: 2400 }],
    [`${STRESS}/fay-1099misc.pdf`, { otherIncome: 1200, federalTaxWithheld: 1200 }],
    [`${STRESS}/fay-1099nec-brewing.pdf`, { amount: 78702 }],
    [`${STRESS}/fay-1099nec-events.pdf`, { amount: 78701 }],
    [`${STRESS}/gus-w2.pdf`, { wages: 112000, federalTaxWithheld: 17400, medicareTax: 1624, stateTaxWithheld: 6050 }],
    [`${STRESS}/okafor-1098.pdf`, { mortgageInterest: 11240.66, outstandingPrincipal: 289400 }],
    [`${E2E}/1099q-529.pdf`, { grossDistribution: 8000, earnings: 1200, basisReturn: 6800 }],
    [`${E2E}/w2c-wages.pdf`, { previousWages: 52431.18, correctWages: 54000, correctFederalTaxWithheld: 6120 }],
  ];

  for (const [file, values] of expected) {
    it(`${file.split('/').pop()} keeps its printed amounts`, async () => {
      const built = factsForExtraction({
        returnId: 'case-1',
        taxYear: 2025,
        documentId: 'doc-1',
        fileName: file.split('/').pop()!,
        extracted: await read(file),
      });
      for (const [field, value] of Object.entries(values)) {
        expect(
          built.toolFields[field],
          `${field} was held: ${built.toolError ?? 'no reason given'}`,
        ).toBe(value);
      }
    });
  }
});