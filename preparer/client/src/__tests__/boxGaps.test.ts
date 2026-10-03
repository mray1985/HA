import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFromPDF } from '../services/pdfImporter';
import { factsForExtraction } from '../services/preparerTaxFacts';

const STRESS = '../local-ai/gauntlet/stress/docs';

/** The path ingestion takes, so the ledger is the post-verification one. */
async function ingested(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const res = await extractFromPDF(new File([bytes], file.split('/').pop()!, { type: 'application/pdf' }));
  factsForExtraction({
    returnId: 'case-1', taxYear: 2025, documentId: 'd-1',
    fileName: file.split('/').pop()!, extracted: res,
  });
  return res;
}

describe('a blank box is not a gap', () => {
  it('stops listing the 1098-T boxes that are printed but empty', async () => {
    const res = await ingested(`${STRESS}/dana-1098t.pdf`);
    const gaps = res.boxLedger!.entries.filter((e) => e.state === 'unread' || e.state === 'held');

    console.log('1098-T read', res.boxLedger!.read, 'of', res.boxLedger!.declared);
    console.log('gaps:', gaps.map((g) => `${g.box || g.label}[${g.state}]`).join(', '));

    // 4, 6 and 10 are printed and carry nothing, so they are not work.
    for (const blank of ['4', '6', '10']) {
      expect(res.boxLedger!.entries.find((e) => e.box === blank)?.state, `box ${blank}`).toBe('empty');
      expect(gaps.map((g) => g.box)).not.toContain(blank);
    }
    // Box 5 is the one that had a value read from the year graphic and held, so
    // it stays on the list: someone has to confirm it really is blank.
    expect(res.boxLedger!.entries.find((e) => e.box === '5')?.state).toBe('held');
    // The three squares are always reported: a square is never called blank.
    for (const square of ['7', '8', '9']) {
      expect(res.boxLedger!.entries.find((e) => e.box === square)?.state, `box ${square}`).toBe('unread');
    }
  });

  it('keeps a real amount on the return and still names the squares', async () => {
    const res = await ingested(`${STRESS}/dana-1098t.pdf`);
    expect(res.extractedData.tuitionPaid).toBe(4200);
    expect(res.boxLedger!.read).toBeGreaterThan(0);
  });

  it('still reports a W-2 by box, without listing every blank square', async () => {
    const res = await ingested(`${STRESS}/dana-w2.pdf`);
    const l = res.boxLedger!;
    const gaps = l.entries.filter((e) => e.state === 'unread' || e.state === 'held');
    console.log('W-2 read', l.read, 'of', l.declared, '| empty', l.empty, '| gaps:', gaps.map((g) => g.box || g.label).join(', '));
    expect(l.read).toBe(11);
    expect(gaps.length).toBeLessThan(l.declared);
  });

  it('calls the state and local boxes blank rather than missing them', async () => {
    const l = (await ingested(`${STRESS}/dana-w2.pdf`)).boxLedger!;
    // The form states Pennsylvania, so box 15 carries a state and is read.
    // Boxes 16 and 17 print wages and tax and are read. Boxes 18–20 are the
    // local row: they print and are empty on this form. The schema labels the
    // state rows "(line 1)" to tell them apart, and no form prints that — which
    // used to make all of them read as unread.
    expect(l.entries.find((e) => e.box === '15')!.state).toBe('read');
    expect(l.entries.find((e) => e.box === '16')!.state).toBe('read');
    expect(l.entries.find((e) => e.box === '17')!.state).toBe('read');
    // No local itemization on this form: boxes 18–20 print and are empty.
    for (const box of ['18', '19', '20']) {
      const entry = l.entries.find((e) => e.box === box);
      expect(entry, `box ${box} is declared`).toBeDefined();
      expect(entry!.state, `box ${box}`).toBe('empty');
    }
  });
});