/**
 * A raster for a page the text layer already read, so its printed squares can be
 * measured.
 *
 * A tick is not text. On a digital form it extracts as a symbol-font glyph — a
 * real 1098-T prints its half-time box as the character "4" — and on a scan it is
 * a mark inside a drawn square. Neither can be read from the text layer, and
 * reading the glyph would be worse than useless: a printed 4 is common, and it
 * would turn a "at least half-time student" answer into something else entirely.
 *
 * So the square is measured instead, with the ink reader in `@hatax/local-ai`
 * (`readCheckbox`), which judges the ink inside the square against the label the
 * form declares. This module's only job is to hand that reader a raster and the
 * page's words in the same coordinate space.
 */
import { readCheckbox, type CheckboxReading, type CheckboxSpec, type PageRaster, type PageWord } from '@hatax/local-ai';
import type { TextBlock } from './pdfExtractHelpers';

export interface RenderedPage {
  raster: PageRaster;
  words: PageWord[];
}

/**
 * Build the raster and words for one rendered page.
 *
 * `dpi` is the resolution the page was rendered at; the blocks are in PDF points
 * (72 per inch), so every coordinate is scaled into pixel space to match. The
 * words come from the extractor's own blocks, so a label the extractor read is
 * the label the square is looked for beside — the two cannot disagree.
 */
export function renderedPage(
  canvas: HTMLCanvasElement,
  blocks: readonly TextBlock[],
  dpi: number,
  source: PageWord['source'] = 'ocr',
): RenderedPage {
  const width = canvas.width;
  const height = canvas.height;
  const gray = new Uint8Array(width * height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      // Luma: the eye weights green most, and a tick in blue or red ink still reads.
      gray[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
    }
  }
  const scale = dpi / 72;
  const words: PageWord[] = blocks.map((b) => ({
    text: b.text,
    // The lower edge has to include the line's height. A zero-height box has no
    // vertical overlap with the next word, so a two-word label such as
    // "half-time student" can never be found.
    box: [b.x * scale, b.y * scale, (b.x + b.width) * scale, (b.y + b.height) * scale],
    source,
  }));
  return { raster: { width, height, gray }, words };
}

/**
 * Read one checkbox on a rendered page.
 *
 * The result is `unknown` whenever the square cannot be proved either way, and an
 * unknown square is never reported as unticked: a box the reader could not see
 * must not settle an eligibility answer.
 */
export function readCheckboxOnPage(
  page: RenderedPage,
  spec: CheckboxSpec,
  near?: [number, number, number, number] | null,
): CheckboxReading {
  return readCheckbox(page.raster, page.words, spec, near ?? null);
}

export type { CheckboxSpec, CheckboxReading, PageRaster, PageWord };