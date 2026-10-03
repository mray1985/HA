/**
 * The Assistant tab: one conversation per case.
 *
 * Everything the case still needs is a turn in the thread, in plain words, most
 * blocking first. Each turn carries what it needs and three ways to give it: a
 * chip to click, a field form, or a type into the box at the bottom. Whatever is
 * given is written straight onto the case — the same validated writes the
 * checklist used to make, with the confirmation step taken out.
 *
 * The thread is projected from the case, not stored: what is written, what is
 * still open and what the preparer said afterwards are recomputed from the case
 * every render, so it can never drift from the return.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowRight, CheckCircle2, CircleHelp, FileText, Loader2,
  MessageSquarePlus, Send, Sparkles,
} from 'lucide-react';
import { clientQuestionLetter, generateClientQuestions } from '@hatax/local-ai';
import { assistantTurns, caseHeadline, nextTurn, type AssistantOption, type AssistantTurn } from '../../services/assistantTurns';
import { applyChosen, sendToAssistant } from '../../services/assistantChat';
import { fetchModelStatus, type LocalRuntimeStatus } from '../../services/localModels';
import { acceptNoteOffer, dismissNoteOffer, type ReadReplyResult } from '../../services/clientReplies';
import { nextCase } from '../../services/caseQueue';
import { loadSpoken, saveSpoken } from '../../services/assistantThread';
import ReviewActionForm, { ReturnFieldsForm } from './ReviewActions';
import type { ReviewItem } from '../../services/caseReview';
import { useCaseStore } from '../../store/caseStore';
import { refundOrOwed } from './caseBadges';

/** One thing the preparer said, and what came of it. */
interface Spoken {
  id: string;
  text: string;
  said: string;
  written: boolean;
}

const KIND_STYLES: Record<AssistantTurn['kind'], { border: string; icon: React.ReactNode; chip: string }> = {
  blocked: { border: 'border-red-500/40', icon: <AlertTriangle className="w-4 h-4 text-red-400" aria-hidden />, chip: 'bg-red-500/10 text-red-200 border-red-500/30' },
  needed: { border: 'border-amber-500/40', icon: <CircleHelp className="w-4 h-4 text-amber-400" aria-hidden />, chip: 'bg-amber-500/10 text-amber-200 border-amber-500/30' },
  ask: { border: 'border-sky-500/40', icon: <MessageSquarePlus className="w-4 h-4 text-sky-400" aria-hidden />, chip: 'bg-sky-500/10 text-sky-200 border-sky-500/30' },
  check: { border: 'border-slate-700', icon: <CircleHelp className="w-4 h-4 text-slate-400" aria-hidden />, chip: 'bg-slate-700/60 text-slate-200 border-slate-600' },
  note: { border: 'border-slate-800', icon: <CircleHelp className="w-4 h-4 text-slate-500" aria-hidden />, chip: 'bg-slate-800 text-slate-300 border-slate-700' },
};

/** The chips under a turn: what it is offering, in one click. */
function OptionChips({ turn, onTake, disabled }: { turn: AssistantTurn; onTake: (o: AssistantOption) => void; disabled: boolean }) {
  if (!turn.options || turn.options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="One-click answers">
      {turn.options.map((o, i) => (
        <button
          key={`${o.label}-${i}`}
          type="button"
          disabled={disabled}
          onClick={() => onTake(o)}
          title={o.note}
          className={`rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:brightness-125 ${KIND_STYLES[turn.kind].chip}`}
        >
          {o.label}
          {o.note && <span className="ml-1.5 text-[11px] font-normal opacity-70">{o.note}</span>}
        </button>
      ))}
    </div>
  );
}

/** Quick decisions: the note is what the preparer attests to, kept in the audit trail. */
const QUICK_DECISIONS: ReadonlyArray<{ decision: 'accepted' | 'not_applicable'; label: string; note: string }> = [
  { decision: 'accepted', label: 'Checked against the document', note: 'Checked against the source document.' },
  { decision: 'accepted', label: 'Confirmed with the client', note: 'Confirmed with the client.' },
  { decision: 'not_applicable', label: 'Does not apply to this client', note: 'Not applicable to this client.' },
];

/** Say what was checked, for a warning or review item that is not a value. */
function ResolveForm({ item, onDone, onResolve }: {
  item: ReviewItem;
  onDone: () => void;
  onResolve: (decision: 'accepted' | 'not_applicable', note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-slate-700 bg-surface-900 p-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick decisions">
        {QUICK_DECISIONS.map((q) => (
          <button
            key={q.note}
            type="button"
            onClick={() => { onResolve(q.decision, q.note); onDone(); }}
            className="text-xs rounded-full border border-slate-600 px-3 py-1 text-slate-200 hover:border-HATaxService-orange-500 hover:text-white"
          >
            {q.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Or write what you checked (kept in the case's history):</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        aria-label="What you checked"
        placeholder="What you checked"
        className="bg-surface-700 border border-slate-600 text-white placeholder-slate-500 text-sm rounded px-2 py-1.5"
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onDone} className="text-sm text-slate-400 hover:text-white px-3 py-1.5">Cancel</button>
        <button
          type="button"
          disabled={!note.trim()}
          onClick={() => { onResolve('accepted', note); onDone(); }}
          className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-40 text-white rounded px-3 py-1.5"
        >
          Record it
        </button>
      </div>
    </div>
  );
}

/** The card for one turn. */
function TurnCard({ turn, focused, onTake, busy, onPasteReply }: {
  turn: AssistantTurn;
  focused: boolean;
  onTake: (turn: AssistantTurn, option: AssistantOption) => void;
  busy: boolean;
  /** Scroll to the client's reply box. */
  onPasteReply: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const showDocument = useCaseStore((s) => s.showDocument);
  const resolve = useCaseStore((s) => s.resolve);
  const style = KIND_STYLES[turn.kind];
  const action = turn.item?.action;
  const item = turn.item;
  // A turn waiting on a value or a decision has to be settled by giving it, not
  // by ticking it off. Only a turn that merely states something can be checked.
  const canDecide = Boolean(item) && !action
    && (item!.category === 'WARNING' || item!.category === 'REVIEW') && !item!.resolution;

  return (
    <li
      id={`turn-${turn.id}`}
      className={`rounded-xl border bg-surface-800 p-4 ${focused ? 'border-HATaxService-orange-500/70 ring-1 ring-HATaxService-orange-500/30' : style.border}`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{style.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-200">{turn.say}</p>
          {turn.ask && <p className="text-sm text-white font-medium mt-1">{turn.ask}</p>}
          {item?.resolution && (
            <p className="text-xs text-emerald-300/90 mt-1">Decided: {item.resolution.note}</p>
          )}
          {turn.why && !item?.resolution && (
            <details className="mt-1.5">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300">Why I am asking</summary>
              <p className="text-xs text-slate-400 mt-1">{turn.why}</p>
            </details>
          )}

          <OptionChips turn={turn} disabled={busy} onTake={(o) => onTake(turn, o)} />

          <div className="flex flex-wrap gap-3 mt-3 text-xs">
            {turn.documentId && (
              <button type="button" onClick={() => showDocument(turn.documentId!)} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200">
                <FileText className="w-3.5 h-3.5" /> Look at the document
              </button>
            )}
            {action && action.kind !== 'return_field' && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="text-emerald-300 hover:text-emerald-200">
                {open ? 'Close' : 'Enter it by hand'}
              </button>
            )}
            {action?.kind === 'return_field' && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="text-emerald-300 hover:text-emerald-200">
                {open ? 'Close' : 'Open the field'}
              </button>
            )}
            {canDecide && !deciding && (
              <button type="button" onClick={() => setDeciding(true)} className="text-HATaxService-orange-400 hover:text-HATaxService-orange-300">
                I have checked this
              </button>
            )}
            {turn.kind === 'ask' && (
              <button type="button" onClick={onPasteReply} className="text-sky-300 hover:text-sky-200">
                Paste their reply
              </button>
            )}
          </div>

          {deciding && item && (
            <ResolveForm item={item} onDone={() => setDeciding(false)} onResolve={(decision, note) => resolve(item, decision, note)} />
          )}
          {open && action?.kind === 'return_field' && (
            <ReturnFieldsForm fields={[action.field]} onDone={() => { setOpen(false); useCaseStore.getState().reloadEvidence(); }} />
          )}
          {open && action && action.kind !== 'return_field' && (
            <ReviewActionForm
              action={action}
              onDone={() => { setOpen(false); useCaseStore.getState().reloadEvidence(); }}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** A new case's identity, entered in one form rather than one card per field. */
function EnterAllFields({ fields }: { fields: string[] }) {
  const [open, setOpen] = useState(false);
  if (fields.length < 2) return null;
  return open
    ? <div className="px-0 pb-3"><ReturnFieldsForm fields={fields} onDone={() => setOpen(false)} /></div>
    : (
      <div className="px-4 pt-3">
        <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-emerald-300 hover:text-emerald-200">
          Enter all {fields.length} details at once
        </button>
      </div>
    );
}

export default function AssistantPanel() {
  const navigate = useNavigate();
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const review = useCaseStore((s) => s.review);
  const facts = useCaseStore((s) => s.facts);
  const documents = useCaseStore((s) => s.documents);
  const missingDocuments = useCaseStore((s) => s.missingDocuments);
  const intakeBusy = useCaseStore((s) => s.intakeBusy);
  const approve = useCaseStore((s) => s.approve);

  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The conversation is kept on the case, not in this component: switching tabs
  // or reloading unmounts the panel, and a thread that forgets what the preparer
  // said is not one conversation per case.
  const [spoken, setSpoken] = useState<Spoken[]>(() => (returnId ? loadSpoken(returnId) : []));
  const [runtime, setRuntime] = useState<LocalRuntimeStatus | null | undefined>(undefined);
  const [offers, setOffers] = useState<ReadReplyResult['offers']>([]);
  /** The reply the offers came from, so accepting one writes against the right record. */
  const [offerReply, setOfferReply] = useState<ReadReplyResult | null>(null);
  const [reply, setReply] = useState('');
  const [offerStates, setOfferStates] = useState<Record<string, 'accepted' | 'dismissed' | 'Held for you'>>({});
  /** Why a fact was recorded but not put on the return, per offer. */
  const [offerHeld, setOfferHeld] = useState<Record<string, string | undefined>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void fetchModelStatus().then((s) => { if (live) setRuntime(s); });
    return () => { live = false; };
  }, []);

  const clientName = useMemo(
    () => [taxReturn?.firstName, taxReturn?.lastName].filter(Boolean).join(' ') || 'this client',
    [taxReturn?.firstName, taxReturn?.lastName],
  );

  const questions = useMemo(
    () => (taxReturn ? generateClientQuestions({ facts, taxYear: taxReturn.taxYear, filingStatus: taxReturn.filingStatus ? String(taxReturn.filingStatus) : null, missingDocuments }) : []),
    [facts, taxReturn, missingDocuments],
  );

  const turns = useMemo(
    () => assistantTurns({ items: review?.items ?? [], facts, documents, questions, clientName, intakeBusy, caseEmpty: documents.length === 0 && facts.length === 0 }),
    [review?.items, facts, documents, questions, clientName, intakeBusy],
  );

const counts = useMemo(() => {
    const onCase = documents.filter((d) => d.status !== 'duplicate' && d.status !== 'rejected');
    return { read: onCase.filter((d) => d.status === 'extracted').length, total: onCase.length };
  }, [documents]);

  /** The return fields still empty, so they can be entered in one form. */
  const returnFields = useMemo(
    () => turns.flatMap((t) => (t.intent.kind === 'return_field' ? [t.intent.field] : [])),
    [turns],
  );

const upNext = nextTurn(turns);
  const federal = refundOrOwed(calculation?.form1040);
  const canApprove = review?.canApprove === true;
  const aiAvailable = runtime?.available === true;

  // An explanation linked to a part of the return: bring the first turn about it into view.
  const focusedGroup = useCaseStore((s) => s.focusedReviewGroup);
  const focusedTurn = focusedGroup ? turns.find((t) => t.item?.group === focusedGroup) : undefined;
  useEffect(() => {
    if (!focusedTurn) return;
    document.getElementById(`turn-${focusedTurn.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusedTurn?.id]);

  useEffect(() => {
    // Opening a case shows where it stands, not the bottom of the thread. Scrolling
    // happens when the preparer says something, so they see what came of it.
    if (spoken.length > 0) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [spoken.length]);

  if (!returnId || !taxReturn || !review) return null;

  /** Add to the conversation, and keep it on the case. */
  const record = (id: string, text: string, said: string, written: boolean) => {
    setSpoken((s) => {
      const next = [...s, { id: `${Date.now()}-${s.length}`, text, said, written }];
      saveSpoken(id, next);
      return next;
    });
  };

  /** Send one message: written straight onto the case, or read as free text. */
  const say = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy !== null) return;
    setTyped('');
    setBusy('Reading that…');
    try {
      const outcome = await sendToAssistant(returnId, trimmed, turns, aiAvailable, setBusy);
      record(returnId, trimmed, outcome.said, outcome.written);
      if (outcome.reply) {
        setOffers(outcome.reply.offers);
        setOfferReply(outcome.reply);
      }
      if (outcome.written) toast.success(outcome.said);
    } catch (err) {
      record(returnId, trimmed, err instanceof Error ? err.message : 'That did not work.', false);
    } finally {
      setBusy(null);
    }
  };

/** Take a chip's value: written straight onto the case, with nothing to confirm. */
  const take = async (turn: AssistantTurn, option: AssistantOption) => {
    if (busy !== null) return;
    setBusy('Applying that…');
    try {
      const outcome = await applyChosen(returnId, turn, option.value, option.label);
      if (outcome.written) toast.success(outcome.said);
      else toast.error(outcome.said);
    } finally {
      setBusy(null);
    }
  };

  /** Read the client's pasted reply. */
  const readReply = async () => {
    const text = reply.trim();
    if (!text || busy !== null) return;
    setReply('');
    setBusy('Reading the reply…');
    try {
      const outcome = await sendToAssistant(returnId, text, turns, true, setBusy);
      setSpoken((s) => [...s, { id: `${Date.now()}-${s.length}`, text, said: outcome.said, written: outcome.written }]);
      if (outcome.reply) {
        setOffers(outcome.reply.offers);
        setOfferReply(outcome.reply);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The reply could not be read.');
    } finally {
      setBusy(null);
    }
  };

  const goNext = () => {
    const next = nextCase(returnId);
    if (next) navigate(`/preparer/case/${next.id}`);
    else { toast.success('No other case needs you right now'); navigate('/preparer'); }
  };

return (
    <div className="flex flex-col gap-5">
      {/* ── Where the case stands ── */}
      <section aria-label="Where the case stands" className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-HATaxService-orange-400" aria-hidden />
              {taxReturn.firstName || taxReturn.lastName ? `${clientName}'s ${taxReturn.taxYear} return` : 'A new case'}
            </h2>
            <p className="text-sm text-slate-300 mt-1">
              {intakeBusy ? intakeBusy : caseHeadline(turns, clientName, counts.read, counts.total)}
            </p>
            {!intakeBusy && upNext && <p className="text-xs text-slate-400 mt-1">Start here: {upNext.ask ?? upNext.say}</p>}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Federal {taxReturn.taxYear}</p>
              <p className={`text-sm font-medium ${federal.className}`}>{federal.text}</p>
            </div>
            {review.approval ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><CheckCircle2 className="w-4 h-4" /> Approved</span>
            ) : canApprove ? (
              <button type="button" onClick={() => { approve(); toast.success('Case approved'); }} className="bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg">
                Approve
              </button>
            ) : null}
            <button type="button" onClick={goNext} className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
              Next case <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

{/* ── The thread ── */}
      <section aria-label="What the case needs" className="flex flex-col gap-3">
        {returnFields.length >= 2 && !intakeBusy && (
          <div className="rounded-xl border border-slate-700 bg-surface-800">
            <EnterAllFields fields={returnFields} />
          </div>
        )}
        {turns.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/40 bg-surface-800 p-6 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-white font-medium">Nothing is open.</p>
              <p className="text-sm text-slate-300 mt-0.5">
                Every document on this case is read and every question the documents left has been answered.
                {canApprove ? ' It is ready to approve.' : ''}
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
{turns.map((turn) => (
              <TurnCard
                key={turn.id}
                turn={turn}
                focused={focusedTurn?.id === turn.id}
                busy={busy !== null}
                onTake={take}
                onPasteReply={() => document.getElementById('client-reply')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── What the preparer said, and what came of it ── */}
      {spoken.length > 0 && (
        <section aria-label="What you typed" className="rounded-xl border border-slate-700 bg-surface-800 p-4">
          <h3 className="text-sm font-semibold text-white mb-3">This conversation</h3>
          <ul className="flex flex-col gap-3">
            {spoken.map((s) => (
              <li key={s.id} className="text-sm">
                <p className="text-white">“{s.text}”</p>
                <p className={`text-xs mt-0.5 ${s.written ? 'text-emerald-300' : 'text-amber-300'}`}>{s.said}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── New facts a reply stated ── */}
{offers.length > 0 && offerReply && (
        <section aria-label="New facts to add" className="rounded-xl border border-slate-700 bg-surface-800 p-4">
          <h3 className="text-sm font-semibold text-white mb-1">New things that were said</h3>
          <p className="text-xs text-slate-400 mb-3">Add the ones that are right. Each is only what the words actually say.</p>
          <ul className="flex flex-col gap-2">
            {offers.map((offer) => (
              <li key={offer.id} className="text-sm rounded-lg border border-slate-700 bg-surface-900 p-3">
                <p className="text-white">{offer.description}</p>
                <p className="text-xs text-slate-500">“{offer.proposal.quote}”</p>
                {offer.proposal.dropped.length > 0 && <p className="text-xs text-slate-400">Not in the words, so left unknown: {offer.proposal.dropped.join(', ')}.</p>}
                {offerStates[offer.id] ? (
                  <p className={`text-xs mt-2 ${offerStates[offer.id] === 'accepted' ? 'text-emerald-300' : 'text-slate-400'}`}>
                    {offerStates[offer.id] === 'accepted' ? 'Added to the return.' : offerStates[offer.id]}
                    {offerHeld[offer.id] && <span className="block text-amber-300/90">{offerHeld[offer.id]}</span>}
                  </p>
                ) : (
                  <div className="mt-2 flex gap-2 justify-end">
<button type="button" onClick={() => { dismissNoteOffer(returnId, offerReply, offer); setOfferStates((s) => ({ ...s, [offer.id]: 'dismissed' })); useCaseStore.getState().reloadEvidence(); }} className="text-sm text-slate-400 hover:text-white px-3 py-1">
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const r = useCaseStore.getState().act((id) => {
                          const accepted = acceptNoteOffer(id, offerReply, offer, offers.indexOf(offer));
                          return accepted.ok ? { ok: true, outcome: { kind: 'recorded' as const } } : accepted;
                        });
                        if (!r.ok) {
                          setOfferStates((s) => ({ ...s, [offer.id]: 'dismissed' }));
                          toast.error(r.error);
                          return;
                        }
                        // A fact can be recorded and still be held off the return —
                        // a business expense waits for its Schedule C line, its
                        // category, and its business. Saying "Added" when it was
                        // held would tell the preparer it is on the return when it
                        // is not.
                        const outcome = r.outcome;
                        const held = outcome.kind === 'held' ? (outcome as { reason?: string }).reason : undefined;
                        setOfferHeld((s) => ({ ...s, [offer.id]: held }));
                        setOfferStates((s) => ({ ...s, [offer.id]: held ? 'Held for you' : 'accepted' }));
                        if (held) toast.error(held); else toast.success('Added to the return');
                      }}
                      className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white rounded px-3 py-1"
                    >
                      Add
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── The client's reply ── */}
      {questions.length > 0 && !intakeBusy && (
        <section aria-label="Ask the client" className="rounded-xl border border-slate-700 bg-surface-800 p-4">
          <h3 className="text-sm font-semibold text-white">Ask {clientName}</h3>
          <p className="text-xs text-slate-400 mt-0.5">Only what the documents on the case do not settle.</p>
          <pre className="mt-3 whitespace-pre-wrap text-sm text-slate-200 bg-surface-900 rounded-lg border border-slate-700 p-4 font-sans">
            {clientQuestionLetter(questions, facts)}
          </pre>
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-xs text-slate-400" role="status">{busy ?? ''}</span>
            <button type="button" onClick={() => { void navigator.clipboard.writeText(clientQuestionLetter(questions, facts)).then(() => toast.success('Message copied')); }} className="text-xs text-slate-300 hover:text-white">
              Copy the message
            </button>
          </div>
          {aiAvailable ? (
            <textarea
              id="client-reply"
              aria-label="The client's reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={4}
              className="mt-3 w-full bg-surface-900 border border-slate-600 rounded-lg p-3 text-sm text-white"
              placeholder="Paste their reply here and I will read it."
            />
          ) : (
            <p className="mt-3 text-xs text-amber-300">
              The local AI is not running{runtime?.reason ? ` — ${runtime.reason}` : ''}, so I cannot read a reply on this machine. Answer for them below instead, or start the models from the Documents tab.
            </p>
          )}
          {aiAvailable && (
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => void readReply()} disabled={!reply.trim() || busy !== null} className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-40 text-white rounded px-4 py-2">
                Read their reply
              </button>
            </div>
          )}
        </section>
      )}

<div ref={endRef} />

      {/* ── The box to type in. Stuck to the bottom of the view, but in the flow,
           so it can never sit on top of the client's reply box. ── */}
      <div className="sticky bottom-0 z-30 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-2 pb-4 bg-gradient-to-t from-surface-900 via-surface-900 to-transparent">
        <div className="rounded-xl border border-slate-700 bg-surface-800 shadow-xl p-2 flex gap-2 items-end">
          <textarea
            aria-label="Type an answer"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void say(typed); }
            }}
            rows={1}
            className="flex-1 bg-transparent border-0 text-sm text-white px-2 py-2 resize-none outline-none"
            placeholder={upNext ? `Answer: ${upNext.ask ?? upNext.say}` : 'Type a value, a name, or a note…'}
          />
          <button
            type="button"
            onClick={() => void say(typed)}
            disabled={!typed.trim() || busy !== null}
            className="shrink-0 inline-flex items-center gap-1.5 bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg px-3 py-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />}
            Send
          </button>
        </div>
        <p className="text-[11px] text-slate-500 text-right mt-1">Enter sends · every change is in the case's history</p>
      </div>
    </div>
  );
}