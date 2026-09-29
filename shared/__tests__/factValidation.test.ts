import { describe, expect, it } from 'vitest';
import { addW2 } from '../src/taxfacts/taxTools.js';
import type { TaxFact } from '../src/taxfacts/taxFact.js';
import {
  amountFromFact,
  isFactAmountReady,
  numericOrMissing,
  validateImportedFacts,
} from '../src/taxfacts/factValidation.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-ocr',
};

function w2Facts(args: Record<string, unknown>): TaxFact[] {
  const result = addW2(args, ctx);
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  return result.facts;
}

describe('fact validation (development-order step 8)', () => {
  it('never treats an unknown fact as zero', () => {
    const facts = w2Facts({
      employerName: 'Acme',
      wages: undefined,
      federalTaxWithheld: 0,
    });
    const wages = facts.find((f) => f.sourceField === 'wages')!;
    const withheld = facts.find((f) => f.sourceField === 'federalTaxWithheld')!;

    expect(wages.status).toBe('unknown');
    expect(withheld.status).toBe('extracted');
    expect(withheld.value).toBe(0);

    expect(amountFromFact(wages)).toBeUndefined();
    expect(amountFromFact(wages)).not.toBe(0);
    expect(amountFromFact(withheld)).toBe(0);
    expect(numericOrMissing(wages)).toBeUndefined();
    expect(isFactAmountReady(wages)).toBe(false);
    expect(isFactAmountReady(withheld)).toBe(true);
  });

  it('flags negative wages without rewriting the extracted value', () => {
    const facts = w2Facts({ wages: -500, employerName: 'Acme' });
    const wages = facts.find((f) => f.sourceField === 'wages')!;
    const validation = validateImportedFacts(facts);

    expect(wages.status).toBe('extracted');
    expect(wages.value).toBe(-500);
    expect(validation.ready).toBe(false);
    expect(validation.issues.some((i) => i.code === 'NEGATIVE_AMOUNT')).toBe(true);
    expect(amountFromFact(wages)).toBe(-500);
    expect(isFactAmountReady(wages, validation)).toBe(false);
  });

  it('flags a non-finite extracted amount without inventing a replacement', () => {
    const fact: TaxFact = {
      factId: 'DOC-1:wages',
      returnId: 'ret-1',
      taxYear: 2025,
      factType: 'W2_wages',
      sourceDocumentId: 'DOC-1',
      sourceFileName: 'w2.pdf',
      sourceField: 'wages',
      rawText: 'NaN',
      confidence: null,
      extractor: 'local-ocr',
      verified: false,
      status: 'extracted',
      value: Number.NaN,
    };
    const validation = validateImportedFacts([fact]);
    expect(validation.ready).toBe(false);
    expect(validation.issues.map((i) => i.code)).toContain('NON_FINITE_AMOUNT');
    expect(amountFromFact(fact)).toBeUndefined();
    expect(fact.value).toBeNaN();
  });

  it('flags an invalid state identifier without inventing a state code', () => {
    const facts = w2Facts({ wages: 1000, state: 'ZZ' });
    const state = facts.find((f) => f.sourceField === 'state')!;
    const validation = validateImportedFacts(facts);
    expect(state.value).toBe('ZZ');
    expect(validation.issues.some((i) => i.code === 'INVALID_STATE_IDENTIFIER')).toBe(true);
  });

  it('flags W-2 Box 3 over the wage base and Box 4 over the 6.2% max', () => {
    const facts = w2Facts({
      wages: 50_000,
      socialSecurityWages: 200_000,
      socialSecurityTax: 20_000,
      medicareWages: 200_000,
      medicareTax: 100,
    });
    const validation = validateImportedFacts(facts, { taxYear: 2025 });
    const codes = validation.issues.map((i) => i.code);
    expect(codes).toContain('W2_BOX3_EXCEEDS_WAGE_BASE');
    expect(codes).toContain('W2_BOX4_EXCEEDS_MAX');
    // Relationship warnings do not invent corrected amounts.
    const ss = facts.find((f) => f.sourceField === 'socialSecurityWages')!;
    expect(ss.value).toBe(200_000);
  });

  it('flags Box 1 vs Box 3 and Box 5 vs Box 3 relationship problems without changing values', () => {
    const facts = w2Facts({
      wages: 80_000,
      socialSecurityWages: 40_000,
      medicareWages: 30_000,
      socialSecurityTax: 2480,
      medicareTax: 435,
    });
    const validation = validateImportedFacts(facts, { taxYear: 2025 });
    const codes = validation.issues.map((i) => i.code);
    expect(codes).toContain('W2_BOX1_BOX3_RELATIONSHIP');
    expect(codes).toContain('W2_BOX5_BELOW_BOX3');
    expect(facts.find((f) => f.sourceField === 'socialSecurityWages')!.value).toBe(40_000);
    expect(facts.find((f) => f.sourceField === 'medicareWages')!.value).toBe(30_000);
  });

  it('flags Box 6 above the Medicare maximum without rewriting it', () => {
    const facts = w2Facts({
      medicareWages: 10_000,
      medicareTax: 500,
    });
    const validation = validateImportedFacts(facts, { taxYear: 2025 });
    expect(validation.issues.some((i) => i.code === 'W2_BOX6_EXCEEDS_MAX')).toBe(true);
    expect(facts.find((f) => f.sourceField === 'medicareTax')!.value).toBe(500);
  });

  it('marks a consistent W-2 ready with no invented issues', () => {
    const facts = w2Facts({
      employerName: 'Acme',
      wages: 50_000,
      federalTaxWithheld: 5_000,
      socialSecurityWages: 50_000,
      socialSecurityTax: 3_100,
      medicareWages: 50_000,
      medicareTax: 725,
      state: 'CA',
    });
    const validation = validateImportedFacts(facts, { taxYear: 2025 });
    expect(validation.issues).toEqual([]);
    expect(validation.ready).toBe(true);
    expect(isFactAmountReady(facts.find((f) => f.sourceField === 'wages')!, validation)).toBe(true);
  });

  it('keeps relationship warnings from blocking ready when there are no structural errors', () => {
    const facts = w2Facts({
      wages: 80_000,
      socialSecurityWages: 40_000,
      medicareWages: 40_000,
      socialSecurityTax: 2480,
      medicareTax: 580,
    });
    const validation = validateImportedFacts(facts, { taxYear: 2025 });
    expect(validation.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(validation.ready).toBe(true);
  });
});
