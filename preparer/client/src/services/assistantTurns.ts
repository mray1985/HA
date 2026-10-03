/**
 * The assistant's thread (work order: the preparer is talked through the case).
 *
 * Everything the case still needs is projected into one ordered list of turns.
 * A turn says, in plain words, what is wrong and the single thing needed to put
 * it right, and carries the machine-readable target for it — so the same turn
 * can be answered by clicking a chip, by typing a number, or by a field form.
 *
 * Two rules shape every turn:
 *
 * 1. Nothing is asked for twice, and nothing is asked for that the evidence on
 *    the case already settles. A turn exists only where a review item is open.
 * 2. The underlying review item is kept on the turn. The engine's diagnostics
 *    and validation still decide what is blocking; this only decides how it is
 *    said. No turn can be resolved that its item could not be resolved.
 *
 * The voice is first person and says what was done and what is missing. The
 * tool field names (`federalIncomeTaxWithheld`) never appear: every field is
 * named the way the form names it, box number included.
 */

import {
  formKeyOf,
  toolFieldLabel,
  type ChoiceTool,
  type DocumentToolName,
  type IngestedDocument,
  type TaxFact,
} from '@hatax/local-ai';
import { FilingStatus, getStateName } from '@hatax/engine';
import type { ClientQuestion } from '@hatax/local-ai';
import { returnFieldSpec } from './returnFields';
import type { ReviewItem } from './caseReview';

/** What one turn is asking the preparer to settle. The chat box routes a typed answer here. */
export type AssistantIntent =
  /** A value on a form the page could not read, or that two readers read differently. */
  | { kind: 'held_field'; tool: DocumentToolName; formKey: string; field: string }
  /** A decision the form cannot make (1099-Q expenses, the education credit, a home sale). */
  | { kind: 'choice'; tool: ChoiceTool; formKey: string }
  /** What a dependent named in the evidence still needs (months at home, relationship). */
  | { kind: 'dependent'; firstName: string; lastName: string }
  /** A filing status the client's reply states. */
  | { kind: 'filing_status'; status: FilingStatus; label: string }
  /** A return field the readiness check reports missing. */
  | { kind: 'return_field'; field: string }
  /** A fact a state return needs. */
  | { kind: 'state_answer'; questionId: string }
  /** The date a depreciable asset (or the vehicle) was acquired. */
  | { kind: 'acquisition_date'; assetId: string }
  /** A document that could not be used: what it is, or a re-read. */
  | { kind: 'document'; documentId: string; job: 'identify' | 'reread' }
  /** A warning or review item the preparer accepts or dismisses with a note. */
  | { kind: 'decision'; itemId: string }
  /** Something only the client can settle. */
  | { kind: 'client_question'; questionId: string }
  /** The taxpayer's identity from the documents: a reading, a person, or an address. */
  | { kind: 'identity'; itemId: string }
  /** A case with a spouse's own case to join. */
  | { kind: 'join_spouse_case'; returnId: string }
  /** Last year's refund account to put on the return. */
  | { kind: 'use_bank' }
  /** A free-text note: a new dependent, a move, an estimated payment. */
  | { kind: 'note' };

export type AssistantValue =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'nothing' };

/** One clickable answer, where the set of answers is known and small. */
export interface AssistantOption {
  label: string;
  value: AssistantValue;
  /** Which reader gave this reading, or why it is offered. */
  note?: string;
}

export type AssistantTurnKind =
  /** Nothing can be finalised until this is settled. */
  | 'blocked'
  /** Something is needed that nobody has to supply but the preparer. */
  | 'needed'
  /** Only the client can answer. */
  | 'ask'
  /** Something to look at and confirm. */
  | 'check'
  /** Information, never blocking. */
  | 'note';

export interface AssistantTurn {
  id: string;
  kind: AssistantTurnKind;
  /** One line, first person, plain words. */
  say: string;
  /** The single question. Present whenever the turn needs something. */
  ask?: string;
  /** One clause of reasoning, shown under the line. */
  why?: string;
  intent: AssistantIntent;
  /** The review item this came from. Kept so the audit trail and the audit rules still apply. */
  item?: ReviewItem;
  /** The client question this came from. */
  question?: ClientQuestion;
  options?: AssistantOption[];
  documentId?: string;
  /** How much this unblocks. A held W-2 unblocks the whole return; an informational note unblocks nothing. */
  weight: number;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/** A dollar amount, to the cent when it has cents. */
export function formatAmount(value: number): string {
  return Number.isInteger(value) ? money.format(value) : moneyExact.format(value);
}

/** What the form on a document is called to a person. */
export function formNameOf(doc: IngestedDocument, index = 0): string {
  const type = doc.classifications?.[index]?.formType ?? doc.formTypes?.[index];
  if (!type) return 'form';
  return FORM_NAMES[type] ?? type.replace(/_/g, ' ');
}

/**
 * What a form is called to a person: the printed name and what it is for.
 * Keyed by both the classifier's printed names (`W-2`) and the engine's own
 * item types (`w2`), because a document records the former and the applier the
 * latter. An unknown type falls back to the name with its punctuation removed.
 */
const FORM_NAMES: Record<string, string> = {
  'W-2': 'W-2 (wages)',
  'W-2c': 'W-2c (corrected wages)',
  'W-2G': 'W-2G (gambling winnings)',
  'K-1': 'K-1',
  'SSA-1099': 'SSA-1099 (Social Security)',
  '1098': '1098 (mortgage interest)',
  '1098-T': '1098-T (education)',
  '1098-E': '1098-E (student loan interest)',
  '1095-A': '1095-A (health insurance)',
  '1099-INT': '1099-INT (interest)',
  '1099-DIV': '1099-DIV (dividends)',
  '1099-NEC': '1099-NEC (self-employment)',
  '1099-R': '1099-R (retirement)',
  '1099-MISC': '1099-MISC (other income)',
  '1099-G': '1099-G (unemployment)',
  '1099-B': '1099-B (sales)',
  '1099-K': '1099-K (card and app payments)',
  '1099-OID': '1099-OID (bond interest)',
  '1099-C': '1099-C (debt cancelled)',
  '1099-Q': '1099-Q (qualified tuition)',
  '1099-SA': '1099-SA (HSA)',
  '1099-S': '1099-S (home sale)',
  w2: 'W-2 (wages)',
  w2c: 'W-2c (corrected wages)',
  w2g: 'W-2G (gambling winnings)',
  k1: 'K-1',
  ssa_1099: 'SSA-1099 (Social Security)',
  mortgage_interest: '1098 (mortgage interest)',
  education_expense: '1098-T (education)',
  '1099-int': '1099-INT (interest)',
  '1099-div': '1099-DIV (dividends)',
  '1099-nec': '1099-NEC (self-employment)',
  '1099-r': '1099-R (retirement)',
  '1099-misc': '1099-MISC (other income)',
  '1099-g': '1099-G (unemployment)',
  '1099-b': '1099-B (sales)',
  '1099-k': '1099-K (card and app payments)',
  '1099-oid': '1099-OID (bond interest)',
  '1099-c': '1099-C (debt cancelled)',
  '1099-q': '1099-Q (qualified tuition)',
  '1099-sa': '1099-SA (HSA)',
  '1099-s': '1099-S (home sale)',
};

/** The other reader's words for a value, when it read one. */
function otherReading(facts: TaxFact[], formKey: string, field: string): TaxFact | undefined {
  return facts.find((f) => formKeyOf(f) === formKey && f.sourceField === field && f.secondReading);
}

/**
 * Both readings of a disputed field as one-click answers: what each reader
 * said, so the preparer takes the right one rather than types the number.
 */
function disputedOptions(facts: TaxFact[], formKey: string, field: string): AssistantOption[] {
  const fact = facts.find((f) => formKeyOf(f) === formKey && f.sourceField === field);
  const out: AssistantOption[] = [];
  const seen = new Set<string>();
  if (fact && fact.status === 'extracted' && typeof fact.value === 'number') {
    seen.add(String(fact.value));
    out.push({ label: formatAmount(fact.value), value: { kind: 'number', value: fact.value }, note: 'The first reader' });
  }
  const secondText = otherReading(facts, formKey, field)?.secondReading?.text;
  const digits = secondText?.replace(/[^0-9.]/g, '');
  if (digits) {
    const n = Number(digits);
    if (Number.isFinite(n) && !seen.has(String(n))) {
      out.push({ label: formatAmount(n), value: { kind: 'number', value: n }, note: 'The second reader' });
    }
  }
  return out;
}

function fieldLabel(tool: DocumentToolName, field: string): string {
  return toolFieldLabel(tool, field);
}

/** The value of a field as an option, whichever kind of value it is. */
function valueOption(label: string, value: AssistantValue, note?: string): AssistantOption {
  return { label, value, ...(note ? { note } : {}) };
}

/**
 * Turn one review item into a turn, or nothing when the item is not something
 * a person should be asked about (information only, or already decided).
 */
function turnForItem(item: ReviewItem, facts: TaxFact[], documents: IngestedDocument[], clientName: string): AssistantTurn | null {
  const base = {
    id: item.id,
    item,
    documentId: item.documentId,
  };
  const action = item.action;

  // ── A form that is not on the return because the page could not read it ──
  if (action?.kind === 'fix') {
    const doc = documents.find((d) => d.documentId === (action.formKey.split('#')[0] ?? item.documentId));
    const form = formNameOf(doc ?? ({ fileName: item.documentId } as IngestedDocument));
    const labelled = action.fields.map((f) => ({ field: f, label: fieldLabel(action.tool, f) }));
    const disputed = labelled.filter((f) => otherReading(facts, action.formKey, f.field));
    const unread = labelled.filter((f) => !otherReading(facts, action.formKey, f.field));
    // A box two readers disagree on is a choice; a box nobody could read is a
    // blank. The choice leads, so it is what the chips and the box both offer.
    const fields = [...disputed, ...unread];
    const where = doc ? ` from ${doc.fileName}` : '';
    const parts: string[] = [];
    if (unread.length > 0) parts.push(unread.map((f) => f.label).join(' and '));
    if (disputed.length > 0) parts.push(`the two readers read ${disputed.map((f) => f.label).join(' and ')} differently`);
    const say = `I could not settle ${parts.join(', and ')} on the ${form}${where}, so I left it off the return rather than guess.`;
    const options = disputed.flatMap((f) => disputedOptions(facts, action.formKey, f.field));
    const ask = fields.length === 1
      ? `What is ${fields[0]!.label.toLowerCase()} on this form?`
      : `What are ${fields.map((f) => f.label.toLowerCase()).join(' and ')}?`;
    return {
      ...base,
      kind: 'blocked',
      say,
      ask,
      why: item.message,
      intent: { kind: 'held_field', tool: action.tool, formKey: action.formKey, field: fields[0]!.field },
      options: options.length > 0 ? options : undefined,
      weight: 1000 + fields.length,
    };
  }

  // ── A reading of the taxpayer's identity no second reader confirmed ──
  // The document already names the person. Saying "the return is not valid
  // without a first name" and asking the preparer to type what is printed on
  // the form is the wrong question: the reading is there, it is just unverified.
  // This turn carries the name as the one-click answer instead.
  if (action?.kind === 'use_identity') {
    const what = action.part === 'tin' ? 'SSN' : action.part === 'name' ? 'name' : 'address';
    return {
      ...base,
      kind: 'needed',
      say: `The ${documents.find((d) => d.documentId === action.documentId)?.fileName ?? 'document'} has the taxpayer's ${what} on it, but no second reading agreed, so I did not use it.`,
      ask: action.part === 'name'
        ? 'Check it against the document and use it if it is right — the IRS matches the name against Social Security\'s records.'
        : `Check the ${what} against the document.`,
      why: item.message,
      intent: { kind: 'identity', itemId: item.id },
      options: [valueOption(action.shown, { kind: 'boolean', value: true }, 'Use this')],
      weight: 1200,
    };
  }

  // ── A decision the form cannot make ──
  if (action?.kind === 'choice') {
    const doc = documents.find((d) => d.documentId === action.formKey.split('#')[0]);
    const form = formNameOf(doc ?? ({ fileName: '' } as IngestedDocument));
    return {
      ...base,
      kind: 'needed',
      say: `I read the ${form}${doc ? ` from ${doc.fileName}` : ''}, but it does not say ${action.missing.map((m) => fieldLabel(action.tool, m).toLowerCase()).join(' or ')}, so it is not on the return yet.`,
      ask: CHOICE_ASK[action.tool],
      intent: { kind: 'choice', tool: action.tool, formKey: action.formKey },
      weight: 700,
    };
  }

  // ── A dependent the evidence names but the return cannot hold yet ──
  if (action?.kind === 'dependent') {
    const who = `${action.firstName} ${action.lastName}`;
    const needs = action.missing.map((m) => (m === 'monthsLivedWithYou' ? 'how many months they lived with you' : 'how they are related to you'));
    return {
      ...base,
      kind: 'needed',
      say: `${who} is on the case but the return will not add them yet.`,
      ask: `Tell me ${needs.join(' and ')}.`,
      why: item.message,
      intent: { kind: 'dependent', firstName: action.firstName, lastName: action.lastName },
      options: action.missing.includes('monthsLivedWithYou')
        ? [12, 11, 10, 9, 8, 6, 3, 0].map((m) => valueOption(m === 12 ? 'All 12 months' : m === 0 ? 'None' : `${m} months`, { kind: 'number', value: m }))
        : undefined,
      weight: 650,
    };
  }

  // ── A filing status the client's reply states ──
  if (action?.kind === 'filing_status') {
    return {
      ...base,
      kind: 'check',
      say: `${clientName} said they file as ${action.label}. The return currently says ${item.message.includes('not the status on the return') ? 'something else' : 'nothing'}.`,
      ask: `Put ${action.label} on the return?`,
      intent: { kind: 'filing_status', status: action.status, label: action.label },
      options: [valueOption(`Yes — ${action.label}`, { kind: 'boolean', value: true }), valueOption('No, leave it', { kind: 'boolean', value: false })],
      weight: 600,
    };
  }

  // ── A return field the readiness check reports missing ──
  if (action?.kind === 'return_field') {
    const spec = returnFieldSpec(action.field, undefined);
    // The return's own field table is the authority on what a field is called;
    // a raw field name is never spoken.
    const label = spec?.label ?? returnFieldLabel(action.field);
    return {
      ...base,
      kind: 'blocked',
      say: `The return is not valid without ${lowerFirst(label)}.`,
      // The label is the return's own name for the field, used as written:
      // "Street address?", "ZIP code?", "Taxpayer's first name?".
      ask: `${label}?`,
      intent: { kind: 'return_field', field: action.field },
      weight: 950,
    };
  }

  // ── A fact a state return needs ──
  if (action?.kind === 'state_answer') {
    return {
      ...base,
      kind: 'needed',
      say: `The ${getStateName(action.question.stateCode)} return needs one more answer from you.`,
      ask: action.question.prompt,
      intent: { kind: 'state_answer', questionId: action.question.key },
      weight: 400,
    };
  }

  if (action?.kind === 'acquisition_date') {
    const what = action.assetId === 'vehicle' ? 'the vehicle' : 'the asset';
    return {
      ...base,
      kind: 'needed',
      say: `The return claims depreciation on ${what}, and the date it was placed in service decides how much.`,
      ask: `What date was ${what} placed in service?`,
      intent: { kind: 'acquisition_date', assetId: action.assetId },
      weight: 420,
    };
  }

  if (action?.kind === 'use_bank') {
    return {
      ...base,
      kind: 'check',
      say: `Last year ended with a refund and a bank account on file.`,
      ask: `Send this year's refund to ${action.label}?`,
      intent: { kind: 'use_bank' },
      options: [valueOption(`Yes — ${action.label}`, { kind: 'boolean', value: true }), valueOption('No, they will take a check', { kind: 'boolean', value: false })],
      weight: 300,
    };
  }

  if (action?.kind === 'join_spouse_case') {
    return {
      ...base,
      kind: 'needed',
      say: `${action.name} has ${action.documents} document${action.documents === 1 ? '' : 's'} on a case of their own. Filing together moves them here and can change the result.`,
      ask: `File ${clientName} and ${action.name} together?`,
      intent: { kind: 'join_spouse_case', returnId: action.returnId },
      options: [valueOption('Yes — file jointly', { kind: 'boolean', value: true }), valueOption('No, keep them separate', { kind: 'boolean', value: false })],
      weight: 500,
    };
  }

  // ── The taxpayer's identity from the documents ──
  if (action && ['use_identity', 'identity_person', 'choose_address'].includes(action.kind)) {
    return {
      ...base,
      kind: 'needed',
      say: IDENTITY_SAY[action.kind] ? IDENTITY_SAY[action.kind]!(item.message) : `The documents name a different person than the return.`,
      ask: item.message,
      intent: { kind: 'identity', itemId: item.id },
      weight: 800,
    };
  }

  // ── A document that could not be used ──
  if (item.id.startsWith('document:unclassified:')) {
    const doc = documents.find((d) => d.documentId === item.documentId);
    return {
      ...base,
      kind: 'blocked',
      say: `I could not tell what form ${doc?.fileName ?? 'this file'} is, so none of it is on the return.`,
      ask: `What is it? If it is a form I support, drop it on the case again and I will read it.`,
      intent: { kind: 'document', documentId: item.documentId ?? '', job: 'identify' },
      weight: 900,
    };
  }
  if (item.id.startsWith('document:unread:')) {
    const doc = documents.find((d) => d.documentId === item.documentId);
    return {
      ...base,
      kind: 'blocked',
      say: `I have ${doc?.fileName ?? 'this file'} but have not read it yet.`,
      ask: `Drop it on the case again and I will read it.`,
      intent: { kind: 'document', documentId: item.documentId ?? '', job: 'reread' },
      weight: 890,
    };
  }
  if (item.id.startsWith('document:rejected:')) {
    const doc = documents.find((d) => d.documentId === item.documentId);
    return {
      ...base,
      kind: 'note',
      say: `I could not use ${doc?.fileName ?? 'that file'}: ${doc?.rejectReason ?? 'it is not a PDF or photo'}.`,
      ask: `Drop it as a PDF or a photo and I will read it.`,
      intent: { kind: 'document', documentId: item.documentId ?? '', job: 'identify' },
      weight: 200,
    };
  }

  // ── A form for another tax year ──
  if (item.id.startsWith('document:year:')) {
    const doc = documents.find((d) => d.documentId === item.documentId);
    const year = /is a (\d{4}) /.exec(item.message)?.[1];
    return {
      ...base,
      kind: 'check',
      say: `${doc?.fileName ?? 'A document'} is a ${year ?? 'different year'} form, so its amounts do not belong on this return. I left it off.`,
      ask: `Is it right that this is a ${year ?? 'other year'} document? Confirm it belongs here and I will add it.`,
      intent: { kind: 'decision', itemId: item.id },
      options: [
        valueOption('Yes — it belongs here, add it', { kind: 'text', value: 'accepted' }),
        valueOption('No — leave it off', { kind: 'text', value: 'not_applicable' }),
      ],
      weight: 550,
    };
  }

  // ── A form read but not applied automatically ──
  if (item.id.startsWith('document:not-applied:')) {
    return {
      ...base,
      kind: 'needed',
      say: item.message.replace(/^[^:]*:\s*/, '').replace(/ — enter it on the return\.$/, ', so it is not on the return yet.'),
      ask: `Open the return and enter it, or tell me the amounts here.`,
      intent: { kind: 'note' },
      weight: 450,
    };
  }

  // ── Anything else: the item's own words, kept as-is ──
  const blocking = item.category === 'ERROR' || item.category === 'BLOCKING';
  // An item with an action is answered on its card. One without is a statement
  // about the return: it is shown, never "confirmed" — there is nothing to click.
  return {
    ...base,
    kind: blocking ? 'blocked' : item.category === 'INFORMATIONAL' ? 'note' : 'check',
    say: item.message,
    intent: action ? { kind: 'decision', itemId: item.id } : { kind: 'note' },
    weight: blocking ? 600 : item.category === 'WARNING' || item.category === 'REVIEW' ? 200 : 50,
  };
}

const IDENTITY_SAY: Record<string, ((message: string) => string) | undefined> = {
  use_identity: () => 'The documents name the taxpayer, but the return has no name or SSN yet.',
  identity_person: (m) => m,
  choose_address: () => 'The documents give more than one address for this taxpayer.',
};

/** The one question each decision asks, in the words the form leaves open. */
const CHOICE_ASK: Record<ChoiceTool, string> = {
  add_education_expense: 'Which education credit does this student qualify for?',
  add_1099_q: 'How much did this 1099-Q pay in qualified education expenses?',
  add_1099_sa: 'Did the whole distribution pay qualified medical expenses?',
  add_1099_s: 'Was this the taxpayer’s main home, and what were the basis and the months owned and used?',
};

// An initialism keeps its caps: "ZIP code" must not become "zIP code".
const lowerFirst = (s: string): string => (/^[A-Z]{2,}/.test(s) ? s : s[0]!.toLowerCase() + s.slice(1));
/** A name that starts a sentence ("this client" reads as a placeholder). */
const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** What a return field is called, for a field the return's own table does not name. */
function returnFieldLabel(field: string): string {
  const head = field.split('.')[0]!;
  const SPOKEN: Record<string, string> = {
    ssn: 'Social Security number', dateOfBirth: 'date of birth', filingStatus: 'filing status',
    firstName: 'first name', lastName: 'last name', middleInitial: 'middle initial',
    addressStreet: 'street address', addressCity: 'city', addressState: 'state', addressZip: 'ZIP code',
    spouseFirstName: "spouse's first name", spouseLastName: "spouse's last name",
    spouseSsn: "spouse's Social Security number", spouseDateOfBirth: "spouse's date of birth",
  };
  return SPOKEN[head] ?? head.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** A turn for a question only the client can answer. */
function turnForQuestion(question: ClientQuestion): AssistantTurn {
  // The subject names a person only when the question is about a person. For a
  // form's payer it would read "Only JPMORGAN CHASE BANK can settle this one".
  const aboutAPerson = question.target.kind === 'dependent' || question.target.kind === 'residency' || question.target.kind === 'filing_status';
  const who = aboutAPerson && question.subjectName ? `Only ${question.subjectName} can settle this one` : 'Only the client can settle this one';
  return {
    id: `client:${question.id}`,
    kind: 'ask',
    say: `${who}.`,
    ask: question.text,
    question,
    intent: { kind: 'client_question', questionId: question.id },
    weight: 350,
  };
}

export interface AssistantInput {
  items: ReviewItem[];
  facts: TaxFact[];
  documents: IngestedDocument[];
  questions: ClientQuestion[];
  clientName: string;
  /** What the intake is doing now; while it runs, nothing is missing yet. */
  intakeBusy?: string | null;
  /** Nothing has been read and nothing has been answered: the client is not on the case yet. */
  caseEmpty?: boolean;
}

/** Income tools: a form held on one of these is why the return has no income. */
const INCOME_TOOLS: ReadonlySet<DocumentToolName> = new Set([
  'add_w2', 'add_w2c', 'add_1099_int', 'add_1099_div', 'add_1099_nec', 'add_1099_r',
  'add_ssa_1099', 'add_1099_misc', 'add_1099_g', 'add_1099_b', 'add_1099_k', 'add_1099_oid',
  'add_1099_c', 'add_mortgage_interest', 'add_education_expense', 'add_1099_q', 'add_1099_sa', 'add_1099_s',
]);

/**
 * The thread, most blocking first: what stops the return being finished is at
 * the top, then what is missing, then what only the client knows, then what to
 * look at. Everything decided is left out — the case summary says so instead.
 */
/**
 * An empty case says nothing is missing, because nothing is missing yet: the
 * client's documents have not arrived. Ten "the return is not valid without…"
 * cards on a case with no documents is the app complaining before it has looked.
 */
function turnsForAnEmptyCase(clientName: string, hasQuestion: boolean): AssistantTurn[] {
  const turns: AssistantTurn[] = [{
    id: 'empty',
    kind: 'needed',
    say: `${upperFirst(clientName)} has nothing on the case yet, so I do not know who they are or what they earned.`,
    ask: 'Drop their documents in — on this page, or on the case list for several clients at once — and I will read them. If there are no documents to hand, enter the details yourself below.',
    intent: { kind: 'document', documentId: '', job: 'reread' },
    weight: 9999,
  }];
  // What the client is asked is worth knowing before the documents land.
  if (hasQuestion) {
    turns.push(turnForQuestion({
      id: 'filing-status', kind: 'filing_status',
      text: 'How do you want to file the return — single, married filing jointly, married filing separately, head of household, or qualifying surviving spouse?',
      target: { kind: 'filing_status' },
    }));
  }
  return turns;
}

/**
 * The thread, most blocking first: what stops the return being finished is at
 * the top, then what is missing, then what only the client knows, then what to
 * look at. Everything decided is left out — the case summary says so instead.
 */
export function assistantTurns({ items, facts, documents, questions, clientName, intakeBusy, caseEmpty }: AssistantInput): AssistantTurn[] {
  // Documents are still being read. Everything the case looks missing right now
  // is a document that has not been read yet, so asking for it would be asking
  // the preparer to do the machine's job — and the question goes away a second
  // later, having asked for nothing.
  if (intakeBusy) {
    return [{ id: 'reading', kind: 'note', say: intakeBusy, intent: { kind: 'note' }, weight: 9999 }];
  }

  // A held income form is already a turn saying the return has no income from it;
  // the engine's "no income sources" item would only repeat it.
  const incomeHeld = items.some(
    (i) => i.action?.kind === 'fix' && INCOME_TOOLS.has(i.action.tool),
  );

  // A case with nothing read on it opens by asking for the documents. The thread is
  // still projected underneath: a rolled-over case carries notes about what came
  // from last year, and with no documents that note is all the preparer is told.
  if (caseEmpty) {
    return [
      ...turnsForAnEmptyCase(clientName, questions.some((q) => q.target.kind === 'filing_status')),
      ...project(items, facts, documents, questions, clientName, incomeHeld),
    ];
  }
  return project(items, facts, documents, questions, clientName, incomeHeld);
}

/**
 * Project the open items and the client's questions into the thread.
 *
 * An item already decided is not something to ask about. An informational item
 * is kept as a note rather than dropped: what a rolled-over case carried from
 * last year is said once, and it blocks nothing.
 */
function project(
  items: ReviewItem[],
  facts: TaxFact[],
  documents: IngestedDocument[],
  questions: ClientQuestion[],
  clientName: string,
  incomeHeld: boolean,
): AssistantTurn[] {
  const asked = new Set<string>();
  const turns: AssistantTurn[] = [];

  // The forms whose decision only the preparer can make from the form itself, by
  // form key. The client may be asked about them, but not in a second card saying
  // the same thing: the form is on the case and the question belongs on it.
  const decidedOnForm = new Set(
    items.flatMap((i) => (i.action?.kind === 'choice' ? [i.action.formKey] : [])),
  );

  // A return field a document already states, so the reading is only unverified:
  // asking the preparer to type what is printed on the form is the wrong question.
  // The identity turn carries the value; this one is dropped.
  const statedByDocument = new Set<string>();
  for (const item of items) {
    if (item.action?.kind !== 'use_identity') continue;
    if (item.action.role !== 'taxpayer') continue;
    if (item.action.part === 'name') { statedByDocument.add('firstName'); statedByDocument.add('lastName'); }
    if (item.action.part === 'tin') statedByDocument.add('ssn');
    if (item.action.part === 'address') {
      statedByDocument.add('addressStreet');
      statedByDocument.add('addressCity');
      statedByDocument.add('addressState');
      statedByDocument.add('addressZip');
    }
  }

  for (const item of items) {
    if (item.resolution) continue;
    if (incomeHeld && item.id.includes('no-income-sources')) continue;
    if (item.action?.kind === 'return_field' && statedByDocument.has(item.action.field)) continue;
    const turn = turnForItem(item, facts, documents, clientName);
    if (!turn || asked.has(turn.id)) continue;
    asked.add(turn.id);
    turns.push(turn);
  }

  for (const question of questions) {
    // A question about a form that is already waiting on the preparer's decision
    // is not asked again: the answer belongs on that form's card.
    const t = question.target;
    if (t.kind === 'form' && decidedOnForm.has(t.formKey)) continue;
    const id = `client:${question.id}`;
    if (asked.has(id)) continue;
    asked.add(id);
    turns.push(turnForQuestion(question));
  }

  return turns.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** The turns that must be settled before the case can be approved. */
export function blockingTurns(turns: AssistantTurn[]): AssistantTurn[] {
  return turns.filter((t) => t.kind === 'blocked');
}

/** The next thing to work on: the heaviest turn that is not a client question. */
export function nextTurn(turns: AssistantTurn[]): AssistantTurn | undefined {
  return turns.find((t) => t.kind === 'blocked') ?? turns.find((t) => t.kind === 'needed') ?? turns.find((t) => t.kind !== 'note');
}

/** A one-line summary of where the case stands, for the top of the thread. */
export function caseHeadline(turns: AssistantTurn[], clientName: string, documentsRead: number, documentsTotal: number): string {
  if (turns.length === 0) return `${clientName}'s return is complete and ready to approve.`;
  const blocked = blockingTurns(turns).length;
  const ask = turns.filter((t) => t.kind === 'ask').length;
  const rest = turns.length - blocked - ask;
  if (documentsTotal === 0) return `Nothing on the case yet. Drop ${lowerFirst(clientName)}'s documents in and I will read them.`;
  const docs = documentsRead === documentsTotal
    ? `I read all ${documentsTotal} document${documentsTotal === 1 ? '' : 's'}.`
    : `I read ${documentsRead} of ${documentsTotal} documents.`;
  if (turns.length === 1) {
    const only = turns[0]!;
    return `${docs} One thing left: ${only.ask ?? only.say}`;
  }
  const parts = [`${blocked} stop${blocked === 1 ? 's' : ''} this return being finished`];
  if (ask > 0) parts.push(`${ask} only the client can answer`);
  if (rest > 0) parts.push(`${rest} to check`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]!;
  return `${docs} ${list}.`;
}

export { FORM_NAMES };