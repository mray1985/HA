import { describe, expect, it } from 'vitest';
import {
  box12CodeAt,
  findPhrase,
  locateValue,
  readBox12Code,
  readCheckbox,
  restoreLineBreaks,
  wordsFromTesseract,
  type PageRaster,
  type PageWord,
  type PixelBox,
} from '../src/pageEvidence.js';
import { getFormExtractionSchema } from '../src/formSchemas.js';

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

describe('wordsFromTesseract', () => {
  it('flattens blocks to page words and drops empty words', () => {
    const words = wordsFromTesseract({
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: '52431.18', confidence: 91.4, bbox: { x0: 870, y0: 157, x1: 938, y1: 169 } },
        { text: ' ', confidence: 0, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
      ] }] }] }],
    });
    expect(words).toEqual([{ text: '52431.18', source: 'ocr', confidence: 91.4, box: [870, 157, 938, 169] }]);
    expect(wordsFromTesseract({ blocks: null })).toEqual([]);
  });
});

describe('readCheckbox on scans', () => {
  /** Square outline (and optional X) rotated by `deg`, plus seeded noise. */
  function scanned(deg: number, checked: boolean): PageRaster {
    const r = blankPage();
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < r.gray.length; i++) r.gray[i] = Math.max(0, Math.min(255, 245 + (rand() - 0.5) * 30));
    const cx = 131; const cy = 121; const half = 7;
    const a = (deg * Math.PI) / 180;
    const plot = (x: number, y: number) => {
      const rx = Math.round(cx + x * Math.cos(a) - y * Math.sin(a));
      const ry = Math.round(cy + x * Math.sin(a) + y * Math.cos(a));
      r.gray[ry * r.width + rx] = 40;
    };
    for (let t = -half; t <= half; t += 0.25) { plot(t, -half); plot(t, half); plot(-half, t); plot(half, t); }
    if (checked) for (let t = -half + 2; t <= half - 2; t += 0.25) { plot(t, t); plot(t, -t); plot(t + 0.5, t); plot(t + 0.5, -t); }
    return r;
  }

  const spec = { labelPhrase: 'Retirement plan', direction: 'below' as const };

  it('does not read a skewed, noisy empty square as checked (measured false positive)', () => {
    expect(readCheckbox(scanned(2, false), LABEL, spec).state).toBe('unchecked');
  });

  it('reads a skewed, noisy crossed square as checked', () => {
    expect(readCheckbox(scanned(2, true), LABEL, spec).state).toBe('checked');
  });
});

describe('checkbox squares versus letters and broken outlines', () => {
  const spec = { labelPhrase: 'Retirement plan', direction: 'below' as const };

  /** A "D": stem, top and bottom bars, rounded right side. */
  function letterD(r: PageRaster, x0: number, y0: number, side: number) {
    const rad = side / 2;
    for (let i = 0; i < side; i++) ink(r, x0, y0 + i);
    for (let i = 0; i <= side / 2; i++) { ink(r, x0 + i, y0); ink(r, x0 + i, y0 + side - 1); }
    for (let a = -90; a <= 90; a += 2) {
      const t = (a * Math.PI) / 180;
      ink(r, Math.round(x0 + side / 2 + (rad - 1) * Math.cos(t)), Math.round(y0 + rad - 0.5 + (rad - 0.5) * Math.sin(t)));
    }
  }

  it('does not take a rounded letter of checkbox size for a square', () => {
    const r = blankPage();
    letterD(r, 125, 115, 14);
    expect(readCheckbox(r, LABEL, spec)).toMatchObject({ state: 'unknown' });
  });

  it('does not take a letter smaller than the label font for a square', () => {
    const r = blankPage();
    square(r, 125, 115, 6);
    cross(r, 125, 115, 6);
    expect(readCheckbox(r, LABEL, spec)).toMatchObject({ state: 'unknown' });
  });

  it('joins a square whose two sides dropped out over the same stretch (fax)', () => {
    const r = blankPage();
    square(r, 125, 115, 20);
    for (let y = 123; y < 126; y++) { r.gray[y * r.width + 125] = 255; r.gray[y * r.width + 144] = 255; }
    expect(readCheckbox(r, LABEL, spec)).toMatchObject({ state: 'unchecked', square: [125, 115, 144, 134] });
  });

  it('finds a square that touches a ruling line', () => {
    const r = blankPage();
    square(r, 125, 115, 14);
    for (let x = 20; x < 380; x++) ink(r, x, 129);
    expect(readCheckbox(r, LABEL, spec)).toMatchObject({ state: 'unchecked', square: [125, 115, 138, 128] });
  });

  /** Paper near 235 with grain, outline and mark near 190 (a faded copy). */
  function faded(checked: boolean): PageRaster {
    const r = blankPage();
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < r.gray.length; i++) r.gray[i] = Math.round(235 + (rand() - 0.5) * 16);
    const gray = (x: number, y: number) => { r.gray[y * r.width + x] = 190; };
    for (let i = 0; i < 16; i++) { gray(125 + i, 115); gray(125 + i, 130); gray(125, 115 + i); gray(140, 115 + i); }
    if (checked) for (let i = 3; i < 13; i++) { gray(125 + i, 115 + i); gray(140 - i, 115 + i); gray(126 + i, 115 + i); }
    return r;
  }

  it('reads a faded copy by its own contrast, and paper grain is never a mark', () => {
    expect(readCheckbox(faded(false), LABEL, spec).state).toBe('unchecked');
    expect(readCheckbox(faded(true), LABEL, spec).state).toBe('checked');
  });
});

describe('checkbox rows by table cell (W-2 box 13 on scans)', () => {
  const W2 = getFormExtractionSchema('W-2')!;
  const box13 = (key: string) => W2.boxes.find((b) => b.key === key)!.checkbox!;

  /** Box 11's cell (y 50–100) above box 13's cell (y 100–160), squares in the lower cell. */
  function table(squares: number[], checkedIndex: number): PageRaster {
    const r = blankPage();
    for (const y of [50, 100, 160]) for (let x = 20; x <= 300; x++) ink(r, x, y);
    for (const x of [20, 300]) for (let y = 50; y <= 160; y++) ink(r, x, y);
    squares.forEach((x, i) => {
      square(r, x, 125, 20);
      if (i === checkedIndex) cross(r, x, 125, 20);
    });
    return r;
  }
  // OCR read the box number "11" but none of the small checkbox labels.
  const words = [word('11', [25, 55, 35, 65], 'ocr')];

  it('reads each square by its position when the labels are unreadable', () => {
    const r = table([60, 140, 220], 1);
    expect(readCheckbox(r, words, box13('13.statutory')).state).toBe('unchecked');
    expect(readCheckbox(r, words, box13('13.retirement'))).toMatchObject({ state: 'checked', square: [140, 125, 159, 144] });
    expect(readCheckbox(r, words, box13('13.sickPay')).state).toBe('unchecked');
  });

  it('answers unknown unless the cell holds exactly the expected squares', () => {
    const r = table([60, 140], 1);
    expect(readCheckbox(r, words, box13('13.retirement'))).toMatchObject({ state: 'unknown', reason: expect.stringContaining('2 squares') });
  });
});

describe('restoreLineBreaks', () => {
  it('rebuilds lines from OCR words even when OCR joined a neighbouring column into the line', () => {
    const words = [
      word('SUMMIT', [10, 10, 60, 20], 'ocr'), word('INDEX', [64, 10, 100, 20], 'ocr'), word('FUNDS', [104, 10, 140, 20], 'ocr'),
      word('1a', [300, 10, 312, 20], 'ocr'), word('Total', [316, 10, 350, 20], 'ocr'),
      word('PO', [10, 23, 25, 33], 'ocr'), word('BOX', [29, 23, 55, 33], 'ocr'), word('2200', [59, 23, 90, 33], 'ocr'),
    ];
    expect(restoreLineBreaks('SUMMIT INDEX FUNDS PO BOX 2200', words)).toBe('SUMMIT INDEX FUNDS\nPO BOX 2200');
  });

  it('refuses when the page does not show the whole value in block order', () => {
    const words = [word('SUMMIT INDEX FUNDS', [10, 10, 120, 20]), word('PO BOX 2200', [200, 60, 280, 70])];
    expect(restoreLineBreaks('SUMMIT INDEX FUNDS PO BOX 2200', words)).toBeNull();
    expect(restoreLineBreaks('SUMMIT INDEX FUNDS', [word('SUMMIT INDEX FUNDS', [10, 10, 120, 20])])).toBeNull();
  });
});

describe('box12CodeAt', () => {
  it('takes the code nearest the amount, not the "C" of the printed "Code" label', () => {
    const words = [word('C', [10, 10, 16, 20]), word('D', [40, 10, 48, 20]), word('2500.00', [100, 10, 150, 20])];
    expect(box12CodeAt([100, 10, 150, 20], words)).toEqual({ code: 'D', box: [40, 10, 48, 20] });
  });
});
