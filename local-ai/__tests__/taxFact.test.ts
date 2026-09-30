import { describe, expect, it } from 'vitest';
import {
  factsFromFields,
  fieldsForToolCall,
  isExtractedValue,
  normalizeSourceLocation,
  type TaxFact,
} from '../src/taxFact.js';

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

  it('stores page and box for a located token and leaves missing fields without a box', () => {
    const wagesBox = { x: 417, y: 75, width: 50, height: 7 };
    const zeroBox = { x: 540, y: 75, width: 25, height: 7 };
    const facts = factsFromFields({
      ...source,
      fields: {
        wages: 61482.17,
        federalTaxWithheld: 0,
        medicareWages: undefined,
      },
      rawText: {
        wages: '$61,482.17',
        federalTaxWithheld: '$0.00',
        medicareWages: '',
      },
      sourceLocation: {
        wages: { page: 1, box: wagesBox },
        federalTaxWithheld: { page: 1, box: zeroBox },
        // medicareWages intentionally absent — missing field gets no fake box
      },
    });

    const wages = facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(61482.17);
    expect(wages?.rawText).toBe('$61,482.17');
    expect(wages?.rawText).not.toBe('61482.17');
    expect(wages?.sourcePage).toBe(1);
    expect(wages?.sourceBox).toEqual(wagesBox);

    const withheld = facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.status).toBe('extracted');
    expect(withheld?.value).toBe(0);
    expect(withheld?.rawText).toBe('$0.00');
    expect(withheld?.sourcePage).toBe(1);
    expect(withheld?.sourceBox).toEqual(zeroBox);

    const medicare = facts.find((f) => f.sourceField === 'medicareWages');
    expect(medicare?.status).toBe('unknown');
    expect(medicare && 'value' in medicare).toBe(false);
    expect(medicare?.sourcePage).toBeUndefined();
    expect(medicare?.sourceBox).toBeUndefined();
  });

  it('keeps a located box on an unreadable unknown token and rejects invented coordinates', () => {
    const badBox = { x: 418, y: 123, width: 34, height: 7 };
    const [unreadable] = factsFromFields({
      ...source,
      fields: { medicareWages: undefined },
      rawText: { medicareWages: '12O.00' },
      sourceLocation: { medicareWages: { page: 1, box: badBox } },
    });
    expect(unreadable.status).toBe('unknown');
    expect(unreadable.rawText).toBe('12O.00');
    expect(unreadable.sourcePage).toBe(1);
    expect(unreadable.sourceBox).toEqual(badBox);

    const [invented] = factsFromFields({
      ...source,
      fields: { wages: 100 },
      sourceLocation: {
        wages: { page: Number.NaN, box: { x: 0, y: 0, width: 1, height: 1 } },
      },
    });
    expect(invented.sourcePage).toBeUndefined();
    expect(invented.sourceBox).toBeUndefined();
  });

  it('rejects page 0, zero-size, and negative-size boxes as non-locatable', () => {
    expect(
      normalizeSourceLocation({ page: 0, box: { x: 10, y: 10, width: 20, height: 8 } }),
    ).toBeUndefined();
    expect(
      normalizeSourceLocation({ page: 1.5, box: { x: 10, y: 10, width: 20, height: 8 } }),
    ).toBeUndefined();
    expect(
      normalizeSourceLocation({ page: 1, box: { x: 10, y: 10, width: 0, height: 8 } }),
    ).toBeUndefined();
    expect(
      normalizeSourceLocation({ page: 1, box: { x: 10, y: 10, width: 20, height: 0 } }),
    ).toBeUndefined();
    expect(
      normalizeSourceLocation({ page: 1, box: { x: 10, y: 10, width: -2, height: 8 } }),
    ).toBeUndefined();
    expect(
      normalizeSourceLocation({ page: 1, box: { x: Number.NaN, y: 10, width: 20, height: 8 } }),
    ).toBeUndefined();

    const [zeroPage] = factsFromFields({
      ...source,
      fields: { wages: 100 },
      sourceLocation: { wages: { page: 0, box: { x: 1, y: 1, width: 10, height: 5 } } },
    });
    expect(zeroPage.sourcePage).toBeUndefined();
    expect(zeroPage.sourceBox).toBeUndefined();

    const [zeroWidth] = factsFromFields({
      ...source,
      fields: { wages: 100 },
      sourceLocation: { wages: { page: 1, box: { x: 1, y: 1, width: 0, height: 5 } } },
    });
    expect(zeroWidth.sourcePage).toBeUndefined();
    expect(zeroWidth.sourceBox).toBeUndefined();
  });

  it('does not collapse per-entry box12 locations onto a single TaxFact box', () => {
    const entries = [
      { page: 1, box: { x: 10, y: 20, width: 30, height: 8 } },
      { page: 1, box: { x: 10, y: 40, width: 30, height: 8 } },
    ];
    const [fact] = factsFromFields({
      ...source,
      fields: { box12: [{ code: 'D', amount: 5000 }, { code: 'DD', amount: 1200 }] },
      sourceLocation: { box12: entries },
    });
    expect(fact.sourcePage).toBeUndefined();
    expect(fact.sourceBox).toBeUndefined();
    expect(fact.value).toEqual([{ code: 'D', amount: 5000 }, { code: 'DD', amount: 1200 }]);
  });
});
