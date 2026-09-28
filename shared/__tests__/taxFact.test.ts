import { describe, expect, it } from 'vitest';
import { factsFromFields, fieldsForToolCall, isExtractedValue, type TaxFact } from '../src/taxfacts/taxFact.js';

const source = {
  returnId: 'ret-1',
  taxYear: 2025,
  documentId: 'DOC-1',
  fileName: 'w2.pdf',
  extractor: 'local-pdf',
  factTypeFor: (field: string) => `W2_${field}`,
};

const factBase = {
  factId: 'DOC-1:wages',
  returnId: 'ret-1',
  taxYear: 2025,
  factType: 'W2_wages',
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  sourceField: 'wages',
  rawText: '',
  confidence: null as number | null,
  extractor: 'local-pdf',
  verified: false,
};

describe('TaxFact unknown-is-not-zero', () => {
  it('drops missing wages instead of writing zero', () => {
    const fields = fieldsForToolCall({
      employerName: 'Acme',
      wages: undefined,
      federalTaxWithheld: null,
      state: '',
      socialSecurityWages: 0,
    });
    expect(fields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
    });
    expect(isExtractedValue(0)).toBe(true);
  });

  it('marks an absent field unknown and keeps the source', () => {
    const [fact] = factsFromFields({
      ...source,
      fields: { wages: undefined },
    });
    expect(fact.status).toBe('unknown');
    expect(fact.value).toBeUndefined();
    expect('value' in fact).toBe(false);
    expect(fact.rawText).toBe('');
    expect(fact.confidence).toBeNull();
    expect(fact.sourceFileName).toBe('w2.pdf');
    expect(fact.sourceField).toBe('wages');
  });

  it('keeps an extracted zero and the original source text', () => {
    const [unlabeled] = factsFromFields({
      ...source,
      fields: { socialSecurityWages: 0 },
    });
    const [labeled] = factsFromFields({
      ...source,
      fields: { socialSecurityWages: 0 },
      rawText: { socialSecurityWages: '0.00' },
      confidence: { socialSecurityWages: 0.2 },
    });

    expect(unlabeled.status).toBe('extracted');
    expect(unlabeled.value).toBe(0);
    expect(unlabeled.rawText).toBe('');
    expect(unlabeled.confidence).toBeNull();

    expect(labeled.status).toBe('extracted');
    expect(labeled.value).toBe(0);
    expect(labeled.rawText).toBe('0.00');
    expect(labeled.confidence).toBe(0.2);
  });

  it('retains structured W-2 box12/box13 values for tool fields and facts', () => {
    const box12 = [{ code: 'D', amount: 5000 }, { code: 'DD', amount: 0 }];
    const box13 = { retirementPlan: true, thirdPartySickPay: false };
    const fields = fieldsForToolCall({
      wages: 60000,
      box12,
      box13,
      missingBox: undefined,
    });
    expect(fields).toEqual({ wages: 60000, box12, box13 });
    expect(isExtractedValue(box12)).toBe(true);
    expect(isExtractedValue(box13)).toBe(true);
    expect(isExtractedValue([])).toBe(false);

    const facts = factsFromFields({
      ...source,
      fields: { box12, box13 },
    });
    expect(facts.find((f) => f.sourceField === 'box12')?.value).toEqual(box12);
    expect(facts.find((f) => f.sourceField === 'box13')?.value).toEqual(box13);
  });

  it('scores confidence per field and leaves an unscored field null', () => {
    const facts = factsFromFields({
      ...source,
      fields: { wages: 52000, federalTaxWithheld: undefined },
      rawText: (field) => (field === 'wages' ? '52,000.00' : undefined),
      confidence: (field) => (field === 'wages' ? 0.91 : null),
    });
    const wages = facts.find((fact) => fact.sourceField === 'wages');
    const withheld = facts.find((fact) => fact.sourceField === 'federalTaxWithheld');

    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(52000);
    expect(wages?.rawText).toBe('52,000.00');
    expect(wages?.confidence).toBe(0.91);

    expect(withheld?.status).toBe('unknown');
    expect(withheld?.value).toBeUndefined();
    expect(withheld && 'value' in withheld).toBe(false);
    expect(withheld?.rawText).toBe('');
    expect(withheld?.confidence).toBeNull();
  });

  it('requires a value on extracted facts and forbids one on unknown facts', () => {
    const extracted: TaxFact = { ...factBase, status: 'extracted', value: 0 };
    const unknown: TaxFact = { ...factBase, status: 'unknown' };
    expect(extracted.value).toBe(0);
    expect(unknown.status).toBe('unknown');
    expect(unknown.value).toBeUndefined();

    // @ts-expect-error extracted status requires a value
    const missingValue: TaxFact = { ...factBase, status: 'extracted' };
    // @ts-expect-error unknown status cannot carry a value
    const carriedValue: TaxFact = { ...factBase, status: 'unknown', value: 0 };
    expect(missingValue.status).toBe('extracted');
    expect(carriedValue.status).toBe('unknown');
  });
});
