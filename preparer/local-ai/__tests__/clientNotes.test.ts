import { describe, expect, it } from 'vitest';
import { confirmNoteCall, confirmNoteProposals, datesIn, noteCalls, noteSchema, proposalIsKnown } from '../src/clientNotes.js';
import type { TaxFact } from '../src/taxFact.js';
import { invokeTaxTool, type TaxToolName } from '../src/taxTools.js';

const record = (tool: TaxToolName, args: Record<string, unknown>, id: string): TaxFact[] => {
  const r = invokeTaxTool({ tool, args, context: { returnId: 'R1', taxYear: 2025, sourceDocumentId: id, sourceFileName: id, extractor: 'test', sourceKind: 'client_response' } });
  if (!r.ok) throw new Error(r.error);
  return r.facts;
};

describe('dates written in a note', () => {
  it('reads only dates that give their year', () => {
    expect(datesIn('Lily was born March 3rd, 2025 at 6am')).toEqual(['2025-03-03']);
    expect(datesIn('paid 4/15/2025 and on 2025-06-16')).toEqual(['2025-04-15', '2025-06-16']);
    expect(datesIn('born March 3rd')).toEqual([]);
    expect(datesIn('February 30, 2025')).toEqual([]);
  });
});

describe("a note's proposals keep only what its words give", () => {
  const note = "Big news: we had a baby girl, Lily Lee, born March 3, 2025! Also I moved from Texas to Louisiana in June. I paid the IRS $1,500 in estimated tax on April 15, 2025.";

  it('proposes a new dependent with the values the words give, and drops the rest', () => {
    const out = confirmNoteProposals('dependents', note, {
      people: [{ quote: 'we had a baby girl, Lily Lee, born March 3, 2025', firstName: 'Lily', lastName: 'Lee', relationship: 'Daughter', dateOfBirth: '2025-03-03' }],
    }, 2025);
    expect(out.rejected).toEqual([]);
    // "baby girl" is not the word daughter: the relationship stays unknown and is asked for.
    expect(out.proposals).toEqual([{ tool: 'add_dependent', args: { firstName: 'Lily', lastName: 'Lee', dateOfBirth: '2025-03-03' }, quote: 'we had a baby girl, Lily Lee, born March 3, 2025', sentence: 'big news: we had a baby girl, lily lee, born march 3, 2025', dropped: ['relationship'] }]);
  });

  it('rejects a person the note does not name, or does not say joined the household', () => {
    const out = confirmNoteProposals('dependents', 'My coworker Dana helped me with the forms.', {
      people: [{ quote: 'My coworker Dana helped me', firstName: 'Dana', lastName: '', relationship: '', dateOfBirth: '' }, { quote: 'helped me', firstName: 'Maya', lastName: '', relationship: 'Daughter', dateOfBirth: '' }],
    }, 2025);
    expect(out.proposals).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      'the note does not say Dana is a dependent or joined the household',
      'the note does not name "Maya" in the words given',
    ]);
  });

  it('asks about each state the note names, and reads a move as part of the year in both', () => {
    const calls = noteCalls(note, 2025).filter((c) => c.kind === 'states');
    expect(calls.map((c) => c.question!.text)).toEqual([
      'Did you live in Louisiana for all of 2025, for part of 2025, or not at all?',
      'Did you live in Texas for all of 2025, for part of 2025, or not at all?',
    ]);
    const [la, tx] = calls;
    expect(confirmNoteCall(tx!, note, { quote: 'I moved from Texas to Louisiana in June', answer: 'part_year' }, 2025).proposals.map((p) => p.args))
      .toEqual([{ stateCode: 'TX', residencyType: 'part_year' }]);
    expect(confirmNoteCall(la!, note, { quote: 'I moved from Texas to Louisiana in June', answer: 'resident' }, 2025).rejected[0]!.reason)
      .toBe('the model read resident for Louisiana but the words state part-year');
    expect(confirmNoteCall(la!, note, { quote: '', answer: 'not_stated' }, 2025)).toEqual({ proposals: [], rejected: [] });
    // "in", "or" and "me" are words, not Indiana, Oregon and Maine.
    expect(noteCalls('Call me in the morning or evening.', 2025).map((c) => c.kind)).toEqual(['dependents', 'payments']);
  });

  it('proposes an estimated payment only with its amount, payee and date in the words', () => {
    const out = confirmNoteProposals('payments', note, {
      payments: [{ quote: 'I paid the IRS $1,500 in estimated tax on April 15, 2025', jurisdiction: 'federal', amount: '1500', datePaid: '2025-04-15' }],
    }, 2025);
    expect(out.proposals.map((p) => p.args)).toEqual([{ jurisdiction: 'federal', amount: 1500, datePaid: '2025-04-15' }]);
    const wrongAmount = confirmNoteProposals('payments', note, {
      payments: [{ quote: 'I paid the IRS $1,500 in estimated tax', jurisdiction: 'federal', amount: '15000', datePaid: '' }],
    }, 2025);
    expect(wrongAmount.proposals).toEqual([]);
    const notEstimated = confirmNoteProposals('payments', 'I paid $300 for tax software.', {
      payments: [{ quote: 'I paid $300 for tax software', jurisdiction: 'federal', amount: '300', datePaid: '' }],
    }, 2025);
    expect(notEstimated.rejected[0]!.reason).toBe('the words do not say it was an estimated tax payment');
  });

  it('rejects quoted words that are not in the note, and output that is not a list', () => {
    expect(confirmNoteProposals('payments', note, { payments: [{ quote: 'We paid Ohio $50 in estimated tax', jurisdiction: 'OH', amount: '50', datePaid: '' }] }, 2025).rejected[0]!.reason)
      .toBe('the words the model quoted are not in the note');
    expect(confirmNoteProposals('payments', note, 'nope', 2025).rejected).toHaveLength(1);
  });

  it('does not offer what the case already has', () => {
    const facts = [
      ...record('add_dependent', { firstName: 'Lily', lastName: 'Lee', dateOfBirth: '2025-03-03' }, 'A'),
      ...record('add_estimated_payment', { jurisdiction: 'federal', amount: 1500, datePaid: '2025-04-15' }, 'B'),
    ];
    const lily = { tool: 'add_dependent' as const, args: { firstName: 'Lily', lastName: 'Lee' }, quote: '', sentence: '', dropped: [] };
    expect(proposalIsKnown(lily, facts, 2025)).toBe(true);
    expect(proposalIsKnown({ ...lily, args: { firstName: 'Lily', relationship: 'Daughter' } }, facts, 2025)).toBe(false);
    expect(proposalIsKnown({ tool: 'add_estimated_payment', args: { jurisdiction: 'federal', amount: 1500 }, quote: '', sentence: '', dropped: [] }, facts, 2025)).toBe(true);
  });

  it('limits each list and each field in its grammar', () => {
    const schema = noteSchema('payments') as { properties: { payments: { maxItems: number; items: { required: string[] } } } };
    expect(schema.properties.payments.maxItems).toBe(4);
    expect(schema.properties.payments.items.required).toEqual(['quote', 'jurisdiction', 'amount', 'datePaid']);
  });
});
