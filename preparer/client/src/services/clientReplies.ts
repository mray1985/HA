/**
 * Client questions and replies on a case (work order §24, §25).
 *
 * The questions come from the case's unresolved facts (clientQuestions.ts).
 * A reply is read one open question at a time by the local reader model under
 * a grammar, and a value is recorded only when the model and a deterministic
 * reading of the client's own words agree (clientAnswers.ts). A recorded
 * answer is a verified client-response fact, applied through the same tools
 * as any other evidence; everything else stays open for the preparer. The
 * reply itself is kept word for word in the case's audit trail.
 *
 * The same text is read as a note too (clientNotes.ts): new dependents, state
 * moves and estimated payments it states become proposed record-tool calls,
 * holding only values the client's words give, that the preparer accepts.
 */

import {
  clientAnswerPrompt,
  clientAnswerRecord,
  clientAnswerSchema,
  clientQuestionLetter,
  confirmClientAnswer,
  confirmNoteCall,
  describeNoteProposal,
  generateClientQuestions,
  noteCalls,
  proposalIsKnown,
  type NoteProposal,
  type ClientAnswerOutcome,
  type ClientAnswerValue,
  type ClientQuestion,
} from '@hatax/local-ai';
import { getReturn } from '../api/client';
import { appendAudit, appendModelRuns } from './caseAudit';
import { askLocalModel, type ModelRunRecord } from './localModels';
import { recordClientFormAnswer } from './preparerDecisions';
import { loadTaxFacts } from './preparerTaxFacts';
import { describeOutcome, recordEvidence, runReturnChecks } from './recordTools';

/** The questions the case still has for the client. */
export function caseQuestions(returnId: string): ClientQuestion[] {
  const tr = getReturn(returnId);
  return generateClientQuestions({ facts: loadTaxFacts(returnId), taxYear: tr.taxYear, filingStatus: tr.filingStatus ? String(tr.filingStatus) : null });
}

/** The message for the client: what has arrived and the open questions. */
export function caseQuestionLetter(returnId: string): string {
  return clientQuestionLetter(caseQuestions(returnId), loadTaxFacts(returnId));
}

export interface ReplyAnswer {
  question: ClientQuestion;
  outcome: ClientAnswerOutcome;
  /** What recording a confirmed answer did, or why it could not be recorded. */
  recorded?: string;
  error?: string;
}

/** A new fact the reply states (not an answer to an open question), for the preparer to accept. */
export interface NoteOffer {
  id: string;
  proposal: NoteProposal;
  description: string;
  modelRunId?: string;
  extractor: string;
}

export interface ReadReplyResult {
  replyId: string;
  label: string;
  answers: ReplyAnswer[];
  offers: NoteOffer[];
  runs: ModelRunRecord[];
}

const show = (v: ClientAnswerValue) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

function answerLabel(q: ClientQuestion, value: ClientAnswerValue): string {
  if (q.kind === 'months') return `${value} month${value === 1 ? '' : 's'}`;
  if (q.kind === 'days') return `${value} days`;
  if (q.kind === 'amount') return (value as number).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (q.kind === 'residency') return value === 'part_year' ? 'part-year resident' : String(value);
  if (q.kind === 'filing_status') return String(value).replace(/_/g, ' ');
  return show(value);
}

/** Record one confirmed answer where its question says it goes. */
function recordAnswer(returnId: string, q: ClientQuestion, value: ClientAnswerValue, quote: string, source: { replyId: string; index: number; label: string; extractor: string; modelRunId?: string }): { ok: true; detail: string } | { ok: false; error: string } {
  const target = clientAnswerRecord(q, value);
  if (target.kind === 'form') {
    const r = recordClientFormAnswer(returnId, target.formKey, target.tool, target.field, target.value,
      { label: source.label, quote, extractor: source.extractor, ...(source.modelRunId ? { modelRunId: source.modelRunId } : {}) });
    return r.ok ? { ok: true, detail: describeOutcome(r.outcome) } : r;
  }
  const { result, outcome } = recordEvidence(returnId, target.tool, target.args, {
    documentId: source.replyId,
    index: source.index,
    label: source.label,
    kind: 'client_response',
    extractor: source.extractor,
    rawText: { [target.field]: quote },
    verified: true,
    ...(source.modelRunId ? { modelRunId: source.modelRunId } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, detail: target.kind === 'filing_status' ? 'recorded for the preparer to confirm' : describeOutcome(outcome!) };
}

/**
 * Read a client's reply against the case's open questions and record every
 * answer the model and the client's words agree on.
 */
export async function readClientReply(
  returnId: string,
  reply: string,
  onProgress?: (message: string) => void,
  now = new Date(),
): Promise<ReadReplyResult> {
  const text = reply.trim();
  if (!text) throw new Error('The reply is empty.');
  const questions = caseQuestions(returnId);
  const replyId = `REPLY-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const label = `Client reply of ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const names = [...new Set(questions.map((q) => q.subjectName).filter((n): n is string => Boolean(n)))];
  const runs: ModelRunRecord[] = [];
  const answers: ReplyAnswer[] = [];
  const offers: NoteOffer[] = [];
  const tr = getReturn(returnId);

  try {
    for (const [index, q] of questions.entries()) {
      onProgress?.(`Reading the reply for question ${index + 1} of ${questions.length}…`);
      const { content, run } = await askLocalModel({ prompt: clientAnswerPrompt(q, text), name: 'answer', jsonSchema: clientAnswerSchema(q) as Record<string, unknown> }, runs);
      const outcome = confirmClientAnswer(q, text, content, {
        otherNames: names,
        alone: questions.filter((o) => o.kind === q.kind).length === 1,
      });
      if (outcome.status !== 'answered') {
        answers.push({ question: q, outcome });
        continue;
      }
      const recorded = recordAnswer(returnId, q, outcome.value, outcome.quote, {
        replyId, index, label, extractor: `${run?.modelName ?? 'Local reader'} + the client's words`, ...(run ? { modelRunId: run.runId } : {}),
      });
      answers.push(recorded.ok ? { question: q, outcome, recorded: recorded.detail } : { question: q, outcome, error: recorded.error });
    }

    // New facts the text states, offered to the preparer — not ones the answers above just recorded.
    const calls = noteCalls(text, tr.taxYear);
    for (const [i, call] of calls.entries()) {
      onProgress?.(`Reading the reply for new facts (${i + 1} of ${calls.length})…`);
      const { content, run } = await askLocalModel({ prompt: call.prompt, name: call.name, jsonSchema: call.schema as Record<string, unknown> }, runs);
      for (const proposal of confirmNoteCall(call, text, content, tr.taxYear).proposals) {
        if (proposalIsKnown(proposal, loadTaxFacts(returnId), tr.taxYear)) continue;
        offers.push({
          id: `${replyId}:${offers.length}`, proposal, description: describeNoteProposal(proposal),
          extractor: `${run?.modelName ?? 'Local reader'} + the client's words`, ...(run ? { modelRunId: run.runId } : {}),
        });
      }
    }
  } finally {
    appendModelRuns(returnId, runs);
  }

  const answered = answers.filter((a) => a.recorded !== undefined).length;
  appendAudit(returnId, { kind: 'client_reply', replyId, text, answered, left: questions.length - answered, offered: offers.map((o) => o.description) }, now);
  for (const a of answers) {
    appendAudit(returnId, a.recorded !== undefined && a.outcome.status === 'answered'
      ? { kind: 'client_answer', replyId, question: a.question.text, recorded: true, answer: answerLabel(a.question, a.outcome.value), quote: a.outcome.quote, detail: a.recorded }
      : {
        kind: 'client_answer', replyId, question: a.question.text, recorded: false,
        detail: a.error ?? (a.outcome.status === 'unclear' ? a.outcome.reason : 'the reply does not answer it'),
      }, now);
  }
  if (answered > 0) runReturnChecks(returnId);
  return { replyId, label, answers, offers, runs };
}

/**
 * The preparer accepts a fact the reply stated: recorded by its record tool
 * as a verified client response (the words give every value it holds), with
 * the client's words as its source text.
 */
export function acceptNoteOffer(returnId: string, reply: Pick<ReadReplyResult, 'replyId' | 'label'>, offer: NoteOffer, index: number): { ok: true; detail: string } | { ok: false; error: string } {
  const { proposal } = offer;
  const { result, outcome } = recordEvidence(returnId, proposal.tool, proposal.args, {
    documentId: `${reply.replyId}:note`,
    index,
    label: reply.label,
    kind: 'client_response',
    extractor: offer.extractor,
    rawText: Object.fromEntries(Object.keys(proposal.args).map((k) => [k, proposal.quote])),
    verified: true,
    ...(offer.modelRunId ? { modelRunId: offer.modelRunId } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error };
  const detail = describeOutcome(outcome!);
  appendAudit(returnId, { kind: 'client_note', replyId: reply.replyId, accepted: true, description: offer.description, quote: proposal.quote, detail });
  runReturnChecks(returnId);
  return { ok: true, detail };
}

/** The preparer dismisses a fact the reply seemed to state. */
export function dismissNoteOffer(returnId: string, reply: Pick<ReadReplyResult, 'replyId'>, offer: NoteOffer): void {
  appendAudit(returnId, { kind: 'client_note', replyId: reply.replyId, accepted: false, description: offer.description, quote: offer.proposal.quote, detail: 'dismissed by the preparer' });
}

export { answerLabel };
