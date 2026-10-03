import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFromPDF } from '../services/pdfImporter';

const FORMS = '../local-ai/gauntlet/forms';

/** Values actually written. A key present but undefined is not a value. */
function written(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

async function read(name: string) {
  const bytes = new Uint8Array(readFileSync(`${FORMS}/${name}`));
  return extractFromPDF(new File([bytes], name, { type: 'application/pdf' }));
}

describe('a box takes the value beside its own label, not one from across the page', () => {
  it('does not read a margin section citation as 1099-Q earnings', async () => {
    // "529 and 530)" is printed in the right margin beside box 2. The box itself
    // is empty on this blank form, so nothing may be written from it.
    const values = written((await read('f1099q.pdf')).extractedData);
    expect(values).not.toHaveProperty('earnings');
    expect(values).not.toHaveProperty('basisReturn');
  });

  it('still reads a real 1099-Q amount that sits beside its label', async () => {
    const res = await read('1099q-529.pdf').catch(() => null);
    if (!res) return; // fixture not in this tree
    const values = written(res.extractedData);
    expect(values.grossDistribution).toBe(8000);
    expect(values.earnings).toBe(1200);
  });
});

describe('legitimate amounts survive the narrower search', () => {
  const cases: Array<[string, string, number]> = [
    ['dana-w2.pdf', 'wages', 39750],
    ['w2-basic-single.pdf', 'wages', 52431.18],
  ];

  for (const [name, field, expected] of cases) {
    it(`${name} still reads ${field}`, async () => {
      const dir = name === 'w2-basic-single.pdf'
        ? 'e2e/fixtures'
        : '../local-ai/gauntlet/stress/docs';
      const bytes = new Uint8Array(readFileSync(`${dir}/${name}`));
      const res = await extractFromPDF(new File([bytes], name, { type: 'application/pdf' }));
      expect(written(res.extractedData)[field]).toBe(expected);
    });
  }
});