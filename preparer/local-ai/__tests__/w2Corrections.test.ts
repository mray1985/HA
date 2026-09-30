import { describe, expect, it } from 'vitest';
import { FORM_EXTRACTION_SCHEMAS, mapBoxesToTool } from '../src/formSchemas.js';
import { extractStructuredFields } from '../src/structuredExtraction.js';
import type { TaxFact } from '../src/taxFact.js';
import { invokeTaxTool, type DocumentToolName } from '../src/taxTools.js';
import { applyW2Corrections, resolveW2Corrections } from '../src/w2Corrections.js';

function read(tool: DocumentToolName, args: Record<string, unknown>, documentId: string): TaxFact[] {
  const r = invokeTaxTool({ tool, args, context: { returnId: 'R1', taxYear: 2025, sourceDocumentId: documentId, sourceFileName: `${documentId}.pdf`, extractor: 'test' } });
  if (!r.ok) throw new Error(r.error);
  return r.facts;
}

const w2 = read('add_w2', { employerName: 'RIVERBEND LOGISTICS', employerEin: '72-1234567', wages: 52431.18, federalTaxWithheld: 5873.4 }, 'W2');

describe('W-2c corrections', () => {
  it('corrects the W-2 with the same employer EIN, checking what it says was reported', () => {
    const w2c = read('add_w2c', { employerName: 'RIVERBEND LOGISTICS', employerEin: '721234567', taxYearCorrected: 2025, previousWages: 52431.18, correctWages: 54000 }, 'W2C');
    const [c] = resolveW2Corrections([...w2, ...w2c], 2025);
    expect(c).toMatchObject({ formKey: 'W2C#0', targetKey: 'W2#0', changes: { wages: 54000 }, ready: true, problems: [] });
    expect(applyW2Corrections('W2#0', { wages: 52431.18, federalTaxWithheld: 5873.4 }, [c!])).toEqual({ wages: 54000, federalTaxWithheld: 5873.4 });
    expect(applyW2Corrections('OTHER#0', { wages: 1 }, [c!])).toEqual({ wages: 1 });
  });

  it('applies nothing when the reported amount does not match, the W-2 is missing, the year differs or two W-2s could be meant', () => {
    const mismatch = read('add_w2c', { employerEin: '72-1234567', previousWages: 50000, correctWages: 54000 }, 'W2C');
    expect(resolveW2Corrections([...w2, ...mismatch], 2025)[0]).toMatchObject({ ready: false, problems: [expect.stringMatching(/previously reported wages \(50,000.00\) does not match the W-2 on the case \(52,431.18\)/)] });

    const otherEmployer = read('add_w2c', { employerEin: '99-0000000', correctWages: 54000 }, 'W2C');
    expect(resolveW2Corrections([...w2, ...otherEmployer], 2025)[0]!.problems[0]).toMatch(/is not on the case; add the original W-2/);

    const otherYear = read('add_w2c', { employerEin: '72-1234567', taxYearCorrected: 2024, correctWages: 54000 }, 'W2C');
    expect(resolveW2Corrections([...w2, ...otherYear], 2025)[0]!.problems).toEqual(['It corrects a 2024 W-2, not 2025.']);

    const second = read('add_w2', { employerEin: '72-1234567', wages: 1000, federalTaxWithheld: 100 }, 'W2-B');
    const ambiguous = read('add_w2c', { employerEin: '72-1234567', correctWages: 54000 }, 'W2C');
    expect(resolveW2Corrections([...w2, ...second, ...ambiguous], 2025)[0]!.problems[0]).toMatch(/2 W-2s from EIN 721234567/);
  });

  it('checks a second W-2c against the first one\'s result', () => {
    const first = read('add_w2c', { employerEin: '72-1234567', previousWages: 52431.18, correctWages: 54000 }, 'W2C-1');
    const second = read('add_w2c', { employerEin: '72-1234567', previousWages: 54000, correctWages: 55000 }, 'W2C-2');
    const resolved = resolveW2Corrections([...w2, ...first, ...second], 2025);
    expect(resolved.map((c) => c.ready)).toEqual([true, true]);
    expect(applyW2Corrections('W2#0', { wages: 52431.18 }, resolved)).toEqual({ wages: 55000 });
  });

  it('reports an SSN / name correction as identity only', () => {
    const idOnly = read('add_w2c', { employerEin: '72-1234567', correctsSsnOrName: true }, 'W2C');
    expect(resolveW2Corrections([...w2, ...idOnly], 2025)[0]).toMatchObject({ ready: true, identityOnly: true, changes: {} });
  });

  it('maps a printed W-2c: both columns, the state pair and the year in box c', () => {
    const mapped = mapBoxesToTool(FORM_EXTRACTION_SCHEMAS['W-2C']!, {
      a: 'RIVERBEND LOGISTICS\n1 RIVER RD', b: '72-1234567', c: '2025 / W-2',
      '1.prev': '52,431.18', '1.correct': '54,000.00', '15.state.1.prev': 'LA', '15.state.1.correct': 'MS', '17.1.correct': '1,210.00',
    });
    expect(extractStructuredFields('add_w2c', mapped.bag, mapped.rawText).args).toEqual({
      employerName: 'RIVERBEND LOGISTICS', employerEin: '72-1234567', taxYearCorrected: 2025,
      previousWages: 52431.18, correctWages: 54000, previousState: 'LA', correctState: 'MS', correctStateTaxWithheld: 1210,
    });
  });
});
