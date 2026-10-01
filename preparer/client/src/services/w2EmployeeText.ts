/**
 * The W-2 employee (box a SSN, box e name, box f address) read from a digital
 * W-2's text layer or its OCR words, by the printed labels:
 *
 * - box a: the TIN printed under "a Employee's social security number";
 * - box e: the row under "e Employee's first name and initial", split by the
 *   printed "Last name" and "Suff." columns — the columns, not the words,
 *   say where the last name starts ("DE LA CRUZ" is one last name);
 * - box f: the lines under the name row, down to the next printed label.
 *
 * A text layer is the page itself, so what it gives is confirmed; OCR is one
 * reader, so its reading is not. Nothing is filled in when a label is not found.
 */

import { parseNameColumns, parseTin, parseUSAddress, type PartyIdentity } from '@hatax/local-ai';
import type { TextBlock } from './pdfExtractHelpers';

const norm = (text: string) => text.replace(/[’‘]/g, "'").trim().toLowerCase();
const TIN = /^(\d{3}-?\d{2}-?\d{4}|[X*•]{3}-?[X*•]{2}-?\d{4})$/i;
/** Rows of one box sit within this many points of the row above. */
const ROW_GAP = 16;

const firstBy = (blocks: TextBlock[], test: (b: TextBlock) => boolean) =>
  blocks.filter(test).sort((a, b) => a.y - b.y || a.x - b.x)[0];

const sameLine = (a: TextBlock, b: TextBlock) => Math.abs(a.y - b.y) <= 3;
const join = (blocks: TextBlock[]) => blocks.sort((a, b) => a.x - b.x).map((b) => b.text.trim()).join(' ').replace(/\s+/g, ' ').trim();

export function w2EmployeeFromTextLayer(blocks: TextBlock[], confirmed: boolean): PartyIdentity | null {
  if (blocks.length === 0) return null;
  const page = [...blocks].sort((a, b) => a.page - b.page)[0]!.page;
  const onPage = blocks.filter((b) => b.page === page);
  const out: PartyIdentity = { formType: 'W-2' };

  // Box a.
  const aLabel = firstBy(onPage, (b) => norm(b.text).startsWith("a employee's social security number"));
  if (aLabel) {
    const value = firstBy(onPage, (b) => b.y > aLabel.y && b.y - aLabel.y <= ROW_GAP + 4
      && b.x < aLabel.x + aLabel.width && b.x + b.width > aLabel.x && TIN.test(b.text.trim()));
    if (value) {
      const tin = parseTin(value.text.trim());
      if (tin.full) out.tin = { raw: value.text.trim(), confirmed, value: tin.full };
      if (tin.lastFour && confirmed) out.tinLastFour = tin.lastFour;
    }
  }

  // Box e, by its three printed columns.
  const eLabel = firstBy(onPage, (b) => norm(b.text).startsWith("e employee's first name"));
  const lastLabel = eLabel && firstBy(onPage, (b) => sameLine(b, eLabel) && b.x > eLabel.x && norm(b.text) === 'last name');
  if (eLabel && lastLabel) {
    const suffLabel = firstBy(onPage, (b) => sameLine(b, eLabel) && b.x > lastLabel.x && norm(b.text).startsWith('suff'));
    const right = suffLabel ? suffLabel.x + suffLabel.width + 5 : lastLabel.x + 140;
    const inBox = (b: TextBlock) => b.x >= eLabel.x - 8 && b.x < right;
    const row = onPage.filter((b) => inBox(b) && b.y > eLabel.y + 3 && b.y - eLabel.y <= ROW_GAP + 4);
    if (row.length > 0) {
      const first = join(row.filter((b) => b.x < lastLabel.x - 4));
      const last = join(row.filter((b) => b.x >= lastLabel.x - 4 && (!suffLabel || b.x < suffLabel.x - 4)));
      const suffix = suffLabel ? join(row.filter((b) => b.x >= suffLabel.x - 4)) : '';
      const raw = [first, last, suffix].filter(Boolean).join(' ');
      if (raw) out.name = { raw, confirmed, value: parseNameColumns(first, last, suffix) };

      // Box f: the lines under the name, each within a row's gap of the one above.
      let bottom = Math.max(...row.map((b) => b.y));
      const lines: string[] = [];
      for (;;) {
        const next = onPage
          .filter((b) => inBox(b) && b.y > bottom + 3 && b.y - bottom <= ROW_GAP)
          .sort((a, b) => a.y - b.y);
        if (next.length === 0 || norm(next[0]!.text).startsWith('f employee')) break;
        const line = next.filter((b) => sameLine(b, next[0]!));
        lines.push(join(line));
        bottom = Math.max(...line.map((b) => b.y));
        if (lines.length > 4) break;
      }
      if (lines.length > 0) out.address = { raw: lines.join('\n'), confirmed, value: parseUSAddress(lines) };
    }
  }
  return out.tin || out.tinLastFour || out.name || out.address ? out : null;
}
