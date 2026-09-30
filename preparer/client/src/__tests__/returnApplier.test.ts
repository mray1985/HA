import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTaxTool, type TaxToolName, type TaxToolSuccess } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { appendTaxFacts } from '../services/preparerTaxFacts';
import { applyToolResult, SOURCE_FORM_KEY } from '../services/returnApplier';

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
