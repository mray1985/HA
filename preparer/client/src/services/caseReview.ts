/**
 * Case review (work order §29, §36, §38, §69): everything a preparer must see
 * before approving a case, in one list, grouped into the review checklist.
 *
 * Sources:
 * - the engine's return diagnostics (ERROR, BLOCKING, WARNING, INFORMATIONAL);
 * - document evidence: a form that validation holds is BLOCKING (its values are
 *   not in the return until it is resolved); other evidence issues, documents
 *   that could not be read, and education forms waiting for the credit choice
 *   are REVIEW.
 *
 * A preparer clears ERROR and BLOCKING items only by changing the return or the
 * documents — the item disappears on the next run. WARNING and REVIEW items can
 * also be resolved by recording a decision with a note. INFORMATIONAL items
 * never block approval.
 *
 * Approval is recorded with a fingerprint of the return: any later change to
 * the return withdraws it.
 */

import type { CalculationResult, Diagnostic, DiagnosticCategory, TaxReturn } from '@hatax/engine';
import { DIAGNOSTIC_CATEGORIES, runReturnDiagnostics } from '@hatax/engine';
import { formKeyOf, validateImportedFacts, type IngestedDocument, type TaxFact } from '@hatax/local-ai';
import { SOURCE_FORM_KEY } from './returnApplier';

export type ReviewGroup = 'personal' | 'income' | 'dependents' | 'deductions' | 'credits' | 'payments' | 'state' | 'documents' | 'other';

export const REVIEW_GROUPS: ReadonlyArray<{ id: ReviewGroup; label: string }> = [
  { id: 'documents', label: 'Documents' },
  { id: 'personal', label: 'Taxpayer & filing status' },
  { id: 'income', label: 'Income' },
  { id: 'dependents', label: 'Dependents' },
  { id: 'deductions', label: 'Deductions' },
  { id: 'credits', label: 'Credits' },
  { id: 'payments', label: 'Payments' },
  { id: 'state', label: 'State' },
  { id: 'other', label: 'Other' },
];

export interface ReviewResolution {
  /** Accepted as correct after checking, or the preparer's other decision. */
  decision: 'accepted' | 'not_applicable';
  note: string;
  resolvedAt: string;
}

export interface CaseApproval {
  approvedAt: string;
  /** Fingerprint of the return when it was approved. */
  returnFingerprint: string;
}

/** Stored per case: decisions on review items and the approval. */
export interface CaseReviewRecord {
  resolutions: Record<string, ReviewResolution>;
  approval?: CaseApproval;
}

export interface ReviewItem {
  id: string;
  category: DiagnosticCategory;
  group: ReviewGroup;
  message: string;
  /** Where it came from: an engine diagnostic, or document evidence. */
  source: Diagnostic['source'] | 'document';
  field?: string;
  itemLabel?: string;
  /** Source document, for document evidence. */
  documentId?: string;
  /** Present when a preparer recorded a decision. */
  resolution?: ReviewResolution;
}

export type CaseStatus = 'waiting_for_documents' | 'needs_attention' | 'needs_review' | 'ready' | 'approved';

export interface CaseReview {
  items: ReviewItem[];
  status: CaseStatus;
  /** Items that stop approval: ERROR, BLOCKING, and unresolved WARNING / REVIEW. */
  open: ReviewItem[];
  canApprove: boolean;
  approval?: CaseApproval;
}

const RESOLVABLE: ReadonlySet<DiagnosticCategory> = new Set(['WARNING', 'REVIEW']);

/** Return section → checklist group. */
export function groupForSection(section: string): ReviewGroup {
  if (section === 'personal_info' || section === 'filing_status') return 'personal';
  if (section === 'dependents') return 'dependents';
  if (section.startsWith('state')) return 'state';
  if (section === 'estimated_payments') return 'payments';
  if (/credit|elderly_disabled|dependent_care|credits_overview/.test(section)) return 'credits';
  if (/deduction|_ded$|itemized|charitable|hsa|alimony_paid/.test(section)) return 'deductions';
  if (/income|^se_|form4797|expense|vehicle|home_office|depreciation|cost_of_goods|schedule1a/.test(section)) return 'income';
  return 'other';
}

/** A change-detecting fingerprint of the return (FNV-1a; not a security hash). */
export function returnFingerprint(taxReturn: TaxReturn): string {
  const { updatedAt: _updatedAt, ...rest } = taxReturn;
  const text = JSON.stringify(rest);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function documentItems(facts: TaxFact[], documents: IngestedDocument[], taxReturn: TaxReturn): ReviewItem[] {
  const items: ReviewItem[] = [];
  const nameOf = (documentId?: string) => documents.find((d) => d.documentId === documentId)?.fileName ?? documentId ?? 'document';

  for (const doc of documents) {
    if (doc.status === 'unclassified') {
      items.push({ id: `document:unclassified:${doc.documentId}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName} could not be identified as a supported tax form. Check what it is.` });
    } else if (doc.status === 'rejected') {
      items.push({ id: `document:rejected:${doc.documentId}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName} was not read: ${doc.rejectReason ?? 'unsupported file'}.` });
    } else if (doc.status === 'registered') {
      items.push({ id: `document:unread:${doc.documentId}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName} has not been read yet.` });
    }
    (doc.appliedAs ?? []).forEach((outcome, index) => {
      if (outcome !== 'not_applied') return;
      const form = doc.formTypes?.[index] ?? doc.classifications?.[index]?.formType ?? 'form';
      items.push({ id: `document:not-applied:${doc.documentId}#${index}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName}: the ${form} was read but is not entered automatically — enter it on the return.` });
    });
  }

  const validation = validateImportedFacts(facts);
  const byForm = new Map<string, string[]>();
  for (const issue of validation.issues) {
    if (issue.holdsForm && issue.formKey) {
      byForm.set(issue.formKey, [...(byForm.get(issue.formKey) ?? []), issue.message]);
      continue;
    }
    items.push({
      id: `document:${issue.code}:${issue.factId ?? issue.formKey ?? ''}`,
      category: 'REVIEW',
      group: 'documents',
      source: 'document',
      documentId: issue.sourceDocumentId,
      field: issue.sourceField,
      message: `${nameOf(issue.sourceDocumentId)}: ${issue.message}`,
    });
  }
  for (const [formKey, messages] of byForm) {
    const documentId = formKey.split('#')[0];
    items.push({
      id: `document:held:${formKey}`,
      category: 'BLOCKING',
      group: 'documents',
      source: 'document',
      documentId,
      message: `${nameOf(documentId)} is held and not in the return: ${[...new Set(messages)].join(' ')}`,
    });
  }

  // Education forms need the preparer's credit choice before they reach the return.
  const applied = new Set((taxReturn.educationCredits ?? []).map((e) => (e as unknown as Record<string, unknown>)[SOURCE_FORM_KEY]));
  const educationForms = new Set(facts.filter((f) => f.factType.startsWith('1098T_')).map(formKeyOf));
  for (const formKey of educationForms) {
    if (applied.has(formKey)) continue;
    const documentId = formKey.split('#')[0];
    items.push({
      id: `document:education-choice:${formKey}`,
      category: 'REVIEW',
      group: 'credits',
      source: 'document',
      documentId,
      message: `${nameOf(documentId)}: choose the American Opportunity or Lifetime Learning credit for this student.`,
    });
  }
  return items;
}

export function buildCaseReview(input: {
  taxReturn: TaxReturn;
  calculation?: CalculationResult | null;
  facts: TaxFact[];
  documents: IngestedDocument[];
  record?: CaseReviewRecord;
}): CaseReview {
  const record = input.record ?? { resolutions: {} };
  const engineItems: ReviewItem[] = runReturnDiagnostics(input.taxReturn, input.calculation).map((d) => ({
    id: d.id,
    category: d.category,
    group: groupForSection(d.section),
    message: d.message,
    source: d.source,
    ...(d.field ? { field: d.field } : {}),
    ...(d.itemLabel ? { itemLabel: d.itemLabel } : {}),
  }));
  const items = [...documentItems(input.facts, input.documents, input.taxReturn), ...engineItems]
    .map((item) => {
      const resolution = RESOLVABLE.has(item.category) ? record.resolutions[item.id] : undefined;
      return resolution ? { ...item, resolution } : item;
    })
    .sort((a, b) => DIAGNOSTIC_CATEGORIES.indexOf(a.category) - DIAGNOSTIC_CATEGORIES.indexOf(b.category));

  const open = items.filter((i) => i.category !== 'INFORMATIONAL' && !i.resolution);
  const canApprove = open.length === 0;
  const approval = record.approval && record.approval.returnFingerprint === returnFingerprint(input.taxReturn) ? record.approval : undefined;

  const hasIncome = [
    input.taxReturn.w2Income, input.taxReturn.income1099INT, input.taxReturn.income1099DIV, input.taxReturn.income1099NEC,
    input.taxReturn.income1099R, input.taxReturn.income1099B, input.taxReturn.income1099K, input.taxReturn.income1099G,
  ].some((list) => (list?.length ?? 0) > 0) || Boolean(input.taxReturn.incomeSSA1099);

  let status: CaseStatus;
  if (approval) status = 'approved';
  else if (input.documents.length === 0 && !hasIncome) status = 'waiting_for_documents';
  else if (open.some((i) => i.category === 'ERROR' || i.category === 'BLOCKING')) status = 'needs_attention';
  else if (!canApprove) status = 'needs_review';
  else status = 'ready';

  return { items, status, open, canApprove, ...(approval ? { approval } : {}) };
}

/** Record a decision on a WARNING or REVIEW item. ERROR and BLOCKING items cannot be waived. */
export function resolveItem(record: CaseReviewRecord, item: ReviewItem, decision: ReviewResolution['decision'], note: string, now = new Date()): CaseReviewRecord {
  if (!RESOLVABLE.has(item.category)) throw new Error(`${item.category} items are cleared by fixing the return, not by a decision.`);
  if (!note.trim()) throw new Error('A resolution needs a note.');
  return { ...record, resolutions: { ...record.resolutions, [item.id]: { decision, note: note.trim(), resolvedAt: now.toISOString() } } };
}

export function reopenItem(record: CaseReviewRecord, itemId: string): CaseReviewRecord {
  const { [itemId]: _removed, ...rest } = record.resolutions;
  return { ...record, resolutions: rest };
}

/** Approve the case as it stands. Refused while anything is open. */
export function approveCase(record: CaseReviewRecord, review: CaseReview, taxReturn: TaxReturn, now = new Date()): CaseReviewRecord {
  if (!review.canApprove) throw new Error(`${review.open.length} review item(s) are still open.`);
  return { ...record, approval: { approvedAt: now.toISOString(), returnFingerprint: returnFingerprint(taxReturn) } };
}
