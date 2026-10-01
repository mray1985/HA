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

describe('documentReader', () => {
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
