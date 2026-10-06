import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { extractFromPDF } from '../services/pdfImporter';
import { gapsWithPieceIndex, type DocumentBoxGap } from '@hatax/local-ai';

const BLANKS = '../local-ai/gauntlet/forms';
const STRESS = '../local-ai/gauntlet/stress/docs';

/** Two real IRS forms in one file, which is what a scanner produces. */
async function twoFormsInOneFile(dir: string, ...files: string[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const file of files) {
    const src = await PDFDocument.load(readFileSync(`${dir}/${file}`));
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
  it('splits a blank file per form page, so a piece index has to be real', async () => {
    // The blanks, because they carry form fields on every page and the extractor
    // therefore reports one piece per page rather than per document: five pieces
    // for two forms, stable across runs. That is the shape the indexing has to
    // survive.
    //
    // Blanks are used deliberately, and their quirks are not asserted: two of
    // the five classify as W-2C, which is an artefact of a blank's field layout
    // and does not happen on a completed form. See #39 for what a completed
    // two-form file actually does, which is the more serious half of this.
    const pieces = await piecesOf(await twoFormsInOneFile(BLANKS, 'fw2.pdf', 'f1099int.pdf'), 'two-blanks.pdf');
    const types = pieces.map((p) => String(p.formType));
    expect(pieces.length).toBe(5);
    expect(types).toContain('W-2');
    expect(types).toContain('1099-INT');
  });

  // Two completed W-2s, from different employers, in one file. The case a
  // preparer creates every time they scan two clients' paystubs together.
  it('finds both employers in one file of two completed W-2s', async () => {
    // This was `it.fails` while detectFormPages merged consecutive pages of the
    // same form type into one span, which dropped the second employer with
    // nothing reported as missing (#39). The sentinel did its job: it started
    // failing the moment the behaviour was fixed.
    const pieces = await piecesOf(await twoFormsInOneFile(STRESS, 'ava-w2.pdf', 'gus-w2.pdf'), 'two-w2s.pdf');
    const employers = pieces.map((p) => String((p.extractedData as { employerName?: string } | undefined)?.employerName ?? ''));
    expect(employers).toContain('CAPITOL CITY ANALYTICS INC');
    expect(employers).toContain('HUDSON VALLEY SOFTWARE CORP');
  });

  it('reports each gap against the piece it came from', async () => {
    const pieces = await piecesOf(await twoFormsInOneFile(BLANKS, 'fw2.pdf', 'f1099int.pdf'), 'two-blanks.pdf');
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
    const pieces = await piecesOf(await twoFormsInOneFile(BLANKS, 'fw2.pdf', 'f1099int.pdf'), 'two-blanks.pdf');
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