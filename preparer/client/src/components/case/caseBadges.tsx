import type { DiagnosticCategory } from '@hatax/engine';
import type { CaseStatus } from '../../services/caseReview';

export const STATUS_META: Record<CaseStatus, { label: string; className: string }> = {
  waiting_for_documents: { label: 'Waiting for documents', className: 'bg-slate-500/20 text-slate-300' },
  needs_attention: { label: 'Needs attention', className: 'bg-red-500/20 text-red-300' },
  needs_review: { label: 'Needs review', className: 'bg-amber-500/20 text-amber-300' },
  ready: { label: 'Ready to approve', className: 'bg-sky-500/20 text-sky-300' },
  approved: { label: 'Approved', className: 'bg-emerald-500/20 text-emerald-300' },
};

export function StatusChip({ status }: { status: CaseStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${meta.className}`}>
      {meta.label}
    </span>
  );
}

export const CATEGORY_META: Record<DiagnosticCategory, { label: string; className: string }> = {
  ERROR: { label: 'Error', className: 'bg-red-500/20 text-red-300 border-red-500/30' },
  BLOCKING: { label: 'Blocking', className: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  WARNING: { label: 'Warning', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  REVIEW: { label: 'Review', className: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
  INFORMATIONAL: { label: 'Info', className: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
};

export function CategoryBadge({ category }: { category: DiagnosticCategory }) {
  const meta = CATEGORY_META[category];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${meta.className}`}>
      {meta.label}
    </span>
  );
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** "Refund $1,234" / "Owes $567" / "—" from a calculation's form 1040 result. */
export function refundOrOwed(form1040: { refundAmount: number; amountOwed: number } | undefined): { text: string; className: string } {
  if (!form1040) return { text: '—', className: 'text-slate-500' };
  if (form1040.refundAmount > 0) return { text: `Refund ${money.format(form1040.refundAmount)}`, className: 'text-emerald-300' };
  if (form1040.amountOwed > 0) return { text: `Owes ${money.format(form1040.amountOwed)}`, className: 'text-amber-300' };
  return { text: 'Even', className: 'text-slate-300' };
}
