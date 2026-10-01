import { describe, expect, it } from 'vitest';
import { factSourcesOf, finishReading, readPagePrimary, readPageSecond, type ReaderPage, type VisionModel } from '../src/documentReader.js';
import { validateImportedFacts } from '../src/factValidation.js';
import type { PageWord } from '../src/pageEvidence.js';
import { invokeTaxTool } from '../src/taxTools.js';

/** A 1099-INT page with a text layer: title, two labelled amounts, blank paper. */
function page(amountPrinted = '1,284.66'): ReaderPage {
  const w = (text: string, x: number, y: number): PageWord => ({ text, source: 'pdf-text', box: [x, y, x + text.length * 9, y + 14] });
  const words = [
    w('Form', 40, 20), w('1099-INT', 90, 20), w('Interest', 200, 20), w('Income', 280, 20),
    w("PAYER'S", 40, 60), w('name', 110, 60), w('FIRST', 40, 80), w('HARBOR', 100, 80), w('BANK', 170, 80),
    w('1', 400, 60), w('Interest', 420, 60), w('income', 500, 60), w(amountPrinted, 420, 82),
    w('4', 400, 130), w('Federal', 420, 130), w('income', 490, 130), w('tax', 550, 130), w('withheld', 590, 130), w('128.47', 420, 152),
  ];
  return { pageNumber: 1, words, raster: { width: 800, height: 400, gray: new Uint8Array(800 * 400).fill(255) }, imagePng: 'iVBORw0KGgo=' };
}

/** A scripted model: the form number it reports, and what it writes into named template fields. */
function model(formNumber: string, reader: Record<string, string>, second: Record<string, string> = {}): VisionModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async chat(role, req) {
      calls.push(`${role}:${req.name}`);
      if (req.name === 'classify') return { content: JSON.stringify({ 'Form number': formNumber, 'Tax year': '2025' }), ms: 5, runId: 'run-classify' };
      const fields = Object.keys((req.jsonSchema as { properties: Record<string, unknown> }).properties);
      const values = role === 'reader' ? reader : second;
      const filled = Object.fromEntries(fields.map((f) => [f, Object.entries(values).find(([k]) => f.startsWith(k))?.[1] ?? '']));
      return { content: JSON.stringify(filled), ms: 7, runId: `run-${role}` };
    },
  };
}

/**
 * A scanned W-2 whose box 12a prints "W  1,200.00" that the OCR could not read
 * (stress run: it came out as "HEE"): the label is there, the cell has ink.
 */
function scannedW2(): ReaderPage {
  const w = (text: string, x: number, y: number): PageWord => ({ text, source: 'ocr', box: [x, y, x + text.length * 9, y + 14] });
  const words = [
    w('Form', 40, 360), w('W-2', 90, 360), w('Wage', 140, 360), w('and', 190, 360), w('Tax', 230, 360), w('Statement', 270, 360),
    w('1', 300, 20), w('Wages,', 315, 20), w('tips,', 380, 20), w('51,200.00', 330, 40),
    w('12a', 500, 100), w('See', 540, 100), w('instructions', 580, 100), w('HEE', 700, 130),
  ];
  const raster = { width: 800, height: 400, gray: new Uint8Array(800 * 400).fill(255) };
  // "W" and "1,200.00": marks a text line high in the cell under the label.
  for (const x0 of [530, 600, 612, 624, 636, 648, 660]) {
    for (let y = 126; y < 138; y++) for (let x = x0; x < x0 + 8; x++) raster.gray[y * 800 + x] = 20;
  }
  return { pageNumber: 1, words, raster, imagePng: 'iVBORw0KGgo=' };
}

describe('documentReader', () => {
  it("asks the second reader for a W-2 box 12 the page prints but no one read, and holds the form when it cannot", async () => {
    const p = scannedW2();
    const read = model('W-2', { '1 Wages': '51,200.00' }, { '12a Code': 'W', '12a Amount': '1,200.00' });
    const primary = await readPagePrimary(p, read);
    expect(primary.evidence!.printedUnread).toEqual(['12a.code', '12a.amount']);
    expect(primary.secondReaderKeys).toEqual(expect.arrayContaining(['12a.code', '12a.amount']));
    const reading = finishReading(primary, p, await readPageSecond(primary, p, read));
    // One reader read it: on the return, for the preparer to review.
    expect(reading.args.box12).toEqual([{ code: 'W', amount: 1200 }]);
    expect(reading.confidence.box12).toBe(0.5);

    const blind = model('W-2', { '1 Wages': '51,200.00' }, {});
    const unread = await readPagePrimary(p, blind);
    const held = finishReading(unread, p, await readPageSecond(unread, p, blind));
    expect(held.args).toHaveProperty('box12', undefined);
    expect(held.rawText.box12).toMatch(/box 12a is printed in but no reader read it/);
    expect(held.confidence.box12).toBe(0);
    // The W-2 is held, not applied without its box 12.
    const facts = invokeTaxTool({
      tool: 'add_w2',
      args: held.args,
      context: { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'DOC', sourceFileName: 'w2.png', extractor: 'qwen3.5-0.8b', modelRunId: 'run-reader', ...factSourcesOf(held, 'GLM-OCR') },
    });
    if (!facts.ok) throw new Error(facts.error);
    expect(validateImportedFacts(facts.facts).heldForms).toEqual(['DOC#0']);
  });

  it('does not ask about an empty box 12 slot', async () => {
    const p = scannedW2();
    p.raster.gray.fill(255);
    // A ruled line across the cell is not printing.
    for (let x = 510; x < 790; x++) p.raster.gray[150 * 800 + x] = 0;
    const primary = await readPagePrimary(p, model('W-2', { '1 Wages': '51,200.00' }));
    expect(primary.evidence!.printedUnread).toEqual([]);
  });

  it('reads a page, confirms each value against the page, and maps it to the form tool', async () => {
    const p = page();
    const m = model('1099-INT', { "PAYER'S name": 'FIRST HARBOR BANK', '1 Interest income': '1,284.66', '4 Federal income tax withheld': '128.47' });
    const primary = await readPagePrimary(p, m);
    expect(primary.classification).toMatchObject({ status: 'classified', formType: '1099-INT', source: 'reader_model', confidence: 'high' });
    const reading = finishReading(primary, p, await readPageSecond(primary, p, m));
    expect(reading.tool).toBe('add_1099_int');
    expect(reading.args).toMatchObject({ amount: 1284.66, federalTaxWithheld: 128.47 });
    expect(reading.confidence).toMatchObject({ amount: 1, federalTaxWithheld: 1 });
    expect(reading.locations.amount).toEqual({ page: 1, box: [420, 82, 492, 96], pageSize: { width: 800, height: 400 } });
    expect(reading.runs.map((r) => r.stage)).toEqual(['classify', 'extract']);
    // Nothing needed the second reader: the page confirmed every value.
    expect(m.calls).toEqual(['reader:classify', 'reader:form']);
  });

  it('leaves a page unclassified when its printed title names another form', async () => {
    const m = model('1099-DIV', {});
    const primary = await readPagePrimary(page(), m);
    expect(primary.classification).toMatchObject({ status: 'unclassified', reason: expect.stringMatching(/reported 1099-DIV but the page's printed markers are 1099-INT/) });
    expect(m.calls).toEqual(['reader:classify']);
  });

  it('holds the form when the second reader disagrees with the reader', async () => {
    // The reader writes .68 where the page prints .66 — the page cannot confirm it, so the second reader reads it.
    const p = page();
    const m = model('1099-INT', { '1 Interest income': '1,284.68', '4 Federal income tax withheld': '128.47' }, { '1 Interest income': '1,284.66' });
    const primary = await readPagePrimary(p, m);
    expect(primary.secondReaderKeys).toContain('1');
    const reading = finishReading(primary, p, await readPageSecond(primary, p, m));
    expect(reading.confidence.amount).toBe(0);
    expect(reading.secondReadings.amount).toEqual({ text: '1,284.66', agrees: false });

    const sources = factSourcesOf(reading, 'GLM-OCR');
    const result = invokeTaxTool({
      tool: 'add_1099_int',
      args: reading.args,
      context: { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'DOC', sourceFileName: 'doc.pdf', extractor: 'qwen3.5-0.8b', modelRunId: 'run-reader', ...sources },
    });
    if (!result.ok) throw new Error(result.error);
    const amount = result.facts.find((f) => f.sourceField === 'amount')!;
    expect(amount).toMatchObject({ modelRunId: 'run-reader', confidence: 0, secondReading: { source: 'model', reader: 'GLM-OCR', text: '1,284.66', agrees: false } });
    expect(validateImportedFacts(result.facts).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'READERS_DISAGREE', holdsForm: true, sourceField: 'amount' })]));
  });
});
