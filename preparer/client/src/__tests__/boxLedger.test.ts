import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFromPDF } from '../services/pdfImporter';
import { buildBoxLedger, summariseBoxLedger, type BoxState } from '../services/boxLedger';
import { factsForExtraction } from '../services/preparerTaxFacts';

const STRESS = '../local-ai/gauntlet/stress/docs';
const FORMS = '../local-ai/gauntlet/forms';

async function read(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  return extractFromPDF(new File([bytes], file.split('/').pop()!, { type: 'application/pdf' }));
}

const stateOf = (ledger: { entries: Array<{ key: string; state: BoxState }> }, key: string): BoxState | undefined =>
  ledger.entries.find((e) => e.key === key)?.state;

describe('every box the form prints is accounted for', () => {
  it('does not claim a miss when it has no page text to judge by', () => {
    // The reader-model path has no page text: it works from the rendered page,
    // and what it could not read is reported through its own page evidence. If
    // the ledger called every absent box unread it would invent a gap on every
    // ordinary form with a blank optional box — and a gap holds a case open.
    const withoutText = buildBoxLedger('1099-G', { unemploymentCompensation: 15600 });
    // A money box the form leaves blank reads blank. A checkbox still reads
    // unread, because a printed square is not a figure: "no value" there means
    // the square was not read, not that it was left unticked.
    expect(stateOf(withoutText, '2')).toBe('empty');
    expect(stateOf(withoutText, '8')).toBe('unread');
    // A box the form really does fill in is still held with its figure.
    const filled = buildBoxLedger('1099-G', {}, [], undefined, [{ key: '2', label: 'State or local income tax refunds, credits, or offsets', text: '310.00' }]);
    expect(stateOf(filled, '2')).toBe('held');

    // With page text, a blank box and a missed one are told apart as before.
    // The page must carry the label's identifying words: "printed" is judged on
    // the words that name the box, not on the box number.
    const printed = '1 Unemployment compensation 2 State or local income tax refunds, credits, or offsets';
    const withText = buildBoxLedger('1099-G', { unemploymentCompensation: 15600 }, [], printed);
    expect(stateOf(withText, '2')).toBe('empty');
    expect(stateOf(buildBoxLedger('1099-G', { unemploymentCompensation: 15600 }, [], '1 Unemployment compensation'), '2')).toBe('unread');
  });

  it('records what became of each declared box', () => {
    const ledger = buildBoxLedger(
      '1098-T',
      { tuitionPaid: 4200 },
      [{ field: 'scholarships', value: '25', reason: 'not-an-amount', detail: 'half of the year graphic' }],
      '1 Payments received for qualified tuition and related expenses 4,200.00 ' +
        '4 Adjustments made for a prior year 5 Scholarships or grants ' +
        "FILER'S street address",
    );

    expect(stateOf(ledger, '1')).toBe('read');
    // Read from the page, but the page does not support it: held, not written.
    expect(stateOf(ledger, '5')).toBe('held');
    // Printed and blank.
    expect(stateOf(ledger, '4')).toBe('empty');
    // A box whose label the page does not show at all is a gap, not a blank.
    expect(stateOf(ledger, '10')).toBe('unread');
    // An address is not on the return, so it is not a gap.
    expect(stateOf(ledger, 'filer.street')).toBe('informational');

    expect(ledger.read).toBe(1);
    expect(ledger.held).toBe(1);
  });

  it('never calls an unread square empty: a checkbox state is a printed mark', () => {
    const ledger = buildBoxLedger(
      '1098-T',
      {},
      [],
      '8 Checked if at least half-time student 9 Checked if a graduate student 4,200.00',
    );
    expect(stateOf(ledger, '8')).toBe('unread');
    expect(stateOf(ledger, '9')).toBe('unread');
  });

  it('holds a box the form fills in that no tool accepts, instead of calling it blank', () => {
    // 1099-DIV box 5 (Section 199A) is printed and filled, but the engine has no
    // field for it. Before this existed the ledger could only see a schema box
    // with no value, and called it empty — so the figure reached no one.
    const unplaced = [{ key: '5', label: 'Section 199A dividends', text: '44.10' }];
    const pageText = '5 Section 199A dividends 44.10';
    const blind0 = buildBoxLedger('1099-DIV', { ordinaryDividends: 2410.55 }, [], pageText);

    const held = buildBoxLedger('1099-DIV', { ordinaryDividends: 2410.55 }, [], pageText, unplaced);
    expect(stateOf(held, '5')).toBe('held');
    const entry = held.entries.find((e) => e.key === '5')!;
    expect(entry.value).toBe('44.10');
    expect(entry.reason).toContain('no part of the return takes it');
    // The figure is on the form, so it is not counted as read and not as a miss.
    expect(held.read).toBe(1);
    expect(held.held).toBe(blind0.held + 1);

    // Without the reader's report of it, the same box reads as blank. That
    // difference is the whole point: the value is there or it is not.
    const blind = buildBoxLedger('1099-DIV', { ordinaryDividends: 2410.55 }, [], pageText);
    expect(stateOf(blind, '5')).toBe('empty');
  });

  it('carries the return field for a held box, so a value can be typed into it', () => {
    const ledger = buildBoxLedger(
      'W-2',
      { wages: 68250 },
      [],
      '7 Social security tips 1,240.00',
      [{ key: '7', label: 'Social security tips', text: '1,240.00' }],
    );
    // Box 7 is use:'review', so it feeds no field — there is nowhere to type it.
    expect(stateOf(ledger, '7')).toBe('held');
    expect(ledger.entries.find((e) => e.key === '7')!.field).toBeUndefined();

    // A held box that does feed a field carries the name, which is what lets the
    // preparer type straight into it. Box 1g feeds washSaleLossDisallowed.
    const withField = buildBoxLedger(
      '1099-B',
      { proceeds: 125000 },
      [{ field: 'washSaleLossDisallowed', value: '500', reason: 'not-an-amount', detail: 'printed beside box 1g' }],
      '1g Wash sales 500.00',
    );
    const wash = withField.entries.find((e) => e.key === '1g')!;
    expect(wash.state).toBe('held');
    expect(wash.field).toBe('washSaleLossDisallowed');
  });

  it('says which boxes could not be read, by name', () => {
    const note = summariseBoxLedger(
      buildBoxLedger('1098-T', {}, [], '1 Payments received 5 Scholarships or grants'),
    );
    expect(note).toContain('could not be read');
    // Names the gaps rather than only counting them.
    expect(note).toMatch(/box \d/);
  });

  it('stays silent on a form with no declared boxes', () => {
    expect(summariseBoxLedger(buildBoxLedger(null, {}, []))).toBeNull();
  });
});

describe('the real forms it reads', () => {
  it('reports the 1098-T checkboxes it cannot read rather than calling them unticked', async () => {
    const ledger = (await read(`${STRESS}/dana-1098t.pdf`)).boxLedger!;
    // Boxes 7, 8 and 9 are printed squares. Box 8 is ticked on this form and the
    // reader does not read it, which is exactly what must stay visible.
    expect(stateOf(ledger, '8')).toBe('unread');
    expect(stateOf(ledger, '7')).toBe('unread');
    expect(stateOf(ledger, '9')).toBe('unread');
    expect(ledger.read).toBeGreaterThan(0);
    expect(ledger.unread).toBeGreaterThan(0);
  });

  it('accounts for every declared box on a W-2', async () => {
    const ledger = (await read(`${STRESS}/dana-w2.pdf`)).boxLedger!;
    expect(ledger.entries.length).toBeGreaterThan(0);
    expect(ledger.read + ledger.held + ledger.unread + ledger.empty + countInfo(ledger)).toBe(ledger.entries.length);
    expect(ledger.read).toBe(11);
  });

  it('counts a held value as held, never as read', async () => {
    // The extraction carries the value until the deterministic check runs, so
    // this has to go through the write boundary — that is where "read" becomes
    // "held", and the ledger is rebuilt to say so.
    const res = await read(`${STRESS}/fay-1099misc.pdf`);
    const built = factsForExtraction({
      returnId: 'case-1',
      taxYear: 2025,
      documentId: 'doc-1',
      fileName: 'fay-1099misc.pdf',
      extracted: res,
    });
    const ledger = res.boxLedger!;
    // The property worth protecting is that royalties is never claimed as read:
    // it was taken from the tax year graphic, and this form does not carry it.
    //
    // How the reader refuses has changed - the whole form is now held rather
    // than one box being held - so this asserts the outcome, not the mechanism.
    // Asserting a held counter would have pinned the earlier behaviour and
    // failed the moment the refusal got stricter, which is the wrong direction
    // for a guard against invented income.
    expect(ledger.entries.find((e) => e.field === 'royalties')?.state).not.toBe('read');
    expect(built.toolFields.royalties).toBeUndefined();
  });

  it('reports a blank form as having nothing to write rather than as a failure', async () => {
    const ledger = (await read(`${FORMS}/f1099div.pdf`)).boxLedger!;
    expect(ledger.read).toBe(0);
  });
});

function countInfo(ledger: { entries: Array<{ state: BoxState }> }): number {
  return ledger.entries.filter((e) => e.state === 'informational').length;
}