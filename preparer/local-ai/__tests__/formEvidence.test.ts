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

  it('keeps an amount printed in two boxes (3 and 5) for both — not a phantom', () => {
    expect(result.phantoms).toEqual([]);
    expect(result.located['3']?.box).not.toEqual(result.located['5']?.box);
  });

  it('never locates a value that is not on the page', () => {
    const r = applyPageEvidence(W2, { '1': '67482.17' }, { words, raster: page });
    expect(r.located['1']).toBeNull();
    expect(r.region).toBeNull();
  });
});

describe("a W-2's name read on into the address below it", () => {
  it('checks the name columns on the name alone (stress run: CARA / OKAFOR / 1427 ASPEN CT / NAPERVILLE IL 60540)', () => {
    const words = [
      w('CARA', [40, 100, 76, 112]), w('OKAFOR', [180, 100, 234, 112]),
      w('1427', [40, 130, 76, 142]), w('ASPEN', [80, 130, 125, 142]), w('CT', [129, 130, 147, 142]),
      w('NAPERVILLE', [40, 145, 130, 157]), w('IL', [134, 145, 150, 157]), w('60540', [154, 145, 199, 157]),
    ];
    // As the model read it in the stress run: the address inside box e, box f not read.
    const r = applyPageEvidence(W2, { e: 'CARA\nOKAFOR\n1427 ASPEN CT\nNAPERVILLE IL 60540' }, { words, raster: raster() });
    expect(r.nameColumns).toEqual(['e']);
    expect(r.values.e).toBe('CARA\nOKAFOR');
    // The address lines are box f's reading, and the page shows them there.
    expect(r.values.f).toBe('1427 ASPEN CT\nNAPERVILLE IL 60540');
    expect(r.located.f).not.toBeNull();
  });

  it('keeps box f as read when the reader read it', () => {
    const words = [w('CARA', [40, 100, 76, 112]), w('OKAFOR', [180, 100, 234, 112])];
    const r = applyPageEvidence(W2, { e: 'CARA\nOKAFOR\n1427 ASPEN CT\nNAPERVILLE IL 60540', f: '99 OTHER RD\nNAPERVILLE IL 60540' }, { words, raster: raster() });
    expect(r.values.f).toBe('99 OTHER RD\nNAPERVILLE IL 60540');
  });
});

describe('phantom copies', () => {
  it('removes a value a model copied into a second box when the page prints it once', () => {
    const words = [
      { text: '15', box: [10, 10, 20, 20] as const, source: 'pdf-text' as const },
      { text: 'State', box: [22, 10, 50, 20] as const, source: 'pdf-text' as const },
      { text: 'LA/1234567', box: [10, 25, 90, 35] as const, source: 'pdf-text' as const },
      { text: '52431.18', box: [200, 25, 260, 35] as const, source: 'pdf-text' as const },
    ];
    const r = applyPageEvidence(getFormExtractionSchema('1099-R')!, { '1': '52431.18', '15.1': 'LA/1234567', '15.2': 'LA/1234567' }, {
      words,
      raster: { width: 300, height: 100, gray: new Uint8Array(300 * 100).fill(255) },
    });
    expect(r.phantoms).toEqual(['15.2']);
    expect(r.values['15.1']).toBe('LA/1234567');
    expect(r.values).not.toHaveProperty('15.2');
  });
});

describe('missed values', () => {
  const words = [...copy(0), ...copy(200)];
  const page = raster();

  it('reports an amount printed under a tool box the model left blank, without filling it', () => {
    const r = applyPageEvidence(W2, { '1': '52431.18', '3': '54931.18' }, { words, raster: page });
    expect(r.missed).toEqual([{ key: '5', pageText: '54931.18', box: [330, 85, 380, 95] }]);
    expect(r.values).not.toHaveProperty('5');
  });

  it('does not report amounts the model transcribed, or amounts in another copy of the form', () => {
    const r = applyPageEvidence(W2, { '1': '52431.18', '3': '54931.18', '5': '54931.18' }, { words, raster: page });
    expect(r.missed).toEqual([]);
  });

  it('ignores label text amounts without cents', () => {
    const extra = [...words, w('$5,000', [330, 87, 370, 95])];
    const r = applyPageEvidence(W2, { '1': '52431.18', '3': '54931.18', '5': '54931.18' }, { words: extra, raster: page });
    expect(r.missed).toEqual([]);
  });
});

describe('W-2 box 12 codes', () => {
  // Each slot prints "Code" vertically at its left; its "C" is an official code.
  const slot = (dy: number, amount?: string, code?: string): PageWord[] => [
    w('12a', [450, 10 + dy, 465, 20 + dy]), w('C', [450, 25 + dy, 456, 33 + dy]),
    ...(code ? [w(code, [470, 25 + dy, 477, 35 + dy])] : []),
    ...(amount ? [w(amount, [500, 25 + dy, 550, 35 + dy])] : []),
  ];
  const page = raster();

  it('confirms a code only when the page prints it beside its amount', () => {
    const words = [...copy(0).filter((x) => !['12a', 'D', '2500.00'].includes(x.text)), ...slot(0, '2500.00', 'D')];
    const right = applyPageEvidence(W2, { '1': '52431.18', '12a.code': 'D', '12a.amount': '2500.00' }, { words, raster: page });
    expect(right.located['12a.code']?.pageText).toBe('D');
    // Measured: a model read the slot's "Code" label letter as the code.
    const wrong = applyPageEvidence(W2, { '1': '52431.18', '12a.code': 'C', '12a.amount': '2500.00' }, { words, raster: page });
    expect(wrong.located['12a.code']).toBeNull();
    expect(wrong.values['12a.code']).toBe('C');
  });

  it('drops a code the model gave for a slot with no amount', () => {
    const words = [...copy(0), w('12b', [450, 60, 465, 70]), w('C', [450, 75, 456, 83])];
    const r = applyPageEvidence(W2, { '1': '52431.18', '12b.code': 'C' }, { words, raster: page });
    expect(r.values).not.toHaveProperty('12b.code');
    expect(r.phantoms).toContain('12b.code');
  });
});

describe('page evidence details', () => {
  it('keeps a second box that OCR saw printed only once, as unconfirmed', () => {
    // Faded W-2: boxes 3 and 5 hold the same amount; OCR read it once.
    const ocr = copy(0).filter((x) => !(x.text === '54931.18' && x.box[1] === 85)).map((x) => ({ ...x, source: 'ocr' as const }));
    const r = applyPageEvidence(W2, { '1': '52431.18', '3': '54931.18', '5': '54931.18' }, { words: ocr, raster: raster() });
    expect(r.values['5']).toBe('54931.18');
    expect(r.located['5']).toBeNull();
    expect(r.phantoms).toEqual([]);
  });

  it('never takes a printed box label for the value', () => {
    // 1098 box 9 (number of properties) often holds "1" — also the number of box 1's label.
    const M = getFormExtractionSchema('1098')!;
    const words = [w('1', [10, 10, 15, 20]), w('Mortgage', [18, 10, 80, 20]), w('9412.37', [20, 25, 80, 35])];
    const r = applyPageEvidence(M, { '1': '9412.37', '9': '1' }, { words, raster: raster() });
    expect(r.located['1']?.pageText).toBe('9412.37');
    expect(r.located['9']).toBeNull();
    const printed = applyPageEvidence(M, { '1': '9412.37', '9': '1' }, { words: [...words, w('1', [200, 60, 205, 70])], raster: raster() });
    expect(printed.located['9']?.box).toEqual([200, 60, 205, 70]);
  });

  it('restores the line breaks of a payer block returned on one line', () => {
    const DIV = getFormExtractionSchema('1099-DIV')!;
    const words = [w('SUMMIT INDEX FUNDS', [10, 10, 120, 20]), w('PO BOX 2200', [10, 22, 80, 32]),
      w('VALLEY FORGE PA 19482', [10, 34, 140, 44]), w('1a', [300, 10, 312, 20]), w('1204.55', [300, 25, 350, 35])];
    const r = applyPageEvidence(DIV, { 'payer.block': 'SUMMIT INDEX FUNDS PO BOX 2200 VALLEY FORGE PA 19482', '1a': '1204.55' }, { words, raster: raster() });
    expect(r.values['payer.block']).toBe('SUMMIT INDEX FUNDS\nPO BOX 2200\nVALLEY FORGE PA 19482');
    expect(r.relined).toEqual(['payer.block']);
    expect(r.located['payer.block']?.pageText).toBe('SUMMIT INDEX FUNDS');
  });
});

describe('one printed token, two claiming boxes', () => {
  it('gives the token to the box whose label it sits under, not the first box in form order', () => {
    // Measured: a model copied the 1099-INT box 1 amount into "Payer's RTN" as well.
    const INT = getFormExtractionSchema('1099-INT')!;
    const words = [w("Payer's", [10, 10, 50, 20]), w('RTN', [52, 10, 75, 20]),
      w('1', [300, 10, 305, 20]), w('Interest', [308, 10, 350, 20]), w('1,284.66', [320, 25, 380, 35])];
    const r = applyPageEvidence(INT, { rtn: '1,284.66', '1': '1,284.66' }, { words, raster: raster() });
    expect(r.values['1']).toBe('1,284.66');
    expect(r.phantoms).toEqual(['rtn']);
  });
});
