import { describe, expect, it } from 'vitest';
import { factsFromFields, fieldsForToolCall, isExtractedValue } from '../src/taxfacts/taxFact.js';

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
      returnId: 'ret-1',
      taxYear: 2025,
      documentId: 'DOC-1',
      fileName: 'w2.pdf',
      extractor: 'local-pdf',
      confidence: null,
      fields: { wages: undefined },
      factTypeFor: (field) => `W2_${field}`,
    });
    expect(fact.status).toBe('unknown');
    expect(fact.value).toBeUndefined();
    expect(fact.sourceFileName).toBe('w2.pdf');
    expect(fact.sourceField).toBe('wages');
  });
});
