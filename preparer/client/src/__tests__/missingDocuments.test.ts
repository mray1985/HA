import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { caseQuestions, readClientReply } from '../services/clientReplies';
import { caseMissingDocuments, priorYearCase, sameClient } from '../services/missingDocuments';
import { loadTaxFacts } from '../services/preparerTaxFacts';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

const CLIENT = { firstName: 'Maya', lastName: 'Lee', ssn: '123-45-6789', filingStatus: FilingStatus.Single };

let thisYear = '';
const missing = () => caseMissingDocuments(getReturn(thisYear), loadTaxFacts(thisYear), []);
const review = () => buildCaseReview({ taxReturn: getReturn(thisYear), facts: loadTaxFacts(thisYear), documents: [], missingDocuments: missing() });

describe('missing documents on a case (§23)', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lastYear = createReturn(2024).id;
    updateReturn(lastYear, {
      ...CLIENT,
      w2Income: [{ id: 'w', employerName: 'ACME CORP', wages: 60000, federalTaxWithheld: 7000 }],
      income1099INT: [{ id: 'i', payerName: 'JPMORGAN CHASE BANK NA', amount: 123.45 }],
      income1099DIV: [{ id: 'd', payerName: 'Fidelity Investments', ordinaryDividends: 800, qualifiedDividends: 600 }],
    });
    thisYear = createReturn(2025).id;
    updateReturn(thisYear, {
      ...CLIENT,
      w2Income: [{ id: 'w', employerName: 'Acme Corp', wages: 62000, federalTaxWithheld: 7100 }],
      income1099DIV: [{ id: 'd', payerName: 'FIDELITY', ordinaryDividends: 850, qualifiedDividends: 650 }],
    });
  });

  it("finds last year's case for the same client, and only that client", () => {
    expect(priorYearCase(getReturn(thisYear))?.taxYear).toBe(2024);
    const other = createReturn(2024);
    updateReturn(other.id, { firstName: 'Maya', lastName: 'Lee', ssn: '987-65-4321' });
    expect(sameClient(getReturn(other.id), getReturn(thisYear))).toBe(false);
    // Without two SSNs: the same name and date of birth.
    expect(sameClient({ ...getReturn(thisYear), ssn: undefined, dateOfBirth: '1990-01-02' }, { ...getReturn(other.id), ssn: undefined, dateOfBirth: '1990-01-02' })).toBe(true);
    expect(sameClient({ ...getReturn(thisYear), ssn: undefined }, { ...getReturn(other.id), ssn: undefined })).toBe(false);
  });

  it('puts a possibly missing document in the review and asks the client', () => {
    expect(missing().map((m) => [m.formType, m.issuer, m.status])).toEqual([['1099-INT', 'JPMORGAN CHASE BANK NA', 'possibly_missing']]);
    const item = review().items.find((i) => i.id.startsWith('missing-document:'));
    expect(item).toMatchObject({
      category: 'REVIEW', group: 'documents',
      message: 'Possible missing 1099-INT from JPMORGAN CHASE BANK NA: the 2024 case has one for $123.45. Upload it, or ask the client (Client tab).',
    });
    expect(caseQuestions(thisYear).map((q) => q.text)).toEqual([
      'Did you receive an interest statement (Form 1099-INT) from JPMORGAN CHASE BANK NA for 2025?',
    ]);
  });

  it("settles it when the client says there is none, keeping the client's words", async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const { prompt } = JSON.parse(init?.body ?? '{}') as { prompt: string };
      n += 1;
      const content = prompt.includes('interest statement')
        ? { quote: 'No, I closed that Chase account in 2024', answer: 'no' }
        : prompt.startsWith('A client of a tax preparer') ? (prompt.includes('List each child') ? { people: [] } : { payments: [] }) : { quote: '', answer: 'not_stated' };
      return new Response(JSON.stringify({ content: JSON.stringify(content), run: { runId: `run-${n}`, role: 'reader', modelId: 'qwen3.5-0.8b', modelName: 'Qwen3.5-0.8B', quantization: 'Q4_K_M', revision: 'r', weightsSha256: 'a'.repeat(64), startedAt: '2026-09-30T00:00:00Z', ms: 800, ok: true } }), { status: 200 });
    }));
    const result = await readClientReply(thisYear, 'No, I closed that Chase account in 2024.');
    expect(result.answers.map((a) => a.outcome.status)).toEqual(['answered']);

    expect(missing()).toEqual([expect.objectContaining({ status: 'client_says_none', answer: expect.objectContaining({ received: false, words: 'No, I closed that Chase account in 2024' }) })]);
    const item = review().items.find((i) => i.id.startsWith('missing-document:'))!;
    expect(item.category).toBe('INFORMATIONAL');
    expect(item.message).toContain('The client says there is no 1099-INT from JPMORGAN CHASE BANK NA this year ("No, I closed that Chase account in 2024"');
    expect(caseQuestions(thisYear)).toEqual([]);
  });

  it('clears when the document arrives', () => {
    updateReturn(thisYear, { income1099INT: [{ id: 'i', payerName: 'Chase Bank USA, N.A.', amount: 140 }] });
    expect(missing()).toEqual([]);
    expect(review().items.some((i) => i.id.startsWith('missing-document:'))).toBe(false);
  });

  it("uses an imported prior-year return's totals when there is no case for last year", () => {
    const fresh = createReturn(2025).id;
    updateReturn(fresh, {
      firstName: 'Sam', lastName: 'Park',
      priorYearSummary: { source: 'competitor-pdf', taxYear: 2024, providerName: 'TurboTax', totalIncome: 0, agi: 0, taxableIncome: 0, deductionAmount: 0, totalTax: 0, totalCredits: 0, totalPayments: 0, refundAmount: 0, amountOwed: 0, effectiveTaxRate: 0, totalInterest: 845 },
    });
    expect(caseMissingDocuments(getReturn(fresh), [], []).map((m) => m.lastYear)).toEqual([
      'the 2024 return (TurboTax) reported $845.00 of taxable interest, and no 1099-INT is on the case',
    ]);
  });
});
