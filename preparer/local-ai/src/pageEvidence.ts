/**
 * Deterministic page evidence (work order §31, §33, §59).
 *
 * The document model transcribes values; it does not reliably report where a
 * value sits, whether a checkbox is marked, or short code letters. This module
 * answers those questions from the page itself:
 *
 *   - words: positioned tokens from the PDF text layer (digital PDFs) or an
 *     independent OCR engine's word boxes (scans / photos);
 *   - raster: the rendered page in grayscale.
 *
 * Locating a transcribed value among independently produced words gives real
 * source coordinates and doubles as a second reading of that value. Nothing
 * here invents a coordinate or a value: when evidence is missing or ambiguous
 * the answer is null / "unknown" and the field routes to review.
 */

import { parseMoneyToken } from './structuredExtraction.js';

/** Pixel box in raster space: [x0, y0, x1, y1], origin top-left. */
export type PixelBox = readonly [number, number, number, number];

export type PageWordSource = 'pdf-text' | 'ocr';

export interface PageWord {
  text: string;
  box: PixelBox;
  source: PageWordSource;
  /** Engine word confidence 0–100 when the source reports one. */
  confidence?: number;
}

export interface PageRaster {
  width: number;
  height: number;
  /** Row-major grayscale, 0 = black, 255 = white. */
  gray: Uint8Array;
}

// ─── Text normalization ──────────────────────────────────────

export function normalizeToken(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9'$.,/%-]/g, '');
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Fold common OCR look-alikes for label words (letters only): "rn"→"m",
 * "vv"→"w", and digit/letter confusions 0→o, 1→l. Never applied to values.
 */
function foldLabelWord(word: string): string {
  return word.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l');
}

/** OCR-tolerant word match: exact, look-alike folded, or one edit for words of 5+ characters. */
function wordMatches(pageWord: string, wanted: string): boolean {
  const a = normalizeToken(pageWord).replace(/[.,]+$/, '');
  const b = normalizeToken(wanted).replace(/[.,]+$/, '');
  if (!a || !b) return false;
  if (a === b) return true;
  const alphabetic = /^[a-z'/-]+$/.test(b);
  const fa = alphabetic ? foldLabelWord(a) : a;
  const fb = alphabetic ? foldLabelWord(b) : b;
  if (fa === fb) return true;
  return fb.length >= 5 && editDistanceAtMost1(fa, fb);
}

function union(boxes: readonly PixelBox[]): PixelBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

function sameLine(a: PixelBox, b: PixelBox): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return overlap > 0.5 * Math.min(a[3] - a[1], b[3] - b[1]);
}

/**
 * Reading-order word sequence for phrase search: page words split on
 * whitespace (text layers often return multi-word runs).
 */
function tokens(words: readonly PageWord[]): Array<{ text: string; box: PixelBox; word: PageWord }> {
  const out: Array<{ text: string; box: PixelBox; word: PageWord }> = [];
  for (const w of words) {
    const parts = w.text.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) { if (parts.length === 1) out.push({ text: parts[0]!, box: w.box, word: w }); continue; }
    // Split a run's box proportionally by character count (same line, same font run).
    const total = parts.reduce((n, p) => n + p.length, 0) + parts.length - 1;
    const width = w.box[2] - w.box[0];
    let x = w.box[0];
    for (const part of parts) {
      const pw = (part.length / total) * width;
      out.push({ text: part, box: [x, w.box[1], x + pw, w.box[3]], word: w });
      x += pw + width / total;
    }
  }
  return out;
}

/**
 * Every occurrence of a phrase (consecutive tokens on one line, OCR-tolerant).
 * Returns the union box of each occurrence.
 */
export function findPhrase(words: readonly PageWord[], phrase: string): PixelBox[] {
  const wanted = phrase.split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return [];
  const toks = tokens(words);
  const hits: PixelBox[] = [];
  for (let i = 0; i + wanted.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < wanted.length; k++) {
      const t = toks[i + k]!;
      if (!wordMatches(t.text, wanted[k]!) || (k > 0 && !sameLine(toks[i + k - 1]!.box, t.box))) { ok = false; break; }
    }
    if (ok) hits.push(union(toks.slice(i, i + wanted.length).map((t) => t.box)));
  }
  // OCR can return one printed word twice as overlapping boxes; that is one occurrence.
  const merged: PixelBox[] = [];
  for (const h of hits) {
    const i = merged.findIndex((m) => boxGap(m, h) === 0);
    if (i >= 0) merged[i] = union([merged[i]!, h]);
    else merged.push(h);
  }
  return merged;
}

// ─── Value location ──────────────────────────────────────────

export interface LocatedValue {
  box: PixelBox;
  source: PageWordSource;
  /** The page's own text for the matched tokens (independent second reading). */
  pageText: string;
}

function center(b: PixelBox): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Gap between two boxes (0 when they overlap). */
function boxGap(a: PixelBox, b: PixelBox): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/**
 * Distance from a label anchor to a candidate value box. Values sit below or
 * to the right of their label on IRS layouts, so candidates above-left of the
 * anchor are penalized rather than excluded.
 */
function anchorDistance(anchor: PixelBox, candidate: PixelBox): number {
  const [ax, ay] = center(anchor);
  const [cx, cy] = center(candidate);
  let d = Math.hypot(cx - ax, cy - ay);
  if (cy < anchor[1] - (anchor[3] - anchor[1])) d *= 3;
  return d;
}

/**
 * Locate a transcribed value among page words. Money compares parsed amounts
 * (so "$1,284.66" matches "1284.66"); other text compares normalized token
 * sequences using the first line of multi-line values. With several matches
 * (e.g. the same amount in boxes 1 and 16), the one nearest the box's printed
 * label wins; without a label anchor, an ambiguous value is not located.
 */
export function locateValue(
  value: string,
  words: readonly PageWord[],
  options: { money?: boolean; anchor?: PixelBox | null } = {},
): LocatedValue | null {
  const unique = findValueCandidates(value, words, options);
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0]!;
  if (!options.anchor) return null;
  return [...unique].sort((a, b) => anchorDistance(options.anchor!, a.box) - anchorDistance(options.anchor!, b.box))[0]!;
}

/**
 * Every place a transcribed value appears among the page words (duplicates
 * collapsed). Money compares parsed amounts; text compares the first line.
 */
export function findValueCandidates(
  value: string,
  words: readonly PageWord[],
  options: { money?: boolean } = {},
): LocatedValue[] {
  const toks = tokens(words);
  const candidates: Array<{ box: PixelBox; source: PageWordSource; text: string }> = [];
  const money = options.money ? parseMoneyToken(value.replace(/\s+/g, '')) : undefined;
  if (options.money && money === undefined) return [];

  if (money !== undefined) {
    for (let i = 0; i < toks.length; i++) {
      // Allow "$" and the amount to be separate tokens.
      for (const span of [1, 2]) {
        const group = toks.slice(i, i + span);
        if (group.length < span) continue;
        if (span === 2 && !sameLine(group[0]!.box, group[1]!.box)) continue;
        const text = group.map((t) => t.text).join('');
        if (parseMoneyToken(text) === money) {
          candidates.push({ box: union(group.map((t) => t.box)), source: group[0]!.word.source, text: group.map((t) => t.text).join(' ') });
        }
      }
    }
  } else {
    const firstLine = value.split(/\r?\n/)[0]!.trim();
    for (const box of findPhrase(words, firstLine)) {
      const src = toks.find((t) => t.box[0] >= box[0] - 1 && t.box[1] >= box[1] - 1)?.word.source ?? 'ocr';
      candidates.push({ box, source: src, text: firstLine });
    }
  }

  // A match inside another match ("1284.66" within "$ 1284.66") is the same value.
  const contains = (outer: PixelBox, inner: PixelBox) =>
    outer[0] <= inner[0] + 1 && outer[1] <= inner[1] + 1 && outer[2] >= inner[2] - 1 && outer[3] >= inner[3] - 1;
  return candidates
    .filter((c, i) => !candidates.some((o, j) => j !== i && contains(o.box, c.box) && (!contains(c.box, o.box) || j < i)))
    .map((c) => ({ box: c.box, source: c.source, pageText: c.text }));
}

/** Gap between a box and a region (0 inside it). Exported for form-instance selection. */
export function distanceToRegion(box: PixelBox, region: PixelBox): number {
  return boxGap(box, region);
}

export function unionBoxes(boxes: readonly PixelBox[]): PixelBox {
  return union(boxes);
}

// ─── Checkbox reading ────────────────────────────────────────

export type CheckboxDirection = 'below' | 'right' | 'left' | 'above';

export interface CheckboxSpec {
  /** Printed label next to the checkbox, e.g. "Retirement plan". */
  labelPhrase: string;
  /** Where the square sits relative to the label on the form layout. */
  direction: CheckboxDirection;
  /** Fallback when OCR cannot read the label: locate the squares by their table cell. */
  row?: CheckboxRowSpec;
  /**
   * Squares stacked one per printed line (1099-B box 2, 1099-SA box 5): search
   * only the label's own line, so a square that cannot be found is "unknown"
   * rather than the neighbouring line's square (measured: a faded 1099-B read
   * the checked long-term square for the short-term label).
   */
  sameRow?: boolean;
}

/**
 * A row of squares that fills one table cell (W-2 box 13). Small checkbox
 * labels are often lost on scans while the larger box numbers survive, so the
 * cell is found from a printed box number and the form's ruling lines.
 */
export interface CheckboxRowSpec {
  /**
   * Printed text tried in order. cellOffset 0 is the anchor's own cell, 1 the
   * cell directly below it, -1 the cell directly above it.
   */
  anchors: ReadonlyArray<{ phrase: string; cellOffset: -1 | 0 | 1 }>;
  /** Squares printed in the cell. Any other count found is "unknown". */
  count: number;
  /** This checkbox's position in the row, 0 = leftmost. */
  index: number;
}

export interface CheckboxReading {
  state: 'checked' | 'unchecked' | 'unknown';
  reason: string;
  /** Checkbox square in raster pixels when one was found. */
  square?: PixelBox;
  /** Share of dark pixels inside the square (excluding its border). */
  inkRatio?: number;
}

const CHECK_MARK_TOKENS = new Set(['x', '✓', '✔', '☑', '☒', '✗', '✘']);
/** Gray levels between the ink and paper means below which a region holds no ink. */
const MIN_INK_CONTRAST = 30;

/**
 * Ink threshold for a region by Otsu's method. Scans, faxes and faded copies
 * each get a threshold that fits their own contrast (measured: a faded copy
 * prints outlines near gray 190 on paper near 235). A region without real
 * contrast gets a threshold nothing reaches, so paper grain never reads as ink.
 */
function regionThreshold(r: PageRaster, region: PixelBox): number {
  const hist = new Array<number>(256).fill(0);
  let n = 0;
  for (let y = region[1]; y <= region[3]; y++) {
    for (let x = region[0]; x <= region[2]; x++) {
      hist[r.gray[y * r.width + x]!]!++;
      n++;
    }
  }
  if (n === 0) return 140;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  const between = new Float64Array(256);
  const separation = new Float64Array(256);
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    between[t] = wB * wF * (mB - mF) * (mB - mF);
    separation[t] = mF - mB;
  }
  const best = Math.max(...between);
  if (best === 0) return 60;
  // Near-binary pages (faxes) have a flat maximum across the whole gap between
  // ink and paper; its first value sits against the ink and drops the gray
  // edge pixels of thin outlines, so take the middle of the flat top.
  let first = -1;
  let last = -1;
  for (let t = 0; t < 256; t++) {
    if (between[t]! < best * 0.99) continue;
    if (first < 0) first = t;
    last = t;
  }
  // No ink/paper contrast (blank paper, grain): nothing in the region is ink.
  if (separation[first]! < MIN_INK_CONTRAST) return 60;
  return Math.max(60, Math.min(230, Math.round((first + last) / 2)));
}

function isInk(r: PageRaster, x: number, y: number, threshold: number): boolean {
  return r.gray[y * r.width + x]! <= threshold;
}

/**
 * A label's font size (em) and inked extent, measured from its glyphs: the
 * tallest letter (a capital or an ascender) is about 0.73 em. Word boxes are a
 * poor measure — text-layer boxes span the em, OCR boxes span the ink and
 * swell on noisy pages (measured: "12a" boxed 37 px tall on a faded copy whose
 * glyphs are 15 px; "requirement" boxed down onto the FATCA square below it).
 *
 * Faded glyphs break into fragments and shrink that measure, so it is held
 * within bounds set by the label's width: printed text runs about 0.52 em per
 * character (measured: a faded "determined" measured 11 px tall and let a
 * fragment of the "t" in "amount" pass as a checked square).
 */
function labelInk(r: PageRaster, label: PixelBox, chars: number): { em: number; ink: PixelBox } {
  const box: PixelBox = [
    Math.max(0, Math.floor(label[0])), Math.max(0, Math.floor(label[1])),
    Math.min(r.width - 1, Math.ceil(label[2])), Math.min(r.height - 1, Math.ceil(label[3])),
  ];
  const boxHeight = box[3] - box[1] + 1;
  const glyphs = inkComponents(r, box, regionThreshold(r, box), Infinity).filter((c) => {
    const w = c[2] - c[0] + 1;
    const h = c[3] - c[1] + 1;
    // Ruling lines crossing the box and bars clipped from shapes beside it are not letters.
    return !(w < 0.15 * h && h >= 0.9 * boxHeight) && w <= 2.5 * h;
  });
  const tallest = Math.max(0, ...glyphs.map((c) => c[3] - c[1] + 1));
  const letters = glyphs.filter((c) => c[3] - c[1] + 1 >= 0.5 * tallest);
  const widthEm = (label[2] - label[0]) / (Math.max(1, chars) * 0.52);
  const em = letters.length > 0 ? Math.min(1.3 * widthEm, Math.max(0.85 * widthEm, tallest / 0.73)) : widthEm;
  const ink = letters.length > 0 ? union(letters) : null;
  // Too little ink for a word: use the word box, cut to one em below its top
  // (swollen OCR boxes grow mostly downward).
  if (!ink || ink[3] - ink[1] < 0.4 * em) return { em, ink: [label[0], label[1], label[2], Math.min(label[3], label[1] + em)] };
  return { em, ink };
}

/**
 * Where to look for the square, in label ems. Measured on the 2026 IRS forms:
 * squares sit up to 9.6 em right of the label's end and 1.8 em below its
 * baseline ("right"), and up to 3.3 em below the label (W-2 box 13).
 */
/** A search region cut to the label's own line (squares are about one em tall). */
function sameRowRegion(region: PixelBox, label: PixelBox, em: number): PixelBox {
  const mid = (label[1] + label[3]) / 2;
  return [region[0], Math.max(region[1], Math.floor(mid - 1.1 * em)), region[2], Math.min(region[3], Math.ceil(mid + 1.1 * em))];
}

function searchRegion(label: PixelBox, direction: CheckboxDirection, r: PageRaster, em: number): PixelBox {
  const h = em;
  const w = label[2] - label[0];
  const clamp = (b: [number, number, number, number]): PixelBox => [
    Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])),
    Math.min(r.width - 1, Math.ceil(b[2])), Math.min(r.height - 1, Math.ceil(b[3])),
  ];
  switch (direction) {
    case 'below': return clamp([label[0] - h, label[3], label[2] + h, label[3] + 4 * h]);
    case 'above': return clamp([label[0] - h, label[1] - 4 * h, label[2] + h, label[1]]);
    // Squares often sit at the far right of the label's cell.
    case 'right': return clamp([label[2], label[1] - h, label[2] + Math.max(12 * h, w), label[3] + 2.2 * h]);
    case 'left': return clamp([label[0] - 6 * h, label[1] - h, label[0], label[3] + h]);
  }
}

/**
 * Bounding boxes of 8-connected ink components in a region (specks and
 * oversized shapes dropped). Ink runs longer than maxSide are ruling lines and
 * are left out first: on blurred pages a square touches the rule beside it and
 * would otherwise vanish into one oversized shape (measured: faded CORRECTED).
 */
function inkComponents(r: PageRaster, region: PixelBox, threshold: number, maxSide: number): PixelBox[] {
  const [x0, y0, x1, y1] = region;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  if (Number.isFinite(maxSide)) markRuns(r, region, threshold, maxSide, seen);
  const out: PixelBox[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y - y0) * w + (x - x0);
      if (seen[idx] || !isInk(r, x, y, threshold)) continue;
      let bx0 = x, by0 = y, bx1 = x, by1 = y;
      const stack = [x, y];
      seen[idx] = 1;
      while (stack.length) {
        const cy = stack.pop()!;
        const cx = stack.pop()!;
        if (cx < bx0) bx0 = cx; if (cx > bx1) bx1 = cx;
        if (cy < by0) by0 = cy; if (cy > by1) by1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const nidx = (ny - y0) * w + (nx - x0);
            if (seen[nidx] || !isInk(r, nx, ny, threshold)) continue;
            seen[nidx] = 1;
            stack.push(nx, ny);
          }
        }
      }
      const sw = bx1 - bx0 + 1;
      const sh = by1 - by0 + 1;
      if (Math.max(sw, sh) < 3 || sw > maxSide || sh > maxSide) continue;
      out.push([bx0, by0, bx1, by1]);
    }
  }
  return out;
}

/** Mark horizontal and vertical ink runs longer than maxRun in a region's `seen` map. */
function markRuns(r: PageRaster, [x0, y0, x1, y1]: PixelBox, threshold: number, maxRun: number, seen: Uint8Array): void {
  const w = x1 - x0 + 1;
  for (let y = y0; y <= y1; y++) {
    let start = -1;
    for (let x = x0; x <= x1 + 1; x++) {
      const ink = x <= x1 && isInk(r, x, y, threshold);
      if (ink && start < 0) start = x;
      if (!ink && start >= 0) {
        if (x - start > maxRun) for (let i = start; i < x; i++) seen[(y - y0) * w + (i - x0)] = 1;
        start = -1;
      }
    }
  }
  for (let x = x0; x <= x1; x++) {
    let start = -1;
    for (let y = y0; y <= y1 + 1; y++) {
      const ink = y <= y1 && isInk(r, x, y, threshold);
      if (ink && start < 0) start = y;
      if (!ink && start >= 0) {
        if (y - start > maxRun) for (let j = start; j < y; j++) seen[(j - y0) * w + (x - x0)] = 1;
        start = -1;
      }
    }
  }
}

/**
 * Groups of components lying within `gap` pixels of each other, as one box.
 * A faxed or scanned outline breaks into fragments that belong together.
 */
function mergedFragments(components: readonly PixelBox[], gap: number, maxSide: number): PixelBox[] {
  const parent = components.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (boxGap(components[i]!, components[j]!) <= gap) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, PixelBox[]>();
  components.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map(union)
    .filter((b) => b[2] - b[0] < maxSide && b[3] - b[1] < maxSide);
}

/**
 * Pairs of pieces that share both side edges (stacked) or both top and bottom
 * edges (side by side) within 2 px, less than maxGap apart: a square whose two
 * sides dropped out over the same stretch. Measured: a faxed 1099-R box 7c lost
 * 7 px of both side edges and split into a top and a bottom piece.
 */
function alignedPairs(components: readonly PixelBox[], maxGap: number): PixelBox[] {
  const out: PixelBox[] = [];
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i]!;
      const b = components[j]!;
      const stacked = Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[2] - b[2]) <= 2
        && Math.max(a[1], b[1]) - Math.min(a[3], b[3]) <= maxGap;
      const sideBySide = Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[3] - b[3]) <= 2
        && Math.max(a[0], b[0]) - Math.min(a[2], b[2]) <= maxGap;
      if (stacked || sideBySide) out.push(union([a, b]));
    }
  }
  return out;
}

/**
 * A drawn square: every edge mostly inked and ink at all four corners.
 * Letters touch their bounding box on two or three sides (E, H, M fail an
 * edge) or have rounded corners (D, O, B fail a corner). An edge may wander
 * up to 2 px inward on larger squares — residual skew and fax jaggies shift
 * it along its length (measured: a faxed 1099-R box 7c edge drifted 2 px).
 */
function hasSquareOutline(r: PageRaster, [bx0, by0, bx1, by1]: PixelBox, threshold: number): boolean {
  const w = bx1 - bx0 + 1;
  const h = by1 - by0 + 1;
  const tol = Math.min(w, h) >= 16 ? 2 : 1;
  const inkInward = (x: number, y: number, dx: number, dy: number) => {
    for (let k = 0; k <= tol; k++) if (isInk(r, x + dx * k, y + dy * k, threshold)) return true;
    return false;
  };
  const coverage = (n: number, at: (i: number) => boolean) => {
    let ink = 0;
    for (let i = 0; i < n; i++) if (at(i)) ink++;
    return ink / n;
  };
  const corner = (x: number, y: number, dx: number, dy: number) => {
    for (let j = 0; j <= tol; j++) for (let i = 0; i <= tol; i++) if (isInk(r, x + dx * i, y + dy * j, threshold)) return true;
    return false;
  };
  const edges = Math.min(
    coverage(w, (i) => inkInward(bx0 + i, by0, 0, 1)),
    coverage(w, (i) => inkInward(bx0 + i, by1, 0, -1)),
    coverage(h, (j) => inkInward(bx0, by0 + j, 1, 0)),
    coverage(h, (j) => inkInward(bx1, by0 + j, -1, 0)),
  );
  return edges >= SQUARE_EDGE_INK
    && corner(bx0, by0, 1, 1) && corner(bx1, by0, -1, 1) && corner(bx0, by1, 1, -1) && corner(bx1, by1, -1, -1);
}

/** Share of each edge that must be inked for a shape to count as a square. */
const SQUARE_EDGE_INK = 0.5;

/**
 * Find checkbox squares in a region: roughly square shapes with all four
 * edges drawn, 0.8 to 2.5 label ems on a side. IRS squares measure 0.93 to 2
 * em; a letter is at most about 0.75 em tall. Measured: without the size
 * floor the letter "a" below "March" read as a checked 1098-T box 7 on a scan.
 */
function findSquares(r: PageRaster, region: PixelBox, em: number, threshold: number): PixelBox[] {
  const minSide = Math.max(4, em * 0.8);
  const maxSide = em * 2.5;
  const squares: PixelBox[] = [];
  // A second, stricter pass separates a square from blurred text beside it
  // (measured: faded W-2 box 13 squares fused with their labels 3 px above).
  for (const t of threshold - 20 >= 60 ? [threshold, threshold - 20] : [threshold]) {
    const components = inkComponents(r, region, t, maxSide * 1.1);
    // Whole components first; pieces of broken outlines only where no square was found.
    for (const b of [...components, ...mergedFragments(components, 2, maxSide), ...alignedPairs(components, 0.5 * em)]) {
      const sw = b[2] - b[0] + 1;
      const sh = b[3] - b[1] + 1;
      if (sw < minSide || sh < minSide || sw > maxSide || sh > maxSide) continue;
      if (sw / sh < 0.75 || sw / sh > 1.33) continue;
      if (squares.some((q) => boxGap(q, b) === 0)) continue;
      if (!hasSquareOutline(r, b, t)) continue;
      squares.push(b);
    }
  }
  return squares;
}

/**
 * Ink share in the central half of the square. A slightly rotated border
 * crosses the outer quarter of the bounding box, so only the center counts —
 * measured: an 18% inset read an empty skewed square as checked.
 */
function interiorInkRatio(r: PageRaster, sq: PixelBox, threshold: number): number {
  const insetX = Math.max(2, Math.round((sq[2] - sq[0]) * 0.25));
  const insetY = Math.max(2, Math.round((sq[3] - sq[1]) * 0.25));
  let ink = 0;
  let total = 0;
  for (let y = sq[1] + insetY; y <= sq[3] - insetY; y++) {
    for (let x = sq[0] + insetX; x <= sq[2] - insetX; x++) {
      total++;
      if (isInk(r, x, y, threshold)) ink++;
    }
  }
  return total > 0 ? ink / total : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Gray level that counts as a mark inside a square: halfway between the
 * square's own outline and the paper around it. A mark is drawn as dark as
 * the outline; paper grain stays near the paper level. Judging the interior
 * with the outline-finding threshold let grain on a faded copy read as a mark.
 */
function markThreshold(r: PageRaster, [x0, y0, x1, y1]: PixelBox, threshold: number): number {
  const gray = (x: number, y: number) => r.gray[y * r.width + x]!;
  const outline: number[] = [];
  for (let x = x0; x <= x1; x++) {
    for (const y of [y0, y0 + 1, y1 - 1, y1]) if (gray(x, y) <= threshold) outline.push(gray(x, y));
  }
  for (let y = y0; y <= y1; y++) {
    for (const x of [x0, x0 + 1, x1 - 1, x1]) if (gray(x, y) <= threshold) outline.push(gray(x, y));
  }
  const paper: number[] = [];
  const pad = Math.max(3, Math.round((x1 - x0) * 0.25));
  for (let y = Math.max(0, y0 - pad); y <= Math.min(r.height - 1, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x <= Math.min(r.width - 1, x1 + pad); x++) {
      const outside = x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1;
      if (outside && gray(x, y) > threshold) paper.push(gray(x, y));
    }
  }
  if (outline.length === 0 || paper.length === 0) return threshold;
  return (median(outline) + median(paper)) / 2;
}

// ─── Table cells (ruling lines) ──────────────────────────────

/** A ruling line inks nearly every pixel along its length. */
const RULE_INK = 0.9;

/** Share of a line segment that is inked, allowing 1 px of wobble across the line. */
function lineInk(r: PageRaster, threshold: number, horizontal: boolean, at: number, from: number, to: number): number {
  let ink = 0;
  let total = 0;
  for (let p = Math.max(0, from); p <= Math.min(to, (horizontal ? r.width : r.height) - 1); p++) {
    total++;
    for (let d = -1; d <= 1; d++) {
      const x = horizontal ? p : at + d;
      const y = horizontal ? at + d : p;
      if (x < 0 || y < 0 || x >= r.width || y >= r.height) continue;
      if (isInk(r, x, y, threshold)) { ink++; break; }
    }
  }
  return total > 0 ? ink / total : 0;
}

/** First ruling line from `start` in direction `step` (+1 / -1), within `limit` pixels. */
function findRule(
  r: PageRaster, threshold: number, horizontal: boolean,
  start: number, step: 1 | -1, limit: number, from: number, to: number,
): number | null {
  const size = horizontal ? r.height : r.width;
  for (let i = 0, at = Math.round(start); i < limit; i++, at += step) {
    if (at < 1 || at >= size - 1) return null;
    if (lineInk(r, threshold, horizontal, at, from, to) >= RULE_INK) return at;
  }
  return null;
}

/** Step past a (possibly several pixels thick) horizontal ruling line. */
function pastRule(r: PageRaster, threshold: number, at: number, step: 1 | -1, from: number, to: number): number {
  let y = at;
  while (y > 0 && y < r.height - 1 && lineInk(r, threshold, true, y, from, to) >= RULE_INK) y += step;
  return y;
}

/**
 * The table cell holding a printed label, bounded by ruling lines, optionally
 * stepped to the cell directly below or above. Horizontal rules are probed
 * just right of the label's left edge so a neighbouring column's rules are not
 * taken for this column's. Null when any bounding rule is missing.
 */
function tableCell(r: PageRaster, threshold: number, label: PixelBox, cellOffset: -1 | 0 | 1): PixelBox | null {
  const h = Math.max(4, label[3] - label[1]);
  const from = Math.round(label[0]);
  const to = Math.round(label[0] + 6 * h);
  const midY = (label[1] + label[3]) / 2;
  let top = findRule(r, threshold, true, midY, -1, 20 * h, from, to);
  let bottom = findRule(r, threshold, true, midY, 1, 20 * h, from, to);
  if (top === null || bottom === null) return null;
  if (cellOffset === 1) {
    top = bottom;
    bottom = findRule(r, threshold, true, pastRule(r, threshold, top, 1, from, to), 1, 20 * h, from, to);
  } else if (cellOffset === -1) {
    bottom = top;
    top = findRule(r, threshold, true, pastRule(r, threshold, bottom, -1, from, to), -1, 20 * h, from, to);
  }
  if (top === null || bottom === null || bottom - top < 2 * h) return null;
  // Vertical rules must span the cell's full height between its horizontal rules.
  const left = findRule(r, threshold, false, label[0], -1, 4 * h, top + 3, bottom - 3);
  const right = findRule(r, threshold, false, to, 1, 80 * h, top + 3, bottom - 3);
  if (left === null || right === null) return null;
  return [left, top, right, bottom];
}

/**
 * Read one square of a checkbox row from its table cell. The cell must hold
 * exactly `count` squares of one size on one line; anything else is unknown.
 * Null when no anchor led to a cell.
 */
function readCheckboxRow(
  raster: PageRaster,
  words: readonly PageWord[],
  row: CheckboxRowSpec,
  near: PixelBox | null | undefined,
): CheckboxReading | null {
  for (const anchor of row.anchors) {
    const hits = findPhrase(words, anchor.phrase);
    if (hits.length === 0 || (hits.length > 1 && !near)) continue;
    const label = hits.length === 1 ? hits[0]! : [...hits].sort((a, b) => boxGap(a, near!) - boxGap(b, near!))[0]!;
    const h = label[3] - label[1];
    const around: PixelBox = [
      Math.max(0, Math.floor(label[0] - 4 * h)), Math.max(0, Math.floor(label[1] - 20 * h)),
      Math.min(raster.width - 1, Math.ceil(label[0] + 40 * h)), Math.min(raster.height - 1, Math.ceil(label[3] + 20 * h)),
    ];
    const cell = tableCell(raster, regionThreshold(raster, around), label, anchor.cellOffset);
    if (!cell) continue;
    // Squares can sit 3 px from the cell's rule at 200 dpi; the rules themselves
    // are masked as long ink runs, so only the rule's own pixel is inset.
    const inner: PixelBox = [cell[0] + 1, cell[1] + 1, cell[2] - 1, cell[3] - 1];
    const threshold = regionThreshold(raster, inner);
    const squares = findSquares(raster, inner, labelInk(raster, label, anchor.phrase.length).em, threshold).sort((a, b) => a[0] - b[0]);
    const where = anchor.cellOffset === 0 ? `the cell of "${anchor.phrase}"`
      : `the cell ${anchor.cellOffset === 1 ? 'below' : 'above'} "${anchor.phrase}"`;
    if (squares.length !== row.count) {
      return { state: 'unknown', reason: `${squares.length} squares in ${where}, expected ${row.count}` };
    }
    const sides = squares.map((q) => Math.max(q[2] - q[0], q[3] - q[1]));
    const middles = squares.map((q) => (q[1] + q[3]) / 2);
    if (Math.max(...sides) > 1.3 * Math.min(...sides) || Math.max(...middles) - Math.min(...middles) > 0.5 * Math.min(...sides)) {
      return { state: 'unknown', reason: `squares in ${where} are not one row` };
    }
    const square = squares[row.index]!;
    const ratio = interiorInkRatio(raster, square, markThreshold(raster, square, threshold));
    const which = `square ${row.index + 1} of ${row.count} in ${where}`;
    if (ratio >= CHECKED_INK) return { state: 'checked', reason: `mark inside ${which}`, square, inkRatio: ratio };
    if (ratio <= EMPTY_INK) return { state: 'unchecked', reason: `${which} is empty`, square, inkRatio: ratio };
    return { state: 'unknown', reason: `${which} is faint (ink ${ratio.toFixed(3)})`, square, inkRatio: ratio };
  }
  return null;
}

/** Interior ink above this share is a mark; below EMPTY is an empty square. */
const CHECKED_INK = 0.08;
const EMPTY_INK = 0.03;

/**
 * Read one checkbox next to its printed label. A printed check glyph in the
 * search area counts as checked; otherwise the square's interior ink decides.
 * Missing label, missing square, several candidate squares or ink between the
 * thresholds all return "unknown" (→ preparer review), never a guess.
 */
export function readCheckbox(
  raster: PageRaster,
  words: readonly PageWord[],
  spec: CheckboxSpec,
  /**
   * Region of the form instance being read (e.g. the union of its located
   * values). Pages often carry several copies of a form; with this, the label
   * occurrence nearest the instance is used. Without it, a repeated label is
   * ambiguous and the answer is "unknown".
   */
  near?: PixelBox | null,
): CheckboxReading {
  const labels = findPhrase(words, spec.labelPhrase);
  if (labels.length === 0) {
    const fromRow = spec.row ? readCheckboxRow(raster, words, spec.row, near) : null;
    return fromRow ?? { state: 'unknown', reason: `label "${spec.labelPhrase}" not found on the page` };
  }
  if (labels.length > 1 && !near) return { state: 'unknown', reason: `label "${spec.labelPhrase}" appears ${labels.length} times` };
  const label = labels.length === 1 ? labels[0]! : [...labels].sort((a, b) => boxGap(a, near!) - boxGap(b, near!))[0]!;
  const { em, ink } = labelInk(raster, label, spec.labelPhrase.length);
  const region = spec.sameRow ? sameRowRegion(searchRegion(ink, spec.direction, raster, em), ink, em) : searchRegion(ink, spec.direction, raster, em);

  const glyph = words.find((w) => {
    if (!CHECK_MARK_TOKENS.has(normalizeToken(w.text)) && !CHECK_MARK_TOKENS.has(w.text.trim())) return false;
    const [cx, cy] = center(w.box);
    return cx >= region[0] && cx <= region[2] && cy >= region[1] && cy <= region[3];
  });
  if (glyph) return { state: 'checked', reason: `printed mark "${glyph.text}" next to "${spec.labelPhrase}"`, square: glyph.box };

  const threshold = regionThreshold(raster, region);
  const squares = findSquares(raster, region, em, threshold);
  if (squares.length === 0) {
    // A square set apart from its label (a cell's far corner) is found by its table cell.
    const fromRow = spec.row ? readCheckboxRow(raster, words, spec.row, near) : null;
    return fromRow ?? { state: 'unknown', reason: `no checkbox square found ${spec.direction} "${spec.labelPhrase}"` };
  }
  // Nearest square to the label when the region holds more than one.
  const square = [...squares].sort((a, b) => anchorDistance(label, a) - anchorDistance(label, b))[0]!;
  const ratio = interiorInkRatio(raster, square, markThreshold(raster, square, threshold));
  if (ratio >= CHECKED_INK) return { state: 'checked', reason: `mark inside the "${spec.labelPhrase}" square`, square, inkRatio: ratio };
  if (ratio <= EMPTY_INK) return { state: 'unchecked', reason: `"${spec.labelPhrase}" square is empty`, square, inkRatio: ratio };
  return { state: 'unknown', reason: `"${spec.labelPhrase}" square is faint (ink ${ratio.toFixed(3)})`, square, inkRatio: ratio };
}

// ─── W-2 box 12 codes ────────────────────────────────────────

/** Box 12 codes listed in the current General Instructions for Forms W-2 and W-3. */
export const W2_BOX12_CODES = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y', 'Z',
  'AA', 'BB', 'DD', 'EE', 'FF', 'GG', 'HH', 'II',
] as const;

const BOX12_CODE_SET = new Set<string>(W2_BOX12_CODES);

/**
 * Read a whole box 12 entry (code + amount) printed under its slot label
 * ("12a", "12b", ...) when the document model returned nothing for the slot.
 * Both parts must be present: an official code and a parseable amount on the
 * same line, inside the slot's cell. Otherwise null.
 */
export function readBox12Entry(
  slot: string,
  words: readonly PageWord[],
  near?: PixelBox | null,
): { code: string; amount: string; codeBox: PixelBox; amountBox: PixelBox } | null {
  const labels = findPhrase(words, slot);
  if (labels.length === 0 || (labels.length > 1 && !near)) return null;
  const label = labels.length === 1 ? labels[0]! : [...labels].sort((a, b) => boxGap(a, near!) - boxGap(b, near!))[0]!;
  const h = label[3] - label[1];
  // The slot's cell: from the label down about two text lines, across the column.
  const cell: PixelBox = [label[0] - h, label[1], label[0] + 16 * h, label[3] + 2.5 * h];
  const inCell = tokens(words).filter((t) => {
    const [cx, cy] = center(t.box);
    return cx >= cell[0] && cx <= cell[2] && cy > label[3] - h * 0.2 && cy <= cell[3];
  });
  const amounts = inCell.filter((t) => parseMoneyToken(t.text) !== undefined && /[.,]/.test(t.text));
  if (amounts.length !== 1) return null;
  const amount = amounts[0]!;
  const cellWords: PageWord[] = inCell.map((t) => ({ ...t.word, text: t.text, box: t.box }));
  const code = readBox12Code(amount.box, cellWords);
  if (!code) return null;
  const codeTok = inCell.find((t) => t.text.trim().toUpperCase() === code)!;
  return { code, amount: amount.text, codeBox: codeTok.box, amountBox: amount.box };
}

/**
 * Read the box 12 code printed on the same line, left of a located amount.
 * Only official codes count; anything else leaves the code unknown.
 */
export function readBox12Code(amount: PixelBox, words: readonly PageWord[]): string | null {
  return box12CodeAt(amount, words)?.code ?? null;
}

/**
 * The official box 12 code nearest to the left of an amount on its line, with
 * its position. The nearest one: W-2s print the word "Code" vertically at the
 * left of every slot, and its "C" is itself an official code.
 */
export function box12CodeAt(amount: PixelBox, words: readonly PageWord[]): { code: string; box: PixelBox } | null {
  const height = amount[3] - amount[1];
  const found = tokens(words)
    .filter((t) => sameLine(t.box, amount) && t.box[2] <= amount[0] + 1 && amount[0] - t.box[2] < 12 * height)
    .map((t) => ({ code: t.text.trim().toUpperCase(), box: t.box }))
    .filter((t) => BOX12_CODE_SET.has(t.code))
    .sort((a, b) => b.box[2] - a.box[2]);
  return found[0] ?? null;
}

// ─── Multi-line blocks ───────────────────────────────────────

/**
 * Line breaks for a block (name and address) that a model returned on one
 * line, read from the page: each next word must continue its printed line
 * (same line, just right of the previous word) or start the next line (just
 * below, aligned with the block's left edge). Words are matched by position,
 * not reading order — OCR joins text from neighbouring columns into one line.
 * Null unless the page shows the whole value, over more than one line.
 * Measured: a model returned "SUMMIT INDEX FUNDS PO BOX 2200 VALLEY FORGE PA
 * 19482" on one line, so the payer name took in the whole address.
 */
/**
 * A comma a model put at the end of a printed line (writing the block as one
 * sentence) is a separator, not text: drop it unless the page prints it there.
 */
function dropSeparatorComma(line: string[], pageToken: { text: string }): void {
  const last = line[line.length - 1]!;
  if (/,$/.test(last) && !/,$/.test(pageToken.text)) line[line.length - 1] = last.replace(/,+$/, '');
}

export function restoreLineBreaks(value: string, words: readonly PageWord[]): string | null {
  if (/\n/.test(value)) return null;
  const wanted = value.trim().split(/\s+/);
  if (wanted.length < 2) return null;
  const toks = tokens(words);
  const matching = (w: string) => toks.filter((t) => wordMatches(t.text, w));
  for (const first of matching(wanted[0]!)) {
    const lines: string[][] = [[wanted[0]!]];
    let prev = first;
    let lineStart = first;
    let ok = true;
    for (const w of wanted.slice(1)) {
      const h = prev.box[3] - prev.box[1];
      const across = matching(w)
        .filter((t) => sameLine(prev.box, t.box) && t.box[0] >= prev.box[2] - 1 && t.box[0] - prev.box[2] < 3 * h)
        .sort((a, b) => a.box[0] - b.box[0])[0];
      const down = across ? undefined : matching(w)
        .filter((t) => t.box[1] > prev.box[1] + 0.5 * h && t.box[1] - prev.box[3] < 1.5 * h && Math.abs(t.box[0] - lineStart.box[0]) < 2 * h)
        .sort((a, b) => a.box[1] - b.box[1])[0];
      if (across) {
        lines[lines.length - 1]!.push(w);
        prev = across;
      } else if (down) {
        dropSeparatorComma(lines[lines.length - 1]!, prev);
        lines.push([w]);
        prev = down;
        lineStart = down;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && lines.length > 1) {
      dropSeparatorComma(lines[lines.length - 1]!, prev);
      return lines.map((l) => l.join(' ')).join('\n');
    }
  }
  return null;
}

// ─── OCR word boxes ──────────────────────────────────────────

/** The subset of a tesseract.js `recognize(..., { blocks: true })` result used here. */
export interface TesseractBlocks {
  blocks?: Array<{
    paragraphs: Array<{
      lines: Array<{
        words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
      }>;
    }>;
  }> | null;
}

/**
 * Convert tesseract.js word boxes into page words (raster pixels). Empty words
 * are dropped; the engine's confidence is kept so a low-confidence second
 * reading can be weighed accordingly.
 */
export function wordsFromTesseract(data: TesseractBlocks): PageWord[] {
  const out: PageWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text) continue;
          out.push({ text, source: 'ocr', confidence: w.confidence, box: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] });
        }
      }
    }
  }
  return out;
}
