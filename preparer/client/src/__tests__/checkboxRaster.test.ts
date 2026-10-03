import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { FORM_EXTRACTION_SCHEMAS } from '@hatax/local-ai';
import { readCheckboxOnPage } from '../services/checkboxRaster';
import type { TextBlock } from '../services/pdfExtractHelpers';

const STRESS = '../local-ai/gauntlet/stress/docs';

/**
 * The ink reader needs pixels. Node has no canvas, so the page is rasterized by
 * hand: every glyph the text layer reports is drawn as a filled box, dark where
 * the page prints ink. That is enough to place a label and judge a square beside
 * it, which is all `readCheckbox` does.
 */
function rasterize(items: Array<{ s: string; x: number; y: number; w: number }>, scale: number) {
  const width = Math.round(612 * scale);
  const height = Math.round(792 * scale);
  const gray = new Uint8Array(width * height).fill(255);
  // pdf.js y is the baseline from the bottom; flip to pixel space from the top.
  const flip = (y: number): number => Math.round(height - y * scale);
  for (const t of items) {
    // A glyph's ink spans its line, not its advance width: a tall "4" must not
    // paint a 9pt-tall block. Text height is the font size, which is close to
    // the reported width for these forms.
    const textHeight = Math.max(6, Math.min(11, t.w * 0.5));
    const x0 = Math.round(t.x * scale);
    const y0 = flip(t.y + textHeight);
    const x1 = Math.round((t.x + t.w) * scale);
    const y1 = flip(t.y);
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) gray[y * width + x] = 0;
    }
  }
  return { width, height, gray };
}

/** Draw a square outline, and a diagonal stroke inside it when it is ticked. */
function drawSquare(
  px: { width: number; height: number; gray: Uint8Array },
  x: number,
  y: number,
  size: number,
  ticked: boolean,
  scale: number,
): void {
  const X = Math.round(x * scale);
  const Y = Math.round(y * scale);
  const S = Math.round(size * scale);
  const put = (px2: number, py2: number): void => {
    if (px2 < 0 || py2 < 0 || px2 >= px.width || py2 >= px.height) return;
    px.gray[py2 * px.width + px2] = 0;
  };
  for (let i = 0; i < S; i++) {
    for (let t = 0; t < 2; t++) {
      put(X + i, Y + t); put(X + i, Y + S - 1 - t);
      put(X + t, Y + i); put(X + S - 1 - t, Y + i);
    }
  }
  if (ticked) {
    for (let i = 0; i < Math.floor(S * 0.7); i++) {
      const t = Math.floor((i / (S * 0.7)) * (S * 0.45));
      put(X + 2 + i, Y + S - 3 - t);
    }
  }
}

/**
 * Split a block's text into the words the reader searches for.
 *
 * `findPhrase` matches a spec word by word against re-tokenized text, so a block
 * holding several printed words has to be handed over as several. The real
 * extractor emits one block per phrase and the reader handles either; a test that
 * hands over a multi-word block must not then blame the reader for not matching.
 */
function toWords(blocks: readonly TextBlock[], scale: number) {
  // The reader decides whether two words share a line by how much their boxes
  // overlap vertically, so the boxes need height. A TextBlock carries its height;
  // a baseline-only box would make every line test as a different line and no
  // multi-word label could ever be found.
  return blocks.flatMap((b) => {
    const parts = b.text.split(/\s+/).filter(Boolean);
    const top = (b.y - (b.height > 0 ? b.height : 9)) * scale;
    const bottom = b.y * scale;
    if (parts.length <= 1) {
      return [{ text: b.text, box: [b.x * scale, top, (b.x + b.width) * scale, bottom] as [number, number, number, number], source: 'ocr' as const }];
    }
    const total = parts.reduce((n, p) => n + p.length, 0) + parts.length - 1;
    const width = b.width * scale;
    let x = b.x * scale;
    return parts.map((p) => {
      const pw = (p.length / total) * width;
      const word = { text: p, box: [x, top, x + pw, bottom] as [number, number, number, number], source: 'ocr' as const };
      x += pw + width / total;
      return word;
    });
  });
}

async function pageItems(file: string) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = content.items
    .filter((i): i is typeof i & { str: string; transform: number[]; width: number } =>
      'str' in i && i.str.trim() !== '')
    .map((i) => ({
      s: i.str,
      x: i.transform[4] as number,
      y: i.transform[5] as number,
      w: i.width || i.str.length * 4,
    }));
  return items;
}

/**
 * TextBlocks in the shape the reader wants.
 *
 * The blocks are the printed *words*, each with its own tight box. That matters:
 * `findPhrase` re-tokenizes what it is given and matches a spec's phrase word by
 * word, requiring consecutive words to share a line. Handing it whole phrase
 * blocks instead would make a two-word spec like "half-time student"
 * unmatchable, which is a fault in the test harness rather than the reader.
 */
function toBlocks(items: Awaited<ReturnType<typeof pageItems>>): TextBlock[] {
  return items.map((i) => ({
    text: i.s,
    x: i.x,
    y: i.y,
    width: i.w,
    height: 9,
    page: 1,
  }));
}

describe('a printed square is measured, never read from its glyph', () => {
  it('reports a ticked box as ticked beside its own label', async () => {
    const items = await pageItems(`${STRESS}/dana-1098t.pdf`);
    const blocks = toBlocks(items);
    const scale = 2;
    const raster = rasterize(items, scale);

    // The 1098-T prints its half-time square at the right end of the label's own
    // cell, and the label spans two lines ("Checked if at least" / "half-time
    // student"). The schema's spec says which word the square sits beside, so
    // the square goes there and nowhere else.
    const label = blocks.find((b) => /half-time/i.test(b.text));
    expect(label, 'the 1098-T prints a half-time label').toBeDefined();
    // Two lines deep, so the square is level with the lower line.
    drawSquare(raster, label!.x + label!.width + 10, label!.y - 10, 8, true, scale);

    const schema = FORM_EXTRACTION_SCHEMAS['1098-T']!;
    const box8 = schema.boxes.find((b) => b.key === '8')!;
    expect(box8.checkbox).toBeDefined();

    const page = { raster, words: toWords(blocks, scale) };
    const reading = readCheckboxOnPage(page, box8.checkbox!);
    // Proved, not merely tolerated: a tick inside the square is a tick.
    expect(reading.state).toBe('checked');
    expect(reading.reason).toMatch(/half-time/i);
  });

  it('reports an empty box as not ticked', async () => {
    const items = await pageItems(`${STRESS}/dana-1098t.pdf`);
    const blocks = toBlocks(items);
    const scale = 2;
    const raster = rasterize(items, scale);

    const label = blocks.find((b) => /graduate/i.test(b.text));
    expect(label).toBeDefined();
    drawSquare(raster, label!.x + label!.width + 8, label!.y - 6, 8, false, scale);

    const schema = FORM_EXTRACTION_SCHEMAS['1098-T']!;
    const box9 = schema.boxes.find((b) => b.key === '9')!;
    const page = { raster, words: toWords(blocks, scale) };
    const reading = readCheckboxOnPage(page, box9.checkbox!);
    // Proved empty, which is a real answer: the square is there and holds no ink.
    expect(reading.state).toBe('unchecked');
  });

  it('never calls a square unticked when there is no square to measure', async () => {
    const items = await pageItems(`${STRESS}/dana-1098t.pdf`);
    const blocks = toBlocks(items);
    const scale = 2;
    // No square drawn at all: the page has the label and nothing beside it.
    const page = { raster: rasterize(items, scale), words: toWords(blocks, scale) };
    const schema = FORM_EXTRACTION_SCHEMAS['1098-T']!;
    const box8 = schema.boxes.find((b) => b.key === '8')!;
    const reading = readCheckboxOnPage(page, box8.checkbox!);
    // "No square" is unknown, never "unchecked": an absent mark must not settle
    // an eligibility answer.
    expect(reading.state).not.toBe('unchecked');
  });

  it('does not treat a printed digit as a tick', async () => {
    // The 1098-T's box 8 mark extracts as the character "4". A reader that took
    // that glyph for a check would answer "at least half-time" from a digit.
    const items = await pageItems(`${STRESS}/dana-1098t.pdf`);
    const glyph = items.find((i) => i.s.trim() === '4');
    expect(glyph, 'the form prints a symbol glyph for the tick').toBeDefined();
    const blocks = toBlocks(items);
    const page = { raster: rasterize(items, 2), words: toWords(blocks, 2) };
    const schema = FORM_EXTRACTION_SCHEMAS['1098-T']!;
    const box8 = schema.boxes.find((b) => b.key === '8')!;
    const reading = readCheckboxOnPage(page, box8.checkbox!);
    // The digit is on the page and in the words. It must not come back as a tick.
    expect(reading.state).not.toBe('checked');
  });
});