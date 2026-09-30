/**
 * Reading a client's reply (work order §25).
 *
 * The local model answers one open question at a time under a JSON grammar:
 * the words of the reply that answer it ("quote") and the answer, from the
 * values the question allows or "not_stated". A value is recorded only when a
 * deterministic reading of the client's own words gives the same value:
 *
 *   - the quoted words must be in the reply, and they are read in their whole
 *     sentence, so "did not live with me all year" is never read as 12 months;
 *   - hedged words ("I think", "about $4,000") state nothing;
 *   - a sentence with two different answers, or about a different person or
 *     state than the question, states nothing;
 *   - every disagreement between the model and the words records nothing and
 *     leaves the question to the preparer.
 *
 * This is the measured filing-status pattern (groundedToolCall.ts) applied to
 * every question clientQuestions.ts can ask.
 */

import { getStateName } from '@hatax/engine';
import type { ClientQuestion } from './clientQuestions.js';
import { filingStatusFromClientWords, FILING_STATUS_ANSWER_PROMPT, NOT_STATED } from './groundedToolCall.js';
import type { ChoiceTool } from './preparerChoices.js';
import { parseMoneyToken } from './structuredExtraction.js';
import { DEPENDENT_RELATIONSHIPS, FILING_STATUS_CANDIDATES, RESIDENCY_TYPES, US_STATE_CODES, type DependentRelationship } from './taxTools.js';
import type { JsonSchema } from './toolDefinitions.js';

export type ClientAnswerValue = number | string | boolean;

// ─── Grammar and prompt ──────────────────────────────────────

function answerProperty(q: ClientQuestion): JsonSchema {
  const choices = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values, NOT_STATED] });
  switch (q.kind) {
    case 'months':
      return choices(Array.from({ length: (q.max ?? 12) + 1 }, (_, i) => String(i)));
    case 'days':
      return { type: 'string', pattern: `^(${NOT_STATED}|[0-9]{1,3})$` };
    case 'amount':
      return { type: 'string', pattern: `^(${NOT_STATED}|[0-9]{1,9}(\\.[0-9]{1,2})?)$` };
    case 'relationship':
      return choices(DEPENDENT_RELATIONSHIPS);
    case 'residency':
      return choices(RESIDENCY_TYPES);
    case 'yes_no':
      return choices(['yes', 'no']);
    case 'filing_status':
      return choices(FILING_STATUS_CANDIDATES);
  }
}

/** JSON grammar for one question: the words first, then the answer. */
export function clientAnswerSchema(q: ClientQuestion): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['quote', 'answer'],
    properties: {
      quote: { type: 'string', maxLength: 400 },
      answer: answerProperty(q),
    },
  };
}

const KIND_INSTRUCTIONS: Record<ClientQuestion['kind'], string> = {
  months: 'answer: the number of months the reply states. "All year" means 12.',
  days: 'answer: the number of days the reply states, digits only.',
  amount: 'answer: the dollar amount the reply states, digits only (for example 4500.00).',
  relationship: 'answer: the relationship the reply states, as one of the allowed terms.',
  residency: 'answer: "resident" if the client lived there all year, "part_year" if they moved in or out during the year, "nonresident" if they did not live there.',
  yes_no: 'answer: "yes" or "no", as the reply states.',
  filing_status: `answer: the filing status the client states.\n${FILING_STATUS_ANSWER_PROMPT}`,
};

/** The instruction paired with clientAnswerSchema. */
export function clientAnswerPrompt(q: ClientQuestion, reply: string): string {
  return [
    'A tax preparer asked the client this question:',
    `"${q.text}"`,
    '',
    'The client replied:',
    '"""',
    reply.trim(),
    '"""',
    '',
    "quote: copy, exactly as written, the words of the reply that answer this question (the client's words, not your answer).",
    'A number that only numbers an item of a list (1., 2.) is not an answer.',
    KIND_INSTRUCTIONS[q.kind],
    `If the reply does not answer this question, the client is unsure, or only estimates, answer "${NOT_STATED}" with an empty quote.`,
  ].join('\n');
}

// ─── The client's own words ──────────────────────────────────

const norm = (s: string) =>
  s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Uncertain words state nothing: an estimate is not a fact. */
const HEDGE = /\b(i think|i believe|i guess|maybe|probably|possibly|perhaps|not sure|unsure|don't know|do not know|don't remember|do not remember|can't remember|cannot remember|not certain|about|around|roughly|approximately|approx|estimated?|or so|give or take|ballpark|let me check|need to check|i'll check|will check|find out|to be confirmed)\b|-ish\b/;

const NEGATION = /(\bnot\b|\bnever\b|\bno\b|n't\b)/;

/** Words that make a full-year phrase something less than the whole year. */
const QUALIFIER_AFTER = /^[^.;!?]{0,30}?\b(except|apart from|other than|besides|minus|but|until|till|from|since|after|before)\b/;

/** Words before a count that make it inexact ("more than 6 months"). */
const INEXACT_BEFORE = /\b(more than|over|at least|less than|fewer than|under|almost|nearly|up to|only about|like|close to|just over|just under)\s*$/;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const toCount = (word: string) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]);

const OTHER_HOME = /\b(with|at) (her|his|their|my ex'?s?|the other) (\w+ )?(mom|mother|dad|father|parents?|grandparents?|grandma|grandpa|grandmother|grandfather|aunt|uncle|family|boyfriend|girlfriend|husband|wife)\b|\bwith my (ex|parents|mom|mother|dad|father)\b/;

const TEMPORARY_ABSENCE = /\b(hospital|hospitali[sz]ed|college|university|school|dorm|camp|deployed|deployment|military|boot camp|jail|juvenile|detention|rehab|treatment)\b/;

const FULL_YEAR = /\b(all year( long)?|the (whole|entire|full) year|(whole|entire|full) year|all of (the year|\d{4})|year[- ]round|every month|the whole time|all twelve months|all 12 months)\b/g;

/** The text of the clause before `index` (back to the last punctuation or "but"). */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 60), index);
  return before.split(/[.;!?,]|\bbut\b/).pop() ?? '';
}

type Cues = { values: Set<string>; unclear: boolean };

function fullYearCues(t: string, value: string, cues: Cues): void {
  for (const m of t.matchAll(FULL_YEAR)) {
    if (NEGATION.test(clauseBefore(t, m.index!)) || QUALIFIER_AFTER.test(t.slice(m.index! + m[0].length))) cues.unclear = true;
    else cues.values.add(value);
  }
}

function single(cues: Cues): string | null {
  return !cues.unclear && cues.values.size === 1 ? [...cues.values][0]! : null;
}

function readMonths(t: string, max: number): number | null {
  const cues: Cues = { values: new Set(), unclear: false };
  fullYearCues(t, String(Math.min(12, max)), cues);
  for (const m of t.matchAll(/\b(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:full\s+|whole\s+)?months?\b/g)) {
    const n = toCount(m[1]!);
    if (n === undefined || n > max || INEXACT_BEFORE.test(t.slice(0, m.index!))) cues.unclear = true;
    else cues.values.add(String(n));
  }
  if (/\bhalf (of )?the year\b|\b(most|part|some) of the year\b|\bsince\b|\buntil\b|\bmoved\b/.test(t)) cues.unclear = true;
  // "She didn't live with me" / "none" — only when nothing in the clause gives a duration.
  for (const m of t.matchAll(/\b(?:did not|didn't|does not|doesn't|never)\s+(?:live|lived|stay|stayed)\s+with\s+(?:me|us)\b([^.;!?,]*)/g)) {
    if (/\b(year|month|months|all|whole|entire|full|half|summer|winter|spring|fall|week|weeks|until|since|except|most)\b/.test(m[1]!)) cues.unclear = true;
    else cues.values.add('0');
  }
  if (/^none\b|\bnone of the year\b|\bnot at all\b/.test(t)) cues.values.add('0');
  // "She lived with her grandparents all year" is time in another home, not with the client.
  if (OTHER_HOME.test(t) && [...cues.values].some((v) => v !== '0')) cues.unclear = true;
  // A temporary absence (school, hospital, camp, service) counts as time at home
  // (Pub. 501): how many months that makes is the preparer's call, not the words'.
  if (TEMPORARY_ABSENCE.test(t)) cues.unclear = true;
  // "10 months, she was in the hospital for 2": another count beside the months.
  const counted = new Set([...t.matchAll(/\b(\d{1,2})\s+(?:full\s+|whole\s+)?months?\b|\ball (\d{1,2}) months\b/g)].map((m) => m.index));
  for (const m of t.matchAll(/\b\d{1,3}\b/g)) {
    if (!counted.has(m.index) && !/^\s*(?:full\s+|whole\s+)?months?\b/.test(t.slice(m.index! + m[0].length)) && !/\ball\s+$/.test(t.slice(0, m.index!))) cues.unclear = true;
  }
  const v = single(cues);
  return v === null ? null : Number(v);
}

function readDays(t: string, max: number): number | null {
  const cues: Cues = { values: new Set(), unclear: false };
  for (const m of t.matchAll(/\b(\d{1,3})\s+days?\b/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > max || INEXACT_BEFORE.test(t.slice(0, m.index!))) cues.unclear = true;
    else cues.values.add(String(n));
  }
  const v = single(cues);
  return v === null ? null : Number(v);
}

/** Relationship words, longest first so "son-in-law" is not also read as "son". */
const RELATIONSHIP_WORDS: Array<[RegExp, DependentRelationship]> = [
  [/\bson[\s-]in[\s-]law\b/g, 'Son-in-Law'], [/\bdaughter[\s-]in[\s-]law\b/g, 'Daughter-in-Law'],
  [/\bfather[\s-]in[\s-]law\b/g, 'Father-in-Law'], [/\bmother[\s-]in[\s-]law\b/g, 'Mother-in-Law'],
  [/\bbrother[\s-]in[\s-]law\b/g, 'Brother-in-Law'], [/\bsister[\s-]in[\s-]law\b/g, 'Sister-in-Law'],
  [/\bstep[\s-]?son\b/g, 'Stepson'], [/\bstep[\s-]?daughter\b/g, 'Stepdaughter'],
  [/\bstep[\s-]?brother\b/g, 'Stepbrother'], [/\bstep[\s-]?sister\b/g, 'Stepsister'],
  [/\bstep[\s-]?(mother|mom)\b/g, 'Stepmother'], [/\bstep[\s-]?(father|dad)\b/g, 'Stepfather'],
  [/\bhalf[\s-]brother\b/g, 'Half Brother'], [/\bhalf[\s-]sister\b/g, 'Half Sister'],
  [/\bfoster (child|son|daughter|kid)\b/g, 'Foster Child'],
  [/\bgrand(son|daughter|child|kid)\b/g, 'Grandchild'],
  [/\bgrand(mother|father|ma|pa|parent|mom|dad)\b|\bgranny\b/g, 'Grandparent'],
  [/\bson\b/g, 'Son'], [/\bdaughter\b/g, 'Daughter'], [/\bbrother\b/g, 'Brother'], [/\bsister\b/g, 'Sister'],
  [/\b(mother|mom|mum)\b/g, 'Mother'], [/\b(father|dad)\b/g, 'Father'], [/\bparent\b/g, 'Parent'],
  [/\bniece\b/g, 'Niece'], [/\bnephew\b/g, 'Nephew'], [/\baunt\b/g, 'Aunt'], [/\buncle\b/g, 'Uncle'],
  [/\b(not related|no relation|unrelated)\b/g, 'None (not related)'],
];

function readRelationship(t: string): DependentRelationship | null {
  const cues: Cues = { values: new Set(), unclear: false };
  let rest = t;
  for (const [re, term] of RELATIONSHIP_WORDS) {
    rest = rest.replace(re, (word, ...args) => {
      const index = args[args.length - 2] as number;
      const before = rest.slice(Math.max(0, index - 30), index);
      // "my girlfriend's son", "like a son to me", "not my son": not the client's relationship.
      if (/\b\w+(?<!\b(?:it|he|she|that|who|what|there|here))'s\s+$|s'\s+$/.test(before) || /\blike (a|an|my|our)\s+$/.test(before) || /(\bnot\b|n't\b)\s+(my|our|a|an)?\s*$/.test(before)) {
        cues.unclear = true;
      } else {
        cues.values.add(term);
      }
      return ' '.repeat(word.length);
    });
  }
  return single(cues) as DependentRelationship | null;
}

const STATE_NAMES = US_STATE_CODES.map((code) => ({ code, name: getStateName(code).toLowerCase() }));

function readResidency(t: string, stateCode: string): (typeof RESIDENCY_TYPES)[number] | null {
  // Words about another state are not about this one.
  const others = STATE_NAMES.filter((s) => s.code !== stateCode && new RegExp(`\\b${s.name}\\b`).test(t));
  if (others.length > 0) return null;
  const cues: Cues = { values: new Set(), unclear: false };
  fullYearCues(t, 'resident', cues);
  let rest = t;
  if (/\b(never|didn't|did not|haven't|have not)\s+moved?\b/.test(rest)) {
    cues.values.add('resident');
    rest = rest.replace(/\b(never|didn't|did not|haven't|have not)\s+moved?\b/g, ' ');
  }
  if (/\b(moved|relocated)\b|\bpart of (the year|\d{4})\b|\bpart[\s-]year\b|\b(half|most) of the year\b|\b(until|since|till|through) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(rest)) cues.values.add('part_year');
  if (/\b(never|didn't|did not|don't|do not)\s+(live|lived|reside|resided)\b|\bnot at all\b|\bnon[\s-]?resident\b|\bonly (worked|work|commuted)\b/.test(rest)) {
    cues.values.add('nonresident');
  }
  return single(cues) as (typeof RESIDENCY_TYPES)[number] | null;
}

/** Numbers that are not dollar amounts: counts, years, percentages. */
const NOT_MONEY_AFTER = /^\s*(months?|years?|days?|weeks?|%|percent|kids?|children|students?|credits?|hours?|classes|semesters?|times)\b/;

function readAmount(t: string): number | null {
  if (/\b\d+(\.\d+)?\s*k\b|\bthousand\b|\bgrand\b|\bhundred\b/.test(t)) return null;
  const cues: Cues = { values: new Set(), unclear: false };
  // With a dollar sign anywhere, a bare whole number is a name, not an amount ("the 529 plan",
  // "Form 1098"); a number written as money ("4,000", "950.00") still counts.
  const dollarsOnly = /\$\s?\d/.test(t);
  for (const m of t.matchAll(/(?<![\w.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?![\w%])/g)) {
    const [token, dollar, whole, cents] = m;
    if (dollarsOnly && !dollar && !cents && !whole!.includes(',')) continue;
    if (!dollar && !cents && !whole!.includes(',') && /^(19|20)\d{2}$/.test(whole!)) continue; // a year
    if (NOT_MONEY_AFTER.test(t.slice(m.index! + token.length))) continue;
    const amount = parseMoneyToken(token.replace(/\s/g, ''));
    if (amount === undefined) cues.unclear = true;
    else cues.values.add(String(amount));
  }
  if (/\b(nothing|none|zero)\b|\$0(\.00)?(?!\d)|\b(didn't|did not) (pay|spend)\b|\bno (qualified )?expenses\b/.test(t)) cues.values.add('0');
  const v = single(cues);
  return v === null ? null : Number(v);
}

function readYesNo(t: string): boolean | null {
  if (/\b(some|part|partly|partially|half|most|portion|except|but|all but|not all|not every)\b|\d/.test(t)) return null;
  const yes = /\b(yes|yeah|yep|yup|correct|absolutely|definitely|certainly|of course|affirmative)\b/.test(t);
  const no = /\b(no|nope|nah|never|none)\b|n't\b|\bnot\b/.test(t);
  if (yes === no) return null;
  return yes;
}

/**
 * The answer the client's words state, read without the model. Null when the
 * words are unsure, give two answers, or do not state one.
 */
export function readAnswerFromWords(q: ClientQuestion, words: string): ClientAnswerValue | null {
  // A list number ("1. Yes all year", "2) $3,200") numbers the answer; it is not part of it.
  const t = norm(words).replace(/^\d{1,2}[.)]\s+/, '');
  if (!t || HEDGE.test(t)) return null;
  switch (q.kind) {
    case 'months': return readMonths(t, q.max ?? 12);
    case 'days': return readDays(t, q.max ?? 366);
    case 'amount': return readAmount(t);
    case 'relationship': return readRelationship(t);
    case 'residency': return q.target.kind === 'residency' ? readResidency(t, q.target.stateCode) : null;
    case 'yes_no': return readYesNo(t);
    case 'filing_status': return filingStatusFromClientWords(words);
  }
}

// ─── Confirming the model's answer ───────────────────────────

export type ClientAnswerOutcome =
  | { status: 'answered'; value: ClientAnswerValue; quote: string; sentence: string }
  | { status: 'not_answered' }
  | { status: 'unclear'; reason: string; quote?: string };

function modelValue(q: ClientQuestion, answer: string): ClientAnswerValue | undefined {
  switch (q.kind) {
    case 'months':
    case 'days': {
      const n = Number(answer);
      return /^\d+$/.test(answer) && n <= (q.max ?? (q.kind === 'months' ? 12 : 366)) ? n : undefined;
    }
    case 'amount':
      return /^\d+(\.\d{1,2})?$/.test(answer) ? Number(answer) : undefined;
    case 'yes_no':
      return answer === 'yes' ? true : answer === 'no' ? false : undefined;
    case 'relationship':
      return (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(answer) ? answer : undefined;
    case 'residency':
      return (RESIDENCY_TYPES as readonly string[]).includes(answer) ? answer : undefined;
    case 'filing_status':
      return (FILING_STATUS_CANDIDATES as readonly string[]).includes(answer) ? answer : undefined;
  }
}

/** The reply lower-cased with its line breaks kept (they end sentences); other spacing collapsed. */
const normLines = (s: string) =>
  s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

/**
 * Whether `text[i]` ends a sentence: . ! ? ; or a line break — never the point
 * of an amount ("9,850.50") or of a list number ("1. Yes all year").
 */
function endsSentence(text: string, i: number, sentenceStart: number): boolean {
  const c = text[i];
  if (c === '!' || c === '?' || c === ';' || c === '\n') return true;
  if (c !== '.') return false;
  if (i + 1 < text.length && !/\s/.test(text[i + 1]!)) return false;
  return !/^\s*\d{1,2}$/.test(text.slice(sentenceStart, i));
}

function sentencesOf(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !endsSentence(text, i, start)) continue;
    if (text.slice(start, i).trim()) out.push({ start, end: i });
    start = i + 1;
  }
  return out;
}

const loose = (s: string) => s.replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * The whole sentence(s) of the reply that hold the quoted words, or null when
 * the words are not in the reply. Matched as written first, then ignoring
 * punctuation and "$" ("$11,480" quoted as "11480") when one sentence alone
 * holds them.
 */
export function sentenceAround(reply: string, quote: string): string | null {
  const text = normLines(reply);
  const flat = text.replace(/\n/g, ' ');
  const q = norm(quote).replace(/^["'\s]+|["'\s.,;!?]+$/g, '');
  if (!q) return null;
  const sentences = sentencesOf(text);
  const at = flat.indexOf(q);
  if (at >= 0) {
    const first = sentences.find((s) => s.end > at) ?? sentences[sentences.length - 1]!;
    const last = sentences.find((s) => s.end >= at + q.length) ?? sentences[sentences.length - 1]!;
    return flat.slice(first.start, last.end).trim();
  }
  const lq = loose(q);
  if (lq.length < 2) return null;
  const holding = sentences.filter((s) => loose(flat.slice(s.start, s.end)).includes(lq));
  return holding.length === 1 ? flat.slice(holding[0]!.start, holding[0]!.end).trim() : null;
}

const show = (v: ClientAnswerValue | null) => (v === null ? 'nothing plain' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

export interface ConfirmContext {
  /** The people the batch's other open questions are about. */
  otherNames?: readonly string[];
  /**
   * No other open question in the batch has this question's kind. Only then
   * may the words be found without the model's quote: the one sentence of the
   * reply that states an answer of this kind.
   */
  alone?: boolean;
}

const named = (name: string, text: string) => new RegExp(`\\b${name.toLowerCase().replace(/[^a-z' -]/g, '')}\\b`).test(text);

/** Why these words cannot answer for `q`'s person, or null when they can. */
function subjectProblem(q: ClientQuestion, reply: string, sentence: string, otherNames: readonly string[]): string | null {
  if (!q.subjectName) return null;
  const others = otherNames.filter((n) => norm(n) !== norm(q.subjectName!) && named(n, norm(reply)));
  if (others.length > 0 && !named(q.subjectName, sentence)) {
    return `the reply is about ${[q.subjectName, ...others].join(' and ')}, and the words that answer do not name ${q.subjectName}`;
  }
  const alsoOthers = others.filter((n) => named(n, sentence));
  return alsoOthers.length > 0 ? `the words that answer are about ${q.subjectName} and ${alsoOthers.join(' and ')} together` : null;
}

/**
 * Record a value only when the model's grammar-constrained answer and the
 * client's own words agree. A reply naming other people the open questions
 * are about must name this question's person in the words that answer it.
 */
export function confirmClientAnswer(q: ClientQuestion, reply: string, modelOutput: unknown, context: ConfirmContext = {}): ClientAnswerOutcome {
  const otherNames = context.otherNames ?? [];
  let out = modelOutput;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return { status: 'unclear', reason: 'the model gave no usable answer' };
    }
  }
  const answer = (out as { answer?: unknown } | null)?.answer;
  const quote = (out as { quote?: unknown } | null)?.quote;
  if (answer === NOT_STATED) return { status: 'not_answered' };
  const value = typeof answer === 'string' ? modelValue(q, answer) : undefined;
  if (value === undefined || typeof quote !== 'string') return { status: 'unclear', reason: 'the model gave no usable answer' };

  let sentence = sentenceAround(reply, quote);
  if (!sentence && context.alone) {
    // The model's quote is not the reply's words ("married_filing_jointly"): the
    // one sentence that states an answer of this kind, if there is exactly one.
    const text = normLines(reply);
    const stating = sentencesOf(text)
      .map((s) => text.slice(s.start, s.end).replace(/\n/g, ' ').trim())
      .filter((s) => readAnswerFromWords(q, s) !== null && subjectProblem(q, reply, s, otherNames) === null);
    if (stating.length === 1) sentence = stating[0]!;
  }
  if (!sentence) return { status: 'unclear', reason: 'the words the model quoted are not in the reply', quote };

  const problem = subjectProblem(q, reply, sentence, otherNames);
  if (problem) return { status: 'unclear', reason: problem, quote };

  const words = readAnswerFromWords(q, sentence);
  const same = words !== null && (typeof value === 'number' && typeof words === 'number' ? Math.abs(value - words) < 0.005 : value === words);
  if (!same) {
    return { status: 'unclear', reason: `the model read ${show(value)} but the client's words state ${show(words)}`, quote };
  }
  return { status: 'answered', value: words!, quote, sentence };
}

// ─── Where a confirmed answer goes ───────────────────────────

export type ClientAnswerRecord =
  | { kind: 'record'; tool: 'add_dependent' | 'set_state_residency'; args: Record<string, unknown>; field: string }
  | { kind: 'filing_status'; tool: 'set_filing_status_candidate'; args: { status: string }; field: 'status' }
  | { kind: 'form'; tool: ChoiceTool; formKey: string; field: string; value: ClientAnswerValue };

export function clientAnswerRecord(q: ClientQuestion, value: ClientAnswerValue): ClientAnswerRecord {
  const t = q.target;
  switch (t.kind) {
    case 'dependent':
      return { kind: 'record', tool: 'add_dependent', field: t.field, args: { ...t.person, [t.field]: value } };
    case 'residency':
      return { kind: 'record', tool: 'set_state_residency', field: t.field, args: { stateCode: t.stateCode, [t.field]: value } };
    case 'form':
      return { kind: 'form', tool: t.tool, formKey: t.formKey, field: t.field, value };
    case 'filing_status':
      return { kind: 'filing_status', tool: 'set_filing_status_candidate', field: 'status', args: { status: String(value) } };
  }
}
