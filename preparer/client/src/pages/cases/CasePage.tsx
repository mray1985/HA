/**
 * One case: header with the client, status and result; tabs for the assistant,
 * the documents, the return's forms, the explanation, scenarios and approval.
 *
 * The Assistant tab is where the work happens — it replaced the review
 * checklist and the client questions, which are both threads in it now.
 */

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Loader2, Upload } from 'lucide-react';
import { useCaseStore, type CaseTab } from '../../store/caseStore';
import { StatusChip, refundOrOwed } from '../../components/case/caseBadges';
import AssistantPanel from '../../components/case/AssistantPanel';
import DocumentsPanel from '../../components/case/DocumentsPanel';
import ExplainPanel from '../../components/case/ExplainPanel';
import ApprovePanel from '../../components/case/ApprovePanel';
import ReturnPanel from '../../components/case/ReturnPanel';
import ScenarioLabToolView from '../../components/scenarioLab/ScenarioLabToolView';
import SaveIndicator from '../../components/common/SaveIndicator';
import ErrorBoundary from '../../components/common/ErrorBoundary';
import { listReturns } from '../../api/client';
import { isIntakeFile } from '../../services/caseIntake';
import { nextCase } from '../../services/caseQueue';
import { useBatchStore } from '../../store/batchStore';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

const TABS: Array<{ id: CaseTab; label: string }> = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'documents', label: 'Documents' },
  { id: 'return', label: 'Return' },
  { id: 'explain', label: 'Explain' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'approve', label: 'Approve' },
];

export default function CasePage() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const returnId = useCaseStore((s) => s.returnId);
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const review = useCaseStore((s) => s.review);
  const saveState = useCaseStore((s) => s.saveState);
  const requestedTab = useCaseStore((s) => s.requestedTab);
  const requestTab = useCaseStore((s) => s.requestTab);
  const ingest = useCaseStore((s) => s.ingest);
  const intakeBusy = useCaseStore((s) => s.intakeBusy);
  const batchBusy = useBatchStore((s) => s.busy);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const exists = Boolean(id && listReturns().some((r) => r.id === id));
  const active: CaseTab = TABS.some((t) => t.id === tab) ? (tab as CaseTab) : 'assistant';

  useEffect(() => {
    if (!id || !exists) return;
    useCaseStore.getState().openCase(id);
    return () => useCaseStore.getState().closeCase();
  }, [id, exists]);

  // Another part of the case asked for a tab ("open the return", "open documents").
  useEffect(() => {
    if (!requestedTab || !id) return;
    navigate(`/preparer/case/${id}/${requestedTab}`);
    requestTab(null);
  }, [requestedTab, id, navigate, requestTab]);

  if (!id || !exists) return <Navigate to="/preparer" replace />;
  if (returnId !== id || !taxReturn || !review) {
    return <div className="min-h-screen bg-surface-900 flex items-center justify-center text-slate-400">Opening case…</div>;
  }

  const name = [taxReturn.firstName, taxReturn.lastName].filter(Boolean).join(' ') || 'New client';
  const result = refundOrOwed(calculation?.form1040);

  // A client's documents can be dropped on any tab of the case.
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const readable = files.filter(isIntakeFile);
    const other = files.length - readable.length;
    if (other > 0) toast.info(`${other} file${other === 1 ? ' is' : 's are'} not a PDF or photo — import CSV, TXF and FDX files from Documents → Other imports.`);
    if (readable.length === 0) return;
    void ingest(readable).then((r) => {
      if (!r) return;
      const parts = [`${r.read} read`, ...(r.skipped ? [`${r.skipped} already on the case`] : []), ...(r.failures.length ? [`${r.failures.length} could not be read`] : [])];
      (r.failures.length ? toast.warning : toast.success)(`Documents: ${parts.join(', ')}`);
    });
  };

  return (
    <div
      className="min-h-screen bg-surface-900 flex flex-col"
      onDragEnter={(e) => { if (hasFiles(e)) { dragDepth.current++; setDragging(true); } }}
      onDragLeave={(e) => { if (hasFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="fixed inset-0 z-50 bg-surface-900/80 border-4 border-dashed border-HATaxService-orange-500 flex items-center justify-center pointer-events-none">
          <p className="flex items-center gap-3 text-xl text-white font-medium"><Upload className="w-7 h-7" /> Drop to add to {name}'s case</p>
        </div>
      )}
      <header className="bg-surface-800 border-b border-slate-700 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="h-16 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <Link to="/preparer" className="text-slate-400 hover:text-white" aria-label="Back to cases"><ArrowLeft className="w-5 h-5" /></Link>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-white truncate">{name}</h1>
                <p className="text-xs text-slate-400">Tax year {taxReturn.taxYear}</p>
              </div>
              <StatusChip status={review.status} />
            </div>
            <div className="flex items-center gap-4">
              {intakeBusy && active !== 'documents' && (
                <button type="button" onClick={() => requestTab('documents')} className="hidden md:inline-flex items-center gap-1.5 text-xs text-sky-300 max-w-xs truncate" title={intakeBusy}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> {intakeBusy}
                </button>
              )}
              {batchBusy && !intakeBusy && (
                <Link to="/preparer" className="hidden md:inline-flex items-center gap-1.5 text-xs text-slate-400 max-w-xs truncate" title={`Batch: ${batchBusy}`}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Batch: {batchBusy}
                </Link>
              )}
              <SaveIndicator state={saveState} />
              <span className={`text-sm font-medium ${result.className}`}>{result.text}</span>
              <button
                type="button"
                onClick={() => {
                  const next = nextCase(id);
                  if (next) navigate(`/preparer/case/${next.id}`);
                  else {
                    toast.success('No other case needs you right now');
                    navigate('/preparer');
                  }
                }}
                className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white"
                title="The most urgent case that needs you"
              >
                Next case <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Case sections">
            {TABS.map((t) => (
              <Link
                key={t.id}
                to={`/preparer/case/${id}/${t.id}`}
                className={`px-4 py-2.5 text-sm border-b-2 whitespace-nowrap ${active === t.id ? 'border-HATaxService-orange-500 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}
              >
                {t.label}
                {t.id === 'assistant' && review.open.length > 0 && (
                  <span className="ml-2 text-xs bg-amber-500/20 text-amber-300 rounded-full px-1.5 py-0.5">{review.open.length}</span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className={`flex-1 w-full ${active === 'return' ? 'flex min-h-0' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6'}`}>
        <ErrorBoundary>
          {active === 'assistant' && <AssistantPanel />}
          {active === 'documents' && <DocumentsPanel />}
          {active === 'return' && <ReturnPanel />}
          {active === 'explain' && <ExplainPanel />}
          {active === 'scenarios' && <ScenarioLabToolView />}
          {active === 'approve' && <ApprovePanel />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
