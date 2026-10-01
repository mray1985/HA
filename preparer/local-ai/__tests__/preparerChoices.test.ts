import { describe, expect, it } from 'vitest';
import { validateImportedFacts } from '../src/factValidation.js';
import { isLongTermHolding } from '../src/holdingPeriod.js';
import { buildChoiceItem, fieldInput, recordFieldCorrection, recordPreparerChoice, toolFieldsFromFacts, type ChoiceTool } from '../src/preparerChoices.js';
import { extractStructuredFields } from '../src/structuredExtraction.js';
import type { TaxFact } from '../src/taxFact.js';
import { invokeTaxTool, type DocumentToolName } from '../src/taxTools.js';

const context = { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'DOC', sourceFileName: 'doc.pdf', extractor: 'test' };

function form(tool: DocumentToolName, args: Record<string, unknown>): TaxFact[] {
  const r = invokeTaxTool({ tool, args, context });
  if (!r.ok) throw new Error(r.error);
  return r.facts;
}

function decide(tool: ChoiceTool, facts: TaxFact[], answer: Record<string, unknown>) {
  const r = recordPreparerChoice(tool, answer, { ...context, extractor: 'preparer' });
  if (!r.ok) throw new Error(r.error);
  return buildChoiceItem(tool, [...facts, ...r.facts]);
}

describe('preparer choices', () => {
  it('needs an answer before a 1099-Q is entered, then builds the engine item from form + answer', () => {
    const q = form('add_1099_q', { payerName: 'LOUISIANA START\n1 MAIN ST', grossDistribution: 8000, earnings: 1200, basisReturn: 6800, recipientNotDesignatedBeneficiary: true });
    expect(buildChoiceItem('add_1099_q', q)).toEqual({ state: 'needs_answer', missing: ['qualifiedExpenses'] });
    expect(decide('add_1099_q', q, { qualifiedExpenses: 5000 })).toEqual({
      state: 'ready', target: 'income1099Q',
      item: { payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200, basisReturn: 6800, qualifiedExpenses: 5000, distributionType: 'non_qualified', recipientType: 'accountOwner' },
    });
    expect(decide('add_1099_q', q, { qualifiedExpenses: 9000 })).toMatchObject({ item: { distributionType: 'qualified' } });
  });

  it('asks box 6 when the page did not settle who received the 1099-Q', () => {
    const q = form('add_1099_q', { payerName: 'PLAN', grossDistribution: 8000, earnings: 1200, basisReturn: 6800 });
    expect(decide('add_1099_q', q, { qualifiedExpenses: 9000 })).toEqual({ state: 'needs_answer', missing: ['recipientNotDesignatedBeneficiary'] });
  });

  it('requires Form 8863 lines 23–26 for the American Opportunity credit', () => {
    expect(recordPreparerChoice('add_education_expense', { creditType: 'american_opportunity' }, context)).toMatchObject({ ok: false, error: expect.stringMatching(/aotcClaimedPrior4Years.*Form 8863/) });
    const t = form('add_education_expense', { institutionName: 'BAYOU STATE UNIVERSITY', institutionEin: '72-6001234', studentName: 'MAYA TESTPAYER', tuitionPaid: 8400, scholarships: 1000, halfTimeStudent: true });
    expect(decide('add_education_expense', t, { creditType: 'american_opportunity', aotcClaimedPrior4Years: false, completedFirst4Years: false, felonyDrugConviction: false })).toEqual({
      state: 'ready', target: 'educationCredits',
      item: { type: 'american_opportunity', studentName: 'MAYA TESTPAYER', institution: 'BAYOU STATE UNIVERSITY', institutionEIN: '726001234', received1098T: true, tuitionPaid: 8400, scholarships: 1000, enrolledHalfTime: true, aotcClaimedPrior4Years: false, completedFirst4Years: false, felonyDrugConviction: false },
    });
  });

  it('enters an HSA distribution only on a yes/no answer, and leaves MSA distributions to the preparer', () => {
    const sa = form('add_1099_sa', { payerName: 'HEALTH TRUST', grossDistribution: 900, distributionCode: '1', accountType: 'HSA' });
    expect(decide('add_1099_sa', sa, { usedForQualifiedMedicalExpenses: false })).toMatchObject({ state: 'ready', item: { qualifiedMedicalExpenses: false } });
    const msa = form('add_1099_sa', { payerName: 'HEALTH TRUST', grossDistribution: 900, distributionCode: '1', accountType: 'Archer MSA' });
    expect(buildChoiceItem('add_1099_sa', msa)).toMatchObject({ state: 'manual', reason: expect.stringMatching(/Form 8853/) });
  });

  it('builds a home sale only for a main home with its §121 facts', () => {
    const s = form('add_1099_s', { filerName: 'MAGNOLIA TITLE', grossProceeds: 310000, closingDate: '06/12/2025' });
    expect(recordPreparerChoice('add_1099_s', { mainHome: true, costBasis: 180000 }, context)).toMatchObject({ ok: false });
    expect(decide('add_1099_s', s, { mainHome: false })).toMatchObject({ state: 'manual' });
    expect(decide('add_1099_s', s, { mainHome: true, costBasis: 180000, ownedMonths: 60, usedAsResidenceMonths: 60, priorExclusionUsedWithin2Years: false })).toEqual({
      state: 'ready', target: 'homeSale',
      item: { salePrice: 310000, costBasis: 180000, ownedMonths: 60, usedAsResidenceMonths: 60, priorExclusionUsedWithin2Years: false },
    });
  });
});

describe('field corrections for a held form', () => {
  it('validates the value with the form tool\'s own schema and replaces the unread value', () => {
    const b = form('add_1099_b', { brokerName: 'SUMMIT', proceeds: 12500 });
    expect(validateImportedFacts(b).heldForms).toEqual(['DOC#0']);
    expect(recordFieldCorrection('add_1099_b', 'isLongTerm', 'yes', context)).toMatchObject({ ok: false });
    expect(recordFieldCorrection('add_1099_b', 'nope', 1, context)).toMatchObject({ ok: false });
    const term = recordFieldCorrection('add_1099_b', 'isLongTerm', true, context);
    const basis = recordFieldCorrection('add_1099_b', 'costBasis', 9100.5, context);
    if (!term.ok || !basis.ok) throw new Error('rejected');
    const all = [...b.filter((f) => f.sourceField !== 'costBasis' && f.sourceField !== 'isLongTerm'), ...term.facts, ...basis.facts];
    expect(validateImportedFacts(all).heldForms).toEqual([]);
    expect(all.filter((f) => f.sourceKind === 'preparer_correction').map((f) => f.verified)).toEqual([true, true]);
    expect(toolFieldsFromFacts('add_1099_b', all)).toEqual({ brokerName: 'SUMMIT', proceeds: 12500, isLongTerm: true, costBasis: 9100.5 });
  });

  it('describes how each field is entered', () => {
    expect(fieldInput('add_1099_b', 'isLongTerm')).toEqual({ kind: 'boolean' });
    expect(fieldInput('add_1099_b', 'costBasis')).toEqual({ kind: 'number', integer: false });
    expect(fieldInput('add_dependent' as DocumentToolName, 'x')).toBeNull();
  });
});

describe('1099-B holding period (IRC §1222)', () => {
  it('counts from the day after acquisition: exactly one year is short-term', () => {
    expect(isLongTermHolding('01/01/2024', '01/01/2025')).toBe(false);
    expect(isLongTermHolding('01/01/2024', '01/02/2025')).toBe(true);
    expect(isLongTermHolding('2024-02-29', '2025-02-28')).toBe(false);
    expect(isLongTermHolding('2024-02-29', '2025-03-01')).toBe(true);
    expect(isLongTermHolding('VARIOUS', '11/03/2025')).toBeUndefined();
    expect(isLongTermHolding('02/30/2024', '11/03/2025')).toBeUndefined();
  });

  it('derives the term from boxes 1b and 1c when box 2 is not read', () => {
    const { args, rawText } = extractStructuredFields('add_1099_b', { brokerName: 'SUMMIT', dateAcquired: '03/02/2019', dateSold: '11/03/2025', proceeds: '12,500.00', costBasis: '9,100.50' });
    expect(args.isLongTerm).toBe(true);
    expect(rawText.isLongTerm).toMatch(/derived from box 1b 03\/02\/2019 and box 1c 11\/03\/2025/);
  });

  it('holds a sale whose box 2 contradicts its dates', () => {
    const b = form('add_1099_b', { brokerName: 'SUMMIT', dateAcquired: '03/02/2025', dateSold: '11/03/2025', proceeds: 12500, costBasis: 9100.5, isLongTerm: true });
    expect(validateImportedFacts(b).issues.map((i) => i.code)).toContain('B_TERM_CONTRADICTS_DATES');
  });
});
