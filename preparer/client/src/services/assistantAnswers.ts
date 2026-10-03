/**
 * Reading a typed answer (work order: the preparer types, the case is written).
 *
 * A message typed into the assistant is matched against the turns that are open
 * and read for the one thing each of them needs. The reading is deterministic:
 * numbers, counts, yes/no and the fixed vocabularies (filing status,
 * relationships, states, form decisions) are read from the words themselves,
 * with no model in the loop. That is deliberate — a value goes onto a return
 * only when the words say so, the same rule the client's replies already follow
 * (clientAnswers.ts).
 *
 * When the words are not enough the turn is not answered and the reason is
 * given. Nothing is inferred from an unrelated sentence, and a message that
 * could belong to more than one open turn is matched on what it names.
 */

import { fieldInput, toolFieldLabel, type DocumentToolName } from '@hatax/local-ai';
import { FilingStatus, getStateName } from '@hatax/engine';
import type { AssistantIntent, AssistantTurn, AssistantValue } from './assistantTurns';

/** What was understood, and what to do with it. */
export type ReadAnswer =
  | { status: 'understood'; intent: AssistantIntent; turnId: string; value: AssistantValue; label: string }
  /** The words fit a turn but not enough of it. */
  | { status: 'partial'; turnId: string; reason: string; intent: AssistantIntent }
  /** The words answer something no open turn asked for. */
  | { status: 'unmatched'; reason: string }
  /** Nothing to answer. */
  | { status: 'nothing' };

const YES = /^\s*(yes|yeah|yep|yup|correct|right|true|indeed|absolutely|definitely|sure|ok|okay)\b/i;
const NO = /^\s*(no|nope|nah|negative|false|incorrect|wrong|never)\b/i;

/**
 * A money amount as typed: 52,000 / $52,000 / 52000.00 / 52k.
 *
 * The box a message names is not part of the value, so "box 2 is 5,873.40" is
 * 5,873.40 and never 2. Years are dropped for the same reason.
 */
export function readAmount(text: string): number | undefined {
  const cleaned = text
    .replace(/[$£€]/g, '')
    .replace(/,/g, '')
    .replace(/\bbox\s*\d{1,2}[a-d]?\b/gi, ' ')
    .replace(/\bline\s*\d{1,2}\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ');
  const k = /(-?\d+(?:\.\d+)?)\s*k\b/i.exec(cleaned);
  if (k) return Math.round(Number(k[1]) * 1000);
  const m = /(-?\d+(?:\.\d+)?)/.exec(cleaned);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** A whole count as typed, including the words people use for them. */
export function readCount(text: string): number | undefined {
  const t = text.toLowerCase().trim();
  if (/^(all|the whole year|the entire year|whole year|year round|all year)\b/.test(t)) return 12;
  const words: Record<string, number> = {
    none: 0, zero: 0, 'no months': 0, never: 0,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, full: 12, all: 12, whole: 12,
  };
  for (const [word, n] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  const m = /(-?\d{1,3})\s*(?:months?|mos?\.?)/i.exec(t) ?? /(-?\d{1,3})/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) ? n : undefined;
}

/** Yes, no, or neither. */
export function readYesNo(text: string): boolean | undefined {
  const t = text.trim();
  if (YES.test(t)) return true;
  if (NO.test(t)) return false;
  if (/\b(did|didn'?t|does|doesn'?t|is|isn'?t|was|wasn'?t|has|hasn'?t|have|haven'?t|received|get|got)\b/i.test(t)) {
    return /\b(not|never|no|didn'?t|doesn'?t|isn'?t|wasn'?t|hasn'?t|haven'?t)\b/i.test(t) ? false : undefined;
  }
  return undefined;
}

/** Filing status, from the words people actually use. */
export function readFilingStatus(text: string): FilingStatus | undefined {
  const t = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bmarried filing jointly\b|\bfile jointly\b|\bjoint return\b|\bfiling jointly\b|\btogether\b|\bhusband and wife\b/.test(t)) return FilingStatus.MarriedFilingJointly;
  if (/\bmarried filing separately\b|\bfile separately\b|\bfiling separately\b/.test(t)) return FilingStatus.MarriedFilingSeparately;
  if (/\bhead of household\b|\bhead of the household\b/.test(t)) return FilingStatus.HeadOfHousehold;
  if (/\bqualifying surviving spouse\b|\bsurviving spouse\b/.test(t)) return FilingStatus.QualifyingSurvivingSpouse;
  if (/\bsingle\b|\bunmarried\b/.test(t)) return FilingStatus.Single;
  return undefined;
}

/**
 * How a dependent is related, from the words people use, as the return's own
 * term. The most specific word wins: "grandmother" is a grandparent, not a
 * grandchild. Anything not on the list is not read — a relationship the schema
 * does not hold would have to be refused downstream anyway.
 */
export function readRelationship(text: string): string | undefined {
  const t = text.toLowerCase();
  const RULES: Array<[RegExp, string]> = [
    [/\bson[- ]in[- ]law\b/, 'Son-in-Law'],
    [/\bdaughter[- ]in[- ]law\b/, 'Daughter-in-Law'],
    [/\bfather[- ]in[- ]law\b/, 'Father-in-Law'],
    [/\bmother[- ]in[- ]law\b/, 'Mother-in-Law'],
    [/\bbrother[- ]in[- ]law\b/, 'Brother-in-Law'],
    [/\bsister[- ]in[- ]law\b/, 'Sister-in-Law'],
    [/\bgrand(mother|father|ma|pa|parent)\b/, 'Grandparent'],
    [/\bgrand(child|son|daughter|kid)\b/, 'Grandchild'],
    [/\bstep\s?(son|daughter)\b/, /\bfoster\b/.test(t) ? 'Foster Child' : /^.*\bstep\s?son\b/.test(t) ? 'Stepson' : 'Stepdaughter'],
    [/\bstep\s?(brother|sister)\b/, /\bstep\s?brother\b/.test(t) ? 'Stepbrother' : 'Stepsister'],
    [/\bstep\s?(mother|father)\b/, /\bstep\s?mother\b/.test(t) ? 'Stepmother' : 'Stepfather'],
    [/\bfoster\b/, 'Foster Child'],
    [/\b(grand)?\s?(daughter|son)\b/, /\bgranddaughter\b/.test(t) ? 'Grandchild' : /\bgrandson\b/.test(t) ? 'Grandchild' : /\bdaughter\b/.test(t) ? 'Daughter' : 'Son'],
    [/\bhalf[- ]sister\b/, 'Half Sister'],
    [/\bhalf[- ]brother\b/, 'Half Brother'],
    [/\b(sister|brother|sibling)\b/, /\bsister\b/.test(t) ? 'Sister' : 'Brother'],
    [/\b(mother|father|mom|dad|parent)\b/, /\bmother\b/.test(t) ? 'Mother' : /\bfather\b/.test(t) ? 'Father' : /\bparent\b/.test(t) ? 'Parent' : 'Parent'],
    [/\b(niece)\b/, 'Niece'],
    [/\b(nephew)\b/, 'Nephew'],
    [/\b(aunt)\b/, 'Aunt'],
    [/\b(uncle)\b/, 'Uncle'],
  ];
  for (const [re, value] of RULES) if (re.test(t)) return value;
  return undefined;
}

/** Whether the words say the whole year, part of it, or not at all. */
export function readResidency(text: string): 'all_year' | 'part_year' | 'none' | undefined {
  const t = text.toLowerCase();
  if (/\b(not at all|did not|didn'?t|never|no|none)\b/.test(t)) return 'none';
  if (/\b(part of|part[- ]year|part year|for part|moved|until|through)\b/.test(t)) return 'part_year';
  if (/\b(all year|all of the year|whole year|entire year|full year|year round|the whole time|since)\b/.test(t)) return 'all_year';
  return undefined;
}

/** The field of a form the words name, e.g. "box 1" or "the wages". */
function namedField(turn: AssistantTurn, text: string): { field: string } | undefined {
  if (turn.intent.kind !== 'held_field') return undefined;
  const t = text.toLowerCase();
  const tool = turn.intent.tool;
  // A box number is the most direct way to name a field.
  const box = /\bbox\s*(\d{1,2}[a-d]?)\b/.exec(t);
  if (box) {
    const wanted = box[1]!;
    const byBox = Object.entries(FIELD_BOXES[tool] ?? {}).find(([, b]) => b === wanted);
    if (byBox) return { field: byBox[0] };
  }
  // Otherwise the field's own words: "wages", "federal tax withheld".
  const words = toolFieldLabel(tool, turn.intent.field).toLowerCase();
  if (words.split(/[,()]/)[0]!.trim().length > 3 && t.includes(words.split(/[,()]/)[0]!.trim())) {
    return { field: turn.intent.field };
  }
  return undefined;
}

/**
 * The printed box number per field, so "box 1" finds the field.
 *
 * Every entry is checked against the form schema by `printedBoxLabels.test.ts` in
 * local-ai — these were typed by hand and drifted: 1099-INT tax-exempt interest
 * is box 8 (not box 5), 1099-R gross distribution is box 1 and its distribution
 * code box 7a (not 1a and 3), and 1099-R federal tax withheld is box 4.
 */
const FIELD_BOXES: Partial<Record<DocumentToolName, Record<string, string>>> = {
  add_w2: {
    wages: '1', federalTaxWithheld: '2', socialSecurityWages: '3', socialSecurityTax: '4',
    medicareWages: '5', medicareTax: '6', state: '15', stateWages: '16', stateTaxWithheld: '17',
    localWages: '18', localTaxWithheld: '19', localityName: '20',
  },
  add_1099_int: { amount: '1', earlyWithdrawalPenalty: '2', usBondInterest: '3', federalTaxWithheld: '4', taxExemptInterest: '8' },
  add_1099_div: { ordinaryDividends: '1a', qualifiedDividends: '1b', capitalGainDistributions: '2a', federalTaxWithheld: '4', foreignTaxPaid: '6' },
  add_1099_nec: { amount: '1', federalTaxWithheld: '4' },
  add_1099_r: { grossDistribution: '1', taxableAmount: '2a', distributionCode: '7a', federalTaxWithheld: '4' },
  add_1099_misc: { rents: '1', royalties: '2', otherIncome: '3', federalTaxWithheld: '4' },
  add_1099_g: { unemploymentCompensation: '1', federalTaxWithheld: '4' },
  add_1099_b: { proceeds: '1d', costBasis: '1e', isLongTerm: '2' },
  add_1099_k: { grossAmount: '1a', cardNotPresent: '1b', federalTaxWithheld: '4' },
  add_1099_oid: { originalIssueDiscount: '1', otherPeriodicInterest: '2', earlyWithdrawalPenalty: '3', federalTaxWithheld: '4' },
  add_1099_c: { dateOfCancellation: '1', amountCancelled: '2', interestIncluded: '3', personallyLiable: '5', identifiableEventCode: '6' },
  add_ssa_1099: { benefitsPaid: '5', benefitsRepaid: '5r', netBenefits: '9', federalTaxWithheld: '10' },
  add_mortgage_interest: { mortgageInterest: '1', outstandingPrincipal: '2', originationDate: '3', refundOfOverpaidInterest: '4', mortgageInsurancePremiums: '5', points: '6' },
};

/** Does the message name this turn's subject (a file, a person, a state, a form)? */
function namesTurn(turn: AssistantTurn, text: string): boolean {
  const t = text.toLowerCase();
  const subject = turn.question?.subjectWords ?? [];
  const who = turn.question?.subjectName?.toLowerCase();
  if (who && t.includes(who)) return true;
  for (const word of subject) if (t.includes(word.toLowerCase())) return true;
  // A return field named by its own words: "the city is …", "street address …".
  // This is what separates two free-text fields that both fit any words.
  if (turn.intent.kind === 'return_field') {
    const label = RETURN_SAY[turn.intent.field]?.toLowerCase() ?? '';
    const words = label.split(/[^a-z]+/).filter((w) => w.length >= 3);
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return true;
  }
  // A held form's file name, when the message mentions a file at all.
  if (/\.(pdf|png|jpe?g|tiff?|heic|webp)\b/.test(t)) {
    return /\b\d{4}\b/.test(t) || subject.length === 0;
  }
  // A state named in the message. Every state turn used to count as named,
  // so a street address was routed to an open county question.
  if (turn.intent.kind === 'state_answer') {
    const question = turn.item?.action?.kind === 'state_answer' ? turn.item.action.question : undefined;
    if (!question) return false;
    const state = getStateName(question.stateCode).toLowerCase();
    return t.includes(state) || new RegExp(`\\b${question.stateCode.toLowerCase()}\\b`).test(t);
  }
  return false;
}

/**
 * How well a message fits a turn, as a score. A message is routed to the turn
 * it fits best, not simply the heaviest one — typing "single" must answer the
 * filing status, not the date of birth that happens to be listed first.
 *
 * A score of 0 means the message says nothing this turn can use.
 */
function fitScore(turn: AssistantTurn, text: string): number {
  const intent = turn.intent;
  // Naming the turn's subject — the file, the person, the state — is a signal
  // on its own, and breaks a tie between two turns that both take a number.
  const named = namesTurn(turn, text) ? 2 : 0;

  const byKind = ((): number => {
  switch (intent.kind) {
    case 'return_field': {
      if (intent.field === 'filingStatus') return readFilingStatus(text) ? 10 : 0;
      if (intent.field === 'dateOfBirth') return /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(19|20)\d{2}\b/.test(text) ? 10 : 0;
      if (intent.field === 'ssn') return /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/.test(text) ? 10 : 0;
      // The return's fields are addressZip and addressState, not zipCode and state.
      if (intent.field === 'addressZip') return /\b\d{5}(-\d{4})?\b/.test(text) ? 10 : 0;
      if (intent.field === 'addressState') return readState(text) ? 10 : 0;
      // Any other name or address is any words at all, so it fits everything
      // weakly — and several open fields tie at 1, so the message goes to the
      // one it names. Without a subject it is not a guess: it stays unrouted and
      // the assistant asks which field it was for.
      return 1;
    }
    case 'filing_status':
      return readFilingStatus(text) ? 10 : 0;

    case 'held_field': {
      const field = namedField(turn, text)?.field;
      const input = fieldInput(intent.tool, field ?? intent.field);
      if (!input) return 1;
      // A held box on a form is the strongest thing a typed number can answer: it
      // is the one field the return cannot do without. It outranks a return field
      // that merely happens to match the shape of the words — a bare five-digit
      // number is a ZIP as readily as it is wages.
      if (input.kind === 'number') return readAmount(text) !== undefined ? 12 : 0;
      if (input.kind === 'boolean') return readYesNo(text) !== undefined ? 12 : 0;
      if (input.kind === 'enum') return input.options.some((o) => text.toLowerCase().includes(o.toLowerCase().replace(/_/g, ' '))) ? 12 : 0;
      return 1;
    }

    case 'dependent': {
      const months = readCount(text) !== undefined;
      const rel = readRelationship(text) !== undefined;
      if (months || rel) return 8;
      return 0;
    }

    case 'choice': {
      if (intent.tool === 'add_1099_sa') return readYesNo(text) !== undefined ? 8 : 0;
      if (intent.tool === 'add_1099_q') return readAmount(text) !== undefined ? 8 : 0;
      return /american opportunity|aotc|lifetime learning|llc/.test(text.toLowerCase()) ? 8 : 0;
    }

    case 'state_answer': {
      const question = turn.item?.action?.kind === 'state_answer' ? turn.item.action.question : undefined;
      if (!question) return 0;
      if (question.kind === 'yes_no') return readYesNo(text) !== undefined ? 8 : 0;
      if (question.kind === 'amount' || question.kind === 'count') return readAmount(text) !== undefined ? 8 : 0;
      if (question.kind === 'choice') return matchChoice(text, question.options ?? []) ? 8 : 0;
      return 0;
    }

    case 'acquisition_date':
      return /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b[A-Z][a-z]+ \d{1,2},? \d{4}\b/.test(text) ? 8 : 0;

    case 'decision':
    case 'use_bank':
    case 'join_spouse_case':
    case 'identity':
      return readYesNo(text) !== undefined ? 6 : 0;

    default:
      return 0;
  }
  })();

  return byKind + named;
}

/**
 * The turn a message is about: the one it fits best, and among equals the one
 * that unblocks the most. Falling back to the heaviest turn is what makes "type
 * a number" work — with nothing said about which box, the number belongs to the
 * thing that most needs it.
 */
export function targetTurn(turns: AssistantTurn[], text: string): AssistantTurn | undefined {
  const open = turns.filter((t) => t.kind === 'blocked' || t.kind === 'needed' || t.kind === 'check' || t.kind === 'ask');
  if (open.length === 0) return undefined;
  // Only a turn that takes a value can take a typed answer.
  const scored = open
    .filter((t) => t.intent.kind !== 'client_question' && t.intent.kind !== 'document')
    .map((t) => ({ turn: t, score: fitScore(t, text) }))
    .sort((a, b) => b.score - a.score || b.turn.weight - a.turn.weight);
  const best = scored[0];
  if (!best || best.score <= 0) return undefined;

  // Several free-text fields all fit any words equally, so a message that names
  // none of them is ambiguous: "123 Main St" could be the street or the city.
  // Routing it to whichever happens to be heaviest would write an address into
  // the wrong field, so it is left unrouted and the assistant asks which field.
  const tied = scored.filter((s) => s.score === best.score);
  if (tied.length > 1 && best.score <= TEXT_FIELD_FIT && !tied.some((s) => namesTurn(s.turn, text))) {
    return undefined;
  }
  return best.turn;
}

/** The score a name or address field gives any words at all. */
const TEXT_FIELD_FIT = 2;

/** Read the value for one turn out of the words. */
export function readForTurn(turn: AssistantTurn, text: string): ReadAnswer {
  const intent = turn.intent;

  switch (intent.kind) {
    case 'held_field': {
      // Which box the words name, and what kind of value that box takes.
      const field = namedField(turn, text)?.field ?? intent.field;
      const input = fieldInput(intent.tool, field);
      const box = toolFieldLabel(intent.tool, field);
      if (!input) {
        const n = readAmount(text);
        return n === undefined
          ? { status: 'partial', turnId: turn.id, intent, reason: `I could not tell what ${box.toLowerCase()} is from “${text.trim()}”` }
          : { status: 'understood', intent: { ...intent, field }, turnId: turn.id, value: { kind: 'number', value: n }, label: formatLabel(box, n) };
      }
      if (input.kind === 'number') {
        const n = readAmount(text);
        if (n === undefined) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `I could not read a number for ${box.toLowerCase()}` };
        if (input.integer && !Number.isInteger(n)) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `${box} has to be a whole number` };
        if (input.min !== undefined && n < input.min) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `${box} cannot be less than ${input.min}` };
        if (input.max !== undefined && n > input.max) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `${box} cannot be more than ${input.max}` };
        // A negative on a box that carries money in is a mistyped sign far more
        // often than it is real. The card validates it against the form's schema;
        // typing it does not, so it is asked for there instead of written here.
        if (n < 0) {
          return {
            status: 'partial', turnId: turn.id, intent: { ...intent, field },
            reason: `${box} cannot be negative. If the form really shows a minus sign, enter it on the card so it can be checked.`,
          };
        }
        return { status: 'understood', intent: { ...intent, field }, turnId: turn.id, value: { kind: 'number', value: n }, label: formatLabel(box, n) };
      }
      if (input.kind === 'boolean') {
        const b = readYesNo(text);
        if (b === undefined) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `I could not tell whether ${box.toLowerCase()} is yes or no` };
        return { status: 'understood', intent: { ...intent, field }, turnId: turn.id, value: { kind: 'boolean', value: b }, label: `${box}: ${b ? 'yes' : 'no'}` };
      }
      if (input.kind === 'enum') {
        const t = text.toLowerCase();
        const opt = input.options.find((o) => t.includes(o.toLowerCase().replace(/_/g, ' ')));
        if (!opt) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `${box} has to be one of ${input.options.join(', ')}` };
        return { status: 'understood', intent: { ...intent, field }, turnId: turn.id, value: { kind: 'text', value: opt }, label: `${box}: ${opt.replace(/_/g, ' ')}` };
      }
      const v = text.trim();
      if (!v) return { status: 'partial', turnId: turn.id, intent: { ...intent, field }, reason: `I could not read ${box.toLowerCase()}` };
      return { status: 'understood', intent: { ...intent, field }, turnId: turn.id, value: { kind: 'text', value: v }, label: `${box}: ${v}` };
    }

    case 'dependent': {
      const months = readCount(text);
      const rel = readRelationship(text);
      if (months !== undefined && rel !== undefined) {
        return {
          status: 'partial', turnId: turn.id, intent,
          reason: `I can see ${months} months and that they are a ${rel.replace(/_/g, ' ')}, but those are two answers — set each one on the card below`,
        };
      }
      if (rel !== undefined) {
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: `relationship:${rel}` }, label: `${intent.firstName} ${intent.lastName} is a ${rel.replace(/_/g, ' ')}` };
      }
      if (months !== undefined) {
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'number', value: months }, label: `${intent.firstName} ${intent.lastName} lived with you ${months === 12 ? 'all year' : `${months} month${months === 1 ? '' : 's'}`}` };
      }
      return { status: 'partial', turnId: turn.id, intent, reason: `I could not tell how many months ${intent.firstName} lived with you, or how they are related to you` };
    }

    case 'filing_status': {
      const s = readFilingStatus(text);
      if (s === undefined) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell which filing status that is' };
      return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: String(s) }, label: `Filing status: ${FILING_LABELS[s]}` };
    }

    case 'return_field': {
      const field = intent.field;
      if (field === 'filingStatus') {
        const s = readFilingStatus(text);
        if (s === undefined) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell which filing status that is' };
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: String(s) }, label: `Filing status: ${FILING_LABELS[s]}` };
      }
      // A name, an address, an SSN, a date: the words themselves.
      const v = text.trim();
      if (!v) return { status: 'partial', turnId: turn.id, intent, reason: `I could not read a value for ${RETURN_SAY[field] ?? field}` };
      return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: v }, label: `${RETURN_SAY[field] ?? field}: ${v}` };
    }

    case 'choice': {
      const b = readYesNo(text);
      if (intent.tool === 'add_1099_sa') {
        if (b === undefined) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell whether the distribution paid qualified medical expenses' };
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'boolean', value: b }, label: b ? 'The whole distribution paid qualified medical expenses' : 'Only part of it did' };
      }
      if (intent.tool === 'add_1099_q') {
        const n = readAmount(text);
        if (n === undefined) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not read how much the 1099-Q paid in qualified expenses' };
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'number', value: n }, label: formatLabel('Qualified education expenses this paid', n) };
      }
      const t = text.toLowerCase();
      if (/american opportunity|aotc/.test(t)) return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: 'american_opportunity' }, label: 'American Opportunity credit' };
      if (/lifetime learning|llc/.test(t)) return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: 'lifetime_learning' }, label: 'Lifetime Learning credit' };
      return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell what this decision is — use the card below' };
    }

    case 'state_answer': {
      const question = turn.item?.action?.kind === 'state_answer' ? turn.item.action.question : undefined;
      // A county or school district is one of the options the card lists. Yes/no
      // and amounts do not cover it, so typing "Polk" used to fall through as
      // partial even though that is exactly the answer the question offers.
      if (question?.kind === 'choice') {
        const hit = matchChoice(text, question.options ?? []);
        if (!hit) {
          const shown = (question.options ?? []).slice(0, 6).map((o) => o.label);
          const more = (question.options?.length ?? 0) > shown.length ? ', …' : '';
          return { status: 'partial', turnId: turn.id, intent, reason: `That one is one of: ${shown.join(', ')}${more}.` };
        }
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: hit.value }, label: hit.label };
      }
      const b = readYesNo(text);
      if (b !== undefined) return { status: 'understood', intent, turnId: turn.id, value: { kind: 'boolean', value: b }, label: b ? 'Yes' : 'No' };
      const n = readAmount(text);
      if (n !== undefined) return { status: 'understood', intent, turnId: turn.id, value: { kind: 'number', value: n }, label: formatLabel('', n) };
      return { status: 'partial', turnId: turn.id, intent, reason: 'I could not read an answer to that' };
    }

    case 'acquisition_date': {
      const d = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})\b/.exec(text);
      if (!d) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not read a date' };
      return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: d[1]! }, label: `Placed in service: ${d[1]}` };
    }

    case 'decision':
    case 'use_bank':
    case 'join_spouse_case': {
      const b = readYesNo(text);
      if (b === undefined) return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell whether that is right' };
      return {
        status: 'understood', intent, turnId: turn.id,
        value: { kind: 'text', value: b ? 'accepted' : 'not_applicable' },
        label: b ? 'Confirmed' : 'Not applicable',
      };
    }

    case 'identity': {
      const b = readYesNo(text);
      if (b !== undefined) {
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'boolean', value: b }, label: b ? 'Yes, use it' : 'No' };
      }
      return { status: 'partial', turnId: turn.id, intent, reason: 'I could not tell what to do with that — use the choices on the card' };
    }

    case 'document': {
      if (/\b(drop|again|re[- ]?read|read it|upload|add it)\b/i.test(text)) {
        return { status: 'understood', intent, turnId: turn.id, value: { kind: 'boolean', value: true }, label: 'Read the file again' };
      }
      return { status: 'partial', turnId: turn.id, intent, reason: 'I need to know what that file is, or to have it dropped on the case again' };
    }

    case 'client_question': {
      // A state question with a fixed set of answers — an Iowa or Indiana county,
      // a school district — can be answered by typing one of them, which is
      // exactly what the card offers. Without this, typing an offered label falls
      // through as partial even though the assistant advertises typed answers.
      const options = stateAnswerOptions(intent.questionId, turn);
      if (options.length > 0) {
        const said = text.toLowerCase().trim();
        const hit = options.find((o) =>
          said === o.label.toLowerCase().trim() ||
          said === o.value.toLowerCase().trim() ||
          said.includes(o.label.toLowerCase()),
        );
        if (hit) {
          return { status: 'understood', intent, turnId: turn.id, value: { kind: 'text', value: hit.value }, label: hit.label };
        }
        return { status: 'partial', turnId: turn.id, intent, reason: `That one is one of: ${options.map((o) => o.label).join(', ')}.` };
      }
      return { status: 'partial', turnId: turn.id, intent, reason: 'Only the client can answer that — paste their reply below and I will read it' };
    }

    case 'note':
      return { status: 'partial', turnId: turn.id, intent, reason: 'I did not find a value for any open question in that' };
  }
}

/**
 * The option a typed answer names, when exactly one option fits.
 *
 * Labels are "49 Polk": the code, the name, or the whole label all count.
 * Two options sharing a word is not a guess.
 */
function matchChoice(
  text: string,
  options: ReadonlyArray<{ value: string; label: string }>,
): { value: string; label: string } | undefined {
  const said = text.toLowerCase().trim();
  const exact = options.find((o) => said === o.label.toLowerCase().trim() || said === o.value.toLowerCase().trim());
  if (exact) return exact;
  const words = said.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const hits = options.filter((o) => {
    const label = o.label.toLowerCase().trim();
    if (label.length >= 3 && said.includes(label)) return true;
    const labelWords = label.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return labelWords.some((w) => words.includes(w));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The answers a state question offers, taken from the card the preparer sees.
 *
 * The question itself does not carry them — the state modules build them from
 * their own county and district lists — so they are read off the options the
 * assistant already rendered. That keeps one list, in one place.
 */
function stateAnswerOptions(questionId: string, turn: AssistantTurn): Array<{ label: string; value: string }> {
  return (turn.options ?? [])
    .filter((o) => o.value.kind === 'text')
    .map((o) => ({ label: o.label, value: String((o.value as { value: string }).value) }));
}

/** Read a typed message against the open turns. */
export function readAnswer(text: string, turns: AssistantTurn[]): ReadAnswer {
  const trimmed = text.trim();
  if (!trimmed) return { status: 'nothing' };
  const turn = targetTurn(turns, trimmed);
  if (!turn) {
    return { status: 'unmatched', reason: 'I do not know what that answers. Tell me the value, or use the card under the question it belongs to.' };
  }
  return readForTurn(turn, trimmed);
}

const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

function formatLabel(label: string, value: number): string {
  const shown = Number.isInteger(value) ? money0.format(value) : money2.format(value);
  return label ? `${label}: ${shown}` : shown;
}

const FILING_LABELS: Record<string, string> = {
  [FilingStatus.Single]: 'Single',
  [FilingStatus.MarriedFilingJointly]: 'Married filing jointly',
  [FilingStatus.MarriedFilingSeparately]: 'Married filing separately',
  [FilingStatus.HeadOfHousehold]: 'Head of household',
  [FilingStatus.QualifyingSurvivingSpouse]: 'Qualifying surviving spouse',
};

const RETURN_SAY: Record<string, string> = {
firstName: 'Taxpayer first name',
    lastName: 'Taxpayer last name',
    ssn: 'Social Security number',
    dateOfBirth: 'Date of birth',
    // The return's own field names.
    addressStreet: 'Street address',
    addressCity: 'City',
    addressState: 'State',
    addressZip: 'ZIP code',
    filingStatus: 'Filing status',
  };

/** Every state and DC, in the order the engine's table has them. */
const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

/** The state's table, built once from the engine's own names. */
const STATE_NAMES: ReadonlyArray<readonly [string, string]> = STATE_CODES.map((code) => [code, getStateName(code)] as const);

/** The state a message names, when it names one. */
export function readState(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const [code, name] of STATE_NAMES) {
    if (t.includes(name.toLowerCase())) return code;
  }
  const abbr = /\b([a-z]{2})\b/.exec(t)?.[1]?.toUpperCase();
  return abbr && STATE_NAMES.some(([c]) => c === abbr) ? abbr : undefined;
}