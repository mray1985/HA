/**
 * Reconcile a model's transcription with the page itself (work order §31,
 * §33, §59, §72 "low confidence becomes review, not a guess").
 *
 * Given the schema box values a document model transcribed, and independent
 * page evidence (text-layer or OCR word boxes plus the grayscale raster):
 *
 *   0. restore the line breaks of a name/address block the model returned on
 *      one line, from the page;
 *   1. locate every transcribed value on the page → real source boxes and an
 *      independent second reading (agreement). A printed box label never
 *      counts as the value (the "7" of "7 Distribution code(s)");
 *   2. pick one form instance when the page repeats the form (employer PDFs
 *      often print Copy B, C and 2 on one sheet) and read within it;
 *   3. read checkboxes deterministically (checked / empty square → explicit
 *      "no" / anything else → "?" which routes the box to review);
 *   4. W-2 box 12: a code is confirmed only by the code printed beside its own
 *      amount; a missing code is read from there; a code with no amount is
 *      the slot's printed "Code" label and is dropped;
 *   5. report amounts printed under a tool box's label that the model left
 *      blank (review — never filled in).
 *
 * Model text is never overwritten by guesses: a checkbox the page cannot
 * settle becomes "?", a box 12 code that is not an official code stays absent.
 */

import type { FormBoxSchema, FormExtractionSchema } from './formSchemas.js';
import { parseMoneyToken } from './structuredExtraction.js';
import {
  box12CodeAt,
  distanceToRegion,
  findPhrase,
  findValueCandidates,
  readBox12Entry,
  readCheckbox,
  restoreLineBreaks,
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
   * Box keys whose transcribed value the page does not back, removed: a value
   * printed only once but also claimed by an earlier box (phantom copy), or a
   * W-2 box 12 code with no amount beside it (the slot's printed "Code" label).
   */
  phantoms: string[];
  /** Text boxes whose line breaks were restored from the page. */
  relined: string[];
  /**
   * Tool boxes the model left blank although the page shows an amount under
   * their label. Never filled in automatically: the page's reading is a
   * single-source candidate, so the box goes to review.
   */
  missed: Array<{ key: string; pageText: string; box: PixelBox }>;
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

/** Share of `box` covered by `other`. */
function overlapShare(box: PixelBox, other: PixelBox): number {
  const w = Math.min(box[2], other[2]) - Math.max(box[0], other[0]);
  const h = Math.min(box[3], other[3]) - Math.max(box[1], other[1]);
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
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

  // 0. Name/address blocks returned on one line get their printed line breaks back.
  const relined: string[] = [];
  for (const b of schema.boxes) {
    if (b.kind !== 'text' || values[b.key] === undefined) continue;
    const restored = restoreLineBreaks(values[b.key]!, page.words);
    if (restored) {
      values[b.key] = restored;
      relined.push(b.key);
    }
  }

  // 1. Candidate locations for every transcribed, locatable value. A token
  //    that is part of a printed box label is not a value.
  const labelBoxes = schema.boxes.flatMap((b) => {
    const phrase = anchorPhrase(b);
    return phrase ? findPhrase(page.words, phrase) : [];
  });
  const onLabel = (box: PixelBox) => labelBoxes.some((l) => overlapShare(box, l) > 0.5);
  const candidates = new Map<string, LocatedValue[]>();
  for (const [key, text] of Object.entries(values)) {
    const b = boxByKey.get(key);
    if (!b || !LOCATABLE_KINDS.has(b.kind)) continue;
    // Box 12 codes are located beside their amounts (step 4).
    if (schema.formType === 'W-2' && /^12[a-d]\.code$/.test(key)) continue;
    candidates.set(key, findValueCandidates(text, page.words, { money: b.kind === 'money' }).filter((c) => !onLabel(c.box)));
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
  // printed only once, the box whose printed label the token sits under keeps
  // it (form order breaks ties, e.g. two state rows under one label; measured:
  // a model copied the box 1 amount into "Payer's RTN", which comes first). On
  // a text layer, which holds every printed token, the others are phantom
  // copies (measured: a model copied a state cell into both state rows). OCR
  // misses tokens, so there the others are only unconfirmed (measured: on a
  // faded W-2 OCR read the amount shared by boxes 3 and 5 once).
  const phantoms: string[] = [];
  const claims = new Map<string, string[]>();
  for (const b of schema.boxes) {
    const at = located[b.key];
    if (!at || (candidates.get(b.key)?.length ?? 0) !== 1) continue;
    const token = at.box.map((n) => Math.round(n)).join(',');
    claims.set(token, [...(claims.get(token) ?? []), b.key]);
  }
  for (const keys of claims.values()) {
    if (keys.length < 2) continue;
    const token = located[keys[0]!]!.box;
    const labelDistance = (key: string) => {
      const phrase = anchorPhrase(boxByKey.get(key)!);
      const hits = phrase ? findPhrase(page.words, phrase) : [];
      return hits.length === 0 ? Infinity : Math.min(...hits.map((h) => belowRightDistance(h, token)));
    };
    const owner = [...keys].sort((x, y) => labelDistance(x) - labelDistance(y))[0]!;
    for (const key of keys) {
      if (key === owner) continue;
      const source = located[key]!.source;
      located[key] = null;
      if (source === 'pdf-text') {
        phantoms.push(key);
        delete values[key];
      }
    }
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

  // 4. W-2 box 12. A code is confirmed only by the code printed beside its own
  //    amount — every slot prints "Code" vertically, and its "C" is an official
  //    code (measured: a model read "C" into 12a and into the empty 12b–12d).
  const box12Codes: Record<string, string> = {};
  const box12FromPage: Record<string, { code: string; amount: string }> = {};
  if (schema.formType === 'W-2') {
    const source = page.words[0]?.source ?? 'ocr';
    for (const slot of ['12a', '12b', '12c', '12d']) {
      const codeKey = `${slot}.code`;
      const amountKey = `${slot}.amount`;
      const modelCode = values[codeKey]?.trim().toUpperCase();
      if (values[amountKey] === undefined) {
        // No amount from the model: read the whole entry from the page, or drop
        // a lone code (nothing backs it but the printed label).
        const entry = readBox12Entry(slot, page.words, region);
        if (entry) {
          values[codeKey] = entry.code;
          values[amountKey] = entry.amount;
          located[amountKey] = { box: entry.amountBox, source, pageText: entry.amount };
          located[codeKey] = { box: entry.codeBox, source, pageText: entry.code };
          box12FromPage[slot] = { code: entry.code, amount: entry.amount };
        } else if (modelCode !== undefined) {
          delete values[codeKey];
          phantoms.push(codeKey);
        }
        continue;
      }
      const amount = located[amountKey];
      const printed = amount ? box12CodeAt(amount.box, page.words) : null;
      if (modelCode === undefined) {
        if (printed) {
          values[codeKey] = printed.code;
          located[codeKey] = { box: printed.box, source, pageText: printed.code };
          box12Codes[slot] = printed.code;
        }
      } else {
        // Confirmed when the page prints the same code beside the amount;
        // otherwise unconfirmed, for the second reader and the preparer.
        located[codeKey] = printed && printed.code === modelCode ? { box: printed.box, source, pageText: printed.code } : null;
      }
    }
  }

  const missed = region ? findMissedValues(schema, values, located, page.words, region) : [];

  return { values, located, checkboxes, box12Codes, box12FromPage, phantoms, relined, missed, region };
}

/**
 * Amounts printed on the page that no transcribed value claimed, assigned to
 * the nearest printed money-box label (values sit below or right of their
 * label). An amount whose nearest label is this form copy's label for a tool
 * box the model left blank is a missed value. Amounts in another copy of the
 * form fall to that copy's own labels. Only amounts with cents count, so label
 * text such as "$5,000 or more" is never taken for a value. Measured: on a
 * faded W-2 the model left boxes 5 and 16 blank although both were printed.
 */
function findMissedValues(
  schema: FormExtractionSchema,
  values: Readonly<Record<string, string>>,
  located: Readonly<Record<string, LocatedValue | null>>,
  words: readonly PageWord[],
  region: PixelBox,
): FormEvidenceResult['missed'] {
  const claimed = Object.values(located).filter((v): v is LocatedValue => v !== null).map((v) => v.box);

  // Every printed occurrence of every money-box label; the one nearest the
  // region is this copy's.
  const labels: Array<{ key: string; box: PixelBox; ours: boolean }> = [];
  for (const b of schema.boxes) {
    if (b.kind !== 'money' || !/^\d+[a-z]?$/.test(b.box)) continue;
    const phrase = anchorPhrase(b);
    if (!phrase) continue;
    const hits = findPhrase(words, phrase);
    if (hits.length === 0) continue;
    const ours = [...hits].sort((a, c) => distanceToRegion(a, region) - distanceToRegion(c, region))[0]!;
    for (const h of hits) {
      // Several schema keys share one printed box (state rows): the first row owns it.
      if (labels.some((l) => distanceToRegion(l.box, h) === 0)) continue;
      labels.push({ key: b.key, box: h, ours: h === ours });
    }
  }
  if (labels.length === 0) return [];

  const missed: FormEvidenceResult['missed'] = [];
  for (const w of words) {
    if (!/\d[.,]\d{2}$/.test(w.text) || parseMoneyToken(w.text) === undefined) continue;
    if (claimed.some((c) => distanceToRegion(w.box, c) === 0)) continue;
    const owner = [...labels].sort((a, c) => belowRightDistance(a.box, w.box) - belowRightDistance(c.box, w.box))[0]!;
    if (!owner.ours || values[owner.key] !== undefined) continue;
    if (schema.boxes.find((b) => b.key === owner.key)?.use !== 'tool') continue;
    if (!missed.some((m) => m.key === owner.key)) missed.push({ key: owner.key, pageText: w.text, box: w.box });
  }
  return missed;
}

/** Values sit below or right of their label; penalize candidates above/left. */
function belowRightDistance(anchor: PixelBox, box: PixelBox): number {
  const dx = box[0] - anchor[0];
  const dy = box[1] - anchor[1];
  const penalty = (dy < -(anchor[3] - anchor[1]) ? 3 : 1) * (dx < -(anchor[2] - anchor[0]) ? 2 : 1);
  return Math.hypot(dx, dy) * penalty;
}
