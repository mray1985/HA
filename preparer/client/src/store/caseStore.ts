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
import type { IngestedDocument, MissingDocument, TaxFact } from '@hatax/local-ai';
import { caseMissingDocuments } from '../services/missingDocuments';
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
import type { IntakeResult } from '../services/caseIntake';
import { loadTaxFacts } from '../services/preparerTaxFacts';
import { applyReleasedForm, withdrawReleasedForm, type DecisionResult } from '../services/preparerDecisions';
import { YEAR_ITEM_PREFIX } from '../services/returnApplier';
import { spouseCaseCandidates } from '../services/spouseCases';

export type SaveState = 'idle' | 'saving' | 'saved';
export type CaseTab = 'review' | 'documents' | 'client' | 'return' | 'explain' | 'scenarios' | 'approve';

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
  /** Last year's documents the case does not have (§23). */
  missingDocuments: MissingDocument[];
  audit: CaseAuditEvent[];
  saveState: SaveState;
  /** What the document intake is doing now ("Reading w2.pdf…"); null when idle. */
  intakeBusy: string | null;
  /** Files the last intake could not read or apply. */
  intakeErrors: string[];

  /** Form viewer state (Return tab). */
  activeFormId: string;
  activeInstanceIndex: number;
  pendingFocusLineId: string | null;
  selectedFormKeys: Set<string>;
  /** A tab another part of the case asked to show (e.g. "open this field"). */
  requestedTab: CaseTab | null;
  /** Checklist group the Review tab should bring into view. */
  focusedReviewGroup: ReviewGroup | null;
  /** Document the Documents tab should bring into view. */
  focusedDocumentId: string | null;

  openCase: (id: string) => void;
  closeCase: () => void;
  /** Re-read the case's facts, documents and return after intake wrote them. */
  reloadEvidence: () => void;
  /** Read dropped files onto the open case (services/caseIntake). */
  ingest: (files: readonly File[]) => Promise<IntakeResult | null>;

  updateField: (field: string, value: unknown) => void;
  /** Set a value at a dot path (e.g. "directDeposit.routingNumber"). */
  updateDeepField: (path: string, value: unknown) => void;
  /** Replace the return with an edited copy (e.g. a Scenario Lab value applied), audited under `label`. */
  applyEdit: (label: string, next: TaxReturn, from: unknown, to: unknown) => void;

  resolve: (item: ReviewItem, decision: ReviewResolution['decision'], note: string) => void;
  /** A review action (§38 decision, held-form value, dependent details); the return is re-applied and the case reloaded. */
  act: (run: (returnId: string) => DecisionResult) => DecisionResult;
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
  /** Open the Documents tab at one document. */
  showDocument: (documentId: string) => void;
}

const EMPTY = {
  returnId: null,
  taxReturn: null,
  calculation: null,
  facts: [] as TaxFact[],
  documents: [] as IngestedDocument[],
  reviewRecord: { resolutions: {} } as CaseReviewRecord,
  review: null,
  missingDocuments: [] as MissingDocument[],
  audit: [] as CaseAuditEvent[],
  saveState: 'idle' as SaveState,
  intakeBusy: null as string | null,
  intakeErrors: [] as string[],
  activeFormId: 'f1040',
  activeInstanceIndex: 0,
  pendingFocusLineId: null,
  selectedFormKeys: new Set<string>(),
  requestedTab: null,
  focusedReviewGroup: null as ReviewGroup | null,
  focusedDocumentId: null as string | null,
};

export const useCaseStore = create<CaseState>((set, get) => {
  /** Recalculate and re-review after the return or its evidence changed. */
  const refresh = (taxReturn: TaxReturn, patch: Partial<CaseState> = {}) => {
    const { facts, documents, reviewRecord } = { ...get(), ...patch };
    const calculation = calculate(taxReturn);
    const missingDocuments = caseMissingDocuments(taxReturn, facts, documents);
    const spouseCases = get().returnId ? spouseCaseCandidates(get().returnId!) : [];
    const review = buildCaseReview({ taxReturn, calculation, facts, documents, record: reviewRecord, missingDocuments, spouseCases });
    set({ ...patch, taxReturn, calculation, review, missingDocuments });
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
      refresh(getReturn(id), { facts: loadTaxFacts(id), documents: loadDocuments(id), audit: loadAudit(id) });
    },

    ingest: async (files) => {
      const id = get().returnId;
      if (!id || files.length === 0) return null;
      const mine = () => get().returnId === id;
      set({ intakeBusy: `Waiting to read ${files.length} file${files.length === 1 ? '' : 's'}…`, intakeErrors: [] });
      try {
        // Loaded when first used: the readers bring the PDF and OCR libraries.
        const { enqueueIntake } = await import('../services/caseIntake');
        const result = await enqueueIntake(id, files, {
          onProgress: (message) => { if (mine()) set({ intakeBusy: message }); },
          beforeApply: flushCaseSave,
          afterDocument: () => { if (mine()) get().reloadEvidence(); },
        });
        if (mine()) set({ intakeErrors: result.failures });
        return result;
      } catch (err) {
        if (mine()) set({ intakeErrors: [err instanceof Error ? err.message : 'The files could not be read.'] });
        return null;
      } finally {
        if (mine()) {
          set({ intakeBusy: null });
          get().reloadEvidence();
        }
      }
    },

    updateField: (field, value) => change(field, value, (tr) => ({ ...tr, [field]: value })),
    applyEdit: (label, next, from, to) => edit(label, next, from, to),
    updateDeepField: (path, value) =>
      change(path, value, (tr) => setDeepPath(tr as unknown as Record<string, unknown>, path, value) as unknown as TaxReturn),

    act: (run) => {
      const id = get().returnId;
      if (!id) return { ok: false, error: 'No case is open.' };
      // The preparer's pending edit is saved before the applier reads the return.
      flushCaseSave();
      const result = run(id);
      get().reloadEvidence();
      return result;
    },

    resolve: (item, decision, note) => {
      saveRecord(resolveItem(get().reviewRecord, item, decision, note));
      record({ kind: 'resolution', itemId: item.id, note, decision, message: item.message });
      // A form for another tax year the preparer accepts as this return's goes on it now;
      // "not applicable" closes the item and the form stays off.
      if (item.id.startsWith(YEAR_ITEM_PREFIX) && decision === 'accepted') get().act((id) => ({ ok: true, outcome: applyReleasedForm(id, item.id.slice(YEAR_ITEM_PREFIX.length), note) ?? { kind: 'recorded' } }));
    },
    reopen: (itemId) => {
      const released = get().reviewRecord.resolutions[itemId]?.decision === 'accepted';
      saveRecord(reopenItem(get().reviewRecord, itemId));
      record({ kind: 'reopened', itemId });
      // ...and comes off it again, every way it reached the return, when that decision is reopened.
      if (itemId.startsWith(YEAR_ITEM_PREFIX) && released) get().act((id) => ({ ok: true, outcome: withdrawReleasedForm(id, itemId.slice(YEAR_ITEM_PREFIX.length)) ?? { kind: 'recorded' } }));
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
    showDocument: (documentId) => set({ requestedTab: 'documents', focusedDocumentId: documentId }),
  };
});
