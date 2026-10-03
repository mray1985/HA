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
    factsForExtraction({
      returnId: 'case-1',
      taxYear: 2025,
      documentId: 'doc-1',
      fileName: 'fay-1099misc.pdf',
      extracted: res,
    });
    const ledger = res.boxLedger!;
    expect(ledger.held).toBeGreaterThan(0);
    // royalties was read from the tax year graphic; the ledger must not claim it.
    expect(ledger.entries.find((e) => e.field === 'royalties')?.state).toBe('held');
    expect(res.warnings.some((w) => w.includes('royalties'))).toBe(true);
  });

  it('reports a blank form as having nothing to write rather than as a failure', async () => {
    const ledger = (await read(`${FORMS}/f1099div.pdf`)).boxLedger!;
    expect(ledger.read).toBe(0);
  });
});

function countInfo(ledger: { entries: Array<{ state: BoxState }> }): number {
  return ledger.entries.filter((e) => e.state === 'informational').length;
}