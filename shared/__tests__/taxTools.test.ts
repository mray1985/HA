import { describe, expect, it } from 'vitest';
import {
  addW2,
  invokeTaxTool,
  setFilingStatusCandidate,
  toolNameForIncomeType,
} from '../src/taxfacts/taxTools.js';
import type { TaxFact } from '../src/taxfacts/taxFact.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-pdf',
};

describe('tax tools (HA-AI-011)', () => {
  it('accepts a valid W-2 tool call and returns facts plus add-income fields', () => {
    const result = addW2(
      {
        employerName: 'Acme Corp',
        wages: 52000,
        federalTaxWithheld: 7800,
        socialSecurityWages: 52000,
      },
      {
        ...ctx,
        rawText: { wages: '52,000.00', federalTaxWithheld: '7,800.00' },
        confidence: { wages: 0.97, federalTaxWithheld: 0.95, employerName: 0.9 },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tool).toBe('add_w2');
    expect(result.incomeType).toBe('w2');
    expect(result.fields).toEqual({
      employerName: 'Acme Corp',
      wages: 52000,
      federalTaxWithheld: 7800,
      socialSecurityWages: 52000,
    });
    expect(result.fields).not.toHaveProperty('medicareWages');

    const wages = result.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(52000);
    expect(wages?.rawText).toBe('52,000.00');
    expect(wages?.confidence).toBe(0.97);
    expect(wages?.sourceDocumentId).toBe('DOC-1');
    expect(wages?.factType).toBe('W2_wages');
  });

  it('omits missing wages instead of writing zero', () => {
    const result = addW2(
      {
        employerName: 'Acme',
        wages: undefined,
        federalTaxWithheld: null,
        socialSecurityWages: 0,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
    });
    expect(result.fields).not.toHaveProperty('wages');
    expect(result.fields).not.toHaveProperty('federalTaxWithheld');

    const wagesFact = result.facts.find((f) => f.sourceField === 'wages');
    expect(wagesFact?.status).toBe('unknown');
    expect(wagesFact && 'value' in wagesFact).toBe(false);

    const withheld = result.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.status).toBe('unknown');
    expect(withheld && 'value' in withheld).toBe(false);

    const ss = result.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
  });

  it('keeps an explicit zero amount', () => {
    const result = invokeTaxTool({
      tool: 'add_1099_int',
      args: { payerName: 'Chase', amount: 0, federalTaxWithheld: 0 },
      context: {
        ...ctx,
        sourceFileName: '1099int.pdf',
        rawText: { amount: '0.00' },
        confidence: { amount: 0.88 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomeType).toBe('1099int');
    expect(result.fields.amount).toBe(0);
    expect(result.fields.federalTaxWithheld).toBe(0);

    const amount = result.facts.find((f) => f.sourceField === 'amount');
    expect(amount?.status).toBe('extracted');
    expect(amount?.value).toBe(0);
    expect(amount?.rawText).toBe('0.00');
  });

  it('rejects unknown fields', () => {
    const result = addW2(
      {
        employerName: 'Acme',
        wages: 1000,
        form1040Line1a: 1000,
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/form1040Line1a|unrecognized/i);
  });

  it('rejects invalid amount types', () => {
    const result = addW2({ wages: 'fifty-two thousand' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('records filing status as a candidate fact without applying it', () => {
    const result = setFilingStatusCandidate(
      { status: 'married_filing_jointly' },
      { ...ctx, sourceFileName: 'intake.pdf', extractor: 'automation' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliesFilingStatus).toBe(false);
    expect(result.incomeType).toBeUndefined();
    expect(result.fields).toEqual({ status: 'married_filing_jointly' });

    const [fact] = result.facts;
    expect(fact.factType).toBe('FILING_STATUS_CANDIDATE');
    expect(fact.status).toBe('extracted');
    expect(fact.value).toBe('married_filing_jointly');
  });

  it('maps income types to tool names for supported forms only', () => {
    expect(toolNameForIncomeType('w2')).toBe('add_w2');
    expect(toolNameForIncomeType('1099int')).toBe('add_1099_int');
    expect(toolNameForIncomeType('1099misc')).toBeNull();
  });

  it('unknown TaxFact status cannot carry a value', () => {
    const result = addW2({ employerName: 'Acme' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Construct an unknown fact the same way callers must: no value key.
    const unknown: TaxFact = {
      factId: 'DOC-1:wages',
      returnId: 'ret-1',
      taxYear: 2025,
      factType: 'W2_wages',
      sourceDocumentId: 'DOC-1',
      sourceFileName: 'w2.pdf',
      sourceField: 'wages',
      rawText: '',
      confidence: null,
      extractor: 'local-pdf',
      verified: false,
      status: 'unknown',
    };
    expect(unknown.value).toBeUndefined();
    expect('value' in unknown).toBe(false);

    // @ts-expect-error unknown status cannot carry a value
    const carried: TaxFact = { ...unknown, status: 'unknown', value: 0 };
    expect(carried.status).toBe('unknown');
  });
});
