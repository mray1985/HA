import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getReturn, calculateReturn, listReturns } from '../../api/client';
import { type TaxReturn } from '@telostax/engine';
import { toast } from 'sonner';
import { format } from 'date-fns';

export default function PreparerClientPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<TaxReturn | null>(null);
  const [calculation, setCalculation] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      navigate('/preparer', { replace: true });
      return;
    }
    try {
      const data = getReturn(id);
      setClient(data);
      const calc = calculateReturn(id);
      setCalculation(calc);
    } catch {
      toast.error('Client not found');
      navigate('/preparer', { replace: true });
    } finally {
      setIsLoading(false);
    }
  }, [id, navigate]);

  const handleOpenReturn = () => {
    navigate(`/preparer/return/${id}`);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-telos-orange-500"></div>
      </div>
    );
  }

  if (!client) return null;

  const fullName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Unnamed';
  const spouseName = client.spouseFirstName && client.spouseLastName
    ? `${client.spouseFirstName} ${client.spouseLastName}`
    : null;
  const wages = client.w2Income?.reduce((s: number, w: { wages?: number }) => s + (w.wages || 0), 0) || 0;
  const seIncome = calculation?.form1040?.scheduleCNetProfit || 0;
  const federalTax = calculation?.form1040?.incomeTax || 0;
  const refund = calculation?.form1040?.refundAmount || 0;
  const stateTax = calculation?.stateReturns?.reduce((s: number, sr: { totalStateTax?: number }) => s + (sr.totalStateTax || 0), 0) || 0;

  return (
    <div className="min-h-screen bg-surface-900">
      <header className="bg-surface-800 border-b border-slate-700 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate('/preparer')}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                </svg>
              </button>
              <div>
                <p className="text-xl font-semibold text-white">{fullName}</p>
                <p className="text-sm text-slate-400">
                  {spouseName && <span>+ {spouseName} • </span>}
                  Tax Year: {client.taxYear || '—'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link
                to={`/preparer/return/${id}`}
                className="bg-telos-orange-500 hover:bg-telos-orange-600 text-white px-5 py-2.5 rounded-lg font-medium"
              >
                Open Return
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <div className="bg-surface-800 rounded-xl border border-slate-700 p-6">
            <h3 className="text-slate-400 text-sm font-medium mb-2">Basic Info</h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-slate-400">Filing Status</dt>
                <dd className="text-white font-medium">{client.filingStatus || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Tax Year</dt>
                <dd className="text-white font-medium">{client.taxYear || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Dependents</dt>
                <dd className="text-white font-medium">{client.dependents?.length || 0}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-surface-800 rounded-xl border border-slate-700 p-6">
            <h3 className="text-slate-400 text-sm font-medium mb-2">Income Summary</h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-slate-400">Wages</dt>
                <dd className="text-white font-medium">${wages.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Self-Employment</dt>
                <dd className="text-white font-medium">${seIncome.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Total Income</dt>
                <dd className="text-white font-medium font-semibold">${(calculation?.form1040?.totalIncome || 0).toLocaleString()}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-surface-800 rounded-xl border border-slate-700 p-6">
            <h3 className="text-slate-400 text-sm font-medium mb-2">Tax Summary</h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-slate-400">Federal Tax</dt>
                <dd className="text-white font-medium">${federalTax.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Refund / Owed</dt>
                <dd className={`text-white font-medium font-semibold ${refund >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${refund.toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">State Tax</dt>
                <dd className="text-white font-medium">${stateTax.toLocaleString()}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-surface-800 rounded-xl border border-slate-700 p-6 md:col-span-2 lg:col-span-3">
            <h3 className="text-slate-400 text-sm font-medium mb-2">Return History</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between py-2 border-b border-slate-700">
                <span className="text-white">Created</span>
                <span className="text-slate-400">{client.createdAt ? format(new Date(client.createdAt), 'MMM d, yyyy HH:mm') : '—'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-700">
                <span className="text-white">Last Updated</span>
                <span className="text-slate-400">{client.updatedAt ? format(new Date(client.updatedAt), 'MMM d, yyyy HH:mm') : '—'}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-white">Status</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  client.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                  client.status === 'in_progress' ? 'bg-blue-500/20 text-blue-400' :
                  'bg-slate-500/20 text-slate-400'
                }`}>
                  {client.status || 'draft'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 flex justify-end gap-4">
          <button
            onClick={() => navigate('/preparer')}
            className="px-4 py-2 text-slate-300 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
          >
            Back to Clients
          </button>
          <button
            onClick={handleOpenReturn}
            className="bg-telos-orange-500 hover:bg-telos-orange-600 text-white px-6 py-2.5 rounded-lg font-medium"
          >
            Open in Wizard
          </button>
        </div>
      </div>
    </div>
  );
}