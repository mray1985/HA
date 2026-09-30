/**
 * One case: header with the client, status and result; tabs for the review,
 * the documents, the return's forms, the explanation, scenarios and approval.
 */

import { useEffect } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useCaseStore, type CaseTab } from '../../store/caseStore';
import { StatusChip, refundOrOwed } from '../../components/case/caseBadges';
import ReviewPanel from '../../components/case/ReviewPanel';
import DocumentsPanel from '../../components/case/DocumentsPanel';
import ExplainPanel from '../../components/case/ExplainPanel';
import ApprovePanel from '../../components/case/ApprovePanel';
import ReturnPanel from '../../components/case/ReturnPanel';
import ScenarioLabToolView from '../../components/scenarioLab/ScenarioLabToolView';
import SaveIndicator from '../../components/common/SaveIndicator';
import ErrorBoundary from '../../components/common/ErrorBoundary';
import { listReturns } from '../../api/client';

const TABS: Array<{ id: CaseTab; label: string }> = [
  { id: 'review', label: 'Review' },
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
  const exists = Boolean(id && listReturns().some((r) => r.id === id));
  const active: CaseTab = TABS.some((t) => t.id === tab) ? (tab as CaseTab) : 'review';

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

  return (
    <div className="min-h-screen bg-surface-900 flex flex-col">
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
              <SaveIndicator state={saveState} />
              <span className={`text-sm font-medium ${result.className}`}>{result.text}</span>
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
                {t.id === 'review' && review.open.length > 0 && (
                  <span className="ml-2 text-xs bg-amber-500/20 text-amber-300 rounded-full px-1.5 py-0.5">{review.open.length}</span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className={`flex-1 w-full ${active === 'return' ? 'flex min-h-0' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6'}`}>
        <ErrorBoundary>
          {active === 'review' && <ReviewPanel />}
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
