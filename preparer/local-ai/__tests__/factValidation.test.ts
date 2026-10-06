import { describe, expect, it } from 'vitest';
import { add1099R, addW2, invokeTaxTool } from '../src/taxTools.js';
import { factsFromFields } from '../src/taxFact.js';
import type { TaxFact } from '../src/taxFact.js';
import {
  amountFromFact,
  isFactAmountReady,
  numericOrMissing,
  omitInvalidToolFields,
  REQUIRED_FORM_FIELDS,
  validateImportedFacts,
} from '../src/factValidation.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-ocr',
};

function w2Facts(
  args: Record<string, unknown>,
  documentId = 'DOC-1',
): TaxFact[] {
  const result = addW2(args, { ...ctx, sourceDocumentId: documentId });
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

  it('omits invalid tool fields while keeping valid fields on the same form', () => {
    const facts = w2Facts({
      wages: -500,
      federalTaxWithheld: 1200,
      employerName: 'Acme',
    });
    const validation = validateImportedFacts(facts);
    const toolFields = {
      wages: -500,
      federalTaxWithheld: 1200,
      employerName: 'Acme',
    };
    const ready = omitInvalidToolFields(toolFields, facts, validation);

    expect(validation.ready).toBe(false);
    expect(ready).not.toHaveProperty('wages');
    expect(ready.federalTaxWithheld).toBe(1200);
    expect(ready.employerName).toBe('Acme');
    // Extracted facts keep the observed negative — not rewritten.
    expect(facts.find((f) => f.sourceField === 'wages')!.value).toBe(-500);
  });

  it('does not let one document\'s bad wages mark another document\'s wages unready', () => {
    const bad = w2Facts({ wages: -100, employerName: 'BadCo' }, 'DOC-bad');
    const good = w2Facts(
      {
        wages: 50_000,
        federalTaxWithheld: 5_000,
        socialSecurityWages: 50_000,
        socialSecurityTax: 3_100,
        medicareWages: 50_000,
        medicareTax: 725,
        employerName: 'GoodCo',
      },
      'DOC-good',
    );
    const validation = validateImportedFacts([...bad, ...good], { taxYear: 2025 });
    const badWages = bad.find((f) => f.sourceField === 'wages')!;
    const goodWages = good.find((f) => f.sourceField === 'wages')!;

    expect(isFactAmountReady(badWages, validation)).toBe(false);
    expect(isFactAmountReady(goodWages, validation)).toBe(true);
    expect(goodWages.value).toBe(50_000);
  });

  it('flags negative money on generic classified forms without inventing a replacement', () => {
    const facts = factsFromFields({
      returnId: 'ret-1',
      taxYear: 2025,
      documentId: 'DOC-w2g',
      fileName: 'w2g.pdf',
      extractor: 'local-pdf',
      fields: {
        payerName: 'Casino',
        grossWinnings: -100,
        federalTaxWithheld: 25,
        unemploymentCompensation: -50,
        grossAmount: -10,
        mortgageInterest: -200,
      },
      factTypeFor: (field) => `W2G_${field}`,
    });
    const validation = validateImportedFacts(facts);

    expect(validation.ready).toBe(false);
    const negativeFields = validation.issues
      .filter((i) => i.code === 'NEGATIVE_AMOUNT')
      .map((i) => i.sourceField);
    expect(negativeFields).toEqual(
      expect.arrayContaining([
        'grossWinnings',
        'unemploymentCompensation',
        'grossAmount',
        'mortgageInterest',
      ]),
    );
    expect(facts.find((f) => f.sourceField === 'grossWinnings')!.value).toBe(-100);
    expect(isFactAmountReady(facts.find((f) => f.sourceField === 'grossWinnings')!, validation)).toBe(
      false,
    );
    expect(
      isFactAmountReady(facts.find((f) => f.sourceField === 'federalTaxWithheld')!, validation),
    ).toBe(true);
  });

  it('flags negative simplifiedMethod money without rewriting nested amounts', () => {
    const result = add1099R(
      {
        payerName: 'Fidelity',
        grossDistribution: 20000,
        taxableAmount: 15000,
        useSimplifiedMethod: true,
        simplifiedMethod: {
          totalContributions: -40000,
          ageAtStartDate: 65,
          isJointAndSurvivor: false,
          paymentsThisYear: -12,
          priorYearTaxFreeRecovery: -100,
        },
      },
      { ...ctx, sourceFileName: '1099r.pdf' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const simplified = result.facts.find((f) => f.sourceField === 'simplifiedMethod')!;
    const validation = validateImportedFacts(result.facts);

    expect(simplified.status).toBe('extracted');
    expect(simplified.value).toEqual({
      totalContributions: -40000,
      ageAtStartDate: 65,
      isJointAndSurvivor: false,
      paymentsThisYear: -12,
      priorYearTaxFreeRecovery: -100,
    });
    expect(validation.ready).toBe(false);
    expect(
      validation.issues.filter((i) => i.code === 'NEGATIVE_AMOUNT').length,
    ).toBeGreaterThanOrEqual(3);
    expect(isFactAmountReady(simplified, validation)).toBe(false);
    expect(
      isFactAmountReady(
        result.facts.find((f) => f.sourceField === 'grossDistribution')!,
        validation,
      ),
    ).toBe(true);

    const readyFields = omitInvalidToolFields(result.fields, result.facts, validation);
    expect(readyFields).not.toHaveProperty('simplifiedMethod');
    expect(readyFields.grossDistribution).toBe(20000);
  });

  it('flags a non-string state identifier without inventing a state code', () => {
    const fact: TaxFact = {
      factId: 'DOC-1:state',
      returnId: 'ret-1',
      taxYear: 2025,
      factType: 'W2_state',
      sourceDocumentId: 'DOC-1',
      sourceFileName: 'w2.pdf',
      sourceField: 'state',
      rawText: '12',
      confidence: null,
      extractor: 'local-ocr',
      verified: false,
      status: 'extracted',
      value: 12,
    };
    const validation = validateImportedFacts([fact]);
    expect(validation.ready).toBe(false);
    expect(validation.issues.some((i) => i.code === 'INVALID_STATE_IDENTIFIER')).toBe(true);
    expect(fact.value).toBe(12);
    expect(isFactAmountReady(fact, validation)).toBe(false);
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

  it('flags an invalid string state identifier without inventing a state code', () => {
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
      federalTaxWithheld: 9_000,
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

describe('the four newly read forms are validated like every other', () => {
  it.each([
    ['W-2G', ['grossWinnings']],
    ['1098-E', ['studentLoanInterest']],
    ['K-1', ['ordinaryBusinessIncome']],
  ] as const)('%s has a required amount, or a blank box would be read as zero', (form, fields) => {
    expect(REQUIRED_FORM_FIELDS[form]).toEqual(fields);
  });

  it.each([
    ['W2G_', 'add_w2g', { payerName: 'RIVERBEND CASINO', grossWinnings: 24600 }],
    ['1098E_', 'add_1098_e', { lenderName: 'BANK A', studentLoanInterest: 1842.55 }],
    ['K1_', 'add_k1', { entityName: 'RIVERBEND PARTNERS LP', ordinaryBusinessIncome: 48200 }],
    ['1095A_', 'add_1095_a', { recipientName: 'ALEX RIVERBEND', annualEnrollmentPremiums: 14400 }],
  ] as const)('%s writes facts the validator can price', (prefix, tool, args) => {
    const result = invokeTaxTool({ tool, args, context: { ...ctx, sourceFileName: 'f.pdf' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const facts = result.facts;
    expect(facts.length, `${prefix} produced no facts`).toBeGreaterThan(0);
    // An amount the reader did not get must stay unpriced rather than becoming 0.
    const amounts = facts.map(amountFromFact);
    expect(amounts.every((a) => a === undefined || Number.isFinite(a))).toBe(true);
    expect(amounts.some((a) => a === 0)).toBe(false);
  });
});