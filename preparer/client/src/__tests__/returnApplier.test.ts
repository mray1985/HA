import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formToolForIncomeType, invokeTaxTool, type IngestedDocument, type TaxToolName, type TaxToolSuccess } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { appendTaxFacts } from '../services/preparerTaxFacts';
import { applyExtraction, applyToolResult, SOURCE_FORM_KEY, YEAR_ITEM_PREFIX } from '../services/returnApplier';
import { loadDocuments, upsertDocument, type ApplyExtractionResult } from '../services/documentIngestion';
import { saveReviewRecord } from '../services/caseAudit';
import { applyReleasedForm, reapplyForm, withdrawReleasedForm } from '../services/preparerDecisions';
import { buildCaseReview } from '../services/caseReview';
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

let returnId = '';

/** Run a tool the way intake does, save its facts, and apply it. */
function readDocument(tool: TaxToolName, args: Record<string, unknown>, documentId: string) {
  const result = invokeTaxTool({
    tool,
    args,
    context: { returnId, taxYear: 2026, sourceDocumentId: documentId, sourceFileName: `${documentId}.pdf`, extractor: 'test' },
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  appendTaxFacts(returnId, (result as TaxToolSuccess).facts);
  return applyToolResult(returnId, result as TaxToolSuccess, { documentId });
}

describe('applyToolResult', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('adds one income item per document form and replaces it when the form is read again', () => {
    const first = readDocument('add_w2', { employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4, stateWages: 52431.18 }, 'DOC-W2');
    expect(first).toMatchObject({ kind: 'income_item', itemType: 'w2', replaced: false });
    const again = readDocument('add_w2', { employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 }, 'DOC-W2');
    expect(again).toMatchObject({ kind: 'income_item', replaced: true });

    const w2s = getReturn(returnId).w2Income;
    expect(w2s).toHaveLength(1);
    expect(w2s[0]).toMatchObject({ wages: 52431.18, [SOURCE_FORM_KEY]: 'DOC-W2#0' });
    // A box read the first time but unknown the second time does not linger.
    expect(w2s[0]).not.toHaveProperty('stateWages');
  });

  it('never applies a form that validation holds', () => {
    // 1099-DIV qualified dividends cannot exceed ordinary dividends.
    const outcome = readDocument('add_1099_div', { payerName: 'Summit Index Funds', ordinaryDividends: 100, qualifiedDividends: 250 }, 'DOC-DIV');
    expect(outcome.kind).toBe('held');
    expect(getReturn(returnId).income1099DIV).toHaveLength(0);
  });

  it('turns a "no" discovery answer into "yes" when a document proves the income exists', () => {
    updateReturn(returnId, { incomeDiscovery: { '1099int': 'no' } });
    readDocument('add_1099_int', { payerName: 'First Harbor Bank', amount: 1284.66 }, 'DOC-INT');
    expect(getReturn(returnId).incomeDiscovery['1099int']).toBe('yes');
  });

  it('totals Social Security benefits over every SSA-1099 and never counts an unknown as zero', () => {
    readDocument('add_ssa_1099', { netBenefits: 18000, federalTaxWithheld: 1800 }, 'DOC-SSA-1');
    const both = readDocument('add_ssa_1099', { netBenefits: 9600, isSpouse: true }, 'DOC-SSA-2');
    expect(both).toMatchObject({ kind: 'aggregate', applied: true, forms: 2 });
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 27600, federalTaxWithheld: 1800 });

    const unknown = readDocument('add_ssa_1099', { federalTaxWithheld: 50 }, 'DOC-SSA-3');
    expect(unknown).toMatchObject({ kind: 'aggregate', applied: false, reason: expect.stringContaining('DOC-SSA-3#0 is held') });
    expect(getReturn(returnId).incomeSSA1099!.totalBenefits).toBe(27600);
  });

  it('totals mortgage interest and writes the balance only when every Form 1098 reports it', () => {
    readDocument('add_mortgage_interest', { lenderName: 'Crescent City Mortgage Co', mortgageInterest: 9412.37, outstandingPrincipal: 214880.15 }, 'DOC-1098-1');
    expect(getReturn(returnId).itemizedDeductions).toMatchObject({ mortgageInterest: 9412.37, mortgageBalance: 214880.15 });
    readDocument('add_mortgage_interest', { lenderName: 'Second Lender', mortgageInterest: 600 }, 'DOC-1098-2');
    const itemized = getReturn(returnId).itemizedDeductions!;
    expect(itemized.mortgageInterest).toBe(10012.37);
    expect(itemized.mortgageBalance).toBeUndefined();
  });

  it('records an education form as facts only, for the preparer to choose the credit', () => {
    const outcome = readDocument('add_education_expense', { institutionName: 'Bayou State University', tuitionPaid: 8400 }, 'DOC-1098T');
    expect(outcome).toEqual({ kind: 'recorded' });
    expect(getReturn(returnId).educationCredits).toHaveLength(0);
  });
});

describe('work order §16 forms', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('records a 1099-Q, 1099-SA or 1099-S for the preparer instead of guessing what the form cannot say', () => {
    expect(readDocument('add_1099_q', { payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200, basisReturn: 6800 }, 'DOC-Q')).toEqual({ kind: 'recorded' });
    expect(readDocument('add_1099_sa', { payerName: 'HEALTH TRUST', grossDistribution: 900, distributionCode: '1' }, 'DOC-SA')).toEqual({ kind: 'recorded' });
    expect(readDocument('add_1099_s', { filerName: 'MAGNOLIA TITLE', grossProceeds: 310000, closingDate: '06/12/2025' }, 'DOC-S')).toEqual({ kind: 'recorded' });
    const tr = getReturn(returnId);
    expect(tr.income1099Q ?? []).toEqual([]);
    expect(tr.income1099SA ?? []).toEqual([]);
    expect(tr.homeSale).toBeUndefined();

    const ids = buildCaseReview({ taxReturn: tr, facts: loadTaxFacts(returnId), documents: [] }).items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['document:qtp-expenses:DOC-Q#0', 'document:hsa-use:DOC-SA#0', 'document:home-sale:DOC-S#0']));
  });

  it('enters a 1099-C without its review-only box 5, and a 1099-OID as an OID item', () => {
    readDocument('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'G', personallyLiable: true }, 'DOC-C');
    readDocument('add_1099_oid', { payerName: 'TREASURY DIRECT', originalIssueDiscount: 142.1 }, 'DOC-OID');
    const tr = getReturn(returnId);
    expect(tr.income1099C).toEqual([{ payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'G', [SOURCE_FORM_KEY]: 'DOC-C#0', id: expect.any(String) }]);
    expect(tr.income1099OID).toEqual([expect.objectContaining({ originalIssueDiscount: 142.1, [SOURCE_FORM_KEY]: 'DOC-OID#0' })]);
  });

  it('holds a 1099-B with no term or basis instead of entering it short-term at zero basis', () => {
    expect(readDocument('add_1099_b', { brokerName: 'SUMMIT BROKERAGE', proceeds: 12500 }, 'DOC-B')).toMatchObject({ kind: 'held' });
    expect(getReturn(returnId).income1099B).toEqual([]);
  });
});

describe('W-2c', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  const readW2 = () => readDocument('add_w2', { employerName: 'RIVERBEND LOGISTICS', employerEin: '72-1234567', wages: 52431.18, federalTaxWithheld: 5873.4 }, 'DOC-W2');

  it('corrects the W-2 on the return, and the correction survives the W-2 being read again', () => {
    readW2();
    expect(readDocument('add_w2c', { employerEin: '72-1234567', taxYearCorrected: 2025, previousWages: 52431.18, correctWages: 54000 }, 'DOC-W2C'))
      .toEqual({ kind: 'correction', applied: true, w2FormKey: 'DOC-W2#0' });
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 54000, federalTaxWithheld: 5873.4, [SOURCE_FORM_KEY]: 'DOC-W2#0' })]);
    readW2();
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 54000 })]);
  });

  it('waits for the W-2 it corrects and says so in the review', () => {
    expect(readDocument('add_w2c', { employerName: 'RIVERBEND LOGISTICS', employerEin: '72-1234567', correctWages: 54000 }, 'DOC-W2C'))
      .toMatchObject({ kind: 'correction', applied: false, reason: expect.stringMatching(/not on the case/) });
    expect(getReturn(returnId).w2Income).toEqual([]);
    const item = buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [] }).items.find((i) => i.id === 'record:w2c:DOC-W2C#0');
    expect(item?.message).toMatch(/The W-2c from RIVERBEND LOGISTICS .* is not applied/);
  });
});

describe('applyExtraction', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  /** One form of a multi-form file, as document intake produces it. */
  function piece(incomeType: string, fields: Record<string, unknown>, formIndex: number) {
    const tool = formToolForIncomeType(incomeType);
    const facts = tool
      ? (invokeTaxTool({ tool, args: fields, context: { returnId, taxYear: 2026, sourceDocumentId: 'DOC-PDF', sourceFormIndex: formIndex, sourceFileName: 'employer.pdf', extractor: 'test' } }) as TaxToolSuccess).facts
      : [];
    appendTaxFacts(returnId, facts);
    return { facts, toolFields: fields, incomeType, validation: { ready: true, issues: [], heldForms: [] }, extracted: {} as never, classification: {} as never };
  }

  it('adds one item per form of a multi-form PDF and records how each form was applied', () => {
    // Every classifiable form now has a tool, so this drives the "no tool" branch
// with a form type outside the map on purpose: the guarantee is that a form the
// app cannot place is reported, not dropped.
const document: IngestedDocument = { documentId: 'DOC-PDF', returnId, fileName: 'employer.pdf', mimeType: 'application/pdf', byteLength: 1, contentHash: 'h', ingestedAt: '', status: 'extracted', formTypes: ['W-2', 'W-2', 'unreadable-form'] };
    const extraction: ApplyExtractionResult = {
      document,
      pieces: [
        piece('w2', { employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 }, 0),
        piece('w2', { employerName: 'Bayou Events Catering Inc', wages: 8100, federalTaxWithheld: 405 }, 1),
        piece('unreadable-form', { amount: 4000 }, 2),
      ],
      facts: [],
    };
    expect(applyExtraction(returnId, extraction)).toEqual(['income_item', 'income_item', 'not_applied']);
    expect(getReturn(returnId).w2Income.map((w) => w.employerName)).toEqual(['Riverbend Logistics LLC', 'Bayou Events Catering Inc']);
    expect(new Set(loadTaxFacts(returnId).map((f) => f.sourceFormIndex ?? 0))).toEqual(new Set([0, 1]));

    const saved = loadDocuments(returnId)[0]!;
    expect(saved.appliedAs).toEqual(['income_item', 'income_item', 'not_applied']);
    const review = buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [saved] });
    expect(review.items.find((i) => i.id === 'document:not-applied:DOC-PDF#2')?.message).toContain('the unreadable-form was read but is not entered automatically');
  });
});

describe('a form printed for another year, released and taken back', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn(2025).id;
  });

  /** The document a form came from, with the year printed on it. */
  const printed = (documentId: string, year: string) =>
    upsertDocument(returnId, { documentId, returnId, fileName: `${documentId}.pdf`, status: 'extracted', taxYearsPrinted: [year] } as unknown as IngestedDocument);
  const decide = (formKey: string, decision?: 'accepted' | 'not_applicable') =>
    saveReviewRecord(returnId, { resolutions: decision ? { [`${YEAR_ITEM_PREFIX}${formKey}`]: { decision, note: 'test', resolvedAt: '2026-10-01T00:00:00Z' } } : {} });

  it("keeps a 2024 SSA-1099 out of the 2025 total, adds it when accepted, and takes it back out when reopened", () => {
    readDocument('add_ssa_1099', { netBenefits: 18000, federalTaxWithheld: 1800 }, 'DOC-SSA-1');
    printed('DOC-SSA-2', '2024');
    expect(readDocument('add_ssa_1099', { netBenefits: 9600 }, 'DOC-SSA-2')).toMatchObject({ kind: 'held' });
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 18000 });

    // "Not applicable to this client": it stays off.
    decide('DOC-SSA-2#0', 'not_applicable');
    expect(reapplyForm(returnId, 'DOC-SSA-2#0')).toMatchObject({ kind: 'held' });
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 18000 });

    decide('DOC-SSA-2#0', 'accepted');
    applyReleasedForm(returnId, 'DOC-SSA-2#0', 'test');
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 27600 });

    decide('DOC-SSA-2#0');
    withdrawReleasedForm(returnId, 'DOC-SSA-2#0');
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 18000 });
  });

  it('takes a total away when the only form that gave it is taken back', () => {
    printed('DOC-SSA', '2024');
    readDocument('add_ssa_1099', { netBenefits: 9600 }, 'DOC-SSA');
    expect(getReturn(returnId).incomeSSA1099).toBeUndefined();
    decide('DOC-SSA#0', 'accepted');
    applyReleasedForm(returnId, 'DOC-SSA#0', 'test');
    expect(getReturn(returnId).incomeSSA1099).toMatchObject({ totalBenefits: 9600 });
    decide('DOC-SSA#0');
    withdrawReleasedForm(returnId, 'DOC-SSA#0');
    expect(getReturn(returnId).incomeSSA1099).toBeUndefined();
  });

  it("takes a W-2c's correction back off the W-2", () => {
    readDocument('add_w2', { employerName: 'RIVERBEND LOGISTICS', employerEin: '72-1234567', wages: 52431.18, federalTaxWithheld: 5873.4 }, 'DOC-W2');
    printed('DOC-W2C', '2026');
    expect(readDocument('add_w2c', { employerEin: '72-1234567', taxYearCorrected: 2025, previousWages: 52431.18, correctWages: 54000 }, 'DOC-W2C')).toMatchObject({ kind: 'held' });
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 52431.18 })]);
    decide('DOC-W2C#0', 'accepted');
    applyReleasedForm(returnId, 'DOC-W2C#0', 'test');
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 54000 })]);
    decide('DOC-W2C#0');
    withdrawReleasedForm(returnId, 'DOC-W2C#0');
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 52431.18 })]);
  });
});

describe('a business expense from a client reply', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn(2025).id;
  });

  const expense = (extra: Record<string, unknown> = {}) =>
    readDocument('add_business_expense', { amount: 3200, description: 'software', scheduleCLine: 27, category: 'other', ...extra }, 'REPLY-1:note');

  it('waits for its business when the return has more than one, and goes to the one chosen', () => {
    updateReturn(returnId, { businesses: [{ id: 'biz-a', businessName: 'Design' }, { id: 'biz-b', businessName: 'Tutoring', isSpouse: true }] as never });
    expect(expense()).toEqual({ kind: 'held', reason: 'The return has more than one business: the expense waits for the business it belongs to.' });
    expect(getReturn(returnId).expenses).toEqual([]);
    expect(expense({ businessId: 'biz-b' })).toMatchObject({ kind: 'income_item', itemType: 'expenses' });
    expect(getReturn(returnId).expenses).toEqual([expect.objectContaining({ amount: 3200, businessId: 'biz-b' })]);
    // A business no longer on the return: taken off, and it waits again.
    expect(expense({ businessId: 'biz-gone' })).toMatchObject({ kind: 'held', reason: expect.stringMatching(/no longer on the return/) });
    expect(getReturn(returnId).expenses).toEqual([]);
  });

  it("goes to the return's only business", () => {
    updateReturn(returnId, { businesses: [{ id: 'biz-a', businessName: 'Design' }] as never });
    expense();
    expect(getReturn(returnId).expenses).toEqual([expect.objectContaining({ businessId: 'biz-a' })]);
  });
});

describe('Form 1098-E aggregate', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('sums student loan interest from every 1098-E on the case', () => {
    const first = readDocument('add_1098_e', { lenderName: 'BANK A', studentLoanInterest: 1842.55 }, 'DOC-E1');
    expect(first).toEqual({ kind: 'aggregate', target: 'studentLoanInterest', applied: true, forms: 1 });
    expect(getReturn(returnId).studentLoanInterest).toBe(1842.55);

    readDocument('add_1098_e', { lenderName: 'BANK B', studentLoanInterest: 657.45 }, 'DOC-E2');
    expect(getReturn(returnId).studentLoanInterest).toBe(2500);
  });

  it('does not take box 1 as the deduction when box 2 is checked', () => {
    // Box 2 means box 1 leaves out origination fees and capitalized interest, so
    // the deductible amount is the Deduction Worksheet's, not box 1's.
    const out = readDocument('add_1098_e', { lenderName: 'BANK A', studentLoanInterest: 1842.55, originationFeesExcluded: true }, 'DOC-E1');
    expect(out.kind).toBe('aggregate');
    if (out.kind !== 'aggregate' || out.applied) return;
    expect(out.reason).toContain('Deduction Worksheet');
    // Nothing is written: a partial deduction would silently understate it.
    expect(getReturn(returnId).studentLoanInterest ?? 0).toBe(0);
  });

  it('applies box 1 when box 2 is present and unchecked', () => {
    const out = readDocument('add_1098_e', { lenderName: 'BANK A', studentLoanInterest: 900, originationFeesExcluded: false }, 'DOC-E1');
    expect(out).toMatchObject({ applied: true });
    expect(getReturn(returnId).studentLoanInterest).toBe(900);
  });

  it('withholds the total when box 1 could not be read', () => {
    // studentLoanInterest is a required amount, so an unreadable box 1 holds the
    // form and the total is not written rather than becoming a zero deduction.
    const out = readDocument('add_1098_e', { lenderName: 'BANK A' }, 'DOC-E1');
    expect(out.kind).toBe('aggregate');
    if (out.kind !== 'aggregate' || out.applied) return;
    expect(out.reason).toBeTruthy();
    expect(getReturn(returnId).studentLoanInterest ?? 0).toBe(0);
  });

  it('says in the case review why a read 1098-E is not on the return', () => {
    readDocument('add_1098_e', { lenderName: 'BANK A', studentLoanInterest: 1842.55, originationFeesExcluded: true }, 'DOC-E1');
    const doc = { documentId: 'DOC-E1', returnId, fileName: 'f1098e.pdf', mimeType: 'application/pdf', byteLength: 1, contentHash: 'h', ingestedAt: '', status: 'extracted', formTypes: ['1098-E'], appliedAs: ['aggregate_waiting'], applyReasons: ['Form 1098-E DOC-E1#0 has box 2 checked: box 1 excludes origination fees and capitalized interest, so the deduction is worked on the Deduction Worksheet rather than taken from box 1.'] } as IngestedDocument;
    const review = buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [doc] });
    const item = review.items.find((i) => i.id === 'document:aggregate-waiting:DOC-E1#0');
    expect(item?.message).toContain('Deduction Worksheet');
  });
});

describe('apply reasons stay true when a form is reapplied', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('records a reason beside the outcome, and keeps them together', () => {
    const document: IngestedDocument = { documentId: 'DOC-E1', returnId, fileName: 'f1098e.pdf', mimeType: 'application/pdf', byteLength: 1, contentHash: 'h', ingestedAt: '', status: 'extracted', formTypes: ['1098-E'] };
    const toolResult = invokeTaxTool({
      tool: 'add_1098_e',
      args: { lenderName: 'BANK A', studentLoanInterest: 1842.55, originationFeesExcluded: true },
      context: { returnId, taxYear: 2026, sourceDocumentId: 'DOC-E1', sourceFileName: 'f1098e.pdf', extractor: 'test' },
    });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) return;
    const facts = (toolResult as TaxToolSuccess).facts;
    appendTaxFacts(returnId, facts);
    const extraction: ApplyExtractionResult = {
      document,
      pieces: [{
        incomeType: '1098e',
        toolFields: { lenderName: 'BANK A', studentLoanInterest: 1842.55, originationFeesExcluded: true },
        facts,
        validation: { ready: true, issues: [], heldForms: [] },
        extracted: {} as never,
        classification: {} as never,
      }],
      facts,
    };
    applyExtraction(returnId, extraction);
    const saved = loadDocuments(returnId)[0]!;
    expect(saved.appliedAs).toEqual(['aggregate_waiting']);
    // The reason is what tells the preparer the deduction is on the worksheet
    // rather than on the return, so it has to be stored, not just returned.
    expect(saved.applyReasons?.[0]).toContain('Deduction Worksheet');
    expect(saved.applyReasons).toHaveLength(saved.appliedAs!.length);

    // Reapplying must not leave the earlier reason behind.
    reapplyForm(returnId, 'DOC-E1#0');
    const again = loadDocuments(returnId)[0]!;
    expect(again.applyReasons).toHaveLength(again.appliedAs!.length);
    expect(again.applyReasons?.[0]).toContain('Deduction Worksheet');
  });
});