/**
 * Client question generator (work order §24).
 *
 * Questions come only from facts the case cannot settle yet: a dependent with
 * no months at home or no relationship, a state with no residency, a form
 * waiting for a fact only the client knows (the qualified expenses a 1099-Q
 * paid), or no filing status. Each question names where its answer goes, so a
 * confirmed reply (clientAnswers.ts) is recorded by the matching record tool.
 * Nothing is asked that a document on the case already answers, and nothing
 * the preparer must decide (which education credit to claim) is put to the
 * client.
 */

import { getStateName } from '@hatax/engine';
import { formKeyOf } from './factValidation.js';
import { buildChoiceItem, choiceForms, formFieldValues, formToolOfFacts, type ChoiceTool } from './preparerChoices.js';
import { resolveDependents, resolveStateResidency, type ResidencyType } from './recordResolution.js';
import { issuerWords, type MissingDocument } from './missingDocuments.js';
import type { TaxFact } from './taxFact.js';
import type { ExpectedDocumentType } from './taxTools.js';

/** How an answer is read: what the grammar allows and how the client's words are checked. */
export type ClientAnswerKind = 'months' | 'relationship' | 'residency' | 'days' | 'amount' | 'yes_no' | 'filing_status';

export interface DependentSubject {
  firstName: string;
  lastName: string;
  ssnLastFour?: string;
}

/** Where a confirmed answer is recorded. */
export type ClientQuestionTarget =
  | { kind: 'dependent'; field: 'monthsLivedWithYou' | 'relationship'; person: DependentSubject }
  | { kind: 'residency'; field: 'residencyType' | 'daysLivedInState'; stateCode: string }
  | { kind: 'form'; tool: ChoiceTool; formKey: string; field: string }
  | { kind: 'filing_status' }
  /** Whether the client received a document they received last year (§23). */
  | { kind: 'document'; formType: ExpectedDocumentType; issuer?: string };

export interface ClientQuestion {
  /** Stable: the same unresolved fact always gives the same id. */
  id: string;
  kind: ClientAnswerKind;
  /** The question as the client reads it. */
  text: string;
  target: ClientQuestionTarget;
  /**
   * The person the question is about. When a reply talks about several
   * people, the words answering this question must name this one.
   */
  subjectName?: string;
  /**
   * Words that name the subject in a reply (a first name, a state, a payer, a
   * form). When another open question takes the same kind of answer, or the
   * reply names another question's subject, the words that answer must name
   * one of these.
   */
  subjectWords?: string[];
  /** Largest count a months or days answer can have. */
  max?: number;
}

/** Form facts a client can give, and how to ask for them. */
const FORM_QUESTIONS: Partial<Record<ChoiceTool, Record<string, { kind: ClientAnswerKind; text: (c: FormContext) => string; max?: number }>>> = {
  add_1099_q: {
    qualifiedExpenses: {
      kind: 'amount',
      text: (c) => `How much did you pay in ${c.year} for qualified education expenses (tuition, required fees, books, supplies, and room and board) for the student on the 1099-Q${c.from}?`,
    },
  },
  add_1099_sa: {
    usedForQualifiedMedicalExpenses: {
      kind: 'yes_no',
      text: (c) => `Was all of the ${c.year} distribution on the 1099-SA${c.from} used to pay qualified medical expenses?`,
    },
  },
  add_education_expense: {
    enrolledHalfTime: {
      kind: 'yes_no',
      text: (c) => `Was ${c.student} enrolled at least half-time for at least one academic period that began in ${c.year}?`,
    },
    aotcClaimedPrior4Years: {
      kind: 'yes_no',
      text: (c) => `Has the American Opportunity credit (or Hope credit) been claimed for ${c.student} in 4 earlier tax years?`,
    },
    completedFirst4Years: {
      kind: 'yes_no',
      text: (c) => `Had ${c.student} completed the first 4 years of college before ${c.year}?`,
    },
    felonyDrugConviction: {
      kind: 'yes_no',
      text: (c) => `Was ${c.student} convicted of a felony drug offense by the end of ${c.year}?`,
    },
  },
};

interface FormContext {
  year: number;
  /** " from Vanguard 529 Plan", or "" when the form names no payer. */
  from: string;
  /** The student's name, or "the student". */
  student: string;
}

const firstLine = (v: unknown) => (typeof v === 'string' && v.trim() ? v.split(/\r?\n/)[0]!.trim() : undefined);

const FILING_STATUS_TEXT = (year: number) =>
  `How do you want to file your ${year} return: single, married filing jointly, married filing separately, head of household, or qualifying surviving spouse?`;

export interface ClientQuestionInputs {
  facts: readonly TaxFact[];
  taxYear: number;
  /** The return's filing status; asked for when empty. */
  filingStatus?: string | null;
  /** Last year's documents this case does not have (missingDocuments.ts); each still open is asked about. */
  missingDocuments?: readonly MissingDocument[];
}

/** What each document is, in the client's words (§24: "an interest statement from Chase"). */
const DOCUMENT_WORDS: Record<ExpectedDocumentType, string> = {
  'W-2': 'wage statement', '1099-INT': 'interest statement', '1099-DIV': 'dividend statement',
  '1099-R': 'retirement or pension distribution statement', '1099-NEC': 'statement of nonemployee pay',
  '1099-MISC': 'statement of miscellaneous income', '1099-G': 'statement of government payments (unemployment or a state tax refund)',
  '1099-K': 'statement of card or app payments', '1099-B': 'brokerage statement of sales', '1099-OID': 'original issue discount statement',
  '1099-SA': 'HSA distribution statement', '1099-Q': '529 plan distribution statement', 'SSA-1099': 'Social Security benefit statement',
  '1098': 'mortgage interest statement', '1098-T': 'tuition statement', '1098-E': 'student loan interest statement',
  '1095-A': 'health insurance marketplace statement', 'K-1': 'Schedule K-1',
};

const article = (word: string) => (/^[aeiouAEIOU]/.test(word) ? 'an' : 'a');

/** Words a client uses for each document ("my W-2", "the interest statement"). */
const DOCUMENT_SUBJECT: Record<ExpectedDocumentType, string[]> = {
  'W-2': ['w-2', 'w2', 'wage', 'wages'], '1099-INT': ['1099-int', 'interest'], '1099-DIV': ['1099-div', 'dividend', 'dividends'],
  '1099-R': ['1099-r', 'retirement', 'pension', 'ira'], '1099-NEC': ['1099-nec', 'contract', 'contractor'], '1099-MISC': ['1099-misc'],
  '1099-G': ['1099-g', 'unemployment', 'refund'], '1099-K': ['1099-k', 'paypal', 'venmo', 'etsy', 'ebay'], '1099-B': ['1099-b', 'brokerage', 'stocks', 'sold', 'sales'],
  '1099-OID': ['1099-oid', 'bond', 'discount'], '1099-SA': ['1099-sa', 'hsa'], '1099-Q': ['1099-q', '529'], 'SSA-1099': ['ssa-1099', 'social security'],
  '1098': ['1098', 'mortgage'], '1098-T': ['1098-t', 'tuition'], '1098-E': ['1098-e', 'student loan'], '1095-A': ['1095-a', 'marketplace', 'healthcare.gov'], 'K-1': ['k-1', 'k1', 'partnership'],
};

/** Words a client uses for the forms whose answers the client gives. */
const FORM_SUBJECT: Record<ChoiceTool, string[]> = {
  add_1099_q: ['529', '1099-q', 'tuition', 'college', 'education'],
  add_1099_sa: ['hsa', 'msa', '1099-sa', 'medical'],
  add_education_expense: ['1098-t', 'tuition', 'college', 'school'],
  add_1099_s: ['1099-s', 'home', 'house', 'sale', 'sold'],
};

export function generateClientQuestions(input: ClientQuestionInputs): ClientQuestion[] {
  const { facts, taxYear: year } = input;
  const out: ClientQuestion[] = [];

  for (const m of input.missingDocuments ?? []) {
    if (m.status !== 'possibly_missing') continue;
    const words = DOCUMENT_WORDS[m.formType];
    out.push({
      id: `document:${m.id}`, kind: 'yes_no',
      subjectName: m.issuer ?? `Form ${m.formType}`,
      subjectWords: [...issuerWords(m.issuer), ...DOCUMENT_SUBJECT[m.formType]],
      text: m.issuer
        ? `Did you receive ${article(words)} ${words} (Form ${m.formType}) from ${m.issuer} for ${year}?`
        : `Did you receive any ${words} (Form ${m.formType}) for ${year}?`,
      target: { kind: 'document', formType: m.formType, ...(m.issuer ? { issuer: m.issuer } : {}) },
    });
  }

  if (!input.filingStatus) {
    out.push({ id: 'filing-status', kind: 'filing_status', text: FILING_STATUS_TEXT(year), target: { kind: 'filing_status' } });
  }

  for (const person of resolveDependents(facts, year)) {
    const { firstName, lastName, ssnLastFour } = person.fields;
    // Someone the evidence cannot name, or whose records disagree, is the preparer's to sort out.
    if (!firstName || !lastName || person.problems.length > 0 || person.conflicts.length > 0) continue;
    const subject: DependentSubject = { firstName, lastName, ...(ssnLastFour ? { ssnLastFour } : {}) };
    const key = person.formKeys[0]!;
    if (person.missing.includes('relationship')) {
      out.push({
        id: `dependent:${key}:relationship`, kind: 'relationship', subjectName: firstName, subjectWords: [firstName.toLowerCase()],
        text: `How is ${firstName} ${lastName} related to you?`,
        target: { kind: 'dependent', field: 'relationship', person: subject },
      });
    }
    if (person.missing.includes('monthsLivedWithYou')) {
      out.push({
        id: `dependent:${key}:months`, kind: 'months', subjectName: firstName, subjectWords: [firstName.toLowerCase()], max: 12,
        text: `How many months of ${year} did ${firstName} live with you?`,
        target: { kind: 'dependent', field: 'monthsLivedWithYou', person: subject },
      });
    }
  }

  for (const state of resolveStateResidency(facts)) {
    if (state.conflicts.length > 0) continue;
    const name = getStateName(state.stateCode);
    if (!state.residencyType) {
      out.push({
        id: `residency:${state.stateCode}:type`, kind: 'residency', subjectName: name, subjectWords: [name.toLowerCase()],
        text: `Did you live in ${name} for all of ${year}, for part of ${year}, or not at all?`,
        target: { kind: 'residency', field: 'residencyType', stateCode: state.stateCode },
      });
    } else if (state.residencyType === ('part_year' satisfies ResidencyType) && state.daysLivedInState === undefined) {
      out.push({
        id: `residency:${state.stateCode}:days`, kind: 'days', max: 366, subjectName: name, subjectWords: [name.toLowerCase()],
        text: `How many days of ${year} did you live in ${name}?`,
        target: { kind: 'residency', field: 'daysLivedInState', stateCode: state.stateCode },
      });
    }
  }

  for (const [tool, fields] of Object.entries(FORM_QUESTIONS) as Array<[ChoiceTool, NonNullable<(typeof FORM_QUESTIONS)[ChoiceTool]>]>) {
    for (const [formKey, formFacts] of choiceForms(facts, tool)) {
      const built = buildChoiceItem(tool, formFacts);
      if (built.state !== 'needs_answer') continue;
      const v = formFieldValues(formFacts);
      const payer = firstLine(v.get('payerName')) ?? firstLine(v.get('filerName')) ?? firstLine(v.get('institutionName'));
      const context: FormContext = {
        year,
        from: payer ? ` from ${payer}` : '',
        student: firstLine(v.get('studentName')) ?? 'the student',
      };
      for (const field of built.missing) {
        const ask = fields[field];
        if (!ask) continue;
        out.push({
          id: `form:${formKey}:${field}`, kind: ask.kind, text: ask.text(context),
          subjectName: payer ?? FORM_SUBJECT[tool][0]!,
          subjectWords: [...issuerWords(payer), ...FORM_SUBJECT[tool], ...(tool === 'add_education_expense' && context.student !== 'the student' ? [context.student.split(' ')[0]!.toLowerCase()] : [])],
          target: { kind: 'form', tool, formKey, field },
          ...(ask.max ? { max: ask.max } : {}),
        });
      }
    }
  }
  return out;
}

const FORM_LABELS: Record<string, string> = {
  add_w2: 'W-2', add_w2c: 'W-2c', add_1099_int: '1099-INT', add_1099_div: '1099-DIV', add_1099_nec: '1099-NEC',
  add_1099_r: '1099-R', add_ssa_1099: 'SSA-1099', add_mortgage_interest: '1098', add_education_expense: '1098-T',
  add_1099_misc: '1099-MISC', add_1099_g: '1099-G', add_1099_b: '1099-B', add_1099_k: '1099-K', add_1099_oid: '1099-OID',
  add_1099_c: '1099-C', add_1099_q: '1099-Q', add_1099_sa: '1099-SA', add_1099_s: '1099-S',
};

const ISSUER_FIELDS = ['employerName', 'payerName', 'filerName', 'institutionName', 'lenderName', 'platformName', 'brokerName'];

/** "your W-2 from Riverbend Logistics LLC" for each tax form on the case, in the order received. */
export function receivedForms(facts: readonly TaxFact[]): string[] {
  const byForm = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (f.sourceKind && f.sourceKind !== 'document') continue;
    byForm.set(formKeyOf(f), [...(byForm.get(formKeyOf(f)) ?? []), f]);
  }
  const out: string[] = [];
  for (const formFacts of byForm.values()) {
    const tool = formToolOfFacts(formFacts);
    const label = tool ? FORM_LABELS[tool] : undefined;
    if (!label) continue;
    const v = formFieldValues(formFacts);
    const issuer = ISSUER_FIELDS.map((k) => firstLine(v.get(k))).find(Boolean);
    out.push(`your ${label}${issuer ? ` from ${issuer}` : ''}`);
  }
  return out;
}

const joinList = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The message for the client (work order §24): what has arrived, then only the open questions. */
export function clientQuestionLetter(questions: readonly ClientQuestion[], facts: readonly TaxFact[]): string {
  const received = receivedForms(facts);
  const lines: string[] = [];
  if (received.length > 0) lines.push(`We have ${joinList(received)}.`, '');
  if (questions.length === 0) {
    lines.push('We have everything we need for now.');
  } else {
    lines.push('We still need to confirm:', '');
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`));
  }
  return lines.join('\n');
}
