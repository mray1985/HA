import { describe, expect, it } from 'vitest';
import {
  clientAnswerRecord,
  clientAnswerSchema,
  confirmClientAnswer,
  readAnswerFromWords,
  sentenceAround,
} from '../src/clientAnswers.js';
import { clientQuestionLetter, generateClientQuestions, type ClientQuestion } from '../src/clientQuestions.js';
import { resolveDependents } from '../src/recordResolution.js';
import type { TaxFact, TaxFactSourceKind } from '../src/taxFact.js';
import { invokeTaxTool, type TaxToolName } from '../src/taxTools.js';

function record(tool: TaxToolName, args: Record<string, unknown>, sourceDocumentId: string, sourceKind?: TaxFactSourceKind, index?: number): TaxFact[] {
  const result = invokeTaxTool({
    tool,
    args,
    context: {
      returnId: 'R1', taxYear: 2025, sourceDocumentId, sourceFileName: `${sourceDocumentId}.pdf`, extractor: 'test',
      ...(sourceKind ? { sourceKind } : {}),
      ...(index !== undefined ? { sourceFormIndex: index } : {}),
    },
  });
  if (!result.ok) throw new Error(result.error);
  return result.facts;
}

const months = (name = 'Maya'): ClientQuestion => ({
  id: `dependent:${name}:months`, kind: 'months', max: 12, subjectName: name,
  text: `How many months of 2025 did ${name} live with you?`,
  target: { kind: 'dependent', field: 'monthsLivedWithYou', person: { firstName: name, lastName: 'Lee' } },
});
const ask = (kind: ClientQuestion['kind'], extra: Partial<ClientQuestion> = {}): ClientQuestion => ({
  id: kind, kind, text: kind, target: { kind: 'filing_status' }, ...extra,
});
const residency = (stateCode = 'LA'): ClientQuestion => ({
  id: 'res', kind: 'residency', text: 'Did you live in Louisiana for all of 2025, for part of 2025, or not at all?',
  target: { kind: 'residency', field: 'residencyType', stateCode },
});

describe('client questions come from what the case cannot settle (§24)', () => {
  const priorYear = [
    ...record('add_dependent', { firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter' }, 'PRIOR', 'structured_import', 0),
    ...record('add_dependent', { firstName: 'Leo', lastName: 'Lee' }, 'PRIOR', 'structured_import', 1),
  ];

  it('asks for what each dependent is missing, and nothing the evidence gives', () => {
    const qs = generateClientQuestions({ facts: priorYear, taxYear: 2025, filingStatus: 'single' });
    expect(qs.map((q) => q.text)).toEqual([
      'How many months of 2025 did Maya live with you?',
      'How is Leo Lee related to you?',
      'How many months of 2025 did Leo live with you?',
    ]);
    expect(qs[0]!.target).toEqual({ kind: 'dependent', field: 'monthsLivedWithYou', person: { firstName: 'Maya', lastName: 'Lee' } });
  });

  it('asks for the filing status only when the return has none', () => {
    expect(generateClientQuestions({ facts: [], taxYear: 2025 }).map((q) => q.kind)).toEqual(['filing_status']);
    expect(generateClientQuestions({ facts: [], taxYear: 2025, filingStatus: 'married_filing_jointly' })).toEqual([]);
  });

  it('asks a form only for facts the client knows', () => {
    const q = record('add_1099_q', { payerName: 'VANGUARD 529 PLAN', grossDistribution: 15000, earnings: 3200, basisReturn: 11800, recipientNotDesignatedBeneficiary: false }, 'Q');
    const qs = generateClientQuestions({ facts: q, taxYear: 2025, filingStatus: 'single' });
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'amount', target: { kind: 'form', tool: 'add_1099_q', formKey: 'Q#0', field: 'qualifiedExpenses' } });
    expect(qs[0]!.text).toContain('on the 1099-Q from VANGUARD 529 PLAN');
    // An education credit: the choice of credit is the preparer's, never put to the client, but the
    // facts that decide it (Form 8863 lines 23–26) are asked before the choice.
    const t = record('add_education_expense', { studentName: 'Maya Lee', tuitionPaid: 9000, halfTimeStudent: true }, 'T');
    const education = generateClientQuestions({ facts: t, taxYear: 2025, filingStatus: 'single' });
    expect(education.map((q) => (q.target as { field: string }).field)).toEqual(['enrolledHalfTime', 'aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction']);
    // Box 8 shows half-time only; line 24 also asks for a program toward a degree or credential.
    expect(education[0]!.text).toBe('Was Maya Lee enrolled at least half-time, for at least one academic period that began in 2025, in a program leading to a degree, certificate or other recognized credential?');
  });

  it('asks where the client lived when a state has no residency, then for days when part-year', () => {
    const unknown = record('set_state_residency', { stateCode: 'TX' }, 'W2-STATE', 'document');
    expect(generateClientQuestions({ facts: unknown, taxYear: 2025, filingStatus: 'single' }).map((q) => q.text))
      .toEqual(['Did you live in Texas for all of 2025, for part of 2025, or not at all?']);
    const partYear = record('set_state_residency', { stateCode: 'TX', residencyType: 'part_year' }, 'A', 'client_response');
    expect(generateClientQuestions({ facts: partYear, taxYear: 2025, filingStatus: 'single' }).map((q) => q.kind)).toEqual(['days']);
  });

  it('writes the message: what has arrived, then the open questions', () => {
    const w2 = record('add_w2', { employerName: 'ACME CORP\n1 MAIN ST', wages: 50000 }, 'W2');
    const facts = [...w2, ...priorYear.slice(0, priorYear.length)];
    const letter = clientQuestionLetter(generateClientQuestions({ facts, taxYear: 2025, filingStatus: 'single' }).slice(0, 1), facts);
    expect(letter).toBe('We have your W-2 from ACME CORP.\n\nWe still need to confirm:\n\n1. How many months of 2025 did Maya live with you?');
  });
});

describe("reading the client's own words", () => {
  it.each([
    ['Yes, she lived with me all year.', 12],
    ['She lived with us the whole year', 12],
    ['all of 2025', 12],
    ['She lived with us for 8 months', 8],
    ['eight months', 8],
    ["She didn't live with us, she lives with her dad.", 0],
    ["No she didn't live with me, she lives with her mom full time.", 0],
    ['none', 0],
    ['All year, all 12 months.', 12],
    ['1. Yes all year', 12],
  ])('months: %j → %s', (words, want) => {
    expect(readAnswerFromWords(months(), words)).toBe(want);
  });

  it.each([
    "She didn't live with me all year.",
    'She lived with us all year except the summer.',
    'More than six months.',
    'I think all year.',
    'Since March.',
    'Half the year.',
    '8 months, maybe 9',
    'She lived with us 5 months and then all year after that',
    "She didn't live with me the whole year.",
    'Maya lived with her grandparents all year.',
    '10 months, she was in the hospital for 2.',
    'She lived with us all year but was away at college in the fall.',
    '8 months, she is 16',
  ])('months: %j states nothing', (words) => {
    expect(readAnswerFromWords(months(), words)).toBeNull();
  });

  it.each([
    ["She's my daughter.", 'Daughter'],
    ['my stepson', 'Stepson'],
    ['He is my son-in-law', 'Son-in-Law'],
    ['my granddaughter', 'Grandchild'],
    ['Leo is my nephew.', 'Nephew'],
  ])('relationship: %j → %s', (words, want) => {
    expect(readAnswerFromWords(ask('relationship'), words)).toBe(want);
  });

  it.each([
    "He's my girlfriend's son.",
    "He's like a son to me.",
    'Not my son, my nephew.',
    'my son and my daughter',
  ])('relationship: %j states nothing', (words) => {
    expect(readAnswerFromWords(ask('relationship'), words)).toBeNull();
  });

  it.each([
    ['I lived in Louisiana all year.', 'resident'],
    ["We didn't move, we were there the whole year.", 'resident'],
    ['I moved here in June.', 'part_year'],
    ['I never lived there, I only worked there.', 'nonresident'],
  ])('residency: %j → %s', (words, want) => {
    expect(readAnswerFromWords(residency(), words)).toBe(want);
  });

  it.each([
    'We lived in Texas all year.',
    "I didn't live there the whole year.",
    'We moved in June but we were there all year',
  ])('residency: %j states nothing', (words) => {
    expect(readAnswerFromWords(residency(), words)).toBeNull();
  });

  // Named in a loop: vitest would read "$12" in an it.each title as a placeholder.
  for (const [words, want] of [
    ['We paid $12,400 for tuition.', 12400],
    ['In 2025 we paid 9,850.50 in total', 9850.5],
    ['Nothing, she had a full scholarship.', 0],
    ['$4,500 for our 2 kids', 4500],
  ] as const) {
    it(`amount: ${JSON.stringify(words)} → ${want}`, () => {
      expect(readAnswerFromWords(ask('amount'), words)).toBe(want);
    });
  }

  for (const words of [
    '$12,400 for tuition and $3,000 for the dorm',
    'About $4,000.',
    'Roughly 4.5k',
    'Four thousand dollars',
    'For 2 kids',
    'We paid 4,000 for tuition and got a $1,500 scholarship.',
  ]) {
    it(`amount: ${JSON.stringify(words)} states nothing`, () => {
      expect(readAnswerFromWords(ask('amount'), words)).toBeNull();
    });
  }

  it.each([
    ['Yes', true],
    ['Yes, all of it.', true],
    ['No.', false],
    ['Nope, we used it for a vacation.', false],
    ['No, only some of it', null],
    ['Mostly.', null],
    ['Yes but not all', null],
    ["I'm not sure", null],
  ])('yes/no: %j → %s', (words, want) => {
    expect(readAnswerFromWords(ask('yes_no'), words)).toBe(want);
  });

  it.each([
    ['The HSA distribution paid doctor bills.', true],
    ['We used the HSA money for prescriptions and dental work', true],
    ['It went to my surgery copays.', true],
    ['It paid some doctor bills and a vacation', null],
    ['Not for medical stuff, we used it for rent.', false],
    ['I think it paid doctor bills', null],
    ['We used it for a vacation.', null],
  ])('the 1099-SA medical-use question: %j → %s', (words, want) => {
    const hsa = ask('yes_no', { target: { kind: 'form', tool: 'add_1099_sa', formKey: 'DOC-SA#0', field: 'usedForQualifiedMedicalExpenses' } });
    expect(readAnswerFromWords(hsa, words)).toBe(want);
  });

  it('reads a statement of medical use only for the 1099-SA question', () => {
    expect(readAnswerFromWords(ask('yes_no'), 'The HSA distribution paid doctor bills.')).toBeNull();
  });

  it('filing status: only a stated status', () => {
    expect(readAnswerFromWords(ask('filing_status'), "We'll file jointly again.")).toBe('married_filing_jointly');
    expect(readAnswerFromWords(ask('filing_status'), 'Whatever saves us the most.')).toBeNull();
  });
});

describe("a value is recorded only when the model and the client's words agree (§25)", () => {
  const reply = 'Hi! Maya lived with us all year. Leo lived with us 5 months. Thanks';
  const others = ['Maya', 'Leo'];

  it('records a confirmed answer with its words', () => {
    const out = confirmClientAnswer(months('Maya'), reply, { quote: 'Maya lived with us all year', answer: '12' }, { others: others.map((n) => months(n)) });
    expect(out).toEqual({ status: 'answered', value: 12, quote: 'Maya lived with us all year', sentence: 'maya lived with us all year' });
    // The grammar's JSON arrives as text.
    expect(confirmClientAnswer(months('Leo'), reply, JSON.stringify({ quote: 'Leo lived with us 5 months', answer: '5' }), { others: others.map((n) => months(n)) }))
      .toMatchObject({ status: 'answered', value: 5 });
  });

  it('reads the quote in its whole sentence', () => {
    const out = confirmClientAnswer(months(), 'She did not live with me all year.', { quote: 'all year', answer: '12' });
    expect(out).toMatchObject({ status: 'unclear' });
  });

  it('keeps nothing when the model and the words disagree', () => {
    const out = confirmClientAnswer(months(), 'She lived with me 8 months.', { quote: 'She lived with me 8 months', answer: '12' });
    expect(out).toEqual({ status: 'unclear', reason: "the model read 12 but the client's words state 8", quote: 'She lived with me 8 months' });
  });

  it('keeps nothing when the quoted words are not in the reply', () => {
    expect(confirmClientAnswer(months(), reply, { quote: 'Maya lived with me the whole year', answer: '12' }, { others: others.map((n) => months(n)) }))
      .toMatchObject({ status: 'unclear', reason: 'the words the model quoted are not in the reply' });
  });

  it("does not give one person's answer to another", () => {
    expect(confirmClientAnswer(months('Leo'), reply, { quote: 'lived with us all year', answer: '12' }, { others: others.map((n) => months(n)) }))
      .toMatchObject({ status: 'unclear' });
    expect(confirmClientAnswer(months('Maya'), 'Maya and Leo lived with us all year.', { quote: 'Maya and Leo lived with us all year', answer: '12' }, { others: others.map((n) => months(n)) }))
      .toMatchObject({ status: 'unclear' });
  });

  it('does not give a bare answer to one of two questions that take it', () => {
    const w2: ClientQuestion = { id: 'doc:w2', kind: 'yes_no', text: '', subjectName: 'RIVERBEND LOGISTICS LLC', subjectWords: ['riverbend', 'logistics', 'w-2'], target: { kind: 'document', formType: 'W-2', issuer: 'RIVERBEND LOGISTICS LLC' } };
    const chase: ClientQuestion = { id: 'doc:chase', kind: 'yes_no', text: '', subjectName: 'JPMORGAN CHASE BANK NA', subjectWords: ['jpmorgan', 'chase', 'interest'], target: { kind: 'document', formType: '1099-INT', issuer: 'JPMORGAN CHASE BANK NA' } };
    const reply = 'No, I closed that Chase account last year.';
    expect(confirmClientAnswer(chase, reply, { quote: reply, answer: 'no' }, { others: [w2, chase] })).toMatchObject({ status: 'answered', value: false });
    expect(confirmClientAnswer(w2, reply, { quote: reply, answer: 'no' }, { others: [w2, chase] }))
      .toMatchObject({ status: 'unclear', reason: 'the reply also names JPMORGAN CHASE BANK NA, and the words that answer do not name RIVERBEND LOGISTICS LLC' });
    expect(confirmClientAnswer(w2, 'No.', { quote: 'No', answer: 'no' }, { others: [w2, chase] }))
      .toMatchObject({ status: 'unclear', reason: 'another open question takes the same answer, and the words that answer do not name RIVERBEND LOGISTICS LLC' });
  });

  it("does not give one person's answer to another asked something else", () => {
    const leoRelationship: ClientQuestion = { id: 'rel:leo', kind: 'relationship', text: '', subjectName: 'Leo', target: { kind: 'dependent', field: 'relationship', person: { firstName: 'Leo', lastName: 'Lee' } } };
    expect(confirmClientAnswer(months('Maya'), 'Leo lived with us all year.', { quote: 'Leo lived with us all year', answer: '12' }, { others: [months('Maya'), leoRelationship] }))
      .toMatchObject({ status: 'unclear' });
  });

  it('leaves an unanswered question open', () => {
    expect(confirmClientAnswer(months(), reply, { quote: '', answer: 'not_stated' })).toEqual({ status: 'not_answered' });
    expect(confirmClientAnswer(months(), reply, 'not json')).toMatchObject({ status: 'unclear' });
    expect(confirmClientAnswer(months(), reply, { quote: 'x', answer: '13' })).toMatchObject({ status: 'unclear' });
  });

  it('finds the sentence around a quote', () => {
    expect(sentenceAround('One. Two three four. Five', 'three')).toBe('two three four');
    expect(sentenceAround('One. Two', 'missing')).toBeNull();
  });
});

describe('where a confirmed answer goes', () => {
  it('fills the waiting dependent through add_dependent as a client response', () => {
    const prior = record('add_dependent', { firstName: 'Maya', lastName: 'Lee', relationship: 'Daughter' }, 'PRIOR', 'structured_import');
    const [q] = generateClientQuestions({ facts: prior, taxYear: 2025, filingStatus: 'single' });
    const target = clientAnswerRecord(q!, 12);
    expect(target).toEqual({ kind: 'record', tool: 'add_dependent', field: 'monthsLivedWithYou', args: { firstName: 'Maya', lastName: 'Lee', monthsLivedWithYou: 12 } });
    if (target.kind !== 'record') throw new Error('unreachable');
    const answer = record(target.tool, target.args, 'REPLY-1', 'client_response');
    const [maya] = resolveDependents([...prior, ...answer], 2025);
    expect(maya).toMatchObject({ ready: true, fields: { monthsLivedWithYou: 12, relationship: 'Daughter' } });
  });

  it('maps a form question to its field', () => {
    const q: ClientQuestion = { id: 'f', kind: 'amount', text: '', target: { kind: 'form', tool: 'add_1099_q', formKey: 'Q', field: 'qualifiedExpenses' } };
    expect(clientAnswerRecord(q, 4500)).toEqual({ kind: 'form', tool: 'add_1099_q', formKey: 'Q', field: 'qualifiedExpenses', value: 4500 });
  });

  it('builds a grammar with the words first and only allowed answers', () => {
    const schema = clientAnswerSchema(months()) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['quote', 'answer']);
    expect(schema.properties.answer!.enum).toEqual([...Array.from({ length: 13 }, (_, i) => String(i)), 'not_stated']);
  });
});

describe("a client's answer to a form's question", () => {
  const context = { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'Q', sourceFileName: 'Client reply', extractor: 'Qwen3.5-0.8B + client words', modelRunId: 'run-1', rawText: { qualifiedExpenses: '$5,000 for tuition' } };

  it('is a verified client-response fact of the form, and completes it', async () => {
    const { recordClientChoiceAnswer, buildChoiceItem } = await import('../src/preparerChoices.js');
    const form = record('add_1099_q', { payerName: 'VANGUARD 529 PLAN', grossDistribution: 15000, earnings: 3200, basisReturn: 11800, recipientNotDesignatedBeneficiary: false }, 'Q');
    const answer = recordClientChoiceAnswer('add_1099_q', 'qualifiedExpenses', 5000, context);
    if (!answer.ok) throw new Error(answer.error);
    expect(answer.facts).toHaveLength(1);
    expect(answer.facts[0]).toMatchObject({ factType: '1099Q_qualifiedExpenses', value: 5000, sourceKind: 'client_response', verified: true, modelRunId: 'run-1', rawText: '$5,000 for tuition' });
    expect(buildChoiceItem('add_1099_q', [...form, ...answer.facts]).state).toBe('ready');
  });

  it('takes only the questions a form asks, with valid values', async () => {
    const { recordClientChoiceAnswer } = await import('../src/preparerChoices.js');
    expect(recordClientChoiceAnswer('add_1099_q', 'grossDistribution', 1, context)).toMatchObject({ ok: false });
    expect(recordClientChoiceAnswer('add_1099_q', 'qualifiedExpenses', -5, context)).toMatchObject({ ok: false });
    expect(recordClientChoiceAnswer('add_education_expense', 'felonyDrugConviction', false, context)).toMatchObject({ ok: true });
  });
});

describe('quoted words are found as whole words', () => {
  it('does not find a quoted "no" inside "know"', () => {
    expect(sentenceAround('I know it is late. Yes, I have it.', 'no')).toBeNull();
    expect(sentenceAround('I know it is late. No, I do not have it.', 'no')).toBe('no, i do not have it');
  });
});
