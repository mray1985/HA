/**
 * Client tab (work order §24, §25): the questions the case still has for the
 * client, as a message to send, and the client's reply, read on this computer
 * by the local reader model. Only answers the model and the client's own
 * words agree on are recorded; the rest stay open, with the reason.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleHelp, Copy, MessageSquareText } from 'lucide-react';
import { clientQuestionLetter, generateClientQuestions } from '@hatax/local-ai';
import { fetchModelStatus, type LocalRuntimeStatus } from '../../services/localModels';
import { answerLabel, readClientReply, type ReadReplyResult, type ReplyAnswer } from '../../services/clientReplies';
import { flushCaseSave, useCaseStore } from '../../store/caseStore';

function AnswerLine({ answer }: { answer: ReplyAnswer }) {
  const { question, outcome } = answer;
  if (outcome.status === 'answered' && answer.recorded !== undefined) {
    return (
      <li className="flex gap-2 text-sm">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <span>
          <span className="text-slate-300">{question.text}</span>{' '}
          <span className="text-emerald-300 font-medium">{answerLabel(question, outcome.value)}</span>
          <span className="block text-xs text-slate-500">“{outcome.quote}” — {answer.recorded}</span>
        </span>
      </li>
    );
  }
  const why = answer.error ?? (outcome.status === 'unclear' ? outcome.reason : 'the reply does not answer it');
  return (
    <li className="flex gap-2 text-sm">
      <CircleHelp className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <span>
        <span className="text-slate-300">{question.text}</span>
        <span className="block text-xs text-amber-300">Still open: {why}.</span>
      </span>
    </li>
  );
}

export default function ClientPanel() {
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const facts = useCaseStore((s) => s.facts);
  const audit = useCaseStore((s) => s.audit);
  const reloadEvidence = useCaseStore((s) => s.reloadEvidence);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReadReplyResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [runtime, setRuntime] = useState<LocalRuntimeStatus | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void fetchModelStatus().then((status) => { if (live) setRuntime(status); });
    return () => { live = false; };
  }, []);

  const questions = useMemo(
    () => (taxReturn ? generateClientQuestions({ facts, taxYear: taxReturn.taxYear, filingStatus: taxReturn.filingStatus ? String(taxReturn.filingStatus) : null }) : []),
    [facts, taxReturn],
  );
  const letter = useMemo(() => clientQuestionLetter(questions, facts), [questions, facts]);
  const replies = useMemo(() => audit.filter((e) => e.kind === 'client_reply').reverse(), [audit]);

  if (!returnId || !taxReturn) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The message could not be copied; select it and copy it by hand.');
    }
  };

  const read = async () => {
    setError(null);
    setResult(null);
    // An edit made on another tab is saved before the reply's answers are recorded.
    flushCaseSave();
    try {
      setResult(await readClientReply(returnId, reply, setBusy));
      setReply('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The reply could not be read.');
    } finally {
      setBusy(null);
      reloadEvidence();
    }
  };

  const available = runtime?.available === true;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-white font-semibold">Questions for the client</h2>
          {questions.length > 0 && (
            <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
              <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy message'}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-1">Asked only for what the documents on the case do not settle.</p>
        <pre aria-label="Message to the client" className="mt-4 whitespace-pre-wrap text-sm text-slate-200 bg-surface-900 rounded-lg border border-slate-700 p-4 font-sans">{letter}</pre>
      </section>

      <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        <h2 className="text-white font-semibold flex items-center gap-2"><MessageSquareText className="w-4 h-4" /> The client's reply</h2>
        <p className="text-xs text-slate-400 mt-1">
          Paste the client's reply. It is read on this computer, one open question at a time; an answer is recorded only when the
          model and the client's own words agree, and the reply is kept word for word in the audit trail.
        </p>
        {runtime !== undefined && !available && (
          <p className="text-xs text-amber-300 mt-2">
            Local AI unavailable{runtime ? ` — ${runtime.reason}` : ''}. Enter the client's answers from the Review tab.
          </p>
        )}
        <textarea
          aria-label="Client's reply"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={6}
          className="mt-3 w-full bg-surface-900 border border-slate-600 rounded-lg p-3 text-sm text-white"
          placeholder="Hi! Maya lived with us all year…"
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="text-xs text-slate-400" role="status">{busy ?? ''}</span>
          <button
            type="button"
            onClick={() => void read()}
            disabled={!available || !reply.trim() || questions.length === 0 || busy !== null}
            className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-40 text-white rounded px-4 py-2"
          >
            Read reply
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-red-300 mt-3">{error}</p>}
        {result && (
          <div className="mt-4">
            <p className="text-sm text-white">
              {result.answers.filter((a) => a.recorded !== undefined).length} of {result.answers.length} question{result.answers.length === 1 ? '' : 's'} answered
            </p>
            <ul className="mt-2 flex flex-col gap-2" aria-label="Answers read from the reply">
              {result.answers.map((a) => <AnswerLine key={a.question.id} answer={a} />)}
            </ul>
          </div>
        )}
      </section>

      {replies.length > 0 && (
        <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
          <h2 className="text-white font-semibold">Replies received</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {replies.map((r) => r.kind === 'client_reply' && (
              <li key={r.replyId} className="text-sm">
                <p className="text-xs text-slate-400">{new Date(r.at).toLocaleString()} — {r.answered} answered, {r.left} left open</p>
                <p className="text-slate-300 whitespace-pre-wrap">{r.text}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
