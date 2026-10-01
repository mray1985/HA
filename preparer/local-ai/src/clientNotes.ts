/**
 * Client notes (work order §25): what a client writes that answers no open
 * question — "we had a baby girl, Lily Lee, born March 3, 2025", "I moved
 * from Texas to Louisiana in June", "I paid the IRS $1,500 in estimated tax
 * on April 15, 2025".
 *
 * The reader model lists, under one small grammar per kind, the new
 * dependents, state moves and estimated payments a note states, each with the
 * words that state it. Every value is then checked against those words:
 * a value the words do not give is dropped (the fact stays unknown and is
 * asked for), and a proposal whose core fact the words do not give is
 * rejected. What survives is a proposed record-tool call that the preparer
 * accepts or dismisses — a note is never recorded unseen.
 */

import { getStateName } from '@hatax/engine';
import { clientAnswerPrompt, clientAnswerSchema, readAnswerFromWords, sentenceAround } from './clientAnswers.js';
import { NOT_STATED } from './groundedToolCall.js';
import type { ClientQuestion } from './clientQuestions.js';
import { formKeyOf } from './factValidation.js';
import { resolveDependents, resolveStateResidency } from './recordResolution.js';
import type { TaxFact } from './taxFact.js';
import {
  DEPENDENT_RELATIONSHIPS,
  ESTIMATED_PAYMENT_JURISDICTIONS,
  factPrefixOf,
  invokeTaxTool,
  US_STATE_CODES,
} from './taxTools.js';
import type { JsonSchema } from './toolDefinitions.js';

export type NoteKind = 'dependents' | 'states' | 'payments';
export const NOTE_KINDS: readonly NoteKind[] = ['dependents', 'states', 'payments'];

export type NoteTool = 'add_dependent' | 'set_state_residency' | 'add_estimated_payment';

export interface NoteProposal {
  tool: NoteTool;
  /** Only values the client's words give. */
  args: Record<string, unknown>;
  /** The words the model gave for it, and their whole sentence. */
  quote: string;
  sentence: string;
  /** Values the model gave that the words do not; they stay unknown. */
  dropped: string[];
}

export interface NoteRejection {
  tool: NoteTool;
  reason: string;
  quote?: string;
}

export interface NoteReading {
  proposals: NoteProposal[];
  rejected: NoteRejection[];
}

// ─── Grammar and prompt ──────────────────────────────────────

const DATE_OR_BLANK = '^(|[0-9]{4}-[0-9]{2}-[0-9]{2})$';
const text = (maxLength: number): JsonSchema => ({ type: 'string', maxLength });

/** What the model lists from a note. States are asked one at a time instead (noteCalls). */
type ListKind = Exclude<NoteKind, 'states'>;

const LISTS: Record<ListKind, { key: string; item: JsonSchema; instruction: string }> = {
  dependents: {
    key: 'people',
    item: {
      type: 'object', additionalProperties: false,
      required: ['quote', 'firstName', 'lastName', 'relationship', 'dateOfBirth'],
      properties: {
        quote: text(300), firstName: text(40), lastName: text(40),
        relationship: { type: 'string', enum: [...DEPENDENT_RELATIONSHIPS, ''] },
        dateOfBirth: { type: 'string', pattern: DATE_OR_BLANK },
      },
    },
    instruction: 'List each child or relative the note says is new in the household or was born or adopted (first name, last name, relationship to the client, date of birth as YYYY-MM-DD). Leave a field "" when the note does not give it.',
  },
  payments: {
    key: 'payments',
    item: {
      type: 'object', additionalProperties: false,
      required: ['quote', 'jurisdiction', 'amount', 'datePaid'],
      properties: {
        quote: text(300),
        jurisdiction: { type: 'string', enum: [...ESTIMATED_PAYMENT_JURISDICTIONS] },
        amount: { type: 'string', pattern: '^[0-9]{1,9}(\\.[0-9]{1,2})?$' },
        datePaid: { type: 'string', pattern: DATE_OR_BLANK },
      },
    },
    instruction: 'List each estimated tax payment the note says the client made: to the IRS ("federal") or to a state (its two-letter code: "the state of Ohio" is OH), the amount in digits, and the date paid as YYYY-MM-DD or "".',
  },
};

export function noteSchema(kind: ListKind): JsonSchema {
  const { key, item } = LISTS[kind];
  return { type: 'object', additionalProperties: false, required: [key], properties: { [key]: { type: 'array', maxItems: 4, items: item } } };
}

export function notePrompt(kind: ListKind, note: string, taxYear: number): string {
  return [
    `A client of a tax preparer wrote this note about their ${taxYear} taxes:`,
    '"""',
    note.trim(),
    '"""',
    '',
    LISTS[kind].instruction,
    "For each, copy into \"quote\" the note's own words that state it. Give an empty list when the note states none.",
  ].join('\n');
}

// ─── The client's own words ──────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Calendar dates written with their year in the words, as YYYY-MM-DD. */
export function datesIn(words: string): string[] {
  const t = words.toLowerCase();
  const out = new Set<string>();
  const add = (y: number, m: number, d: number) => {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso) out.add(iso);
  };
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    add(Number(m[3]), MONTHS.findIndex((name) => name.startsWith(m[1]!.slice(0, 3))) + 1, Number(m[2]));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) add(Number(m[3]), Number(m[1]), Number(m[2]));
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  return [...out];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name written capitalized as a word in the client's words. */
function namedIn(name: string, words: string): boolean {
  if (!/^[A-Za-z][A-Za-z'-]{1,39}$/.test(name)) return false;
  return new RegExp(`(^|[^A-Za-z])${escape(name[0]!.toUpperCase() + name.slice(1))}(?![A-Za-z])`).test(words);
}

/** Words that are not a person's first name. */
const NOT_A_NAME = new Set(['baby', 'son', 'daughter', 'mom', 'dad', 'mother', 'father', 'grandma', 'grandpa', 'the', 'my', 'our', 'he', 'she', 'we', 'i', 'hi', 'hello', 'thanks', 'irs']);

/** The note says a person joined the household. */
const JOINED = /\b(born|baby|newborn|adopted|adopt|had a|gave birth|welcomed|moved in with (us|me)|lives? with (us|me)|lived with (us|me)|living with (us|me)|dependent)\b/;

/** Capitalized words that are not people: the reader, months, sentence openers. */
const NOT_A_PERSON = new Set([
  ...NOT_A_NAME, ...MONTHS, 'our', 'we', "i'm", 'ssn', 'also', 'and', 'but', 'so', 'it', 'this', 'that', 'they', 'please', 'dear', 'thank', 'yes', 'no',
]);

/** The people the note names: its capitalized words, lowercased, that are not other words or states. */
function peopleNamedIn(note: string): Set<string> {
  const states = new Set(STATES.flatMap((st) => st.name.split(' ')));
  return new Set((note.match(/\b[A-Z][a-z'-]+\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !NOT_A_PERSON.has(w) && !states.has(w)));
}

/** Whether the words from the person's last mention before `at` up to `at` name no one else. */
function onlyThisPersonBefore(firstName: string, lastName: string, sentence: string, at: number, people: Set<string>): boolean {
  const before = sentence.slice(0, at);
  const mentions = [...before.matchAll(new RegExp(`(?<![a-z])${escape(firstName.toLowerCase())}(?![a-z])`, 'g'))];
  const last = mentions[mentions.length - 1];
  if (!last) return false;
  const own = new Set([firstName.toLowerCase(), lastName.toLowerCase()].filter(Boolean));
  const between = before.slice(last.index! + firstName.length).match(/[a-z][a-z'-]+/g) ?? [];
  return !between.some((w) => people.has(w) && !own.has(w));
}

/** The date the words say this person was born ("Noah Okafor (born April 12, 2016"), with no one else named in between. */
function birthDateOf(firstName: string, lastName: string, sentence: string, people: Set<string>): string | undefined {
  for (const m of sentence.matchAll(/\bborn\b(?:\s+on)?\s+([^()]*?\b\d{4}\b)/g)) {
    const dates = datesIn(m[1]!);
    if (dates.length === 1 && onlyThisPersonBefore(firstName, lastName, sentence, m.index!, people)) return dates[0];
  }
  return undefined;
}

/** "Marcus lived with me all year": the whole year in the home, said of this person. */
const LIVED_ALL_YEAR = /\blived with (me|us) (all year|all of the year|the whole year|the entire year|all of \d{4}|for the whole year|for the entire year)\b/g;

const question = (kind: ClientQuestion['kind'], stateCode = ''): ClientQuestion => ({
  id: kind, kind, text: '', target: kind === 'residency' ? { kind: 'residency', field: 'residencyType', stateCode } : { kind: 'filing_status' },
});

const STATES = US_STATE_CODES.map((code) => ({ code, name: getStateName(code).toLowerCase() }));

/** States the words name in full ("Louisiana"); two-letter codes are also words ("in", "or", "me"). */
function statesNamedIn(words: string): string[] {
  const t = words.toLowerCase();
  return STATES.filter((s) => new RegExp(`\\b${s.name}\\b`).test(t)).map((s) => s.code);
}

/** "moved from Texas to Louisiana": the states a move leaves and reaches are part-year. */
function movedStates(words: string): string[] {
  const t = words.toLowerCase();
  if (!/\b(moved|relocated)\b/.test(t) || /\b(never|didn't|did not|haven't|have not) (moved|relocated)\b/.test(t)) return [];
  return STATES.filter((s) => new RegExp(`\\b(from|to|out of|into|away from|back to)( the state of)? ${s.name}\\b`).test(t)).map((s) => s.code);
}

// ─── Checking the model's list ───────────────────────────────

function checkDependent(item: Record<string, unknown>, sentence: string, words: string): NoteProposal | NoteRejection {
  const people = peopleNamedIn(words);
  const quote = String(item.quote ?? '');
  const firstName = String(item.firstName ?? '').trim();
  if (!firstName || NOT_A_NAME.has(firstName.toLowerCase()) || !namedIn(firstName, words) || !new RegExp(`\\b${escape(firstName.toLowerCase())}\\b`).test(sentence)) {
    return { tool: 'add_dependent', reason: `the note does not name "${firstName || 'anyone'}" in the words given`, quote };
  }
  const args: Record<string, unknown> = { firstName };
  const dropped: string[] = [];
  const lastName = String(item.lastName ?? '').trim();
  if (lastName) {
    if (namedIn(lastName, words) && new RegExp(`\\b${escape(lastName.toLowerCase())}\\b`).test(sentence)) args.lastName = lastName;
    else dropped.push('lastName');
  }
  const relationship = String(item.relationship ?? '');
  const stated = readAnswerFromWords(question('relationship'), sentence);
  if (relationship) {
    if (stated === relationship) args.relationship = relationship;
    else dropped.push('relationship');
  }
  const birth = String(item.dateOfBirth ?? '');
  if (birth) {
    // The date said of this person: in "Ben and I (Cara, born July 19, 1988)" it is not Ben's.
    if (birthDateOf(firstName, lastName, sentence, people) === birth) args.dateOfBirth = birth;
    else dropped.push('dateOfBirth');
  }
  for (const m of sentence.matchAll(LIVED_ALL_YEAR)) {
    if (onlyThisPersonBefore(firstName, lastName, sentence, m.index!, people)) args.monthsLivedWithYou = 12;
  }
  if (args.relationship === undefined && !JOINED.test(sentence)) {
    return { tool: 'add_dependent', reason: `the note does not say ${firstName} is a dependent or joined the household`, quote };
  }
  return { tool: 'add_dependent', args, quote, sentence, dropped };
}

function checkState(item: Record<string, unknown>, sentence: string, words: string): NoteProposal | NoteRejection {
  const quote = String(item.quote ?? '');
  const code = String(item.stateCode ?? '');
  const type = String(item.residencyType ?? '');
  const named = statesNamedIn(sentence);
  if (!named.includes(code)) return { tool: 'set_state_residency', reason: `the words do not name ${getStateName(code)}`, quote };
  const moved = movedStates(sentence);
  const stated = moved.length > 0 ? (moved.includes(code) ? 'part_year' : null) : readAnswerFromWords(question('residency', code), sentence);
  if (stated !== type) {
    return { tool: 'set_state_residency', reason: `the model read ${type.replace('_', '-')} for ${getStateName(code)} but the words state ${stated ? String(stated).replace('_', '-') : 'nothing plain'}`, quote };
  }
  return { tool: 'set_state_residency', args: { stateCode: code, residencyType: type }, quote, sentence, dropped: [] };
}

function checkPayment(item: Record<string, unknown>, sentence: string): NoteProposal | NoteRejection {
  const quote = String(item.quote ?? '');
  if (!/\b(estimated|estimate|quarterly|1040-?es|installment|q[1-4])\b/.test(sentence)) {
    return { tool: 'add_estimated_payment', reason: 'the words do not say it was an estimated tax payment', quote };
  }
  if (/\b(each|two|three|four|both|twice|all four)\b/.test(sentence)) {
    return { tool: 'add_estimated_payment', reason: 'the words give more than one payment together; each is entered from its own record', quote };
  }
  const amount = Number(item.amount);
  // "estimated tax" and "Q3 estimate" name the payment; they are not the client estimating.
  const named = sentence.replace(/\bestimated (tax|taxes|payments?)\b/g, 'quarterly $1').replace(/\b(q[1-4] )?estimates?\b(?= (of|payment|to|for)\b)/g, 'quarterly payment');
  const stated = readAnswerFromWords(question('amount'), named);
  if (stated !== amount) return { tool: 'add_estimated_payment', reason: `the model read ${amount} but the words state ${stated ?? 'no single amount'}`, quote };
  const states = statesNamedIn(sentence);
  const federal = /\b(irs|federal)\b/.test(sentence);
  const jurisdiction = federal && states.length === 0 ? 'federal' : !federal && states.length === 1 ? states[0] : null;
  if (jurisdiction !== item.jurisdiction) {
    return { tool: 'add_estimated_payment', reason: `the words do not say it was paid to ${item.jurisdiction === 'federal' ? 'the IRS' : getStateName(String(item.jurisdiction))}`, quote };
  }
  const args: Record<string, unknown> = { jurisdiction, amount };
  const dropped: string[] = [];
  const date = String(item.datePaid ?? '');
  if (date) {
    const dates = datesIn(sentence);
    if (dates.length === 1 && dates[0] === date) args.datePaid = date;
    else dropped.push('datePaid');
  }
  return { tool: 'add_estimated_payment', args, quote, sentence, dropped };
}

const TOOL_OF: Record<ListKind, NoteTool> = { dependents: 'add_dependent', payments: 'add_estimated_payment' };

/**
 * Check each item the model listed against the note's words. Returns the
 * proposals the words support (with unsupported values dropped) and the
 * items rejected, with the reason.
 */
export function confirmNoteProposals(kind: ListKind, note: string, modelOutput: unknown, taxYear: number): NoteReading {
  let out = modelOutput;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return { proposals: [], rejected: [{ tool: TOOL_OF[kind], reason: 'the model gave no usable list' }] };
    }
  }
  const items = (out as Record<string, unknown> | null)?.[LISTS[kind].key];
  if (!Array.isArray(items)) return { proposals: [], rejected: [{ tool: TOOL_OF[kind], reason: 'the model gave no usable list' }] };

  const reading: NoteReading = { proposals: [], rejected: [] };
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const sentence = typeof item.quote === 'string' ? sentenceAround(note, item.quote) : null;
    if (!sentence) {
      reading.rejected.push({ tool: TOOL_OF[kind], reason: 'the words the model quoted are not in the note', ...(typeof item.quote === 'string' ? { quote: item.quote } : {}) });
      continue;
    }
    const checked = kind === 'dependents' ? checkDependent(item, sentence, note) : checkPayment(item, sentence);
    if (!('args' in checked)) {
      reading.rejected.push(checked);
      continue;
    }
    addChecked(reading, checked, taxYear);
  }
  return reading;
}

/** A checked proposal, once the tool's own schema accepts it (it has the last word before a preparer sees it). */
function addChecked(reading: NoteReading, checked: NoteProposal, taxYear: number): void {
  const valid = invokeTaxTool({ tool: checked.tool, args: checked.args, context: { returnId: 'check', taxYear, sourceDocumentId: 'check', sourceFileName: 'check', extractor: 'check' } });
  if (!valid.ok) reading.rejected.push({ tool: checked.tool, reason: valid.error, quote: checked.quote });
  else if (!reading.proposals.some((p) => p.tool === checked.tool && JSON.stringify(p.args) === JSON.stringify(checked.args))) reading.proposals.push(checked);
}

// ─── The calls for one note ──────────────────────────────────

/** One model call for a note. */
export interface NoteCall {
  kind: NoteKind;
  prompt: string;
  /** Name of the JSON schema (for the grammar). */
  name: string;
  schema: JsonSchema;
  /** For a state the note names: the residency question asked of the note. */
  question?: ClientQuestion;
}

/**
 * The calls that read a note: a list of new dependents, a list of estimated
 * payments, and for each state the note names, its residency question — the
 * reader lists states poorly from 51 codes (it gave an empty list for "I moved
 * from Texas to Louisiana") but answers a question about one named state.
 */
export function noteCalls(note: string, taxYear: number): NoteCall[] {
  const calls: NoteCall[] = (['dependents', 'payments'] as const).map((kind) => ({ kind, prompt: notePrompt(kind, note, taxYear), name: 'note', schema: noteSchema(kind) }));
  for (const code of statesNamedIn(note)) {
    const q: ClientQuestion = {
      id: `note-residency:${code}`, kind: 'residency',
      text: `Did you live in ${getStateName(code)} for all of ${taxYear}, for part of ${taxYear}, or not at all?`,
      target: { kind: 'residency', field: 'residencyType', stateCode: code },
    };
    calls.push({ kind: 'states', prompt: clientAnswerPrompt(q, note), name: 'answer', schema: clientAnswerSchema(q), question: q });
  }
  return calls;
}

/** Check one call's output against the note's words. */
export function confirmNoteCall(call: NoteCall, note: string, modelOutput: unknown, taxYear: number): NoteReading {
  if (call.kind !== 'states' || !call.question || call.question.target.kind !== 'residency') {
    return confirmNoteProposals(call.kind as ListKind, note, modelOutput, taxYear);
  }
  const code = call.question.target.stateCode;
  let out = modelOutput;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return { proposals: [], rejected: [{ tool: 'set_state_residency', reason: 'the model gave no usable answer' }] };
    }
  }
  const { quote, answer } = (out ?? {}) as { quote?: unknown; answer?: unknown };
  if (answer === NOT_STATED) return { proposals: [], rejected: [] };
  const sentence = typeof quote === 'string' ? sentenceAround(note, quote) : null;
  if (!sentence || typeof answer !== 'string') {
    return { proposals: [], rejected: [{ tool: 'set_state_residency', reason: 'the words the model quoted are not in the note', ...(typeof quote === 'string' ? { quote } : {}) }] };
  }
  const checked = checkState({ quote, stateCode: code, residencyType: answer }, sentence, note);
  const reading: NoteReading = { proposals: [], rejected: [] };
  if ('args' in checked) addChecked(reading, checked, taxYear);
  else reading.rejected.push(checked);
  return reading;
}

/**
 * Whether the case already holds everything a proposal would record (a reply
 * that answered an open question about the same person), so it is not
 * offered again.
 */
export function proposalIsKnown(proposal: NoteProposal, facts: readonly TaxFact[], taxYear: number): boolean {
  const a = proposal.args;
  if (proposal.tool === 'add_dependent') {
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    return resolveDependents(facts, taxYear).some((d) =>
      norm(d.fields.firstName) === norm(a.firstName) &&
      Object.entries(a).every(([k, v]) => norm((d.fields as Record<string, unknown>)[k]) === norm(v)));
  }
  if (proposal.tool === 'set_state_residency') {
    return resolveStateResidency(facts).some((s) => s.stateCode === a.stateCode && s.residencyType === a.residencyType);
  }
  const payments = new Map<string, Map<string, unknown>>();
  for (const f of facts) {
    if (!f.factType.startsWith(factPrefixOf('add_estimated_payment')) || f.status !== 'extracted') continue;
    const key = formKeyOf(f);
    payments.set(key, (payments.get(key) ?? new Map()).set(f.sourceField, f.value));
  }
  return [...payments.values()].some((p) => p.get('jurisdiction') === a.jurisdiction && p.get('amount') === a.amount && (a.datePaid === undefined || p.get('datePaid') === a.datePaid));
}

/** A proposed dependent who is the taxpayer or the spouse on the case: never offered. */
export function namesSomeoneOnTheReturn(proposal: NoteProposal, people: ReadonlyArray<{ firstName?: string; lastName?: string }>): boolean {
  if (proposal.tool !== 'add_dependent') return false;
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const first = norm(proposal.args.firstName);
  const last = norm(proposal.args.lastName);
  return people.some((p) => norm(p.firstName) !== '' && norm(p.firstName) === first && (!last || !norm(p.lastName) || norm(p.lastName) === last));
}

/** The proposal as the preparer reads it before accepting it. */
export function describeNoteProposal(p: NoteProposal): string {
  const a = p.args;
  if (p.tool === 'add_dependent') {
    const name = [a.firstName, a.lastName].filter(Boolean).join(' ');
    const extra = [a.relationship ? String(a.relationship).toLowerCase() : null, a.dateOfBirth ? `born ${String(a.dateOfBirth)}` : null].filter(Boolean);
    return `Add ${name} as a dependent${extra.length ? ` (${extra.join(', ')})` : ''}`;
  }
  if (p.tool === 'set_state_residency') {
    const type = a.residencyType === 'part_year' ? 'part-year resident' : a.residencyType === 'nonresident' ? 'nonresident' : 'resident all year';
    return `${getStateName(String(a.stateCode))}: ${type}`;
  }
  const payee = a.jurisdiction === 'federal' ? 'the IRS' : getStateName(String(a.jurisdiction));
  const amount = Number(a.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return `Estimated tax payment of ${amount} to ${payee}${a.datePaid ? ` on ${String(a.datePaid)}` : ''}`;
}
