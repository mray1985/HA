import { describe, expect, it } from 'vitest';
import { applyPageEvidence } from '../src/formEvidence.js';
import { getFormExtractionSchema, mapBoxesToTool } from '../src/formSchemas.js';
import type { PageRaster, PageWord, PixelBox } from '../src/pageEvidence.js';

const W2 = getFormExtractionSchema('W-2')!;

function w(text: string, box: PixelBox): PageWord {
  return { text, box, source: 'pdf-text' };
}

function raster(width = 600, height = 500): PageRaster {
  return { width, height, gray: new Uint8Array(width * height).fill(255) };
}

function drawSquare(r: PageRaster, x0: number, y0: number, side: number, checked: boolean) {
  const ink = (x: number, y: number) => { r.gray[y * r.width + x] = 0; };
  for (let i = 0; i < side; i++) { ink(x0 + i, y0); ink(x0 + i, y0 + side - 1); ink(x0, y0 + i); ink(x0 + side - 1, y0 + i); }
  if (checked) for (let i = 2; i < side - 2; i++) { ink(x0 + i, y0 + i); ink(x0 + side - 1 - i, y0 + i); ink(x0 + i + 1, y0 + i); }
}

/** One W-2 copy's words at vertical offset dy. */
function copy(dy: number): PageWord[] {
  return [
    w('1', [300, 10 + dy, 305, 20 + dy]), w('Wages,', [308, 10 + dy, 340, 20 + dy]), w('52431.18', [330, 25 + dy, 380, 35 + dy]),
    w('3', [300, 40 + dy, 305, 50 + dy]), w('Social', [308, 40 + dy, 340, 50 + dy]), w('54931.18', [330, 55 + dy, 380, 65 + dy]),
    w('5', [300, 70 + dy, 305, 80 + dy]), w('Medicare', [308, 70 + dy, 350, 80 + dy]), w('54931.18', [330, 85 + dy, 380, 95 + dy]),
    w('12a', [450, 10 + dy, 465, 20 + dy]), w('D', [455, 25 + dy, 462, 35 + dy]), w('2500.00', [500, 25 + dy, 550, 35 + dy]),
    w('Retirement', [100, 40 + dy, 150, 50 + dy]),
  ];
}

describe('applyPageEvidence', () => {
  // Employer PDFs repeat the filled W-2 (Copy B, C, 2) on one sheet.
  const words = [...copy(0), ...copy(200)];
  const page = raster();
  drawSquare(page, 118, 53, 12, true);
  drawSquare(page, 118, 253, 12, true);

  const transcribed = {
    '1': '52431.18',
    '3': '54931.18',
    '5': '54931.18',
    '12a.amount': '2500.00', // model omitted the "D" code
  };

  const result = applyPageEvidence(W2, transcribed, { words, raster: page });

  it('reads one copy consistently', () => {
    expect(result.located['1']?.box).toEqual([330, 25, 380, 35]);
    expect(result.region![3]).toBeLessThan(200);
  });

  it('takes a repeated amount from under its own label', () => {
    expect(result.located['3']?.box).toEqual([330, 55, 380, 65]);
    expect(result.located['5']?.box).toEqual([330, 85, 380, 95]);
  });

  it('fills the box 12 code from the page and reads the checkbox deterministically', () => {
    expect(result.box12Codes).toEqual({ '12a': 'D' });
    expect(result.checkboxes['13.retirement']?.state).toBe('checked');
    const mapped = mapBoxesToTool(W2, result.values);
    expect(mapped.bag.box12).toEqual([{ code: 'D', amount: '2500.00' }]);
    expect(mapped.bag.box13).toMatchObject({ retirementPlan: true });
  });

  it('routes checkboxes the page cannot settle to review instead of guessing', () => {
    expect(result.checkboxes['13.statutory']?.state).toBe('unknown');
    expect(result.values['13.statutory']).toBe('?');
    expect(mapBoxesToTool(W2, result.values).reviewBoxes.map((b) => b.key)).toContain('13.statutory');
  });

  it('never locates a value that is not on the page', () => {
    const r = applyPageEvidence(W2, { '1': '67482.17' }, { words, raster: page });
    expect(r.located['1']).toBeNull();
    expect(r.region).toBeNull();
  });
});
