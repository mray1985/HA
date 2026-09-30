/**
 * Review tab: the case's review checklist (work order §36, §37, §69). Each
 * group shows what is open; a preparer opens the evidence, fixes the return,
 * or records a decision on a warning or review item.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, RotateCcw } from 'lucide-react';
import { REVIEW_GROUPS, type ReviewItem, type ReviewResolution } from '../../services/caseReview';
import { useCaseStore } from '../../store/caseStore';
import { CategoryBadge } from './caseBadges';

const DECISIONS: Array<{ value: ReviewResolution['decision']; label: string }> = [
  { value: 'accepted', label: 'Checked — correct as is' },
  { value: 'not_applicable', label: 'Not applicable to this client' },
];

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
        rows={2}
        required
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
  const reopen = useCaseStore((s) => s.reopen);
  const [resolving, setResolving] = useState(false);
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
            {item.documentId && (
              <button onClick={() => requestTab('documents')} className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200">
                <FileText className="w-3.5 h-3.5" /> Open documents
              </button>
            )}
            {item.field && (
              <button onClick={() => requestTab('return')} className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200">
                <ExternalLink className="w-3.5 h-3.5" /> Open the return
              </button>
            )}
            {resolvable && !item.resolution && !resolving && (
              <button onClick={() => setResolving(true)} className="text-xs text-HATaxService-orange-400 hover:text-HATaxService-orange-300">
                Record a decision
              </button>
            )}
            {item.resolution && (
              <button onClick={() => reopen(item.id)} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white">
                <RotateCcw className="w-3 h-3" /> Reopen
              </button>
            )}
          </div>
          {resolving && <ResolveForm item={item} onDone={() => setResolving(false)} />}
        </div>
      </div>
    </li>
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
      return { ...g, items, open: items.filter((i) => i.category !== 'INFORMATIONAL' && !i.resolution).length };
    }),
    [review],
  );
  if (!review) return null;

  return (
    <div className="space-y-4">
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
