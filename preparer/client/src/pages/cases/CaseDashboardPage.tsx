/**
 * Case dashboard (work order §69): every case with its status, what is open,
 * and the result — so the preparer starts with what needs them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Plus, Search, Trash2 } from 'lucide-react';
import { calculateForm1040, FilingStatus, SUPPORTED_TAX_YEARS, type TaxReturn } from '@hatax/engine';
import { createReturn, deleteReturn, exportAllData, listReturns } from '../../api/client';
import { loadReviewRecord } from '../../services/caseAudit';
import { buildCaseReview, type CaseStatus } from '../../services/caseReview';
import { loadDocuments } from '../../services/documentIngestion';
import { loadTaxFacts } from '../../services/preparerTaxFacts';
import { useAuthStore } from '../../store/authStore';
import { STATUS_META, StatusChip, refundOrOwed } from '../../components/case/caseBadges';

interface CaseRow {
  id: string;
  name: string;
  taxYear: number;
  status: CaseStatus;
  open: number;
  documents: number;
  result: ReturnType<typeof refundOrOwed>;
  updatedAt: string;
}

const STATUS_ORDER: CaseStatus[] = ['needs_attention', 'needs_review', 'ready', 'waiting_for_documents', 'approved'];

function summarize(tr: TaxReturn): CaseRow {
  const calculation = (() => {
    try {
      return calculateForm1040({ ...tr, filingStatus: tr.filingStatus || FilingStatus.Single });
    } catch {
      return null;
    }
  })();
  const documents = loadDocuments(tr.id);
  const review = buildCaseReview({ taxReturn: tr, calculation, facts: loadTaxFacts(tr.id), documents, record: loadReviewRecord(tr.id) });
  const names = [[tr.firstName, tr.lastName], [tr.spouseFirstName, tr.spouseLastName]]
    .map((p) => p.filter(Boolean).join(' '))
    .filter(Boolean);
  return {
    id: tr.id,
    name: names.join(' & ') || 'New client',
    taxYear: tr.taxYear,
    status: review.status,
    open: review.open.length,
    documents: documents.length,
    result: refundOrOwed(calculation?.form1040),
    updatedAt: tr.updatedAt,
  };
}

export default function CaseDashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all');
  const [newYear, setNewYear] = useState<number>(SUPPORTED_TAX_YEARS[SUPPORTED_TAX_YEARS.length - 1]!);
  const [downloadPassword, setDownloadPassword] = useState('');

  const load = useCallback(() => setRows(listReturns().map(summarize)), []);
  useEffect(load, [load]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<CaseStatus, number>;
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const shown = rows
    .filter((r) => statusFilter === 'all' || r.status === statusFilter)
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.id.includes(search))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));

  const newCase = () => {
    const created = createReturn(newYear);
    navigate(`/preparer/case/${created.id}/documents`);
  };

  const remove = (row: CaseRow) => {
    if (!window.confirm(`Delete the case for ${row.name}? Its return, documents and audit trail are removed. This cannot be undone.`)) return;
    deleteReturn(row.id);
    toast.success('Case deleted');
    load();
  };

  const download = async () => {
    if (downloadPassword.length < 8) {
      toast.error('Use a download password of at least 8 characters');
      return;
    }
    try {
      await exportAllData(downloadPassword);
      toast.success('Encrypted case file downloaded');
      setDownloadPassword('');
    } catch {
      toast.error('Could not download the case file');
    }
  };

  return (
    <div className="min-h-screen bg-surface-900">
      <header className="bg-surface-800 border-b border-slate-700 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white">HA Preparer</h1>
            <span className="text-xs bg-HATaxService-orange-500/20 text-HATaxService-orange-400 px-2 py-0.5 rounded">CASES</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden md:inline text-sm text-slate-400">{user?.email}</span>
            <input
              type="password"
              value={downloadPassword}
              onChange={(e) => setDownloadPassword(e.target.value)}
              placeholder="Download password"
              aria-label="Download password"
              className="hidden lg:block w-40 bg-surface-700 border border-slate-600 text-white text-sm rounded px-2 py-1"
            />
            <button type="button" onClick={() => { void download(); }} className="hidden lg:block text-sm text-slate-300 hover:text-white">
              Download cases
            </button>
            <button type="button" onClick={() => { void logout().then(() => navigate('/preparer/login')); }} className="text-sm text-slate-300 hover:text-white">
              Sign out
            </button>
            <select
              value={newYear}
              onChange={(e) => setNewYear(Number(e.target.value))}
              aria-label="Tax year for a new case"
              className="bg-surface-700 border border-slate-600 text-white text-sm rounded px-2 py-1.5"
            >
              {[...SUPPORTED_TAX_YEARS].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={newCase} className="inline-flex items-center gap-1.5 bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white px-4 py-2 rounded-lg font-medium text-sm">
              <Plus className="w-4 h-4" /> New case
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
              className={`text-left rounded-xl border p-4 transition-colors ${statusFilter === s ? 'border-HATaxService-orange-500 bg-surface-800' : 'border-slate-700 bg-surface-800 hover:border-slate-500'}`}
            >
              <p className="text-2xl font-semibold text-white">{counts[s]}</p>
              <p className="text-xs text-slate-400 mt-1">{STATUS_META[s].label}</p>
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-80">
          <input
            type="search"
            placeholder="Search cases..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-surface-800 border border-slate-600 text-white placeholder-slate-500 rounded-lg px-4 py-2 pl-10 text-sm"
          />
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-16">
            <h2 className="text-lg font-medium text-white">No cases yet</h2>
            <p className="mt-2 text-slate-400">Start a case and drop the client’s documents in.</p>
            <button onClick={newCase} className="mt-6 inline-flex items-center gap-2 bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white px-6 py-3 rounded-lg font-medium">
              <Plus className="w-5 h-5" /> New case
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto bg-surface-800 rounded-xl border border-slate-700">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-900 border-b border-slate-700 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                  <th className="px-5 py-3">Client</th>
                  <th className="px-5 py-3">Year</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Open</th>
                  <th className="px-5 py-3 hidden md:table-cell">Documents</th>
                  <th className="px-5 py-3 hidden md:table-cell">Result</th>
                  <th className="px-5 py-3 hidden lg:table-cell">Updated</th>
                  <th className="px-5 py-3 w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {shown.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-900/50">
                    <td className="px-5 py-3">
                      <Link to={`/preparer/case/${r.id}`} className="text-white font-medium hover:text-HATaxService-orange-400">{r.name}</Link>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{r.taxYear}</td>
                    <td className="px-5 py-3"><StatusChip status={r.status} /></td>
                    <td className="px-5 py-3 text-slate-300">{r.open || '—'}</td>
                    <td className="px-5 py-3 text-slate-300 hidden md:table-cell">{r.documents}</td>
                    <td className={`px-5 py-3 hidden md:table-cell text-sm ${r.result.className}`}>{r.result.text}</td>
                    <td className="px-5 py-3 text-slate-400 text-sm hidden lg:table-cell">{r.updatedAt ? format(new Date(r.updatedAt), 'MMM d, yyyy') : '—'}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => remove(r)} className="p-1.5 text-slate-500 hover:text-red-400" title="Delete case" aria-label={`Delete case for ${r.name}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
