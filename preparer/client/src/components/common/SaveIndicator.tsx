import { CheckCircle2, Loader2, HardDrive } from 'lucide-react';

type SaveState = 'idle' | 'saving' | 'saved';

/**
 * Visual save indicator — shows saving/saved/idle states.
 * Shown in the case header while the case saves.
 */
export default function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <div
      className={`flex items-center gap-1.5 text-xs transition-opacity duration-300 ${
        state === 'idle' ? 'opacity-40' : 'opacity-100'
      }`}
    >
      {state === 'saving' && (
        <>
          <Loader2 className="w-3 h-3 animate-spin text-HATaxService-blue-400" />
          <span className="text-HATaxService-blue-400">Saving...</span>
        </>
      )}
      {state === 'saved' && (
        <>
          <CheckCircle2 className="w-3 h-3 text-HATaxService-orange-400" />
          <span className="text-HATaxService-orange-400">Saved</span>
        </>
      )}
      {state === 'idle' && (
        <>
          <HardDrive className="w-3 h-3 text-slate-400" />
          <span className="text-slate-400">All changes saved</span>
        </>
      )}
    </div>
  );
}
