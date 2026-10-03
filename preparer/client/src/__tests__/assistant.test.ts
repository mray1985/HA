import { describe, expect, it } from 'vitest';
import { FilingStatus, type TaxReturn } from '@hatax/engine';
import { generateClientQuestions, invokeTaxTool, type ClientQuestion, type IngestedDocument, type TaxFact, type TaxToolName, type TaxToolSuccess } from '@hatax/local-ai';
import { buildCaseReview, type ReviewItem } from '../services/caseReview';
import { assistantTurns, caseHeadline, nextTurn } from '../services/assistantTurns';
import { readAnswer, readAmount, readCount, readFilingStatus, readRelationship, readResidency, readYesNo } from '../services/assistantAnswers';

/** A held W-2: box 1 was read two ways, so the form is off the return. */
function disputedW2(extra: Record<string, unknown> = {}): { facts: TaxFact[]; document: IngestedDocument } {
  const r = invokeTaxTool({
    tool: 'add_w2' as TaxToolName,
    args: { employerName: 'Riverbend Logistics LLC', wages: 52431, ...extra },
    context: { returnId: 'case-1', taxYear: 2026, sourceDocumentId: 'DOC-W2', sourceFileName: 'w2-riverbend.pdf', extractor: 'test' },
  });
  const facts = ((r as TaxToolSuccess).facts as TaxFact[]).map((f) =>
    f.sourceField === 'wages' && f.status === 'extracted'
      ? { ...f, secondReading: { source: 'model' as const, text: '62,431', agrees: false } }
      : f,
  );
  const document: IngestedDocument = {
    documentId: 'DOC-W2', returnId: 'case-1', fileName: 'w2-riverbend.pdf', mimeType: 'application/pdf',
    byteLength: 10, contentHash: 'h', ingestedAt: '', status: 'extracted',
    classifications: [{ status: 'classified', formType: 'W-2', confidence: 'high', reason: 'printed markers', matchedMarkers: [], source: 'text_markers' }],
    formTypes: ['w2'],
  };
  return { facts, document };
}

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'case-1', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'assistant',
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [],
    income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
    rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

const PERSON = {
  firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456', filingStatus: FilingStatus.Single,
  addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802',
  dateOfBirth: '1988-04-02',
} as Partial<TaxReturn>;

describe('reading what the preparer types', () => {
  it('reads a money amount the ways people write one', () => {
    expect(readAmount('52,000')).toBe(52000);
    expect(readAmount('$52,000.00')).toBe(52000);
    expect(readAmount('52k')).toBe(52000);
    expect(readAmount('52000')).toBe(52000);
    expect(readAmount('1,234.56')).toBe(1234.56);
    expect(readAmount('nothing here')).toBeUndefined();
  });

  it('does not read the box number a message names as the value', () => {
    expect(readAmount('box 2 is 5,873.40')).toBe(5873.4);
    expect(readAmount('box 1a was 1,200')).toBe(1200);
    expect(readAmount('in 2025 they paid 300')).toBe(300);
    expect(readAmount('line 25 yes')).toBeUndefined();
  });

  it('reads a months count from the words as well as the digits', () => {
    expect(readCount('all year')).toBe(12);
    expect(readCount('the whole year')).toBe(12);
    expect(readCount('10 months')).toBe(10);
    expect(readCount('none')).toBe(0);
    expect(readCount('she did not')).toBeUndefined();
  });

  it('reads yes and no, and refuses a hedge', () => {
    expect(readYesNo('yes')).toBe(true);
    expect(readYesNo('nope')).toBe(false);
    expect(readYesNo('did not')).toBe(false);
    expect(readYesNo('maybe')).toBeUndefined();
  });

  it('reads a filing status from the words people use', () => {
    expect(readFilingStatus('they are married and want to file together')).toBe(FilingStatus.MarriedFilingJointly);
    expect(readFilingStatus('married filing separately')).toBe(FilingStatus.MarriedFilingSeparately);
    expect(readFilingStatus('head of household')).toBe(FilingStatus.HeadOfHousehold);
    expect(readFilingStatus('single')).toBe(FilingStatus.Single);
    expect(readFilingStatus('I do not know')).toBeUndefined();
  });

  it('reads a relationship as the return spells it, most specific word first', () => {
    expect(readRelationship('she is my daughter')).toBe('Daughter');
    expect(readRelationship('my son')).toBe('Son');
    expect(readRelationship('her grandmother')).toBe('Grandparent');
    expect(readRelationship('my grandson')).toBe('Grandchild');
    expect(readRelationship('he is my stepson')).toBe('Stepson');
    expect(readRelationship('her step father')).toBe('Stepfather');
    expect(readRelationship('his sister')).toBe('Sister');
    // Not a relationship on the return: refused rather than guessed at.
    expect(readRelationship('the neighbour’s cat')).toBeUndefined();
    expect(readRelationship('my friend')).toBeUndefined();
  });

  it('reads residency as all year, part year or none', () => {
    expect(readResidency('she lived with us all year')).toBe('all_year');
    expect(readResidency('I moved here in March')).toBe('part_year');
    expect(readResidency('we did not live there at all')).toBe('none');
  });
});

describe('the assistant thread', () => {
  it('says what stopped a form being used, and offers both readings to take', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });
    const held = turns.find((t) => t.id.startsWith('document:held:'));

    expect(held).toBeDefined();
    // Plain words: no tool field names, no issue codes.
    expect(held!.say).not.toMatch(/READERS_DISAGREE|federalTaxWithheld/);
    expect(held!.say).toMatch(/the two readers read/i);
    expect(held!.say).toMatch(/w2-riverbend\.pdf/);
    expect(held!.ask).toMatch(/wages, tips and other compensation \(box 1\)/);
    // Both readings are one click away.
    expect(held!.options?.map((o) => o.label)).toEqual(['$52,431', '$62,431']);
  });

  it('names each box that failed, and how it failed', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });
    const held = turns.find((t) => t.id.startsWith('document:held:'))!;

    // Box 2 is missing entirely; box 1 the readers disagree on. Both are said.
    expect(held.say).toMatch(/Federal income tax withheld \(box 2\)/);
    expect(held.say).toMatch(/the two readers read Wages, tips and other compensation \(box 1\) differently/);
    expect(held.ask).not.toMatch(/federal tax withheld \(box 2\), wages/);
  });

  it('orders what blocks the return above what only the client can answer', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const questions = generateClientQuestions({ facts, taxYear: 2026, filingStatus: '1', missingDocuments: [] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions, clientName: 'Maya' });

    const blocking = turns.filter((t) => t.kind === 'blocked');
    const asking = turns.filter((t) => t.kind === 'ask');
    if (blocking.length > 0 && asking.length > 0) {
      expect(turns.indexOf(blocking[0]!)).toBeLessThan(turns.indexOf(asking[0]!));
    }
    expect(nextTurn(turns)?.kind).toBe('blocked');
  });

  it('never asks about an item that has been decided', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const decided = review.items.map((i) => (i.id.startsWith('document:held:') ? { ...i, resolution: { decision: 'accepted' as const, note: 'checked', resolvedAt: '' } } : i));
    const turns = assistantTurns({ items: decided, facts, documents: [document], questions: [], clientName: 'Maya' });
    expect(turns.some((t) => t.id.startsWith('document:held:'))).toBe(false);
  });

  it('says a file it could not identify plainly, and does not ask about an informational item', () => {
    const scan: IngestedDocument = {
      documentId: 'SCAN-1', returnId: 'case-1', fileName: 'IMG_4471.pdf', mimeType: 'application/pdf',
      byteLength: 10, contentHash: 'h', ingestedAt: '', status: 'unclassified',
    };
    const taxReturn = makeReturn({ ...PERSON, w2Income: [{ id: 'w1', wages: 50000 } as TaxReturn['w2Income'][number]] });
    const review = buildCaseReview({ taxReturn, calculation: null, facts: [], documents: [scan] });
    const turns = assistantTurns({ items: review.items, facts: [], documents: [scan], questions: [], clientName: 'Maya' });
    const ask = turns.find((t) => t.intent.kind === 'document');

    expect(ask?.say).toMatch(/could not tell what form IMG_4471\.pdf is/);
    expect(ask?.kind).toBe('blocked');
    expect(turns.every((t) => t.kind !== 'note' || !/is left out:/.test(t.say))).toBe(true);
  });
});

describe('routing a typed answer to the right turn', () => {
  it('puts a typed number into the box that was held, and names the box back', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });

    const read = readAnswer('62000', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.intent).toMatchObject({ kind: 'held_field', field: 'wages' });
    expect(read.value).toEqual({ kind: 'number', value: 62000 });
    expect(read.label).toBe('Wages, tips and other compensation (box 1): $62,000');
  });

  it('picks the box a message names when the turn needs more than one', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });

    const read = readAnswer('box 2 is 5873.40', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.intent).toMatchObject({ kind: 'held_field', field: 'federalTaxWithheld' });
    expect(read.value).toEqual({ kind: 'number', value: 5873.4 });
  });

  it('refuses a number that the box cannot take', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });

    // Wages cannot be negative: the reading says so rather than writing it.
    const read = readAnswer('-500', turns);
    expect(read.status).toBe('partial');
    if (read.status !== 'partial') return;
    expect(read.reason).toMatch(/cannot be negative/);
  });

  it('does not repeat the return having no income when a held form already says so', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });

    expect(review.items.some((i) => i.id.includes('no-income-sources'))).toBe(true);
    expect(turns.some((t) => /No income sources/.test(t.say))).toBe(false);
  });

it('says it did not understand rather than writing something', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });

    const read = readAnswer('call me later about it', turns);
    expect(['unmatched', 'partial']).toContain(read.status);
  });
});

describe('routing by what the message says, not by which turn is listed first', () => {
  /** A case with the identity still empty: a date of birth and a filing status both open. */
  function identityTurns() {
    const taxReturn = makeReturn({ ...PERSON, ssn: '', dateOfBirth: '', filingStatus: undefined });
    const review = buildCaseReview({ taxReturn, calculation: null, facts: [], documents: [] });
    return assistantTurns({ items: review.items, facts: [], documents: [], questions: [], clientName: 'Maya' });
  }

  it('sends a filing status to the filing status, not to the date of birth above it', () => {
    const turns = identityTurns();
    const read = readAnswer('single', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.intent).toMatchObject({ kind: 'return_field', field: 'filingStatus' });
    expect(read.label).toMatch(/^Filing status: Single$/);
  });

  it('sends a date to the date of birth', () => {
    const turns = identityTurns();
    const read = readAnswer('1988-04-02', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.intent).toMatchObject({ kind: 'return_field', field: 'dateOfBirth' });
  });

  it('still sends a bare number to the only thing that takes one', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });
    const read = readAnswer('62000', turns);
    expect(read.status).toBe('understood');
  });
});

describe('a question is not asked twice', () => {
  it('does not ask the client about a form the preparer already has to decide', () => {
    // A 1099-Q read but waiting for the qualified expenses: a form decision and a
    // client question would be about the same fact, so only the form's card stands.
    const facts: TaxFact[] = [];
    const document: IngestedDocument = {
      documentId: 'DOC-Q', returnId: 'case-1', fileName: '1099q-529.pdf', mimeType: 'application/pdf',
      byteLength: 10, contentHash: 'h', ingestedAt: '', status: 'extracted',
      classifications: [{ status: 'classified', formType: '1099-Q', confidence: 'high', reason: '', matchedMarkers: [], source: 'text_markers' }],
      formTypes: ['1099q'],
    };
    const choiceItem: ReviewItem = {
      id: 'document:qtp-expenses:DOC-Q#0', category: 'REVIEW', group: 'income', source: 'document',
      documentId: 'DOC-Q', message: '1099q-529.pdf: enter the qualified education expenses this 1099-Q distribution paid.',
      action: { kind: 'choice', tool: 'add_1099_q', formKey: 'DOC-Q#0', missing: ['qualifiedExpenses'] },
    };
    const questions: ClientQuestion[] = [{
      id: 'form:add_1099_q:qualifiedExpenses', kind: 'amount', text: 'How much did you pay in 2025 for qualified education expenses?',
      target: { kind: 'form', tool: 'add_1099_q', formKey: 'DOC-Q#0', field: 'qualifiedExpenses' },
      subjectName: 'Louisiana Start Savings Program', subjectWords: ['529'],
    }];
    const turns = assistantTurns({ items: [choiceItem], facts, documents: [document], questions, clientName: 'Maya' });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.intent).toMatchObject({ kind: 'choice', tool: 'add_1099_q' });
    expect(turns[0]!.ask).toBe('How much did this 1099-Q pay in qualified education expenses?');
    // The raw review message, with its file prefix and trailing clause, is not shown.
    expect(turns[0]!.ask).not.toMatch(/1099q-529\.pdf|until then/);
  });

  it('does not say a payer name can settle a question only the client can answer', () => {
    const questions = generateClientQuestions({
      facts: [], taxYear: 2025, filingStatus: null, missingDocuments: [],
    });
    const turns = assistantTurns({ items: [], facts: [], documents: [], questions, clientName: 'Maya' });
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.say).not.toMatch(/LOUISIANA|JPMORGAN|CHASE|RIVERBEND/);
  });
});

describe('a fact the documents already state is never asked for by hand', () => {
  /** The identity items planIdentity raises when a reading has no second reader agreeing. */
  function unconfirmedIdentityItems(): ReviewItem[] {
    return [
      { id: 'identity:unconfirmed:DOC-W2#0:name', category: 'REVIEW', group: 'personal', source: 'document',
        documentId: 'DOC-W2', message: 'w2.pdf reads the name as Maya Testpayer, but no second reader confirmed it.',
        action: { kind: 'use_identity', documentId: 'DOC-W2', index: 0, part: 'name', role: 'taxpayer', shown: 'Maya Testpayer' } },
      { id: 'identity:unconfirmed:DOC-W2#0:tin', category: 'REVIEW', group: 'personal', source: 'document',
        documentId: 'DOC-W2', message: 'w2.pdf reads the SSN as 000-12-3456, but no second reader confirmed it.',
        action: { kind: 'use_identity', documentId: 'DOC-W2', index: 0, part: 'tin', role: 'taxpayer', shown: '000-12-3456' } },
      // ...and the readiness items for the same empty fields.
      { id: 'case:firstName', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'firstName',
        message: 'First name is required.', action: { kind: 'return_field', field: 'firstName' } },
      { id: 'case:lastName', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'lastName',
        message: 'Last name is required.', action: { kind: 'return_field', field: 'lastName' } },
      { id: 'case:ssn', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'ssn',
        message: 'Social Security number is required.', action: { kind: 'return_field', field: 'ssn' } },
    ];
  }

  const document = (): IngestedDocument => ({
    documentId: 'DOC-W2', returnId: 'case-1', fileName: 'w2.pdf', mimeType: 'application/pdf',
    byteLength: 10, contentHash: 'h', ingestedAt: '', status: 'extracted',
    classifications: [{ status: 'classified', formType: 'W-2', confidence: 'high', reason: '', matchedMarkers: [], source: 'text_markers' }],
  });

  it('offers the name printed on the form instead of asking the preparer to type it', () => {
    const turns = assistantTurns({
      items: unconfirmedIdentityItems(), facts: [], documents: [document()], questions: [], clientName: 'Maya',
    });

    // Nothing asks for the name, the SSN, or the last name by hand.
    expect(turns.some((t) => t.intent.kind === 'return_field')).toBe(false);
    expect(turns.some((t) => /What is .*(first name|last name|Social Security)/i.test(t.ask ?? ''))).toBe(false);

    // The reading on the form is the answer, one click.
    const nameTurn = turns.find((t) => t.id.endsWith(':name'))!;
    expect(nameTurn.kind).toBe('needed');
    expect(nameTurn.say).toMatch(/w2\.pdf has the taxpayer's name on it/);
    expect(nameTurn.say).toMatch(/no second reading agreed/);
    expect(nameTurn.options?.map((o) => o.label)).toEqual(['Maya Testpayer']);
    expect(nameTurn.intent).toMatchObject({ kind: 'identity' });
  });

  it('leads with it, because it is the thing that unblocks the return', () => {
    const turns = assistantTurns({
      items: unconfirmedIdentityItems(), facts: [], documents: [document()],
      questions: [{ id: 'filing-status', kind: 'filing_status', text: 'How do you want to file?', target: { kind: 'filing_status' } }],
      clientName: 'Maya',
    });
    expect(turns[0]!.id).toMatch(/:(name|tin)$/);
    expect(nextTurn(turns)!.id).toMatch(/:(name|tin)$/);
  });

  it('still asks for a field no document says anything about', () => {
    const items: ReviewItem[] = [
      ...unconfirmedIdentityItems(),
      { id: 'case:dateOfBirth', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'dateOfBirth',
        message: 'Date of birth is required.', action: { kind: 'return_field', field: 'dateOfBirth' } },
    ];
    const turns = assistantTurns({ items, facts: [], documents: [document()], questions: [], clientName: 'Maya' });
    const dob = turns.find((t) => t.intent.kind === 'return_field');
    expect(dob?.intent).toMatchObject({ kind: 'return_field', field: 'dateOfBirth' });
  });
});

describe('while the documents are being read, nothing is missing yet', () => {
  it('says what it is reading instead of asking for what the documents will supply', () => {
    const items: ReviewItem[] = [
      { id: 'case:firstName', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'firstName',
        message: 'First name is required.', action: { kind: 'return_field', field: 'firstName' } },
      { id: 'case:ssn', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'ssn',
        message: 'Social Security number is required.', action: { kind: 'return_field', field: 'ssn' } },
    ];
    const questions: ClientQuestion[] = [{ id: 'filing-status', kind: 'filing_status', text: 'How do you want to file?', target: { kind: 'filing_status' } }];

    const turns = assistantTurns({ items, facts: [], documents: [], questions, clientName: 'Maya', intakeBusy: 'Reading w2.pdf…' });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.say).toBe('Reading w2.pdf…');
    expect(turns.some((t) => t.intent.kind === 'return_field')).toBe(false);
    expect(turns.some((t) => t.kind === 'ask')).toBe(false);
    // Nothing is offered to work on while it is still reading.
    expect(nextTurn(turns)).toBeUndefined();
  });

  it('goes back to asking once the reading is done', () => {
    const items: ReviewItem[] = [
      { id: 'case:firstName', category: 'REVIEW', group: 'personal', source: 'readiness', field: 'firstName',
        message: 'First name is required.', action: { kind: 'return_field', field: 'firstName' } },
    ];
    const turns = assistantTurns({ items, facts: [], documents: [], questions: [], clientName: 'Maya', intakeBusy: null });
    expect(turns[0]!.intent).toMatchObject({ kind: 'return_field', field: 'firstName' });
  });
});

describe('an empty case is not a case with ten problems', () => {
  const missingEverything: ReviewItem[] = ['firstName', 'lastName', 'ssn', 'dateOfBirth', 'addressStreet', 'addressCity', 'addressState', 'addressZip', 'filingStatus']
    .map((field) => ({
      id: `case:${field}`, category: 'REVIEW' as const, group: 'personal' as const, source: 'readiness' as const,
      field, message: `${field} is required.`, action: { kind: 'return_field' as const, field },
    }));

  it('asks for the documents first, and still lets the details be entered by hand', () => {
    const turns = assistantTurns({ items: missingEverything, facts: [], documents: [], questions: [], clientName: 'this client', caseEmpty: true });
    // The documents come first: they carry the client's identity and income.
    expect(turns[0]!.ask).toMatch(/Drop their documents in/);
    // With no forms to read, the fields are not "missing" — they are unknown, and
    // the preparer still has to be able to write them.
    expect(turns.some((t) => t.kind === 'ask')).toBe(false);
    const fields = turns.filter((t) => t.intent.kind === 'return_field');
    expect(fields).toHaveLength(missingEverything.length);
    expect(fields.every((t) => t.say.startsWith('Nothing on the case says what'))).toBe(true);
    expect(fields.map((t) => t.ask)).toContain("Taxpayer's first name?");
  });

  it('says so in the headline instead of counting problems it cannot judge yet', () => {
    const turns = assistantTurns({ items: missingEverything, facts: [], documents: [], questions: [], clientName: 'this client', caseEmpty: true });
    expect(caseHeadline(turns, 'this client', 0, 0)).toBe("Nothing on the case yet. Drop this client's documents in and I will read them.");
  });
});

describe('no return field is ever spoken as its field name', () => {
  it('names every missing field the way the return’s own table names it', () => {
    const fields = ['firstName', 'lastName', 'ssn', 'dateOfBirth', 'addressStreet', 'addressCity', 'addressState', 'addressZip', 'filingStatus'];
    const items: ReviewItem[] = fields.map((field) => ({
      id: `case:${field}`, category: 'REVIEW', group: 'personal', source: 'readiness',
      field, message: 'required', action: { kind: 'return_field', field },
    }));
    const turns = assistantTurns({ items, facts: [], documents: [{ documentId: 'D', returnId: 'case-1', fileName: 'w2.pdf', mimeType: 'application/pdf', byteLength: 1, contentHash: 'h', ingestedAt: '', status: 'extracted' }], questions: [], clientName: 'Maya' });
    const text = turns.map((t) => `${t.say} ${t.ask ?? ''}`).join(' | ');

    expect(text).not.toMatch(/addresscity|addressstreet|addressstate|addresszip|\bfirstname\b|\blastname\b|dateofbirth|filingstatus/i);
    expect(text).toMatch(/city/i);
    expect(text).toMatch(/ZIP code/);
    expect(text).toMatch(/Social Security number|SSN or ITIN/);
    expect(text).not.toMatch(/zIP/);
  });
});

describe('the headline', () => {
  it('says the case is done when nothing is open', () => {
    expect(caseHeadline([], 'Maya', 3, 3)).toBe("Maya's return is complete and ready to approve.");
  });

  it('counts what is left in words, not codes', () => {
    const { facts, document } = disputedW2();
    const taxReturn = makeReturn({ ...PERSON });
    const review = buildCaseReview({ taxReturn, calculation: null, facts, documents: [document] });
    const turns = assistantTurns({ items: review.items, facts, documents: [document], questions: [], clientName: 'Maya' });
    const headline = caseHeadline(turns, 'Maya', 1, 1);

    expect(headline).not.toMatch(/BLOCKING|ERROR|REVIEW item/);
    expect(headline).toMatch(/I read all 1 document/);
  });
});