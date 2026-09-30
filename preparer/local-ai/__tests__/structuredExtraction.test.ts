import { describe, expect, it } from 'vitest';
import { addW2 } from '../src/taxTools.js';
import {
  extractStructuredFields,
  normalizeGenericFields,
  parseMoneyToken,
} from '../src/structuredExtraction.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-ocr',
};

describe('structured extraction', () => {
  it('parses printed money and keeps an explicit zero', () => {
    expect(parseMoneyToken('$1,234.56')).toBe(1234.56);
    expect(parseMoneyToken('1,234')).toBe(1234);
    expect(parseMoneyToken('$0.00')).toBe(0);
    expect(parseMoneyToken('0')).toBe(0);
    expect(parseMoneyToken('(100.00)')).toBe(-100);
    expect(parseMoneyToken('-20.5')).toBe(-20.5);
  });

  it('does not guess an unreadable money token', () => {
    expect(parseMoneyToken('')).toBeUndefined();
    expect(parseMoneyToken('   ')).toBeUndefined();
    expect(parseMoneyToken('12O.00')).toBeUndefined();
    expect(parseMoneyToken('1234 wages')).toBeUndefined();
    expect(parseMoneyToken('1.234,56')).toBeUndefined();
    expect(parseMoneyToken('$')).toBeUndefined();
    expect(parseMoneyToken('1,23')).toBeUndefined();
  });

  it('normalizes a W-2 bag without turning a bad box into zero', () => {
    const structured = extractStructuredFields('w2', {
      employerName: '  Acme Corp  ',
      wages: '$61,482.17',
      federalTaxWithheld: '$0.00',
      socialSecurityWages: undefined,
      medicareWages: '12O.00',
      state: 'ca',
      box13: { retirementPlan: 'X', statutoryEmployee: 'no' },
      box12: [
        { code: 'D', amount: '$1,200.00' },
        { code: 'W', amount: 'not-a-number' },
      ],
      inventedLine: 99,
    });

    expect(structured.tool).toBe('add_w2');
    expect(structured.args.employerName).toBe('Acme Corp');
    expect(structured.args.wages).toBe(61482.17);
    expect(structured.args.federalTaxWithheld).toBe(0);
    expect(structured.args.socialSecurityWages).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(structured.args, 'socialSecurityWages')).toBe(true);
    expect(structured.args.medicareWages).toBeUndefined();
    expect(structured.args.state).toBe('ca');
    expect(structured.args.box13).toEqual({ retirementPlan: true, statutoryEmployee: false });
    expect(structured.args.box12).toEqual([{ code: 'D', amount: 1200 }]);
    expect(structured.args).not.toHaveProperty('inventedLine');
    expect(structured.rawText.wages).toBe('$61,482.17');
    expect(structured.rawText.federalTaxWithheld).toBe('$0.00');
    expect(structured.rawText.medicareWages).toBe('12O.00');
    expect(structured.rawText.wages).not.toBe('61482.17');
  });

  it('reads the first local line of a W-2: boxes 18, 19 and 20', () => {
    const structured = extractStructuredFields('w2', { localWages: '57,500.00', localTaxWithheld: '1,161.50', localityName: 'MARION' });
    expect(structured.args).toMatchObject({ localWages: 57500, localTaxWithheld: 1161.5, localityName: 'MARION' });
  });

  it('keeps a numeric zero and does not invent raw text from it', () => {
    const structured = extractStructuredFields('1099int', {
      payerName: 'Bank',
      amount: 0,
      taxExemptInterest: null,
    });
    expect(structured.args.amount).toBe(0);
    expect(structured.rawText.amount).toBeUndefined();
    expect(structured.args.taxExemptInterest).toBeUndefined();
    expect(structured.args).not.toHaveProperty('earlyWithdrawalPenalty');
  });

  it('feeds normalized fields through the W-2 tool', () => {
    const structured = extractStructuredFields('w2', {
      employerName: 'Acme',
      wages: '$52,000.00',
      federalTaxWithheld: 'n/a',
      socialSecurityWages: 0,
    });
    const result = addW2(structured.args, { ...ctx, rawText: structured.rawText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({
      employerName: 'Acme',
      wages: 52000,
      socialSecurityWages: 0,
    });
    const wages = result.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(52000);
    expect(wages?.rawText).toBe('$52,000.00');
    const withheld = result.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.status).toBe('unknown');
    expect(withheld?.rawText).toBe('n/a');
    expect(withheld && 'value' in withheld).toBe(false);
  });

  it('normalizes 1099-R codes as text and simplified-method amounts', () => {
    const structured = extractStructuredFields('1099r', {
      payerName: 'Plan',
      grossDistribution: '$10,000.00',
      distributionCode: '7',
      qcdAmount: '$0',
      simplifiedMethod: {
        totalContributions: '$50,000',
        ageAtStartDate: '65',
        isJointAndSurvivor: 'no',
        paymentsThisYear: '12000',
      },
    });
    expect(structured.args.distributionCode).toBe('7');
    expect(structured.args.grossDistribution).toBe(10000);
    expect(structured.args.qcdAmount).toBe(0);
    expect(structured.args.simplifiedMethod).toEqual({
      totalContributions: 50000,
      ageAtStartDate: 65,
      isJointAndSurvivor: false,
      paymentsThisYear: 12000,
    });
  });

  it('drops an incomplete simplified method instead of inventing the missing parts', () => {
    const structured = extractStructuredFields('1099r', {
      grossDistribution: 1000,
      simplifiedMethod: { totalContributions: '$50,000' },
    });
    expect(structured.args.grossDistribution).toBe(1000);
    expect(structured.args.simplifiedMethod).toBeUndefined();
  });

  it('leaves an unrecognized form untouched for the generic path', () => {
    const generic = normalizeGenericFields({
      totalBenefits: '$9,999.50',
      payerName: 'SSA',
      missing: undefined,
      blank: '   ',
      already: 0,
    });
    expect(generic.fields.totalBenefits).toBe(9999.5);
    expect(generic.rawText.totalBenefits).toBe('$9,999.50');
    expect(generic.fields.payerName).toBe('SSA');
    expect(generic.fields.missing).toBeUndefined();
    expect(generic.fields.blank).toBeUndefined();
    expect(generic.fields.already).toBe(0);
    expect(generic.rawText.already).toBeUndefined();
    const plain = normalizeGenericFields({
      account: '12345',
      wages: '41000.00',
      box12: [{ code: 'D', amount: 1 }],
      bad: Number.NaN,
    });
    expect(plain.fields.account).toBe('12345');
    expect(plain.fields.wages).toBe(41000);
    expect(plain.rawText.wages).toBe('41000.00');
    expect(plain.fields.box12).toEqual([{ code: 'D', amount: 1 }]);
    expect(plain.fields.bad).toBeUndefined();
  });

  it('rejects a joint-annuity worksheet when combinedAge is supplied but unreadable', () => {
    const structured = extractStructuredFields('1099r', {
      payerName: 'Plan',
      grossDistribution: 10000,
      useSimplifiedMethod: true,
      simplifiedMethod: {
        totalContributions: '$50,000',
        ageAtStartDate: '65',
        isJointAndSurvivor: 'yes',
        paymentsThisYear: '12000',
        combinedAge: '12O',
      },
    });
    expect(structured.args.useSimplifiedMethod).toBe(true);
    expect(structured.args.simplifiedMethod).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(structured.args, 'simplifiedMethod')).toBe(true);
  });

  it('keeps a readable combinedAge of 0 and omits a never-supplied combinedAge', () => {
    const withZero = extractStructuredFields('1099r', {
      simplifiedMethod: {
        totalContributions: 50000,
        ageAtStartDate: 65,
        isJointAndSurvivor: true,
        paymentsThisYear: 12000,
        combinedAge: 0,
      },
    });
    expect(withZero.args.simplifiedMethod).toEqual({
      totalContributions: 50000,
      ageAtStartDate: 65,
      isJointAndSurvivor: true,
      paymentsThisYear: 12000,
      combinedAge: 0,
    });
    const omitted = extractStructuredFields('1099r', {
      simplifiedMethod: {
        totalContributions: 50000,
        ageAtStartDate: 65,
        isJointAndSurvivor: true,
        paymentsThisYear: 12000,
      },
    });
    expect(omitted.args.simplifiedMethod).toEqual({
      totalContributions: 50000,
      ageAtStartDate: 65,
      isJointAndSurvivor: true,
      paymentsThisYear: 12000,
    });
  });

  it('keeps amount-shaped but unreadable generic tokens unknown', () => {
    const generic = normalizeGenericFields({
      totalBenefits: '12O.00',
      federalTaxWithheld: '$0.00',
      payerName: 'SSA',
      account: '12345',
    });
    expect(generic.fields.totalBenefits).toBeUndefined();
    expect(generic.rawText.totalBenefits).toBe('12O.00');
    expect(generic.fields.federalTaxWithheld).toBe(0);
    expect(generic.rawText.federalTaxWithheld).toBe('$0.00');
    expect(generic.fields.payerName).toBe('SSA');
    expect(generic.fields.account).toBe('12345');
  });

  it('uppercases Box 12 codes and drops an empty code', () => {
    const structured = extractStructuredFields('w2', {
      wages: 50000,
      box12: [
        { code: 'd', amount: '$1,200.00' },
        { code: '  ee ', amount: 100 },
        { code: '   ', amount: 50 },
        { code: 'W', amount: 0 },
      ],
    });
    expect(structured.args.box12).toEqual([
      { code: 'D', amount: 1200 },
      { code: 'EE', amount: 100 },
      { code: 'W', amount: 0 },
    ]);
  });

  it('applies extractor fieldRawTokens instead of stringifying numbers', () => {
    const structured = extractStructuredFields(
      'w2',
      {
        employerName: 'Acme',
        wages: 61482.17,
        federalTaxWithheld: 0,
        medicareWages: undefined,
      },
      {
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        medicareWages: '12O.00',
      },
    );
    expect(structured.args.wages).toBe(61482.17);
    expect(structured.args.federalTaxWithheld).toBe(0);
    expect(structured.args.medicareWages).toBeUndefined();
    expect(structured.rawText.wages).toBe('$61,482.17');
    expect(structured.rawText.federalTaxWithheld).toBe('$0.00');
    expect(structured.rawText.medicareWages).toBe('12O.00');
    expect(structured.rawText.wages).not.toBe('61482.17');
  });
});
