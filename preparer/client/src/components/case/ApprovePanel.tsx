/**
 * Approve tab: the preparer's approval (work order §38, §39) and the filing
 * output. Approval is available only when nothing is open in the review, and
 * any later change to the return withdraws it. The audit trail of the case is
 * shown in full.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ArrowRight, CheckCircle2, ClipboardList, Download, ShieldCheck } from 'lucide-react';
import { nextCase } from '../../services/caseQueue';
import { downloadIRSFormsPDF } from '../../api/client';
import { generateStateFormPDF } from '../../services/stateFormFiller';
import { flushCaseSave, useCaseStore } from '../../store/caseStore';
import type { CaseAuditEvent } from '../../services/caseAudit';
import AuditRiskCard from '../common/AuditRiskCard';
import TaxCalendarCard from '../common/TaxCalendarCard';
import { refundOrOwed } from './caseBadges';

function saveBlob(bytes: Blob, fileName: string) {
  const url = URL.createObjectURL(bytes);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describe(event: CaseAuditEvent): string {
  switch (event.kind) {
    case 'correction': return `Changed ${event.field}`;
    case 'resolution': return `Decided: ${event.message} — ${event.note}`;
    case 'reopened': return 'Reopened a review item';
    case 'approval': return 'Approved the case';
    case 'document': return `Document ${event.fileName}: ${event.outcome}`;
    case 'decision': return `Decided for ${event.subject}: ${event.detail}`;
    case 'tool': return `${event.tool}${event.source ? ` (${event.source})` : ''}: ${event.accepted ? '' : 'rejected — '}${event.detail}`;
    case 'client_reply': return `Client reply read: ${event.answered} answered, ${event.left} left open — "${event.text.length > 160 ? `${event.text.slice(0, 160)}…` : event.text}"`;
    case 'client_note': return `${event.accepted ? 'Accepted' : 'Dismissed'} from a client reply: ${event.description} ("${event.quote}")${event.accepted ? ` — ${event.detail}` : ''}`;
    case 'client_answer': return event.recorded ? `Client answered "${event.question}": ${event.answer} ("${event.quote}")` : `Client reply did not settle "${event.question}": ${event.detail}`;
  }
}

export default function ApprovePanel() {
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const review = useCaseStore((s) => s.review);
  const audit = useCaseStore((s) => s.audit);
  const documents = useCaseStore((s) => s.documents);
  const missingDocuments = useCaseStore((s) => s.missingDocuments);
  const approve = useCaseStore((s) => s.approve);
  const requestTab = useCaseStore((s) => s.requestTab);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!returnId || !taxReturn || !review) return null;
  const name = [taxReturn.firstName, taxReturn.lastName].filter(Boolean).join('-') || 'client';
  const result = refundOrOwed(calculation?.form1040);

  const buildFederal = async () => {
    flushCaseSave();
    saveBlob(await downloadIRSFormsPDF(returnId), `${name}-${taxReturn.taxYear}-federal.pdf`);
  };

  const buildStates = async () => {
    if (!calculation) return;
    for (const state of calculation.stateResults ?? []) {
      const bytes = await generateStateFormPDF(taxReturn, calculation, state);
      if (bytes) saveBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${name}-${taxReturn.taxYear}-${state.stateCode}.pdf`);
      // RCW 82.87.110(1)(b): the Washington capital gains return is filed electronically.
      else if (state.stateCode === 'WA') toast.info('The Washington capital gains return is filed electronically on My DOR (dor.wa.gov); it has no paper form');
      else toast.info(`No ${state.stateName} form template is available yet`);
    }
  };

  const run = async (what: string, build: () => Promise<void>) => {
    setBusy(true);
    try {
      await build();
    } catch {
      toast.error(`Could not build the ${what}`);
    } finally {
      setBusy(false);
    }
  };
  // §38: the case summarized for the preparer's file.
  const downloadReviewPackage = () => run('review package', async () => {
    flushCaseSave();
    const { generateReviewPackagePDF } = await import('../../services/reviewPackage');
    const bytes = await generateReviewPackagePDF({ taxReturn, calculation, review, documents, missingDocuments });
    saveBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${name}-${taxReturn.taxYear}-review-package.pdf`);
  });
  const downloadFederal = () => run('federal filing packet', buildFederal);
  const downloadStates = () => run('state forms', buildStates);
  const downloadAll = () => run('filing packet', async () => { await buildFederal(); await buildStates(); });

  const goNext = () => {
    const next = nextCase(returnId);
    if (next) navigate(`/preparer/case/${next.id}`);
    else {
      toast.success('No other case needs you right now');
      navigate('/preparer');
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        {review.approval ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
            <div className="flex-1">
              <p className="text-white font-semibold">Approved {format(new Date(review.approval.approvedAt), 'MMM d, yyyy h:mm a')}</p>
              <p className="text-sm text-slate-400 mt-1">Any change to the return withdraws this approval.</p>
            </div>
            <button type="button" onClick={goNext} className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
              Next case <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : review.canApprove ? (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-white font-semibold">Ready to approve</p>
              <p className="text-sm text-slate-400 mt-1">Nothing is open in the review. <span className={result.className}>{result.text}</span>.</p>
            </div>
            <button
              onClick={() => {
                approve();
                toast.success('Case approved');
              }}
              className="inline-flex items-center gap-2 bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white text-sm font-medium px-4 py-2.5 rounded-lg"
            >
              <ShieldCheck className="w-4 h-4" /> Approve
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-white font-semibold">Not ready</p>
              <p className="text-sm text-slate-400 mt-1">
                {review.open.length} thing{review.open.length === 1 ? '' : 's'} still to clear — the assistant has them all.
              </p>
            </div>
            <button onClick={() => requestTab('assistant')} className="text-sm text-sky-300 hover:text-sky-200">Go to the assistant</button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        <h3 className="text-sm font-semibold text-white">Filing output</h3>
        <p className="text-xs text-slate-400 mt-1">
          {review.approval ? 'Built from the approved return.' : 'Drafts until the case is approved.'} Electronic filing is not available yet; these are the paper forms.
        </p>
        <div className="flex flex-wrap gap-3 mt-3">
          {(calculation?.stateResults?.length ?? 0) > 0 && (
            <button disabled={busy} onClick={() => { void downloadAll(); }} className="inline-flex items-center gap-2 text-sm font-medium text-white bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 rounded-lg px-3 py-2 disabled:opacity-50">
              <Download className="w-4 h-4" /> Federal and state
            </button>
          )}
          <button disabled={busy} onClick={() => { void downloadReviewPackage(); }} className="inline-flex items-center gap-2 text-sm text-white bg-surface-700 hover:bg-surface-600 border border-slate-600 rounded-lg px-3 py-2 disabled:opacity-50">
            <ClipboardList className="w-4 h-4" /> Review package
          </button>
          <button disabled={busy} onClick={() => { void downloadFederal(); }} className="inline-flex items-center gap-2 text-sm text-white bg-surface-700 hover:bg-surface-600 border border-slate-600 rounded-lg px-3 py-2 disabled:opacity-50">
            <Download className="w-4 h-4" /> Federal filing packet
          </button>
          {(calculation?.stateResults?.length ?? 0) > 0 && (
            <button disabled={busy} onClick={() => { void downloadStates(); }} className="inline-flex items-center gap-2 text-sm text-white bg-surface-700 hover:bg-surface-600 border border-slate-600 rounded-lg px-3 py-2 disabled:opacity-50">
              <Download className="w-4 h-4" /> State forms
            </button>
          )}
        </div>
        {(calculation?.stateResults ?? []).filter((s) => s.unsupported?.length).map((s) => (
          <p key={s.stateCode} role="alert" className="text-xs text-amber-300 mt-2">
            {s.stateName}: not supported — {s.unsupported!.join(' ')}
          </p>
        ))}
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <AuditRiskCard alwaysOpen />
        <TaxCalendarCard alwaysOpen />
      </div>

      <section className="rounded-xl border border-slate-700 bg-surface-800 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Audit trail</h3>
        {audit.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-1.5 max-h-80 overflow-y-auto">
            {[...audit].reverse().map((event, i) => (
              <li key={`${event.at}-${i}`} className="text-xs text-slate-300">
                <span className="text-slate-500 font-mono">{format(new Date(event.at), 'MMM d HH:mm')}</span> {describe(event)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
