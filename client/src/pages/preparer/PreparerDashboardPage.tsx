import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { deleteReturn, listReturns } from '../../api/client';
import { type TaxReturn } from '@telostax/engine';
import { toast } from 'sonner';
import { format } from 'date-fns';
import LockScreen from '../../components/common/LockScreen';

type ClientSummary = Pick<TaxReturn, 'id' | 'firstName' | 'lastName' | 'spouseFirstName' | 'spouseLastName' | 'taxYear' | 'status' | 'updatedAt' | 'createdAt'>;

export default function PreparerDashboardPage({
  lockMode,
  onUnlock,
  lockError,
}: {
  lockMode?: 'setup' | 'unlock';
  onUnlock?: (passphrase: string) => Promise<boolean>;
  lockError?: string | null;
}) {
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [search, setSearch] = useState('');
  const [filterYear, setFilterYear] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'year'>('updated');
  const [isLoading, setIsLoading] = useState(true);

  const loadClients = useCallback(async () => {
    try {
      const returns = listReturns();
      setClients(returns.map((r: TaxReturn) => ({
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        spouseFirstName: r.spouseFirstName,
        spouseLastName: r.spouseLastName,
        taxYear: r.taxYear,
        status: r.status,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
      })));
    } catch (err) {
      toast.error('Failed to load clients');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  const filteredClients = clients
    .filter((c) => {
      if (filterYear !== 'all' && c.taxYear?.toString() !== filterYear) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      const fullName = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
      const spouseFullName = `${c.spouseFirstName || ''} ${c.spouseLastName || ''}`.toLowerCase();
      return (
        fullName.includes(q) ||
        spouseFullName.includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sortBy === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (sortBy === 'name') {
        const nameA = `${a.firstName || ''} ${a.lastName || ''}`;
        const nameB = `${b.firstName || ''} ${b.lastName || ''}`;
        return nameA.localeCompare(nameB);
      }
      if (sortBy === 'year') return (b.taxYear || 0) - (a.taxYear || 0);
      return 0;
    });

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this client return? This cannot be undone.')) return;
    try {
      await deleteReturn(id);
      toast.success('Client deleted');
      loadClients();
    } catch (err) {
      toast.error('Failed to delete client');
    }
  };

  const getYears = () => {
    const years = new Set(clients.map(c => c.taxYear).filter((y): y is number => typeof y === 'number'));
    return Array.from(years).sort((a, b) => b - a);
  };

  const showLockScreen = lockMode && onUnlock;

  return (
    <div className="min-h-screen bg-surface-900">
      {showLockScreen ? (
        <LockScreen
          mode={lockMode}
          onUnlock={onUnlock}
          error={lockError}
        />
      ) : (
        <>
          <header className="bg-surface-800 border-b border-slate-700 sticky top-0 z-40">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-16">
                <div className="flex items-center gap-3">
                  <svg className="h-8 w-8 text-telos-orange-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                  <h1 className="text-xl font-semibold text-white">HA Preparer</h1>
                  <span className="text-xs bg-telos-orange-500/20 text-telos-orange-400 px-2 py-0.5 rounded">PREPARER</span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="hidden sm:flex items-center gap-2">
                    <span className="text-sm text-slate-400">Tax Year</span>
                    <select
                      value={filterYear}
                      onChange={(e) => setFilterYear(e.target.value)}
                      className="bg-surface-700 border border-slate-600 text-white text-sm rounded px-2 py-1"
                    >
                      <option value="all">All Years</option>
                      {getYears().map(y => <option key={y} value={y.toString()}>{y}</option>)}
                    </select>
                  </div>
                  <button
                    onClick={() => navigate('/preparer/clients/new')}
                    className="bg-telos-orange-500 hover:bg-telos-orange-600 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
                  >
                    + New Client
                  </button>
                </div>
              </div>
            </div>
            <div className="border-t border-slate-700 px-4 py-3">
              <div className="max-w-7xl mx-auto flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                <div className="relative w-full sm:w-80">
                  <input
                    type="search"
                    placeholder="Search clients..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full bg-surface-700 border border-slate-600 text-white placeholder-slate-500 rounded-lg px-4 py-2 pl-10 text-sm"
                  />
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                  </svg>
                </div>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="bg-surface-700 border border-slate-600 text-white text-sm rounded-lg px-3 py-2"
                >
                  <option value="updated">Sort: Recently Updated</option>
                  <option value="name">Sort: Client Name</option>
                  <option value="year">Sort: Tax Year</option>
                </select>
              </div>
            </div>
          </header>

          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {isLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-telos-orange-500"></div>
              </div>
            ) : filteredClients.length === 0 ? (
              <div className="text-center py-16">
                <svg className="mx-auto h-16 w-16 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
                </svg>
                <h3 className="mt-4 text-lg font-medium text-white">No clients yet</h3>
                <p className="mt-2 text-slate-400">Start by adding your first client</p>
                <button
                  onClick={() => navigate('/preparer/clients/new')}
                  className="mt-6 inline-flex items-center gap-2 bg-telos-orange-500 hover:bg-telos-orange-600 text-white px-6 py-3 rounded-lg font-medium"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                  </svg>
                  Add First Client
                </button>
              </div>
            ) : (
              <div className="overflow-hidden bg-surface-800 rounded-xl border border-slate-700">
                <table className="w-full">
                  <thead>
                    <tr className="bg-surface-900 border-b border-slate-700">
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Client</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider hidden md:table-cell">Tax Year</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider hidden lg:table-cell">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Last Updated</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider w-24">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredClients.map((client) => (
                      <tr key={client.id} className="hover:bg-surface-900/50 transition-colors">
                        <td className="px-6 py-4">
                          <Link to={`/preparer/client/${client.id}`} className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-telos-orange-500/20 flex items-center justify-center">
                              <svg className="h-6 w-6 text-telos-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h18a7 7 0 00-7-7z"/>
                              </svg>
                            </div>
                            <div>
                              <p className="text-white font-medium">
                                {client.firstName || ''} {client.lastName || ''} || 'Unnamed'
                              </p>
                              {client.spouseFirstName && client.spouseLastName && (
                                <p className="text-xs text-slate-400">+ {client.spouseFirstName} {client.spouseLastName}</p>
                              )}
                            </div>
                          </Link>
                        </td>
                        <td className="px-6 py-4 hidden md:table-cell text-slate-300">
                          {client.taxYear || '—'}
                        </td>
                        <td className="px-6 py-4 hidden lg:table-cell">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            client.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                            client.status === 'in_progress' ? 'bg-blue-500/20 text-blue-400' :
                            'bg-slate-500/20 text-slate-400'
                          }`}>
                            {client.status || 'draft'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-slate-400 text-sm">
                          {client.updatedAt ? format(new Date(client.updatedAt), 'MMM d, yyyy') : '—'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Link
                              to={`/preparer/return/${client.id}`}
                              className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                              title="Open Return"
                            >
                              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                              </svg>
                            </Link>
                            <Link
                              to={`/preparer/client/${client.id}`}
                              className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                              title="Client Details"
                            >
                              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                              </svg>
                            </Link>
                            <button
                              onClick={() => handleDelete(client.id)}
                              className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-colors"
                              title="Delete"
                            >
                              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}