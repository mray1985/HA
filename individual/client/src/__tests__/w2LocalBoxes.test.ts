/**
 * W-2 boxes 18-20 (local wages, local income tax, locality name) read from a
 * digital W-2's text layer. Fixtures are official IRS W-2 Copy B PDFs filled
 * with synthetic values (preparer/local-ai/gauntlet/cases).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFromPDF } from '../services/pdfImporter';

const pdf = (name: string) => new File([readFileSync(`src/__tests__/fixtures/${name}`)], name, { type: 'application/pdf' });

describe('W-2 boxes 18-20 from the text layer', () => {
  it('reads the local wages, local income tax and locality name by column', async () => {
    const indiana = await extractFromPDF(pdf('w2-indiana-local.pdf'));
    expect(indiana.extractedData).toMatchObject({ state: 'IN', stateWages: 57500, stateTaxWithheld: 1725, localWages: 57500, localTaxWithheld: 1161.5, localityName: 'MARION' });
  });

  it('leaves blank local boxes absent', async () => {
    const louisiana = await extractFromPDF(pdf('w2-basic-single.pdf'));
    expect(louisiana.extractedData).toMatchObject({ state: 'LA', stateWages: 52431.18, stateTaxWithheld: 1420.55 });
    expect(louisiana.extractedData).not.toHaveProperty('localTaxWithheld');
  });
});
