/**
 * The open case: its return, calculation, document evidence, review and audit
 * trail. Replaces HATax's wizard store — return data, autosave and form-view
 * state stay; step navigation is gone.
 *
 * Every change to the return is saved (debounced, encrypted by api/client),
 * recalculated by the engine, and re-reviewed. A change a preparer makes by
 * hand is recorded in the case's audit trail with the old and new value
 * (work order §40, §41).
 */

import { create } from 'zustand';
import { calculateForm1040, FilingStatus, setDeepPath, type CalculationResult, type TaxReturn } from '@hatax/engine';
import type { IngestedDocument, TaxFact } from '@hatax/local-ai';
import { getReturn, writeReturn } from '../api/client';
import { loadAudit, appendAudit, loadReviewRecord, saveReviewRecord, type CaseAuditEvent, type NewAuditEvent } from '../services/caseAudit';
import {
  approveCase,
  buildCaseReview,
  reopenItem,
  resolveItem,
  groupForSection,
  type CaseReview,
  type CaseReviewRecord,
  type ReviewGroup,
  type ReviewItem,
  type ReviewResolution,
} from '../services/caseReview';
import { loadDocuments } from '../services/documentIngestion';
import { loadTaxFacts } from '../services/preparerTaxFacts';

export type SaveState = 'idle' | 'saving' | 'saved';
export type CaseTab = 'review' | 'documents' | 'return' | 'explain' | 'scenarios' | 'approve';

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Write the preparer's pending edit now (before leaving the case, printing,
 * approving, or letting the return applier read the return). Without a
 * pending edit the stored return is already current — and may be newer than
 * this copy, when the applier wrote it — so nothing is written.
 */
export function flushCaseSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tr = useCaseStore.getState().taxReturn;
  if (tr) writeReturn(tr);
}

/** The value at a dot path (numeric parts index arrays), for the audit trail's "before". */
function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node != null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), obj);
}

function calculate(taxReturn: TaxReturn): CalculationResult | null {
  try {
    return calculateForm1040({ ...taxReturn, filingStatus: taxReturn.filingStatus || FilingStatus.Single }, { enabled: true });
  } catch (err) {
    console.error('Calculation failed:', err);
    return null;
  }
}

interface CaseState {
  returnId: string | null;
  taxReturn: TaxReturn | null;
  calculation: CalculationResult | null;
  facts: TaxFact[];
  documents: IngestedDocument[];
  reviewRecord: CaseReviewRecord;
  review: CaseReview | null;
  audit: CaseAuditEvent[];
  saveState: SaveState;

  /** Form viewer state (Return tab). */
  activeFormId: string;
  activeInstanceIndex: number;
  pendingFocusLineId: string | null;
  selectedFormKeys: Set<string>;
  /** A tab another part of the case asked to show (e.g. "open this field"). */
  requestedTab: CaseTab | null;
  /** Checklist group the Review tab should bring into view. */
  focusedReviewGroup: ReviewGroup | null;

  openCase: (id: string) => void;
  closeCase: () => void;
  /** Re-read the case's facts, documents and return after intake wrote them. */
  reloadEvidence: () => void;

  updateField: (field: string, value: unknown) => void;
  /** Set a value at a dot path (e.g. "directDeposit.routingNumber"). */
  updateDeepField: (path: string, value: unknown) => void;
  /** Replace the return with an edited copy (e.g. a Scenario Lab value applied), audited under `label`. */
  applyEdit: (label: string, next: TaxReturn, from: unknown, to: unknown) => void;

  resolve: (item: ReviewItem, decision: ReviewResolution['decision'], note: string) => void;
  reopen: (itemId: string) => void;
  approve: () => void;

  setActiveForm: (formId: string, instanceIndex: number) => void;
  navigateToFormLine: (formId: string, lineId?: string) => void;
  clearPendingFocus: () => void;
  toggleFormSelection: (key: string) => void;
  selectAllForms: (keys: string[]) => void;
  clearFormSelection: () => void;
  requestTab: (tab: CaseTab | null) => void;
  /** Open the Review tab at the checklist group of a return section. */
  showReviewSection: (section: string) => void;
}

const EMPTY = {
  returnId: null,
  taxReturn: null,
  calculation: null,
  facts: [] as TaxFact[],
  documents: [] as IngestedDocument[],
  reviewRecord: { resolutions: {} } as CaseReviewRecord,
  review: null,
  audit: [] as CaseAuditEvent[],
  saveState: 'idle' as SaveState,
  activeFormId: 'f1040',
  activeInstanceIndex: 0,
  pendingFocusLineId: null,
  selectedFormKeys: new Set<string>(),
  requestedTab: null,
  focusedReviewGroup: null as ReviewGroup | null,
};

export const useCaseStore = create<CaseState>((set, get) => {
  /** Recalculate and re-review after the return or its evidence changed. */
  const refresh = (taxReturn: TaxReturn, patch: Partial<CaseState> = {}) => {
    const { facts, documents, reviewRecord } = { ...get(), ...patch };
    const calculation = calculate(taxReturn);
    const review = buildCaseReview({ taxReturn, calculation, facts, documents, record: reviewRecord });
    set({ ...patch, taxReturn, calculation, review });
  };

  const scheduleSave = () => {
    set({ saveState: 'saving' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tr = get().taxReturn;
      if (tr) writeReturn(tr);
      set({ saveState: 'saved' });
      setTimeout(() => {
        if (get().saveState === 'saved') set({ saveState: 'idle' });
      }, 1500);
    }, 400);
  };

  const record = (event: NewAuditEvent) => {
    const id = get().returnId;
    if (!id) return;
    set({ audit: appendAudit(id, event) });
  };

  const change = (path: string, value: unknown, apply: (tr: TaxReturn) => TaxReturn) => {
    const { taxReturn } = get();
    if (!taxReturn) return;
    const before = readPath(taxReturn, path);
    const updated = apply({ ...taxReturn, updatedAt: new Date().toISOString() });
    record({ kind: 'correction', field: path, from: before, to: value });
    refresh(updated);
    scheduleSave();
  };

  const edit = (label: string, next: TaxReturn, from: unknown, to: unknown) => {
    if (!get().taxReturn) return;
    record({ kind: 'correction', field: label, from, to });
    refresh({ ...next, updatedAt: new Date().toISOString() });
    scheduleSave();
  };

  const saveRecord = (next: CaseReviewRecord) => {
    const { returnId, taxReturn } = get();
    if (!returnId || !taxReturn) return;
    saveReviewRecord(returnId, next);
    refresh(taxReturn, { reviewRecord: next });
  };

  return {
    ...EMPTY,

    openCase: (id) => {
      flushCaseSave();
      const taxReturn = getReturn(id);
      const patch: Partial<CaseState> = {
        ...EMPTY,
        selectedFormKeys: new Set<string>(),
        returnId: id,
        facts: loadTaxFacts(id),
        documents: loadDocuments(id),
        reviewRecord: loadReviewRecord(id),
        audit: loadAudit(id),
      };
      refresh(taxReturn, patch);
    },

    closeCase: () => {
      flushCaseSave();
      set({ ...EMPTY, selectedFormKeys: new Set<string>() });
    },

    reloadEvidence: () => {
      const id = get().returnId;
      if (!id) return;
      flushCaseSave();
      refresh(getReturn(id), { facts: loadTaxFacts(id), documents: loadDocuments(id) });
    },

    updateField: (field, value) => change(field, value, (tr) => ({ ...tr, [field]: value })),
    applyEdit: (label, next, from, to) => edit(label, next, from, to),
    updateDeepField: (path, value) =>
      change(path, value, (tr) => setDeepPath(tr as unknown as Record<string, unknown>, path, value) as unknown as TaxReturn),

    resolve: (item, decision, note) => {
      saveRecord(resolveItem(get().reviewRecord, item, decision, note));
      record({ kind: 'resolution', itemId: item.id, note, decision, message: item.message });
    },
    reopen: (itemId) => {
      saveRecord(reopenItem(get().reviewRecord, itemId));
      record({ kind: 'reopened', itemId });
    },
    approve: () => {
      const { review, taxReturn, reviewRecord } = get();
      if (!review || !taxReturn) return;
      flushCaseSave();
      saveRecord(approveCase(reviewRecord, review, taxReturn));
      record({ kind: 'approval' });
    },

    setActiveForm: (formId, instanceIndex) => set({ activeFormId: formId, activeInstanceIndex: instanceIndex }),
    navigateToFormLine: (formId, lineId) =>
      set({ activeFormId: formId, activeInstanceIndex: 0, pendingFocusLineId: lineId ?? null, requestedTab: 'return' }),
    clearPendingFocus: () => set({ pendingFocusLineId: null }),
    toggleFormSelection: (key) =>
      set((state) => {
        const next = new Set(state.selectedFormKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return { selectedFormKeys: next };
      }),
    selectAllForms: (keys) => set({ selectedFormKeys: new Set(keys) }),
    clearFormSelection: () => set({ selectedFormKeys: new Set<string>() }),
    requestTab: (tab) => set({ requestedTab: tab }),
    showReviewSection: (section) => set({ requestedTab: 'review', focusedReviewGroup: groupForSection(section) }),
  };
});
