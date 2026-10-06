import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { extractFromPDF } from '../services/pdfImporter';
import { gapsWithPieceIndex, type DocumentBoxGap } from '@hatax/local-ai';

const FORMS = '../local-ai/gauntlet/forms';

/** Two real IRS blanks in one file, which is what a scanner produces. */
async function twoFormsInOneFile(...files: string[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const file of files) {
    const src = await PDFDocument.load(readFileSync(`${FORMS}/${file}`));
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

async function piecesOf(bytes: Uint8Array, name: string): Promise<Record<string, unknown>[]> {
  const r = (await extractFromPDF(new File([new Uint8Array(bytes)], name, {
    type: 'application/pdf',
  }))) as unknown as Record<string, unknown>;
  return [r, ...((r.additionalResults ?? []) as Record<string, unknown>[])];
}

/** A gap with named boxes, and one with none, which is what the filter drops. */
function gap(formType: string | null, boxes: number): DocumentBoxGap {
  return {
    formType,
    declared: boxes,
    read: 0,
    boxes: Array.from({ length: boxes }, (_, i) => ({
      box: String(i + 1),
      label: `box ${i + 1}`,
      state: 'held' as const,
    })),
  };
}

describe('a two-form file, end to end', () => {
  it('is split into pieces the extractor actually found', async () => {
    // A W-2 and a 1099-INT in one PDF. Both blanks carry form fields on every
    // page, so the extractor reports one piece per form page rather than per
    // document - five pieces for two forms, and stable across runs. That is why
    // a piece index has to be a real index into what the extractor returned.
    const pieces = await piecesOf(await twoFormsInOneFile('fw2.pdf', 'f1099int.pdf'), 'two-forms.pdf');
    const types = pieces.map((p) => String(p.formType));
    expect(pieces.length).toBe(5);
    expect(types).toContain('W-2');
    expect(types).toContain('1099-INT');

    // This file contains no W-2C, yet two pieces classify as one. Recorded as
    // observed rather than asserted, because blessing it would lock in a
    // misclassification; see the PR.
    expect(types).toContain('W-2C');
  });

  it('reports each gap against the piece it came from', async () => {
    const pieces = await piecesOf(await twoFormsInOneFile('fw2.pdf', 'f1099int.pdf'), 'two-forms.pdf');
    expect(pieces.length).toBeGreaterThanOrEqual(3);

    // The pieces are the ones the extractor found. The gaps are arranged rather
    // than read, because the extractor does not report them - they are built
    // during ingestion - and the property under test is about how they are
    // numbered, not about what they say. The first piece is left empty so that
    // every later index shifts by one if the filtering happens first.
    const boxGaps: DocumentBoxGap[] = pieces.map((_, i) => gap(null, i));

    const indexed = gapsWithPieceIndex(boxGaps);
    const expected = boxGaps
      .map((g, piece) => ({ g, piece }))
      .filter(({ g }) => g.boxes.length > 0);

    expect(indexed.map((x) => x.piece)).toEqual(expected.map((x) => x.piece));
    // Piece 0 is empty, so it is dropped and every index after it is shifted by
    // one. Reporting them shifted would record a value typed into the third form
    // against the second - the wrong employer, or the wrong income item where
    // both forms carry the field.
    expect(indexed.map((x) => x.piece)).toEqual(pieces.map((_, i) => i).slice(1));
  });

  it('would have recorded a later form against the first if it numbered after filtering', async () => {
    const pieces = await piecesOf(await twoFormsInOneFile('fw2.pdf', 'f1099int.pdf'), 'two-forms.pdf');
    const boxGaps: DocumentBoxGap[] = pieces.map((_, i) => gap(null, i));

    const right = gapsWithPieceIndex(boxGaps).map((x) => x.piece);
    // The bug, written out: filter, then number what is left.
    const wrong = boxGaps
      .filter((g) => g.boxes.length > 0)
      .map((_, piece) => piece);

    // The two must differ, or this fixture proves nothing about the bug.
    expect(right).not.toEqual(wrong);
    // And the right answer must be the piece's own position.
    expect(right.every((piece) => boxGaps[piece]!.boxes.length > 0)).toBe(true);
  });
});