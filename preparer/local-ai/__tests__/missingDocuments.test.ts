import { describe, expect, it } from 'vitest';
import { FilingStatus, type PriorYearSummary, type TaxReturn } from '@hatax/engine';
import { clientAnswerRecord, readAnswerFromWords } from '../src/clientAnswers.js';
import { generateClientQuestions } from '../src/clientQuestions.js';
import {
  distinctDocuments,
  documentAnswers,
  documentsFromReturn,
  findMissingDocuments,
  missingDocumentTitle,
  priorYearFromCase,
  priorYearFromSummary,
  receivedDocuments,
  sameIssuer,
} from '../src/missingDocuments.js';
import type { TaxFact, TaxFactSourceKind } from '../src/taxFact.js';
import { invokeTaxTool, type TaxToolName } from '../src/taxTools.js';

function record(tool: TaxToolName, args: Record<string, unknown>, id: string, sourceKind?: TaxFactSourceKind, taxYear = 2025): TaxFact[] {
  const r = invokeTaxTool({ tool, args, context: { returnId: 'R', taxYear, sourceDocumentId: id, sourceFileName: `${id}.pdf`, extractor: 'test', ...(sourceKind ? { sourceKind } : {}) } });
  if (!r.ok) throw new Error(r.error);
  return r.facts;
}

/** A return with only what these tests read. */
function aReturn(taxYear: number, parts: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: `R${taxYear}`, taxYear, filingStatus: FilingStatus.Single, dependents: [], w2Income: [], income1099NEC: [], income1099K: [],
    income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], income1099DA: [], income1099C: [], rentalProperties: [], income1099Q: [], businesses: [],
    expenses: [], educationCredits: [], deductionMethod: 'standard', ...parts,
  } as unknown as TaxReturn;
}

const LAST_YEAR = aReturn(2024, {
  w2Income: [{ id: 'w', employerName: 'ACME CORP', employerEin: '12-3456789', wages: 60000, federalTaxWithheld: 7000 }],
  income1099INT: [{ id: 'i', payerName: 'JPMORGAN CHASE BANK NA\n270 PARK AVE', amount: 123.45 }],
  income1099DIV: [{ id: 'd', payerName: 'Fidelity Investments', ordinaryDividends: 800, qualifiedDividends: 600 }],
} as Partial<TaxReturn>);

describe('the same payer', () => {
  it.each([
    [{ issuer: 'Chase' }, { issuer: 'JPMORGAN CHASE BANK, N.A.' }, true],
    [{ issuer: 'Wells Fargo Bank NA' }, { issuer: 'WELLS FARGO ADVISORS' }, true],
    [{ issuer: 'Charles Schwab & Co., Inc.' }, { issuer: 'SCHWAB' }, true],
    [{ issuer: 'Acme', issuerEin: '12-3456789' }, { issuer: 'Different Name LLC', issuerEin: '123456789' }, true],
    [{ issuer: 'First Bank' }, { issuer: 'First National Bank of Omaha' }, false],
    [{ issuer: 'Bank of America' }, { issuer: 'American Express' }, false],
    [{ issuer: 'Fidelity' }, { issuer: 'Vanguard' }, false],
    [{ issuer: undefined }, { issuer: 'Chase' }, false],
  ])('%j and %j: %s', (a, b, want) => {
    expect(sameIssuer(a, b)).toBe(want);
  });
});

describe('last year against this year (§23)', () => {
  const prior = priorYearFromCase(LAST_YEAR, []);

  it("reports the work order's example as possibly missing, never as missing", () => {
    const thisYear = aReturn(2025, {
      w2Income: [{ id: 'w', employerName: 'Acme Corp', wages: 62000, federalTaxWithheld: 7100 }],
      income1099DIV: [{ id: 'd', payerName: 'FIDELITY INVESTMENTS INSTITUTIONAL', ordinaryDividends: 850, qualifiedDividends: 650 }],
    } as Partial<TaxReturn>);
    const missing = findMissingDocuments(prior, receivedDocuments([], thisYear));
    expect(missing).toEqual([{
      id: 'missing:1099-INT:JPMORGAN CHASE',
      formType: '1099-INT',
      issuer: 'JPMORGAN CHASE BANK NA',
      lastYear: 'the 2024 case has one for $123.45',
      status: 'possibly_missing',
    }]);
    expect(missingDocumentTitle(missing[0]!)).toBe('Possible missing 1099-INT from JPMORGAN CHASE BANK NA');
  });

  it('matches uploaded forms by their facts, and a payer-less entry stands in for one form', () => {
    const facts = [
      ...record('add_w2', { employerName: 'ACME CORP', employerEin: '12-3456789', wages: 61000 }, 'W2'),
      ...record('add_1099_int', { payerName: 'Chase Bank USA', amount: 130 }, 'INT'),
    ];
    expect(findMissingDocuments(prior, receivedDocuments(facts, aReturn(2025))).map((m) => m.formType)).toEqual(['1099-DIV']);
    const handEntered = aReturn(2025, { income1099DIV: [{ id: 'd', payerName: '', ordinaryDividends: 5, qualifiedDividends: 0 }] } as Partial<TaxReturn>);
    expect(findMissingDocuments(prior, receivedDocuments(facts, handEntered))).toEqual([]);
  });

  it("takes last year's case forms with their lenders, over the return's payer-less totals", () => {
    const priorFacts = record('add_mortgage_interest', { lenderName: 'ROCKET MORTGAGE LLC', mortgageInterest: 9100 }, 'M', undefined, 2024);
    const withMortgage = aReturn(2024, { itemizedDeductions: { mortgageInterest: 9100 } } as Partial<TaxReturn>);
    const evidence = priorYearFromCase(withMortgage, priorFacts);
    expect(evidence.documents).toEqual([{ formType: '1098', issuer: 'ROCKET MORTGAGE LLC', amount: 9100 }]);
  });

  it('reads a prior return known only by its totals, and asks about any form of the kind', () => {
    const summary = { source: 'competitor-pdf', taxYear: 2024, providerName: 'TurboTax', totalInterest: 845, totalDividends: 4, totalWages: 50000 } as PriorYearSummary;
    const evidence = priorYearFromSummary(summary)!;
    expect(evidence.documents.map((d) => d.formType)).toEqual(['W-2', '1099-INT']);
    const missing = findMissingDocuments(evidence, receivedDocuments([], aReturn(2025, { w2Income: [{ id: 'w', employerName: 'New Job Inc', wages: 1 }] } as Partial<TaxReturn>)));
    expect(missing).toEqual([expect.objectContaining({
      formType: '1099-INT', lastYear: 'the 2024 return (TurboTax) reported $845.00 of taxable interest, and no 1099-INT is on the case',
    })]);
    expect(missing[0]).not.toHaveProperty('issuer');
  });

  it("uses an imported HATax return's documents when the import kept them", () => {
    const summary = { source: 'hatax-json', taxYear: 2024, documents: documentsFromReturn(LAST_YEAR) } as PriorYearSummary;
    expect(priorYearFromSummary(summary)!.documents.map((d) => `${d.formType} ${d.issuer}`)).toEqual([
      'W-2 ACME CORP', '1099-INT JPMORGAN CHASE BANK NA', '1099-DIV Fidelity Investments',
    ]);
  });

  it('keeps one entry per form and payer', () => {
    expect(distinctDocuments([{ formType: '1098' }, { formType: '1098', issuer: 'Rocket' }, { formType: '1098', issuer: 'ROCKET MORTGAGE' }]))
      .toEqual([{ formType: '1098', issuer: 'Rocket' }]);
  });
});

describe("the client is asked (§24), and the answer settles it (§25)", () => {
  const prior = priorYearFromCase(LAST_YEAR, []);
  const received = receivedDocuments([], aReturn(2025, {
    w2Income: [{ id: 'w', employerName: 'Acme Corp', wages: 1 }],
    income1099DIV: [{ id: 'd', payerName: 'Fidelity', ordinaryDividends: 1, qualifiedDividends: 0 }],
  } as Partial<TaxReturn>));

  it('asks whether the client received it', () => {
    const [q] = generateClientQuestions({ facts: [], taxYear: 2025, filingStatus: 'single', missingDocuments: findMissingDocuments(prior, received) });
    expect(q).toMatchObject({
      kind: 'yes_no',
      text: 'Did you receive an interest statement (Form 1099-INT) from JPMORGAN CHASE BANK NA for 2025?',
      target: { kind: 'document', formType: '1099-INT', issuer: 'JPMORGAN CHASE BANK NA' },
    });
  });

  it.each([
    ['No, I closed that account in 2024.', false],
    ['Nope.', false],
    ["Yes, I'll send it over.", true],
    ['Not yet.', null],
    ["I don't think so.", null],
    ['I might, let me look.', null],
  ])('reads %j as %s', (words, want) => {
    const q = generateClientQuestions({ facts: [], taxYear: 2025, filingStatus: 'single', missingDocuments: findMissingDocuments(prior, received) })[0]!;
    expect(readAnswerFromWords(q, words)).toBe(want);
  });

  it('records the answer and reports what the client said', () => {
    const q = generateClientQuestions({ facts: [], taxYear: 2025, filingStatus: 'single', missingDocuments: findMissingDocuments(prior, received) })[0]!;
    const target = clientAnswerRecord(q, false);
    expect(target).toEqual({ kind: 'record', tool: 'set_document_expected', field: 'received', args: { formType: '1099-INT', issuer: 'JPMORGAN CHASE BANK NA', received: false } });
    if (target.kind !== 'record') throw new Error('unreachable');
    const r = invokeTaxTool({ tool: target.tool, args: target.args, context: { returnId: 'R', taxYear: 2025, sourceDocumentId: 'REPLY-1', sourceFileName: 'Client reply of Sep 30, 2026', extractor: 'test', sourceKind: 'client_response', rawText: { received: 'No, I closed that account in 2024.' } } });
    if (!r.ok) throw new Error(r.error);
    expect(r.application).toEqual({ kind: 'candidate_fact' });

    const answers = documentAnswers(r.facts);
    expect(answers).toEqual([{ formType: '1099-INT', issuer: 'JPMORGAN CHASE BANK NA', received: false, words: 'No, I closed that account in 2024.', source: 'Client reply of Sep 30, 2026' }]);
    const [m] = findMissingDocuments(prior, received, answers);
    expect(m).toMatchObject({ status: 'client_says_none', answer: { received: false } });
    // An answered document is not asked again.
    expect(generateClientQuestions({ facts: [], taxYear: 2025, filingStatus: 'single', missingDocuments: [m!] })).toEqual([]);
  });

  it('never matches a form of another kind or year-one documents', () => {
    const rejects = invokeTaxTool({ tool: 'set_document_expected', args: { formType: '1099-S', received: false }, context: { returnId: 'R', taxYear: 2025, sourceDocumentId: 'A', sourceFileName: 'a', extractor: 'test' } });
    expect(rejects.ok).toBe(false);
  });
});
