/**
 * What the assistant does with a typed message.
 *
 * A message is read against the open turns (assistantAnswers.ts) and, when the
 * words settle one of them, written straight onto the case — no confirmation
 * step. Every write goes through the same validated path the review list uses
 * (`preparerDecisions`), so the engine's rules, the fail-closed guarantee and
 * the audit trail are unchanged; the only thing that has gone is the click.
 *
 * When the deterministic reading settles nothing, the message is offered to the
 * client's-reply pipeline, which reads free text against the open questions and
 * proposes any new fact it states. If that cannot run (no local models), the
 * assistant says plainly that it did not understand, and nothing is written.
 */

import { FilingStatus } from '@hatax/engine';
import { appendAudit } from './caseAudit';
import { readAnswer, type ReadAnswer } from './assistantAnswers';
import { readClientReply, type ReadReplyResult } from './clientReplies';
import { loadDocuments } from './documentIngestion';
import { applyAddress, applyIdentityReading, setPersonOnReturn } from './caseIdentity';
import {
  applyStatedFilingStatus,
  completeDependent,
  correctFormField,
  recordChoice,
  recordStateAnswer,
  type DecisionResult,
} from './preparerDecisions';
import { parseReturnField, returnFieldSpec } from './returnFields';
import { flushCaseSave, useCaseStore } from '../store/caseStore';
import type { AssistantTurn, AssistantValue } from './assistantTurns';

/** What one message did. */
export interface AssistantOutcome {
  /** What the assistant says back, in its own words. */
  said: string;
  /** True when the case was written. */
  written: boolean;
  /** The turn it answered, so the card can show what changed. */
  turnId?: string;
  /** The whole reply reading, when free text was read: its answers and the new facts it proposes. */
  reply?: ReadReplyResult;
}

/** The store calls the assistant needs, passed in so this module holds no state of its own. */
export interface AssistantWiring {
  flush: () => void;
  reload: () => void;
  updateField: (field: string, value: unknown) => void;
}

/** The wiring the case store gives the assistant. */
export function storeWiring(): AssistantWiring {
  return {
    flush: flushCaseSave,
    reload: () => useCaseStore.getState().reloadEvidence(),
    updateField: (field, value) => useCaseStore.getState().updateField(field, value),
  };
}

/** Read one message and write whatever it settles. */
export async function sendToAssistant(
  returnId: string,
  text: string,
  turns: AssistantTurn[],
  aiAvailable: boolean,
  onProgress?: (message: string) => void,
): Promise<AssistantOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { said: '', written: false };
  const wiring = storeWiring();
  const read: ReadAnswer = readAnswer(trimmed, turns);

  if (read.status === 'understood') {
    const turn = turns.find((t) => t.id === read.turnId);
    if (!turn) return { said: 'That question is no longer open.', written: false };
    const applied = applyValue(returnId, turn, read.value, read.label, wiring);
    if (!applied.ok) return { said: applied.error, written: false, turnId: read.turnId };
    wiring.flush();
    const result = applied.run();
    wiring.reload();
    if (!result.ok) return { said: result.error, written: false, turnId: read.turnId };
    appendAudit(returnId, { kind: 'decision', subject: 'Assistant', detail: `Typed: "${trimmed}" — ${read.label}` });
    return { said: `${read.label}. Done.`, written: true, turnId: read.turnId };
  }

  if (read.status === 'partial' || read.status === 'unmatched') {
    const why = read.status === 'partial' ? read.reason : read.reason;
    if (aiAvailable) return readAsNote(returnId, trimmed, wiring, onProgress, why);
    return { said: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`, written: false };
  }

  return { said: '', written: false };
}

type ApplyResult =
  | { ok: true; run: () => DecisionResult | { ok: true; outcome: { kind: 'recorded' } } }
  | { ok: false; error: string };

/**
 * Write a value the preparer chose rather than typed (a chip, or a card's
 * field). The same write a typed answer makes — the value is not read back out
 * of any text, so nothing can be misheard between the choice and the return.
 *
 * `wiring` is how the case is written; it defaults to the open case's store, and
 * is passed in by callers holding something else.
 */
export function applyChosen(
  returnId: string,
  turn: AssistantTurn,
  value: AssistantValue,
  label: string,
  wiring: AssistantWiring = storeWiring(),
): AssistantOutcome {
  const applied = applyValue(returnId, turn, value, label, wiring);
  if (!applied.ok) return { said: applied.error, written: false, turnId: turn.id };
  wiring.flush();
  const result = applied.run();
  wiring.reload();
  if (!result.ok) return { said: result.error, written: false, turnId: turn.id };
  appendAudit(returnId, { kind: 'decision', subject: 'Assistant', detail: `${label} — chosen in the assistant` });
  return { said: `${label}. Done.`, written: true, turnId: turn.id };
}

/** The value to write, or why there is none. */
function writable(value: AssistantValue): { ok: true; value: number | boolean | string } | { ok: false } {
  return value.kind === 'nothing' ? { ok: false } : { ok: true, value: value.value };
}

/** Write one value onto the case, through the path the review list already uses. */
function applyValue(
  returnId: string,
  turn: AssistantTurn,
  value: AssistantValue,
  label: string,
  wiring: AssistantWiring,
): ApplyResult {
  const intent = turn.intent;

  switch (intent.kind) {
    case 'held_field': {
      const w = writable(value);
      if (!w.ok) return { ok: false, error: 'I did not get a value for that box.' };
      const v = w.value;
      return { ok: true, run: () => correctFormField(returnId, intent.formKey, intent.field, v) };
    }

    case 'choice': {
      const answer: Record<string, unknown> = {};
      if (value.kind === 'number') answer.qualifiedExpenses = value.value;
      else if (value.kind === 'boolean') answer.usedForQualifiedMedicalExpenses = value.value;
      else if (value.kind === 'text') answer.creditType = value.value;
      return { ok: true, run: () => recordChoice(returnId, intent.formKey, intent.tool, answer) };
    }

    case 'dependent': {
      const person = { firstName: intent.firstName, lastName: intent.lastName };
      // "relationship:child" carries both facts; a bare number is the months.
      if (value.kind === 'text' && value.value.startsWith('relationship:')) {
        return { ok: true, run: () => completeDependent(returnId, person, { relationship: value.value.slice('relationship:'.length) }) };
      }
      if (value.kind === 'number') {
        return { ok: true, run: () => completeDependent(returnId, person, { monthsLivedWithYou: value.value }) };
      }
      return { ok: false, error: 'I did not get a months count or a relationship. Answer one at a time, or use the card.' };
    }

    case 'filing_status': {
      const w = writable(value);
      if (!w.ok || !FILING_SAY[Number(w.value)]) return { ok: false, error: 'I did not get a filing status from that.' };
      const status = Number(w.value) as FilingStatus;
      return { ok: true, run: () => applyStatedFilingStatus(returnId, status, FILING_SAY[status]!) };
    }

    case 'return_field': {
      const spec = returnFieldSpec(intent.field);
      if (!spec) return { ok: false, error: 'That is not a field on the return.' };
      const w = writable(value);
      if (!w.ok) return { ok: false, error: 'I did not get a value for that.' };
      const raw = typeof w.value === 'string' ? w.value : String(w.value);
      const parsed = parseReturnField(spec.kind, spec.kind === 'filing_status' ? (FILING_NUMBERS[raw.trim().toLowerCase()] ?? raw) : raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        run: () => {
          wiring.updateField(intent.field, parsed.value);
          return { ok: true as const, outcome: { kind: 'recorded' as const } };
        },
      };
    }

    case 'state_answer': {
      const question = turn.item?.action?.kind === 'state_answer' ? turn.item.action.question : undefined;
      if (!question) return { ok: false, error: 'That state question is no longer on the case.' };
      const w = writable(value);
      if (!w.ok) return { ok: false, error: 'I did not get an answer for that.' };
      const v = w.value;
      if (question.kind === 'yes_no' && typeof v !== 'boolean') {
        return { ok: false, error: 'That one is a yes or no.' };
      }
      if ((question.kind === 'amount' || question.kind === 'count') && typeof v !== 'number') {
        return { ok: false, error: question.kind === 'amount' ? 'That one is a dollar amount.' : 'That one is a number of days or months.' };
      }
      if (question.kind === 'choice' && typeof v !== 'string') {
        return { ok: false, error: `That one is one of: ${(question.options ?? []).map((o) => o.label).join(', ')}.` };
      }
      return { ok: true, run: () => recordStateAnswer(returnId, question, v) };
    }

    case 'decision':
    case 'use_bank': {
      const accepted = value.kind === 'text' ? value.value === 'accepted' : value.kind === 'boolean' ? value.value : undefined;
      if (accepted === undefined) return { ok: false, error: 'I did not get yes or no.' };
      const itemId = intent.kind === 'decision' ? intent.itemId : turn.id;
      return {
        ok: true,
        run: () => {
          const store = useCaseStore.getState();
          const item = store.review?.items.find((i) => i.id === itemId);
          if (!item) return { ok: false, error: 'That item is no longer open.' };
          store.resolve(item, accepted ? 'accepted' : 'not_applicable', accepted ? 'Confirmed in the assistant.' : 'Not applicable — confirmed in the assistant.');
          return { ok: true as const, outcome: { kind: 'recorded' as const } };
        },
      };
    }

    case 'join_spouse_case': {
      const yes = value.kind === 'boolean' ? value.value : value.kind === 'text' ? value.value === 'accepted' : undefined;
      if (yes === undefined) return { ok: false, error: 'I did not get yes or no.' };
      return {
        ok: true,
        run: () => {
          if (!yes) return { ok: true as const, outcome: { kind: 'recorded' as const } };
          // Joining moves documents between cases: not one synchronous step.
          void import('./spouseCases').then(({ joinSpouseCase }) => joinSpouseCase(returnId, intent.returnId));
          return { ok: true as const, outcome: { kind: 'recorded' as const } };
        },
      };
    }

    case 'acquisition_date':
      return { ok: false, error: 'Enter that date on the card, so it can be checked against the return.' };

    case 'identity': {
      const item = turn.item;
      const action = item?.action;
      if (!item || action?.kind !== 'identity_person' && action?.kind !== 'choose_address' && action?.kind !== 'use_identity') {
        return { ok: false, error: 'Use the choices on the card for that one.' };
      }
      if (action.kind === 'use_identity') {
        // A reading of the taxpayer's identity the second reader did not agree
        // with: the preparer has checked the document, so it goes on.
        const documents = loadDocuments(returnId);
        return {
          ok: true,
          run: () => {
            const used = applyIdentityReading(returnId, documents, action.documentId, action.index, action.part, action.role);
            return used.ok ? { ok: true as const, outcome: { kind: 'recorded' as const } } : used;
          },
        };
      }
      if (action.kind === 'choose_address') {
        if (value.kind !== 'text') return { ok: false, error: 'Choose the address.' };
        return {
          ok: true,
          run: () => {
            const used = applyAddress(returnId, loadDocuments(returnId), value.value);
            return used.ok ? { ok: true as const, outcome: { kind: 'recorded' as const } } : used;
          },
        };
      }
      const key = value.kind === 'text' ? value.value : (action.options.length === 1 ? action.options[0]!.key : undefined);
      if (!key) return { ok: false, error: 'Choose the person.' };
      return {
        ok: true,
        run: () => {
          const placed = setPersonOnReturn(returnId, loadDocuments(returnId), key, action.purpose);
          return placed.ok ? { ok: true as const, outcome: { kind: 'recorded' as const } } : placed;
        },
      };
    }

    case 'document':
      return { ok: false, error: 'Drop that file on the case and I will read it again.' };

    case 'client_question':
      return { ok: false, error: 'That one is for the client. Paste their reply and I will read it.' };

    case 'note':
      return { ok: false, error: 'I did not find a value for any open question in that.' };
  }
}

/** Read the message as free text: the client's-reply pipeline, proposals included. */
async function readAsNote(
  returnId: string,
  text: string,
  wiring: AssistantWiring,
  onProgress: ((message: string) => void) | undefined,
  before: string,
): Promise<AssistantOutcome> {
  wiring.flush();
  try {
    const result = await readClientReply(returnId, text, onProgress);
    const answered = result.answers.filter((a) => a.recorded !== undefined).length;
    const parts: string[] = [];
    if (answered > 0) parts.push(`${answered} answer${answered === 1 ? '' : 's'} recorded`);
    if (result.offers.length > 0) parts.push(`${result.offers.length} new thing${result.offers.length === 1 ? '' : 's'} to add below`);
    const said = parts.length > 0
      ? `${parts.join(', and ')}.`
      : `${before.charAt(0).toUpperCase()}${before.slice(1)}. Paste the client's reply instead, or use the card under the question it belongs to.`;
    return { said, written: answered > 0, reply: result };
  } catch (err) {
    return { said: err instanceof Error ? err.message : 'I could not read that.', written: false };
  }
}

const FILING_SAY: Record<number, string> = {
  [FilingStatus.Single]: 'Single',
  [FilingStatus.MarriedFilingJointly]: 'Married filing jointly',
  [FilingStatus.MarriedFilingSeparately]: 'Married filing separately',
  [FilingStatus.HeadOfHousehold]: 'Head of household',
  [FilingStatus.QualifyingSurvivingSpouse]: 'Qualifying surviving spouse',
};

const FILING_NUMBERS: Record<string, string> = {
  'married filing jointly': String(FilingStatus.MarriedFilingJointly),
  'filing jointly': String(FilingStatus.MarriedFilingJointly),
  joint: String(FilingStatus.MarriedFilingJointly),
  together: String(FilingStatus.MarriedFilingJointly),
  'married filing separately': String(FilingStatus.MarriedFilingSeparately),
  'filing separately': String(FilingStatus.MarriedFilingSeparately),
  'head of household': String(FilingStatus.HeadOfHousehold),
  'qualifying surviving spouse': String(FilingStatus.QualifyingSurvivingSpouse),
  single: String(FilingStatus.Single),
  unmarried: String(FilingStatus.Single),
};