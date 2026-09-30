import { describe, expect, it } from 'vitest';
import {
  findPhrase,
  locateValue,
  readBox12Code,
  readCheckbox,
  type PageRaster,
  type PageWord,
  type PixelBox,
} from '../src/pageEvidence.js';

function blankPage(width = 400, height = 300): PageRaster {
  return { width, height, gray: new Uint8Array(width * height).fill(255) };
}

function ink(r: PageRaster, x: number, y: number) {
  if (x >= 0 && y >= 0 && x < r.width && y < r.height) r.gray[y * r.width + x] = 0;
}

function square(r: PageRaster, x0: number, y0: number, side: number) {
  for (let i = 0; i < side; i++) {
    ink(r, x0 + i, y0); ink(r, x0 + i, y0 + side - 1);
    ink(r, x0, y0 + i); ink(r, x0 + side - 1, y0 + i);
  }
}

function cross(r: PageRaster, x0: number, y0: number, side: number) {
  for (let i = 2; i < side - 2; i++) {
    for (const t of [0, 1]) { ink(r, x0 + i + t, y0 + i); ink(r, x0 + side - 1 - i - t, y0 + i); }
  }
}

function word(text: string, box: PixelBox, source: PageWord['source'] = 'pdf-text'): PageWord {
  return { text, box, source };
}

const LABEL: PageWord[] = [word('Retirement', [100, 100, 150, 110]), word('plan', [152, 100, 170, 110])];

describe('findPhrase', () => {
  it('finds a phrase split across words and inside multi-word runs', () => {
    expect(findPhrase(LABEL, 'Retirement plan')).toEqual([[100, 100, 170, 110]]);
    const run = [word('Retirement plan', [100, 100, 170, 110])];
    expect(findPhrase(run, 'Retirement plan')).toHaveLength(1);
  });

  it('tolerates one OCR error in longer words only', () => {
    expect(findPhrase([word('Retirernent', [0, 0, 50, 10]), word('plan', [52, 0, 70, 10])], 'Retirement plan')).toHaveLength(1);
    expect(findPhrase([word('Retirement', [0, 0, 50, 10]), word('plam', [52, 0, 70, 10])], 'Retirement plan')).toHaveLength(0);
  });

  it('does not join words from different lines', () => {
    expect(findPhrase([word('Retirement', [0, 0, 50, 10]), word('plan', [0, 40, 20, 50])], 'Retirement plan')).toHaveLength(0);
  });
});

describe('readCheckbox', () => {
  const spec = { labelPhrase: 'Retirement plan', direction: 'below' as const };

  it('reads an empty square below its label as unchecked', () => {
    const r = blankPage();
    square(r, 125, 115, 14);
    const reading = readCheckbox(r, LABEL, spec);
    expect(reading.state).toBe('unchecked');
    expect(reading.square).toEqual([125, 115, 138, 128]);
  });

  it('reads a crossed square as checked', () => {
    const r = blankPage();
    square(r, 125, 115, 14);
    cross(r, 125, 115, 14);
    expect(readCheckbox(r, LABEL, spec).state).toBe('checked');
  });

  it('treats a printed X in the checkbox area as checked', () => {
    const r = blankPage();
    const words = [...LABEL, word('X', [128, 116, 136, 126])];
    expect(readCheckbox(r, words, spec)).toMatchObject({ state: 'checked' });
  });

  it('returns unknown when the label, the square, or a unique label is missing', () => {
    const r = blankPage();
    square(r, 125, 115, 14);
    expect(readCheckbox(r, [], spec).state).toBe('unknown');
    expect(readCheckbox(blankPage(), LABEL, spec).state).toBe('unknown');
    const twice = [...LABEL, word('Retirement', [100, 200, 150, 210]), word('plan', [152, 200, 170, 210])];
    expect(readCheckbox(r, twice, spec).state).toBe('unknown');
  });

  it('returns unknown for a faint mark between the empty and checked thresholds', () => {
    const r = blankPage();
    square(r, 125, 115, 20);
    // ~5% of the 12x12 interior: more than an empty square, less than a mark.
    for (const [x, y] of [[133, 123], [134, 123], [135, 123], [133, 124], [134, 124], [135, 124], [134, 125]]) ink(r, x!, y!);
    const reading = readCheckbox(r, LABEL, spec);
    expect(reading.state).toBe('unknown');
    expect(reading.inkRatio).toBeGreaterThan(0.03);
  });
});

describe('locateValue', () => {
  // Same amount in box 1 (top right) and box 16 (bottom); labels anchor each.
  const words: PageWord[] = [
    word('1', [300, 20, 305, 30]), word('Wages,', [308, 20, 340, 30]),
    word('52431.18', [330, 40, 380, 50]),
    word('16', [150, 200, 160, 210]), word('State', [163, 200, 190, 210]),
    word('$', [150, 220, 155, 230]), word('52,431.18', [160, 220, 210, 230]),
  ];

  it('matches money by parsed value across formatting and "$" tokens', () => {
    const only = locateValue('$1,284.66', [word('$', [0, 0, 5, 10]), word('1284.66', [8, 0, 50, 10])], { money: true });
    expect(only?.box).toEqual([0, 0, 50, 10]);
  });

  it('uses the label anchor to pick between duplicate amounts', () => {
    expect(locateValue('52431.18', words, { money: true, anchor: [300, 20, 340, 30] })?.box).toEqual([330, 40, 380, 50]);
    expect(locateValue('52431.18', words, { money: true, anchor: [150, 200, 190, 210] })?.box).toEqual([150, 220, 210, 230]);
  });

  it('refuses to guess between duplicates without an anchor', () => {
    expect(locateValue('52431.18', words, { money: true })).toBeNull();
  });

  it('returns null for values that are not on the page', () => {
    expect(locateValue('67482.17', words, { money: true })).toBeNull();
    expect(locateValue('$', words, { money: true })).toBeNull();
  });

  it('locates text by its first line', () => {
    const w = [word('RIVERBEND LOGISTICS LLC', [10, 10, 150, 20]), word('4100 CANAL ST', [10, 25, 90, 35])];
    expect(locateValue('RIVERBEND LOGISTICS LLC\n4100 CANAL ST', w)?.box).toEqual([10, 10, 150, 20]);
  });
});

describe('readBox12Code', () => {
  const amount: PixelBox = [300, 100, 350, 110];

  it('reads a valid code left of the amount on the same line', () => {
    expect(readBox12Code(amount, [word('D', [260, 100, 268, 110]), word('2500.00', [300, 100, 350, 110])])).toBe('D');
    expect(readBox12Code(amount, [word('DD', [255, 100, 270, 110])])).toBe('DD');
  });

  it('ignores invalid codes and codes on other lines', () => {
    expect(readBox12Code(amount, [word('I', [260, 100, 264, 110])])).toBeNull();
    expect(readBox12Code(amount, [word('D', [260, 140, 268, 150])])).toBeNull();
  });
});
