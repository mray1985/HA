/**
 * Case dashboard (work order §69): every case with its status, what is open,
 * and the result — so the preparer starts with what needs them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { CalendarPlus, Plus, Search, Trash2 } from 'lucide-react';
import { SUPPORTED_TAX_YEARS } from '@hatax/engine';
import { createReturn, deleteReturn, exportAllData } from '../../api/client';
import type { CaseStatus } from '../../services/caseReview';
import { caseQueue, STATUS_ORDER, type CaseRow } from '../../services/caseQueue';
import { startNextYear } from '../../services/caseRollover';
import { useAuthStore } from '../../store/authStore';
import { STATUS_META, StatusChip, refundOrOwed } from '../../components/case/caseBadges';

export default function CaseDashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all');
  const [newYear, setNewYear] = useState<number>(SUPPORTED_TAX_YEARS[SUPPORTED_TAX_YEARS.length - 1]!);
  const [downloadPassword, setDownloadPassword] = useState('');

  const load = useCallback(() => setRows(caseQueue()), []);
  useEffect(load, [load]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<CaseStatus, number>;
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const shown = rows
    .filter((r) => statusFilter === 'all' || r.status === statusFilter)
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.id.includes(search));

  const newCase = () => {
    const created = createReturn(newYear);
    navigate(`/preparer/case/${created.id}/documents`);
  };

  // §14: a returning client's new year starts from last year's case.
  const startFrom = (row: CaseRow) => {
    try {
      const created = startNextYear(row.id);
      toast.success(`${row.name}: ${created.taxYear} case started from ${row.taxYear}`);
      navigate(`/preparer/case/${created.id}/review`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not start the ${row.taxYear + 1} case`);
    }
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
                  <th className="px-5 py-3 w-12"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {shown.map((r) => {
                  const result = refundOrOwed(r.refundAmount === undefined ? undefined : { refundAmount: r.refundAmount, amountOwed: r.amountOwed ?? 0 });
                  return (
                  <tr key={r.id} className="hover:bg-surface-900/50">
                    <td className="px-5 py-3">
                      <Link to={`/preparer/case/${r.id}`} className="text-white font-medium hover:text-HATaxService-orange-400">{r.name}</Link>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{r.taxYear}</td>
                    <td className="px-5 py-3"><StatusChip status={r.status} /></td>
                    <td className="px-5 py-3 text-slate-300">{r.open || '—'}</td>
                    <td className="px-5 py-3 text-slate-300 hidden md:table-cell">{r.documents}</td>
                    <td className={`px-5 py-3 hidden md:table-cell text-sm ${result.className}`}>{result.text}</td>
                    <td className="px-5 py-3 text-slate-400 text-sm hidden lg:table-cell">{r.updatedAt ? format(new Date(r.updatedAt), 'MMM d, yyyy') : '—'}</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {r.nextYear !== null && (
                        <button
                          onClick={() => startFrom(r)}
                          className="inline-flex items-center gap-1 mr-2 text-xs text-sky-300 hover:text-sky-200"
                          title={`Start ${r.name}'s ${r.nextYear} case from this one: identity, dependents, filing status and carryovers`}
                        >
                          <CalendarPlus className="w-4 h-4" /> Start {r.nextYear}
                        </button>
                      )}
                      <button onClick={() => remove(r)} className="p-1.5 text-slate-500 hover:text-red-400" title="Delete case" aria-label={`Delete case for ${r.name}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
