/**
 * Reconcile a model's transcription with the page itself (work order §31,
 * §33, §59, §72 "low confidence becomes review, not a guess").
 *
 * Given the schema box values a document model transcribed, and independent
 * page evidence (text-layer or OCR word boxes plus the grayscale raster):
 *
 *   1. locate every transcribed value on the page → real source boxes and an
 *      independent second reading (agreement);
 *   2. pick one form instance when the page repeats the form (employer PDFs
 *      often print Copy B, C and 2 on one sheet) and read within it;
 *   3. read checkboxes deterministically (checked / empty square → explicit
 *      "no" / anything else → "?" which routes the box to review);
 *   4. fill a missing W-2 box 12 code from the code printed beside its amount.
 *
 * Model text is never overwritten by guesses: a checkbox the page cannot
 * settle becomes "?", a box 12 code that is not an official code stays absent.
 */

import type { FormBoxSchema, FormExtractionSchema } from './formSchemas.js';
import {
  distanceToRegion,
  findPhrase,
  findValueCandidates,
  readBox12Code,
  readBox12Entry,
  readCheckbox,
  unionBoxes,
  type CheckboxReading,
  type LocatedValue,
  type PageRaster,
  type PageWord,
  type PixelBox,
} from './pageEvidence.js';

export interface PageEvidence {
  words: readonly PageWord[];
  raster: PageRaster;
}

export interface FormEvidenceResult {
  /** Box values after deterministic checkbox / box 12 reading. */
  values: Record<string, string>;
  /** Where each transcribed value was found on the page (null = not found). */
  located: Record<string, LocatedValue | null>;
  checkboxes: Record<string, CheckboxReading>;
  /** Box 12 codes read from the page (slot → code) when the model omitted them. */
  box12Codes: Record<string, string>;
  /**
   * Whole box 12 entries read from the page when the model returned nothing for
   * the slot. Single-source evidence: confidence scoring must treat these as
   * unconfirmed by a second reader.
   */
  box12FromPage: Record<string, { code: string; amount: string }>;
  /**
   * Box keys whose transcribed value is printed only once on the page but was
   * also claimed by an earlier box — removed as phantom copies.
   */
  phantoms: string[];
  /** Region of the form instance that was read, when any value was located. */
  region: PixelBox | null;
}

const LOCATABLE_KINDS = new Set(['money', 'text', 'tin', 'code', 'date', 'percent', 'integer', 'stateCode', 'stateAndId']);

/** Printed words that identify a box's label on the page. */
function anchorPhrase(b: FormBoxSchema): string | null {
  if (b.key.endsWith('.code') || b.key.endsWith('.amount')) return b.box || null;
  const firstWord = b.label.replace(/\s*\(line \d\)$/, '').split(/\s+/)[0]!;
  if (b.box) return `${b.box} ${firstWord}`;
  return b.label.split(/\s+/).slice(0, 2).join(' ');
}

function nearestTo(candidates: readonly LocatedValue[], target: PixelBox): LocatedValue {
  return [...candidates].sort((a, b) => distanceToRegion(a.box, target) - distanceToRegion(b.box, target))[0]!;
}

export function applyPageEvidence(
  schema: FormExtractionSchema,
  transcribed: Readonly<Record<string, string>>,
  page: PageEvidence,
): FormEvidenceResult {
  const values: Record<string, string> = { ...transcribed };
  const located: Record<string, LocatedValue | null> = {};
  const boxByKey = new Map(schema.boxes.map((b) => [b.key, b]));

  // 1. Candidate locations for every transcribed, locatable value.
  const candidates = new Map<string, LocatedValue[]>();
  for (const [key, text] of Object.entries(values)) {
    const b = boxByKey.get(key);
    if (!b || !LOCATABLE_KINDS.has(b.kind)) continue;
    candidates.set(key, findValueCandidates(text, page.words, { money: b.kind === 'money' }));
  }

  // 2. Choose one form instance: seed with the top-left occurrence of the first
  //    located amount, then take each value's occurrence nearest that seed.
  const seedKey = schema.boxes.find((b) => b.kind === 'money' && (candidates.get(b.key)?.length ?? 0) > 0)?.key
    ?? [...candidates.keys()].find((k) => candidates.get(k)!.length > 0);
  let region: PixelBox | null = null;
  if (seedKey) {
    const seed = [...candidates.get(seedKey)!].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])[0]!;
    const chosen: PixelBox[] = [seed.box];
    located[seedKey] = seed;
    for (const [key, list] of candidates) {
      if (key === seedKey || list.length === 0) continue;
      const pick = nearestTo(list, seed.box);
      located[key] = pick;
      chosen.push(pick.box);
    }
    region = unionBoxes(chosen);
  }

  // Prefer the occurrence under the box's own printed label when a value is
  // repeated inside the instance (box 3 and box 5 often hold the same amount).
  if (region) {
    for (const [key, list] of candidates) {
      if (list.length < 2) continue;
      const phrase = anchorPhrase(boxByKey.get(key)!);
      if (!phrase) continue;
      const anchors = findPhrase(page.words, phrase);
      if (anchors.length === 0) continue;
      const anchor = [...anchors].sort((a, b) => distanceToRegion(a, region!) - distanceToRegion(b, region!))[0]!;
      located[key] = [...list].sort(
        (a, b) => belowRightDistance(anchor, a.box) - belowRightDistance(anchor, b.box),
      )[0]!;
    }
  }
  for (const key of candidates.keys()) if (!(key in located)) located[key] = null;

  // One printed token backs one box. When several boxes claim a value that is
  // printed only once, the first box in form order keeps it; the others are
  // phantom copies (measured: a model copied a state cell into both state rows).
  const phantoms: string[] = [];
  const claimed = new Map<string, string>();
  for (const b of schema.boxes) {
    const at = located[b.key];
    if (!at || (candidates.get(b.key)?.length ?? 0) !== 1) continue;
    const token = at.box.map((n) => Math.round(n)).join(',');
    if (!claimed.has(token)) {
      claimed.set(token, b.key);
      continue;
    }
    phantoms.push(b.key);
    delete values[b.key];
    located[b.key] = null;
  }

  // 3. Checkboxes: deterministic reading replaces model text.
  const checkboxes: Record<string, CheckboxReading> = {};
  for (const b of schema.boxes) {
    if (b.kind !== 'checkbox' || !b.checkbox) continue;
    const reading = readCheckbox(page.raster, page.words, b.checkbox, region);
    checkboxes[b.key] = reading;
    if (reading.state === 'checked') values[b.key] = 'X';
    else if (reading.state === 'unchecked') values[b.key] = 'no';
    else if (values[b.key] !== undefined || region) values[b.key] = '?';
  }

  // 4. W-2 box 12: fill a missing code from the page beside its located amount,
  //    or read the whole entry from the page when the model returned nothing.
  const box12Codes: Record<string, string> = {};
  const box12FromPage: Record<string, { code: string; amount: string }> = {};
  if (schema.formType === 'W-2') {
    for (const slot of ['12a', '12b', '12c', '12d']) {
      const codeKey = `${slot}.code`;
      const amountKey = `${slot}.amount`;
      const amount = located[amountKey];
      if (values[codeKey] === undefined && amount) {
        const code = readBox12Code(amount.box, page.words);
        if (code) {
          values[codeKey] = code;
          box12Codes[slot] = code;
        }
      } else if (values[codeKey] === undefined && values[amountKey] === undefined) {
        const entry = readBox12Entry(slot, page.words, region);
        if (entry) {
          values[codeKey] = entry.code;
          values[amountKey] = entry.amount;
          located[amountKey] = { box: entry.amountBox, source: page.words[0]?.source ?? 'ocr', pageText: entry.amount };
          box12FromPage[slot] = { code: entry.code, amount: entry.amount };
        }
      }
    }
  }

  return { values, located, checkboxes, box12Codes, box12FromPage, phantoms, region };
}

/** Values sit below or right of their label; penalize candidates above/left. */
function belowRightDistance(anchor: PixelBox, box: PixelBox): number {
  const dx = box[0] - anchor[0];
  const dy = box[1] - anchor[1];
  const penalty = (dy < -(anchor[3] - anchor[1]) ? 3 : 1) * (dx < -(anchor[2] - anchor[0]) ? 2 : 1);
  return Math.hypot(dx, dy) * penalty;
}
