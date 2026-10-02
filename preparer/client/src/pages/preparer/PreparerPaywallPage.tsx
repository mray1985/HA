import { useAuthStore } from '../../store/authStore';

export default function PreparerPaywallPage() {
  const { user, activateSeason, isLoading, error } = useAuthStore();

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-surface-800 rounded-xl border border-slate-700 p-8">
        <p className="text-xs uppercase tracking-wide text-HATaxService-orange-400 mb-2">Preparer seat</p>
        <h1 className="text-2xl font-bold text-white mb-3">Start this tax season</h1>
        <p className="text-slate-300 text-sm leading-relaxed mb-4">
          HA Tax Preparer is the paid product. A seat lasts through April 15. Client returns stay on this computer, encrypted with your passphrase.
        </p>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">
          Card checkout is not connected on this server yet. Starting the season records {user?.email ? `${user.email}'s` : 'your'} seat here so you can prepare returns.
        </p>
        {error && (
          <div className="bg-red-500/20 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg text-sm mb-4">
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={isLoading}
          onClick={() => { void activateSeason(); }}
          className="w-full bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 disabled:opacity-50 text-white font-medium py-3 px-4 rounded-lg"
        >
          {isLoading ? 'Starting season...' : 'Start this season'}
        </button>
      </div>
    </div>
  );
}
