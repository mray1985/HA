/**
 * The W-2 employee read from a digital W-2's text layer: box a's SSN, box e's
 * name by its printed columns, and box f's address — confirmed, since a text
 * layer is the page itself. Fixtures are official IRS W-2 Copy B PDFs filled
 * with synthetic values (local-ai/gauntlet/cases).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFromPDF } from '../services/pdfImporter';

const pdf = (name: string) => new File([readFileSync(`e2e/fixtures/${name}`)], name, { type: 'application/pdf' });

describe('the W-2 employee from the text layer', () => {
  it('reads the SSN, the name by column and the address', async () => {
    const la = await extractFromPDF(pdf('w2-basic-single.pdf'));
    expect(la.identity).toEqual({
      formType: 'W-2',
      tin: { raw: '000-12-3456', confirmed: true, value: '000123456' },
      tinLastFour: '3456',
      name: { raw: 'MAYA TESTPAYER', confirmed: true, value: { first: 'Maya', last: 'Testpayer' } },
      address: { raw: '815 MAGNOLIA AVE\nBATON ROUGE LA 70802', confirmed: true, value: { street: '815 MAGNOLIA AVE', city: 'BATON ROUGE', state: 'LA', zip: '70802' } },
    });
    const indiana = await extractFromPDF(pdf('w2-indiana-local.pdf'));
    expect(indiana.identity).toMatchObject({
      tin: { value: '000456789' },
      name: { value: { first: 'Jordan', last: 'Testpayer' } },
      address: { value: { street: '1450 N MERIDIAN ST', city: 'INDIANAPOLIS', state: 'IN', zip: '46202' } },
    });
  });
});
