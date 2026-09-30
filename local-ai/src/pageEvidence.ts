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
  return hits;
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
const INK = 140;

function isInk(r: PageRaster, x: number, y: number): boolean {
  return r.gray[y * r.width + x]! < INK;
}

function searchRegion(label: PixelBox, direction: CheckboxDirection, r: PageRaster): PixelBox {
  const h = label[3] - label[1];
  const w = label[2] - label[0];
  const clamp = (b: [number, number, number, number]): PixelBox => [
    Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])),
    Math.min(r.width - 1, Math.ceil(b[2])), Math.min(r.height - 1, Math.ceil(b[3])),
  ];
  switch (direction) {
    case 'below': return clamp([label[0] - h, label[3], label[2] + h, label[3] + 4 * h]);
    case 'above': return clamp([label[0] - h, label[1] - 4 * h, label[2] + h, label[1]]);
    // Squares often sit at the far right of the label's cell.
    case 'right': return clamp([label[2], label[1] - h, label[2] + Math.max(12 * h, w), label[3] + 2 * h]);
    case 'left': return clamp([label[0] - 6 * h, label[1] - h, label[0], label[3] + h]);
  }
}

/**
 * Find checkbox squares in a region: connected ink components whose bounding
 * box is roughly square, about one to three text heights on a side, with a
 * mostly-inked outline.
 */
function findSquares(r: PageRaster, region: PixelBox, textHeight: number): PixelBox[] {
  const [x0, y0, x1, y1] = region;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  const squares: PixelBox[] = [];
  const minSide = Math.max(4, textHeight * 0.6);
  const maxSide = textHeight * 3;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y - y0) * w + (x - x0);
      if (seen[idx] || !isInk(r, x, y)) continue;
      // Flood fill (8-connected) to the component's bounding box.
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
            if (seen[nidx] || !isInk(r, nx, ny)) continue;
            seen[nidx] = 1;
            stack.push(nx, ny);
          }
        }
      }
      const sw = bx1 - bx0 + 1;
      const sh = by1 - by0 + 1;
      if (sw < minSide || sh < minSide || sw > maxSide || sh > maxSide) continue;
      if (sw / sh < 0.75 || sw / sh > 1.33) continue;
      // Outline check: most of each edge is inked.
      let edgeInk = 0;
      let edgeTotal = 0;
      for (let i = bx0; i <= bx1; i++) { edgeTotal += 2; if (isInk(r, i, by0)) edgeInk++; if (isInk(r, i, by1)) edgeInk++; }
      for (let j = by0; j <= by1; j++) { edgeTotal += 2; if (isInk(r, bx0, j)) edgeInk++; if (isInk(r, bx1, j)) edgeInk++; }
      if (edgeInk / edgeTotal < 0.7) continue;
      squares.push([bx0, by0, bx1, by1]);
    }
  }
  return squares;
}

function interiorInkRatio(r: PageRaster, sq: PixelBox): number {
  const insetX = Math.max(2, Math.round((sq[2] - sq[0]) * 0.18));
  const insetY = Math.max(2, Math.round((sq[3] - sq[1]) * 0.18));
  let ink = 0;
  let total = 0;
  for (let y = sq[1] + insetY; y <= sq[3] - insetY; y++) {
    for (let x = sq[0] + insetX; x <= sq[2] - insetX; x++) {
      total++;
      if (isInk(r, x, y)) ink++;
    }
  }
  return total > 0 ? ink / total : 0;
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
  if (labels.length === 0) return { state: 'unknown', reason: `label "${spec.labelPhrase}" not found on the page` };
  if (labels.length > 1 && !near) return { state: 'unknown', reason: `label "${spec.labelPhrase}" appears ${labels.length} times` };
  const label = labels.length === 1 ? labels[0]! : [...labels].sort((a, b) => boxGap(a, near!) - boxGap(b, near!))[0]!;
  const textHeight = label[3] - label[1];
  const region = searchRegion(label, spec.direction, raster);

  const glyph = words.find((w) => {
    if (!CHECK_MARK_TOKENS.has(normalizeToken(w.text)) && !CHECK_MARK_TOKENS.has(w.text.trim())) return false;
    const [cx, cy] = center(w.box);
    return cx >= region[0] && cx <= region[2] && cy >= region[1] && cy <= region[3];
  });
  if (glyph) return { state: 'checked', reason: `printed mark "${glyph.text}" next to "${spec.labelPhrase}"`, square: glyph.box };

  const squares = findSquares(raster, region, textHeight);
  if (squares.length === 0) return { state: 'unknown', reason: `no checkbox square found ${spec.direction} "${spec.labelPhrase}"` };
  // Nearest square to the label when the region holds more than one.
  const square = [...squares].sort((a, b) => anchorDistance(label, a) - anchorDistance(label, b))[0]!;
  const ratio = interiorInkRatio(raster, square);
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
  const height = amount[3] - amount[1];
  const found = tokens(words)
    .filter((t) => sameLine(t.box, amount) && t.box[2] <= amount[0] + 1 && amount[0] - t.box[2] < 12 * height)
    .map((t) => ({ code: t.text.trim().toUpperCase(), box: t.box }))
    .filter((t) => BOX12_CODE_SET.has(t.code))
    .sort((a, b) => b.box[2] - a.box[2]);
  return found[0]?.code ?? null;
}
