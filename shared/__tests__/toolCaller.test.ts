import { describe, expect, it } from 'vitest';
import { validateImportedFacts } from '../src/taxfacts/factValidation.js';
import { addW2 } from '../src/taxfacts/taxTools.js';
import {
  callIncomeToolFromStructuredFields,
  deterministicToolCaller,
  executeDeterministicToolCall,
  proposeFilingStatusCandidate,
  proposeIncomeToolCall,
} from '../src/taxfacts/toolCaller.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-ocr',
};

describe('tool caller (development-order step 9)', () => {
  it('proposes add_w2 from a classified W-2 and invokes with validated fields', () => {
    const proposal = proposeIncomeToolCall('w2', {
      employerName: 'Acme',
      wages: 40_000,
      federalTaxWithheld: 0,
    });
    expect(proposal).toEqual({
      tool: 'add_w2',
      args: {
        employerName: 'Acme',
        wages: 40_000,
        federalTaxWithheld: 0,
      },
    });

    const outcome = executeDeterministicToolCall({ proposal: proposal!, context: ctx });
    expect(outcome.ok).toBe(true);
    expect(outcome.tool).toBe('add_w2');
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.appliedArgs).toEqual({
      employerName: 'Acme',
      wages: 40_000,
      federalTaxWithheld: 0,
    });
    expect(outcome.skippedFields).toEqual([]);
    expect(outcome.validation.ready).toBe(true);

    const wages = outcome.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.value).toBe(40_000);
    const withheld = outcome.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.value).toBe(0);
  });

  it('never passes a validation-rejected field to the tax-engine tool', () => {
    const outcome = callIncomeToolFromStructuredFields({
      incomeType: 'w2',
      args: {
        employerName: 'Acme',
        wages: -500,
        federalTaxWithheld: 1200,
      },
      context: ctx,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.validation.ready).toBe(false);
    expect(outcome.skippedFields).toContain('wages');
    expect(outcome.appliedArgs).not.toHaveProperty('wages');
    expect(outcome.appliedArgs.federalTaxWithheld).toBe(1200);
    expect(outcome.appliedArgs.employerName).toBe('Acme');

    // Review facts still show the rejected extracted value (not rewritten to 0).
    const wagesFact = outcome.facts.find((f) => f.sourceField === 'wages');
    expect(wagesFact?.value).toBe(-500);

    // The clean tool result must not carry the rejected wages field.
    expect(outcome.result?.ok).toBe(true);
    if (outcome.result?.ok) {
      expect(outcome.result.fields).not.toHaveProperty('wages');
      expect(outcome.result.fields.federalTaxWithheld).toBe(1200);
    }
  });

  it('keeps UNKNOWN out of applied args and keeps a real numeric 0', () => {
    const outcome = callIncomeToolFromStructuredFields({
      incomeType: '1099int',
      args: {
        payerName: 'Bank',
        amount: 0,
        federalTaxWithheld: undefined,
      },
      context: { ...ctx, sourceFileName: '1099int.pdf' },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.appliedArgs).toEqual({
      payerName: 'Bank',
      amount: 0,
    });
    expect(outcome.appliedArgs).not.toHaveProperty('federalTaxWithheld');
    expect(outcome.appliedArgs.amount).not.toBeUndefined();
  });

  it('records filing status as a candidate fact only', () => {
    const proposal = proposeFilingStatusCandidate('single');
    const outcome = deterministicToolCaller.execute({ proposal, context: ctx });

    expect(outcome.ok).toBe(true);
    expect(outcome.tool).toBe('set_filing_status_candidate');
    expect(outcome.result?.ok).toBe(true);
    if (outcome.result?.ok) {
      expect(outcome.result.appliesFilingStatus).toBe(false);
      expect(outcome.result.fields).toEqual({ status: 'single' });
    }
    const fact = outcome.facts.find((f) => f.factType === 'FILING_STATUS_CANDIDATE');
    expect(fact?.value).toBe('single');
  });

  it('refuses tax-calculation and later-phase tools', () => {
    const outcome = executeDeterministicToolCall({
      proposal: { tool: 'calculate_return', args: {} },
      context: ctx,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatch(/Blocked tool/);
  });

  it('refuses unknown tool names (no hallucinated tools)', () => {
    const outcome = executeDeterministicToolCall({
      proposal: { tool: 'add_imaginary_form', args: { wages: 1 } },
      context: ctx,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/Unsupported tool/);
  });

  it('uses precomputed validation so rejected fields stay unwritten', () => {
    const provisional = addW2(
      { wages: -1, employerName: 'Acme', federalTaxWithheld: 100 },
      ctx,
    );
    expect(provisional.ok).toBe(true);
    if (!provisional.ok) return;

    const validation = validateImportedFacts(provisional.facts, { taxYear: 2025 });
    const outcome = executeDeterministicToolCall({
      proposal: {
        tool: 'add_w2',
        args: { wages: -1, employerName: 'Acme', federalTaxWithheld: 100 },
      },
      context: ctx,
      facts: provisional.facts,
      validation,
    });

    expect(outcome.appliedArgs).toEqual({
      employerName: 'Acme',
      federalTaxWithheld: 100,
    });
    expect(outcome.skippedFields).toEqual(['wages']);
  });

  it('returns a schema error without inventing amounts when args are invalid', () => {
    const outcome = callIncomeToolFromStructuredFields({
      incomeType: 'w2',
      args: { wages: 'not-a-number', employerName: 'Acme' },
      context: ctx,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.appliedArgs).toEqual({});
    expect(outcome.error).toBeTruthy();
  });

  it('does not invent a tool for an unsupported income type', () => {
    const outcome = callIncomeToolFromStructuredFields({
      incomeType: 'w2g',
      args: { grossWinnings: 50 },
      context: ctx,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.tool).toBeNull();
    expect(proposeIncomeToolCall('w2g', {})).toBeNull();
  });
});
