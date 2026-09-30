/**
 * Review tab: the case's return summary and review checklist (work order §36,
 * §37, §69). The summary says where the case stands — documents read, the
 * federal and state results, what is open, what may be missing, the change
 * from last year — with approval and the next case one click away. Each
 * checklist group shows what is open; a preparer fills a missing field in
 * place, opens the evidence, answers what a form cannot say, or records a
 * decision on a warning or review item.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, FileText, RotateCcw, ShieldCheck } from 'lucide-react';
import { DIAGNOSTIC_CATEGORIES, type DiagnosticCategory } from '@hatax/engine';
import { REVIEW_GROUPS, type ReviewItem, type ReviewResolution } from '../../services/caseReview';
import { nextCase } from '../../services/caseQueue';
import { useCaseStore } from '../../store/caseStore';
import { CATEGORY_META, CategoryBadge, refundOrOwed } from './caseBadges';
import ReviewActionForm, { actionLabel, ReturnFieldsForm } from './ReviewActions';

const DECISIONS: Array<{ value: ReviewResolution['decision']; label: string }> = [
  { value: 'accepted', label: 'Checked — correct as is' },
  { value: 'not_applicable', label: 'Not applicable to this client' },
];

/** One-click decisions: the note is what the preparer attests to, kept in the audit trail. */
const QUICK_DECISIONS: Array<{ decision: ReviewResolution['decision']; note: string }> = [
  { decision: 'accepted', note: 'Checked against the source document.' },
  { decision: 'accepted', note: 'Confirmed with the client.' },
  { decision: 'not_applicable', note: 'Not applicable to this client.' },
];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function ResolveForm({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const resolve = useCaseStore((s) => s.resolve);
  const [decision, setDecision] = useState<ReviewResolution['decision']>('accepted');
  const [note, setNote] = useState('');
  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg border border-slate-700 bg-surface-900 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return;
        resolve(item, decision, note);
        onDone();
      }}
    >
      <div className="flex flex-wrap gap-2" aria-label="Quick decisions">
        {QUICK_DECISIONS.map((q) => (
          <button
            key={q.note}
            type="button"
            onClick={() => { resolve(item, q.decision, q.note); onDone(); }}
            className="text-xs rounded-full border border-slate-600 px-3 py-1 text-slate-200 hover:border-HATaxService-orange-500 hover:text-white"
          >
            {q.note.replace(/\.$/, '')}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Or write what you checked:</p>
      <select
        value={decision}
        onChange={(e) => setDecision(e.target.value as ReviewResolution['decision'])}
        className="bg-surface-700 border border-slate-600 text-white text-sm rounded px-2 py-1.5"
        aria-label="Decision"
      >
        {DECISIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && note.trim()) {
            e.preventDefault();
            resolve(item, decision, note);
            onDone();
          }
        }}
        rows={2}
        placeholder="What you checked (kept in the case's audit trail)"
        className="bg-surface-700 border border-slate-600 text-white placeholder-slate-500 text-sm rounded px-2 py-1.5"
        aria-label="Note"
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onDone} className="text-sm text-slate-400 hover:text-white px-3 py-1.5">Cancel</button>
        <button
          type="submit"
          disabled={!note.trim()}
          className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-40 text-white rounded px-3 py-1.5"
        >
          Record decision
        </button>
      </div>
    </form>
  );
}

function ItemRow({ item }: { item: ReviewItem }) {
  const requestTab = useCaseStore((s) => s.requestTab);
  const showDocument = useCaseStore((s) => s.showDocument);
  const reopen = useCaseStore((s) => s.reopen);
  const [resolving, setResolving] = useState(false);
  const [acting, setActing] = useState(false);
  const resolvable = item.category === 'WARNING' || item.category === 'REVIEW';
  const muted = item.category === 'INFORMATIONAL' || Boolean(item.resolution);

  return (
    <li className={`px-4 py-3 ${muted ? 'opacity-75' : ''}`}>
      <div className="flex items-start gap-3">
        <CategoryBadge category={item.category} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-200">{item.message}</p>
          {item.itemLabel && <p className="text-xs text-slate-500 mt-0.5">{item.itemLabel}</p>}
          {item.resolution && (
            <p className="text-xs text-emerald-300/90 mt-1">
              {DECISIONS.find((d) => d.value === item.resolution!.decision)?.label}: {item.resolution.note}
            </p>
          )}
          <div className="flex flex-wrap gap-3 mt-2">
            {item.action && !item.resolution && !acting && (
              <button onClick={() => { setActing(true); setResolving(false); }} className="text-xs font-medium text-emerald-300 hover:text-emerald-200">
                {actionLabel(item.action)}
              </button>
            )}
            {resolvable && !item.resolution && !resolving && (
              <button onClick={() => { setResolving(true); setActing(false); }} className="text-xs text-HATaxService-orange-400 hover:text-HATaxService-orange-300">
                Record a decision
              </button>
            )}
            {item.documentId && (
              <button onClick={() => showDocument(item.documentId!)} className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200">
                <FileText className="w-3.5 h-3.5" /> Open the document
              </button>
            )}
            {item.field && item.action?.kind !== 'return_field' && (
              <button onClick={() => requestTab('return')} className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200">
                <ExternalLink className="w-3.5 h-3.5" /> Open the return
              </button>
            )}
            {item.resolution && (
              <button onClick={() => reopen(item.id)} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white">
                <RotateCcw className="w-3 h-3" /> Reopen
              </button>
            )}
          </div>
          {acting && item.action && (item.action.kind === 'return_field'
            ? <ReturnFieldsForm fields={[item.action.field]} onDone={() => setActing(false)} />
            : <ReviewActionForm action={item.action} onDone={() => setActing(false)} />)}
          {resolving && <ResolveForm item={item} onDone={() => setResolving(false)} />}
        </div>
      </div>
    </li>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <div className="text-sm text-white mt-0.5">{children}</div>
    </div>
  );
}

const pct = (now: number, before: number) => (before > 0 ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%` : null);

/** §37: the return summary — where the case stands, with approval and the next case one click away. */
function ReturnSummary() {
  const navigate = useNavigate();
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const review = useCaseStore((s) => s.review);
  const documents = useCaseStore((s) => s.documents);
  const missingDocuments = useCaseStore((s) => s.missingDocuments);
  const approve = useCaseStore((s) => s.approve);
  if (!taxReturn || !review) return null;

  const onCase = documents.filter((d) => d.status !== 'duplicate' && d.status !== 'rejected');
  const read = onCase.filter((d) => d.status === 'extracted').length;
  const federal = refundOrOwed(calculation?.form1040);
  const states = calculation?.stateResults ?? [];
  const counts = DIAGNOSTIC_CATEGORIES.map((c) => [c, review.open.filter((i) => i.category === c).length] as [DiagnosticCategory, number]).filter(([, n]) => n > 0);
  const info = review.items.filter((i) => i.category === 'INFORMATIONAL').length;
  const missing = missingDocuments.filter((m) => m.status !== 'client_says_none').length;
  const prior = taxReturn.priorYearSummary?.taxYear === taxReturn.taxYear - 1 ? taxReturn.priorYearSummary : undefined;
  const f = calculation?.form1040;

  const goNext = () => {
    const next = nextCase(returnId);
    if (next) navigate(`/preparer/case/${next.id}`);
    else {
      toast.success('No other case needs you right now');
      navigate('/preparer');
    }
  };

  return (
    <section aria-label="Return summary" className="rounded-xl border border-slate-700 bg-surface-800 p-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Documents">
          {onCase.length === 0 ? <span className="text-slate-400">None yet</span> : `${read} of ${onCase.length} read`}
          {missing > 0 && <span className="block text-xs text-amber-300">{missing} possibly missing</span>}
        </Stat>
        <Stat label={`Federal ${taxReturn.taxYear}`}>
          <span className={federal.className}>{federal.text}</span>
          {prior && f && <span className="block text-xs text-slate-400">{prior.taxYear}: {prior.refundAmount > 0 ? `refund ${money.format(prior.refundAmount)}` : prior.amountOwed > 0 ? `owed ${money.format(prior.amountOwed)}` : 'even'}</span>}
        </Stat>
        <Stat label="State">
          {states.length === 0 ? <span className="text-slate-400">None</span> : states.map((s) => (
            <span key={s.stateCode} className={`block ${s.stateRefundOrOwed >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {s.stateCode} {s.stateRefundOrOwed >= 0 ? 'refund' : 'owes'} {money.format(Math.abs(s.stateRefundOrOwed))}
            </span>
          ))}
        </Stat>
        <Stat label="Open">
          {counts.length === 0 ? <span className="text-emerald-300">Nothing</span> : counts.map(([c, n]) => (
            <span key={c} className="block">{n} {CATEGORY_META[c].label.toLowerCase()}</span>
          ))}
          {info > 0 && <span className="block text-xs text-slate-400">{info} for information</span>}
        </Stat>
      </div>
      {prior && f && (
        <p className="text-xs text-slate-400 mt-4">
          Since {prior.taxYear}: AGI {money.format(prior.agi)} → {money.format(f.agi)}{pct(f.agi, prior.agi) ? ` (${pct(f.agi, prior.agi)})` : ''}
          {prior.totalWages !== undefined && prior.totalWages > 0 && ` · wages ${pct(f.totalWages, prior.totalWages)}`}
          {` · tax ${money.format(prior.totalTax)} → ${money.format(f.totalTax)}`}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3 mt-4">
        {review.approval ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><CheckCircle2 className="w-4 h-4" /> Approved</span>
        ) : review.canApprove && (
          <button
            type="button"
            onClick={() => { approve(); toast.success('Case approved'); }}
            className="inline-flex items-center gap-2 bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg"
          >
            <ShieldCheck className="w-4 h-4" /> Approve
          </button>
        )}
        <button type="button" onClick={goNext} className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
          Next case <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
}

function GroupFill({ fields }: { fields: string[] }) {
  const [open, setOpen] = useState(false);
  if (fields.length < 2) return null;
  return open
    ? <div className="px-4 pb-3"><ReturnFieldsForm fields={fields} onDone={() => setOpen(false)} /></div>
    : (
      <div className="px-4 pt-3">
        <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-emerald-300 hover:text-emerald-200">
          Enter all {fields.length} missing details at once
        </button>
      </div>
    );
}

export default function ReviewPanel() {
  const review = useCaseStore((s) => s.review);
  const focusedGroup = useCaseStore((s) => s.focusedReviewGroup);
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (focusedGroup) groupRefs.current[focusedGroup]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusedGroup]);

  const groups = useMemo(
    () => REVIEW_GROUPS.map((g) => {
      const items = review?.items.filter((i) => i.group === g.id) ?? [];
      const open = items.filter((i) => i.category !== 'INFORMATIONAL' && !i.resolution);
      const fields = open.flatMap((i) => (i.action?.kind === 'return_field' ? [i.action.field] : []));
      return { ...g, items, open: open.length, fields };
    }),
    [review],
  );
  if (!review) return null;

  return (
    <div className="space-y-4">
      <ReturnSummary />
      <p className="text-sm text-slate-400">
        {review.open.length === 0
          ? 'Nothing is open. The case can be approved.'
          : `${review.open.length} item${review.open.length === 1 ? '' : 's'} to clear before approval. Errors and blocking items clear when the return or documents are fixed; warnings and review items can also be decided with a note.`}
      </p>
      {groups.map((g) => (
        <section
          key={g.id}
          ref={(el) => { groupRefs.current[g.id] = el; }}
          className={`rounded-xl border bg-surface-800 ${focusedGroup === g.id ? 'border-HATaxService-orange-500/60' : 'border-slate-700'}`}
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              {g.open === 0
                ? <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden />
                : <AlertTriangle className="w-4 h-4 text-amber-400" aria-hidden />}
              {g.label}
            </h3>
            <span className="text-xs text-slate-400">{g.open === 0 ? 'Nothing open' : `${g.open} open`}</span>
          </header>
          <GroupFill fields={g.fields} />
          {g.items.length > 0 && (
            <ul className="divide-y divide-slate-700/70">
              {g.items.map((item) => <ItemRow key={item.id} item={item} />)}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
