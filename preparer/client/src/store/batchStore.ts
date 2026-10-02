/**
 * The dashboard's batch intake (work order §49), kept while the preparer works
 * elsewhere: a large batch reads for many minutes, so its progress and its
 * result outlive the dashboard page, and the preparer is told when it ends.
 */

import { create } from 'zustand';
import { SUPPORTED_TAX_YEARS } from '@hatax/engine';
import { toast } from 'sonner';
import type { BatchResult, FileRead } from '../services/caseIntake';

interface BatchState {
  /** The tax year new cases and dropped documents go to; kept when the dashboard closes (a lock, another page). */
  taxYear: number;
  setTaxYear: (taxYear: number) => void;
  busy: string | null;
  result: BatchResult | null;
  /** Read a batch for any clients into `taxYear` cases; one batch at a time. */
  run: (files: File[], taxYear: number) => Promise<void>;
  /** A file the preparer placed by hand leaves the unplaced list. */
  placed: (read: FileRead) => void;
  clear: () => void;
}

function notifyDone(text: string) {
  toast.success(text);
  // A long batch usually ends while the window is in the background.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification('HA Tax Preparer', { body: text });
    } catch {
      /* notifications unavailable */
    }
  }
}

/**
 * The tax year being filed: last calendar year (in October 2026, 2025 returns
 * and their extensions), within the years the engine supports.
 */
export function filingYear(now = new Date()): number {
  const first = SUPPORTED_TAX_YEARS[0];
  const last = SUPPORTED_TAX_YEARS[SUPPORTED_TAX_YEARS.length - 1]!;
  return Math.min(last, Math.max(first, now.getFullYear() - 1));
}

export const useBatchStore = create<BatchState>((set, get) => ({
  taxYear: filingYear(),
  setTaxYear: (taxYear) => set({ taxYear }),
  busy: null,
  result: null,

  run: async (files, taxYear) => {
    if (get().busy || files.length === 0) return;
    set({ result: null, busy: `Reading ${files.length} file${files.length === 1 ? '' : 's'}…` });
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
    try {
      const { enqueueBatch } = await import('../services/caseIntake');
      const result = await enqueueBatch(files, taxYear, { onProgress: (busy) => set({ busy }) });
      set({ result });
      const started = result.placed.filter((p) => p.created).length;
      notifyDone(`Documents read: ${files.length - result.unmatched.length} of ${files.length} placed${started ? `, ${started} new case${started === 1 ? '' : 's'}` : ''}${result.unmatched.length ? `, ${result.unmatched.length} to place` : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The documents could not be read');
    } finally {
      set({ busy: null });
    }
  },

  placed: (read) => set((s) => (s.result ? { result: { ...s.result, unmatched: s.result.unmatched.filter((r) => r !== read) } } : {})),
  clear: () => set({ result: null }),
}));
