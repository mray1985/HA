import { describe, expect, it } from 'vitest';
import {
  confirmFilingStatusCandidate,
  filingStatusAnswerSchema,
  filingStatusFromClientWords,
  filingStatusCallFromAnswer,
  groundedToolDefinitions,
  toolForFormType,
  verifyGroundedCall,
} from '../src/groundedToolCall.js';
import { factsFromFields } from '../src/taxFact.js';

const facts = factsFromFields({
  returnId: 'R1',
  taxYear: 2026,
  documentId: 'DOC-1',
  fileName: 'w2.pdf',
  extractor: 'qwen3.5-0.8b',
  factTypeFor: (f) => `W2_${f}`,
  fields: {
    employerName: 'RIVERBEND LOGISTICS LLC',
    federalTaxWithheld: 5873.4,
    wages: undefined, // unreadable on the document
    box12: [{ code: 'D', amount: 2500 }],
  },
});

describe('groundedToolDefinitions', () => {
  it('offers only the tool for the classified form, with each argument fixed to its fact', () => {
    const defs = groundedToolDefinitions('W-2', facts);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('add_w2');
    expect(defs[0]!.parameters).toEqual({
      type: 'object',
      properties: {
        employerName: { const: 'RIVERBEND LOGISTICS LLC' },
        federalTaxWithheld: { const: 5873.4 },
        box12: { const: [{ code: 'D', amount: 2500 }] },
      },
      additionalProperties: false,
    });
  });

  it('leaves unknown facts out of the grammar entirely', () => {
    const props = (groundedToolDefinitions('W-2', facts)[0]!.parameters as { properties: object }).properties;
    expect(props).not.toHaveProperty('wages');
  });

  it('offers nothing for a form without a tax tool, or with no usable facts', () => {
    expect(groundedToolDefinitions('1098', facts)).toEqual([]);
    expect(groundedToolDefinitions(null, facts)).toEqual([]);
    expect(groundedToolDefinitions('W-2', [])).toEqual([]);
  });

  it('maps forms to tools', () => {
    expect(toolForFormType('1099-R')).toBe('add_1099_r');
    expect(toolForFormType('SSA-1099')).toBeNull();
  });
});

describe('verifyGroundedCall', () => {
  it('accepts a call whose every argument equals a document fact', () => {
    const v = verifyGroundedCall({ name: 'add_w2', args: { employerName: 'RIVERBEND LOGISTICS LLC', federalTaxWithheld: 5873.4 } }, 'W-2', facts);
    expect(v).toEqual({ ok: true, errors: [], omittedFields: ['box12'] });
  });

  it('rejects zero passed for an unknown fact (measured Qwen3.5-0.8B failure)', () => {
    const v = verifyGroundedCall({ name: 'add_w2', args: { employerName: 'RIVERBEND LOGISTICS LLC', wages: 0 } }, 'W-2', facts);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['"wages" is unknown in the document and must be omitted (got 0)']);
  });

  it('rejects a changed value, an invented field, the wrong tool, and a tool for a form that has none', () => {
    expect(verifyGroundedCall({ name: 'add_w2', args: { federalTaxWithheld: 5873 } }, 'W-2', facts).errors)
      .toEqual(['"federalTaxWithheld" is 5873.4 on the document, not 5873']);
    expect(verifyGroundedCall({ name: 'add_w2', args: { employerEin: '12-3456789' } }, 'W-2', facts).errors)
      .toEqual(['"employerEin" has no fact in the document']);
    expect(verifyGroundedCall({ name: 'add_1099_nec', args: {} }, 'W-2', facts).errors)
      .toEqual(['tool "add_1099_nec" does not match a W-2 (expected "add_w2")']);
    expect(verifyGroundedCall({ name: 'add_1099_nec', args: { payerName: 'CRESCENT CITY MORTGAGE CO' } }, '1098', facts).ok).toBe(false);
    expect(verifyGroundedCall({ name: 'calculate_everything', args: {} }, 'W-2', facts).errors[0]).toBe('"calculate_everything" is not a tax tool');
  });

  it('rejects arguments that are not an object', () => {
    expect(verifyGroundedCall({ name: 'add_w2', args: null }, 'W-2', facts).errors).toContain('arguments are not a JSON object');
  });
});

describe('filing-status answers', () => {
  it('constrains the answer to the five statuses or not_stated', () => {
    const schema = filingStatusAnswerSchema() as { properties: { filingStatusCandidate: { enum: string[] } } };
    expect(schema.properties.filingStatusCandidate.enum).toEqual([
      'single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household', 'qualifying_surviving_spouse', 'not_stated',
    ]);
  });

  it('makes a candidate call only when a status was stated', () => {
    expect(filingStatusCallFromAnswer({ filingStatusCandidate: 'married_filing_jointly' }))
      .toEqual({ name: 'set_filing_status_candidate', args: { status: 'married_filing_jointly' } });
    expect(filingStatusCallFromAnswer({ filingStatusCandidate: 'not_stated' })).toBeNull();
    expect(filingStatusCallFromAnswer({ filingStatusCandidate: 'married' })).toBeNull();
    expect(filingStatusCallFromAnswer('married_filing_jointly')).toBeNull();
  });
});

describe('filingStatusFromClientWords', () => {
  it.each([
    ['We got married in June and want to file together.', 'married_filing_jointly'],
    ['My wife and I will file a joint return like last year.', 'married_filing_jointly'],
    ["I'm married but we keep our finances separate, so I'll file my own return.", 'married_filing_separately'],
    ["I'm single, never been married.", 'single'],
    ['Single.', 'single'],
    ['Please file me as head of household.', 'head_of_household'],
    ['Not sure yet, I need to ask my accountant what is best.', null],
    ['Divorced last year. My two kids live with me full time and I pay all the bills.', null],
    ['My husband passed away last year. I have a 6 year old at home.', null],
    ["We're married, do whatever saves us the most money.", null],
    ["We don't want to file jointly this year.", null],
    ['Should we file jointly or separately?', null],
  ])('%j → %j', (words, expected) => {
    expect(filingStatusFromClientWords(words)).toBe(expected);
  });
});

describe('confirmFilingStatusCandidate', () => {
  it('records a candidate only when the model and the words agree', () => {
    expect(confirmFilingStatusCandidate({ filingStatusCandidate: 'married_filing_jointly' }, 'We will file together.').call)
      .toEqual({ name: 'set_filing_status_candidate', args: { status: 'married_filing_jointly' } });
  });

  it('records nothing when the model leans on a status the words do not state (measured bias)', () => {
    const r = confirmFilingStatusCandidate(
      { filingStatusCandidate: 'married_filing_separately' },
      'Divorced last year. My two kids live with me full time.',
    );
    expect(r.call).toBeNull();
    expect(r.reason).toMatch(/model read married_filing_separately but the client's words state no status/);
    expect(confirmFilingStatusCandidate({ filingStatusCandidate: 'married_filing_separately' }, 'We want to file together.').call).toBeNull();
  });
});
