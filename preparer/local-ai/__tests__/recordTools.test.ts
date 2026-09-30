import { describe, expect, it } from 'vitest';
import { FilingStatus, type TaxReturn } from '@hatax/engine';
import { validateImportedFacts } from '../src/factValidation.js';
import {
  installmentDueDates,
  resolveDependents,
  resolveEstimatedPayments,
  resolveStateResidency,
} from '../src/recordResolution.js';
import { invokeReturnTool } from '../src/returnTools.js';
import type { TaxFact, TaxFactSourceKind } from '../src/taxFact.js';
import { invokeTaxTool, type TaxToolName } from '../src/taxTools.js';

function record(tool: TaxToolName, args: Record<string, unknown>, sourceDocumentId: string, sourceKind?: TaxFactSourceKind, index?: number): TaxFact[] {
  const result = invokeTaxTool({
    tool,
    args,
    context: {
      returnId: 'R1', taxYear: 2025, sourceDocumentId, sourceFileName: `${sourceDocumentId}.pdf`, extractor: 'test',
      ...(sourceKind ? { sourceKind } : {}),
      ...(index !== undefined ? { sourceFormIndex: index } : {}),
    },
  });
  if (!result.ok) throw new Error(result.error);
  return result.facts;
}

describe('record tools validate before anything is recorded', () => {
  const context = { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'D', sourceFileName: 'd.pdf', extractor: 'test' };
  const call = (tool: TaxToolName, args: Record<string, unknown>) => invokeTaxTool({ tool, args, context });

  it('accepts a dependent and writes DEPENDENT_ facts with their source kind', () => {
    const result = invokeTaxTool({ tool: 'add_dependent', args: { firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter', monthsLivedWithYou: 12 }, context: { ...context, sourceKind: 'client_response' } });
    expect(result).toMatchObject({ ok: true, application: { kind: 'dependent' } });
    if (!result.ok) return;
    expect(result.facts.map((f) => f.factType)).toEqual(['DEPENDENT_firstName', 'DEPENDENT_lastName', 'DEPENDENT_relationship', 'DEPENDENT_monthsLivedWithYou']);
    expect(result.facts.every((f) => f.sourceKind === 'client_response')).toBe(true);
  });

  it('rejects values outside what the engine can hold', () => {
    expect(call('add_dependent', { relationship: 'Child' }).ok).toBe(false);
    expect(call('add_dependent', { monthsLivedWithYou: 13 }).ok).toBe(false);
    expect(call('add_dependent', { dateOfBirth: '2025-02-30' }).ok).toBe(false);
    expect(call('add_dependent', { ssn: '12-345-6789' }).ok).toBe(false);
    expect(call('add_dependent', { nickname: 'M' }).ok).toBe(false);
    expect(call('add_schedule_c_income', { amount: -5 }).ok).toBe(false);
    expect(call('add_estimated_payment', { jurisdiction: 'Federal', amount: 100 }).ok).toBe(false);
    expect(call('add_estimated_payment', { jurisdiction: 'federal', installment: 5 }).ok).toBe(false);
    expect(call('set_state_residency', { stateCode: 'XX' }).ok).toBe(false);
  });

  it('applies receipts as one Schedule C item per source and payments / residency as totals', () => {
    expect(call('add_schedule_c_income', { description: 'Cash sales', amount: 1200 })).toMatchObject({ ok: true, incomeType: 'business-receipts', application: { kind: 'income_item', itemType: 'business-receipts' } });
    expect(call('add_estimated_payment', { jurisdiction: 'federal', amount: 500 })).toMatchObject({ ok: true, application: { kind: 'aggregate', target: 'estimatedPayments' } });
    expect(call('set_state_residency', { stateCode: 'CA', residencyType: 'resident' })).toMatchObject({ ok: true, application: { kind: 'aggregate', target: 'stateResidency' } });
  });
});

describe('resolveDependents', () => {
  it('merges a prior-year return and the client answer about the same child', () => {
    const facts = [
      ...record('add_dependent', { firstName: 'Maya', lastName: 'Lee', ssnLastFour: '4321', relationship: 'Daughter' }, 'PRIOR', 'structured_import'),
      ...record('add_dependent', { firstName: 'maya', lastName: 'LEE', monthsLivedWithYou: 12 }, 'ANSWER-1', 'client_response'),
    ];
    const [maya, ...rest] = resolveDependents(facts, 2025);
    expect(rest).toHaveLength(0);
    expect(maya).toMatchObject({ ready: true, formKeys: ['PRIOR#0', 'ANSWER-1#0'], missing: [], conflicts: [] });
    expect(maya!.fields).toEqual({ firstName: 'Maya', lastName: 'Lee', ssnLastFour: '4321', relationship: 'Daughter', monthsLivedWithYou: 12 });
  });

  it('waits for the months at home instead of assuming twelve', () => {
    const facts = record('add_dependent', { firstName: 'Sam', lastName: 'Lee', relationship: 'Son' }, 'PRIOR', 'structured_import');
    expect(resolveDependents(facts, 2025)[0]).toMatchObject({ ready: false, missing: ['monthsLivedWithYou'] });
  });

  it('lets the higher-authority source win and reports equal-authority disagreement', () => {
    const doc = record('add_dependent', { firstName: 'Sam', lastName: 'Lee', relationship: 'Son', monthsLivedWithYou: 7 }, 'DOC', 'document');
    const answer = record('add_dependent', { firstName: 'Sam', lastName: 'Lee', monthsLivedWithYou: 12 }, 'ANSWER-1', 'client_response');
    expect(resolveDependents([...doc, ...answer], 2025)[0]!.fields.monthsLivedWithYou).toBe(7);

    const second = record('add_dependent', { firstName: 'Sam', lastName: 'Lee', monthsLivedWithYou: 6 }, 'ANSWER-2', 'client_response');
    const [sam] = resolveDependents([...record('add_dependent', { firstName: 'Sam', lastName: 'Lee', relationship: 'Son' }, 'PRIOR', 'structured_import'), ...answer, ...second], 2025);
    expect(sam).toMatchObject({ ready: false, conflicts: [{ field: 'monthsLivedWithYou' }] });
  });

  it('keeps two people with the same name but different SSNs apart', () => {
    const facts = [
      ...record('add_dependent', { firstName: 'Alex', lastName: 'Kim', ssn: '123-45-6789', relationship: 'Son', monthsLivedWithYou: 12 }, 'A'),
      ...record('add_dependent', { firstName: 'Alex', lastName: 'Kim', ssn: '987654321', relationship: 'Nephew', monthsLivedWithYou: 12 }, 'B'),
    ];
    const people = resolveDependents(facts, 2025);
    expect(people.map((p) => p.fields.ssn)).toEqual(['123456789', '987654321']);
  });

  it('refuses a person born after the tax year', () => {
    const facts = record('add_dependent', { firstName: 'Baby', lastName: 'Lee', dateOfBirth: '2026-03-01', relationship: 'Son', monthsLivedWithYou: 0 }, 'A');
    expect(resolveDependents(facts, 2025)[0]).toMatchObject({ ready: false, problems: [expect.stringMatching(/after the 2025 tax year/)] });
  });

  it('matches several dependents listed on one prior-year return by their position', () => {
    const facts = [
      ...record('add_dependent', { firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter' }, 'PRIOR', 'structured_import', 0),
      ...record('add_dependent', { firstName: 'Sam', lastName: 'Lee', relationship: 'Son' }, 'PRIOR', 'structured_import', 1),
    ];
    expect(resolveDependents(facts, 2025).map((p) => p.formKeys)).toEqual([['PRIOR#0'], ['PRIOR#1']]);
  });
});

describe('estimated payments', () => {
  it('moves installment due dates off weekends and legal holidays (IRC §7503)', () => {
    expect(installmentDueDates(2025)).toEqual(['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15']);
    // 2022: Emancipation Day observed Friday April 15; January 15, 2023 was a Sunday and the 16th was MLK Day.
    expect(installmentDueDates(2022)).toEqual(['2022-04-18', '2022-06-15', '2022-09-15', '2023-01-17']);
  });

  it('places each federal payment in its installment and totals the states', () => {
    const facts = [
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1000, datePaid: '2025-04-15' }, 'P1'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1000, datePaid: '2025-06-16' }, 'P2'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1000, datePaid: '2025-06-17' }, 'P3'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 250, priorYearOverpaymentApplied: true }, 'P4'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 900, installment: 4, taxYear: 2025 }, 'P5'),
      ...record('add_estimated_payment', { jurisdiction: 'CA', amount: 400, datePaid: '2025-04-10' }, 'P6'),
      ...record('add_estimated_payment', { jurisdiction: 'CA', amount: 300.5, datePaid: '2026-01-12' }, 'P7'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 800, taxYear: 2026, installment: 1 }, 'P8'),
    ];
    const resolved = resolveEstimatedPayments(facts, 2025);
    expect(resolved.federal).toEqual({ quarters: [1250, 1000, 1000, 900], total: 4150, payments: 5 });
    expect(resolved.states).toEqual({ CA: { total: 700.5, payments: 2 } });
    expect(resolved.excluded).toEqual([{ formKey: 'P8#0', jurisdiction: 'federal', reason: 'The payment is for tax year 2026.' }]);
    expect(resolved.waiting).toEqual([]);
  });

  it('writes no federal total while any federal payment cannot be placed', () => {
    const facts = [
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1000, datePaid: '2025-04-15' }, 'P1'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1000, datePaid: '2026-02-01' }, 'P2'),
      ...record('add_estimated_payment', { jurisdiction: 'NY', amount: 200, datePaid: '2025-09-01' }, 'P3'),
    ];
    const resolved = resolveEstimatedPayments(facts, 2025);
    expect(resolved.federal).toBeUndefined();
    expect(resolved.waiting).toEqual([{ formKey: 'P2#0', jurisdiction: 'federal', reason: expect.stringMatching(/record which tax year/) }]);
    expect(resolved.states).toEqual({ NY: { total: 200, payments: 1 } });
  });

  it('holds a payment with no amount or jurisdiction, and a payment recorded twice', () => {
    const facts = [
      ...record('add_estimated_payment', { jurisdiction: 'federal', datePaid: '2025-04-15' }, 'P1'),
      ...record('add_estimated_payment', { amount: 50, datePaid: '2025-04-15' }, 'P2'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 700, datePaid: '2025-09-15' }, 'P3'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 700, datePaid: '2025-09-15' }, 'P4'),
    ];
    const v = validateImportedFacts(facts);
    expect(v.heldForms.sort()).toEqual(['P1#0', 'P2#0', 'P4#0']);
    expect(v.issues.find((i) => i.formKey === 'P2#0')!.message).toMatch(/jurisdiction is not in the evidence\. It is held until that is known/);
    expect(resolveEstimatedPayments(facts, 2025).federal).toBeUndefined();
  });
});

describe('resolveStateResidency', () => {
  it('sets a full-year resident state', () => {
    const facts = record('set_state_residency', { stateCode: 'CA', residencyType: 'resident' }, 'A');
    expect(resolveStateResidency(facts)).toEqual([{ stateCode: 'CA', formKeys: ['A#0'], residencyType: 'resident', conflicts: [], problems: [], ready: true }]);
  });

  it('needs the days for a part-year state', () => {
    const facts = [
      ...record('set_state_residency', { stateCode: 'NY', residencyType: 'part_year' }, 'A'),
      ...record('set_state_residency', { stateCode: 'NJ', residencyType: 'part_year', daysLivedInState: 200 }, 'B'),
    ];
    const [ny, nj] = resolveStateResidency(facts);
    expect(ny).toMatchObject({ ready: false, problems: [expect.stringMatching(/number of days/)] });
    expect(nj).toMatchObject({ ready: true, daysLivedInState: 200 });
  });

  it('refuses two full-year resident states and equal-authority disagreement', () => {
    const two = [
      ...record('set_state_residency', { stateCode: 'CA', residencyType: 'resident' }, 'A'),
      ...record('set_state_residency', { stateCode: 'OR', residencyType: 'resident' }, 'B'),
    ];
    expect(resolveStateResidency(two).every((s) => !s.ready && /both CA and OR/.test(s.problems[0]!))).toBe(true);

    const disagree = [
      ...record('set_state_residency', { stateCode: 'CA', residencyType: 'resident' }, 'A', 'client_response'),
      ...record('set_state_residency', { stateCode: 'CA', residencyType: 'nonresident' }, 'B', 'client_response'),
    ];
    expect(resolveStateResidency(disagree)[0]).toMatchObject({ ready: false, conflicts: [{ field: 'residencyType' }] });
  });
});

describe('business receipts', () => {
  it('warns when recorded receipts equal a 1099-NEC amount', () => {
    const facts = [
      ...record('add_1099_nec', { payerName: 'Client', amount: 4800 }, 'NEC'),
      ...record('add_schedule_c_income', { description: 'Invoices', amount: 4800 }, 'LEDGER'),
    ];
    expect(validateImportedFacts(facts).issues).toEqual([expect.objectContaining({ code: 'RECEIPTS_MATCH_1099', severity: 'warning', formKey: 'LEDGER#0' })]);
  });
});

describe('return tools', () => {
  const taxReturn = {
    id: 'R1', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review', filingStatus: FilingStatus.Single,
    firstName: 'Pat', lastName: 'Doe',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 50000, federalTaxWithheld: 6000 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [],
    income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [], income1099SA: [], incomeW2G: [],
    rentalProperties: [], otherIncome: 0, businesses: [], expenses: [], deductionMethod: 'standard', educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
  } as unknown as TaxReturn;

  it('calculate_return reports the engine totals and changes nothing', () => {
    const before = JSON.stringify(taxReturn);
    const result = invokeReturnTool({ tool: 'calculate_return', args: {}, taxReturn });
    expect(result.ok).toBe(true);
    if (!result.ok || result.tool !== 'calculate_return') return;
    expect(result.summary.agi).toBe(50000);
    expect(result.summary.totalPayments).toBe(6000);
    expect(result.summary).toEqual({
      agi: result.calculation.form1040.agi, taxableIncome: result.calculation.form1040.taxableIncome, totalTax: result.calculation.form1040.totalTax,
      totalPayments: 6000, refundAmount: result.calculation.form1040.refundAmount, amountOwed: result.calculation.form1040.amountOwed,
    });
    expect(JSON.stringify(taxReturn)).toBe(before);
  });

  it('run_diagnostics reports engine diagnostics and the forms evidence holds', () => {
    const facts = record('add_w2', { employerName: 'Acme', wages: 50000 }, 'W2');
    const result = invokeReturnTool({ tool: 'run_diagnostics', args: {}, taxReturn, facts });
    expect(result.ok).toBe(true);
    if (!result.ok || result.tool !== 'run_diagnostics') return;
    expect(result.heldForms).toEqual(['W2#0']);
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.diagnostics.length);
  });

  it('rejects any argument', () => {
    expect(invokeReturnTool({ tool: 'calculate_return', args: { wages: 1 }, taxReturn })).toMatchObject({ ok: false });
  });
});
