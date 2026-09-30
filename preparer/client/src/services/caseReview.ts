/**
 * Case review (work order §29, §36, §38, §69): everything a preparer must see
 * before approving a case, in one list, grouped into the review checklist.
 *
 * Sources:
 * - the engine's return diagnostics (ERROR, BLOCKING, WARNING, INFORMATIONAL);
 * - document evidence: a form that validation holds is BLOCKING (its values are
 *   not in the return until it is resolved); other evidence issues, documents
 *   that could not be read, and education forms waiting for the credit choice
 *   are REVIEW;
 * - recorded evidence (dependents, estimated payments, state residency): what
 *   the evidence names but the return cannot hold yet — a dependent missing
 *   the months at home, a payment with no date, conflicting residency — is
 *   REVIEW, recomputed from the facts on every run.
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
import { DIAGNOSTIC_CATEGORIES, FilingStatus, runReturnDiagnostics } from '@hatax/engine';
import {
  buildChoiceItem,
  choiceForms,
  fieldSchemaFor,
  formKeyOf,
  formToolOfFacts,
  resolveDependents,
  resolveEstimatedPayments,
  resolveStateResidency,
  resolveW2Corrections,
  validateImportedFacts,
  type ChoiceTool,
  type DocumentToolName,
  type IngestedDocument,
  type TaxFact,
} from '@hatax/local-ai';
import { dependentWaitReason, SOURCE_FORM_KEY } from './returnApplier';

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
  /** What the preparer can do from the review list to clear the item. */
  action?: ReviewAction;
}

/**
 * - choice: answer what the form cannot say (the form is then applied);
 * - fix: give the value of each field that holds the form;
 * - dependent: give what a dependent named in the evidence still needs.
 */
export type ReviewAction =
  | { kind: 'choice'; tool: ChoiceTool; formKey: string; missing: string[] }
  | { kind: 'fix'; tool: DocumentToolName; formKey: string; fields: string[] }
  | { kind: 'dependent'; firstName: string; lastName: string; missing: Array<'relationship' | 'monthsLivedWithYou'> }
  /** A filing status the client's reply states: the preparer puts it on the return. */
  | { kind: 'filing_status'; status: FilingStatus; label: string };

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
  const heldFields = new Map<string, Set<string>>();
  for (const issue of validation.issues) {
    if (issue.holdsForm && issue.formKey) {
      byForm.set(issue.formKey, [...(byForm.get(issue.formKey) ?? []), issue.message]);
      if (issue.sourceField) heldFields.set(issue.formKey, (heldFields.get(issue.formKey) ?? new Set()).add(issue.sourceField));
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
    const tool = formToolOfFacts(facts.filter((f) => formKeyOf(f) === formKey));
    const shape = tool ? (fieldSchemaFor(tool).shape as Record<string, unknown>) : {};
    const fields = [...(heldFields.get(formKey) ?? [])].filter((f) => Object.prototype.hasOwnProperty.call(shape, f));
    items.push({
      id: `document:held:${formKey}`,
      category: 'BLOCKING',
      group: 'documents',
      source: 'document',
      documentId,
      message: `${nameOf(documentId)} is held and not in the return: ${[...new Set(messages)].join(' ')}`,
      ...(tool && fields.length > 0 ? { action: { kind: 'fix' as const, tool, formKey, fields } } : {}),
    });
  }

  // Forms that need the preparer's decision before they reach the return.
  for (const choice of PREPARER_CHOICES) {
    const target = taxReturn[choice.field] as unknown;
    const entries = Array.isArray(target) ? target : target ? [target] : [];
    const applied = new Set(entries.map((e) => (e as Record<string, unknown>)[SOURCE_FORM_KEY]));
    for (const [formKey, formFacts] of choiceForms(facts, choice.tool)) {
      if (applied.has(formKey) || validation.heldForms.includes(formKey)) continue;
      const documentId = formKey.split('#')[0];
      const built = buildChoiceItem(choice.tool, formFacts);
      items.push({
        id: `document:${choice.id}:${formKey}`,
        category: 'REVIEW',
        group: choice.group,
        source: 'document',
        documentId,
        message: `${nameOf(documentId)}: ${built.state === 'manual' ? built.reason : built.state === 'ready' ? 'the decision is recorded but the form could not be entered — see the document.' : choice.ask}`,
        ...(built.state === 'needs_answer' ? { action: { kind: 'choice' as const, tool: choice.tool, formKey, missing: built.missing } } : {}),
      });
    }
  }
  return items;
}

/** Forms recorded but not applied until the preparer decides what the form cannot say. */
const PREPARER_CHOICES: ReadonlyArray<{ id: string; tool: ChoiceTool; field: keyof TaxReturn; group: ReviewGroup; ask: string }> = [
  { id: 'education-choice', tool: 'add_education_expense', field: 'educationCredits', group: 'credits',
    ask: 'choose the American Opportunity or Lifetime Learning credit for this student.' },
  { id: 'qtp-expenses', tool: 'add_1099_q', field: 'income1099Q', group: 'income',
    ask: 'enter the qualified education expenses this 1099-Q distribution paid; until then it is not on the return.' },
  { id: 'hsa-use', tool: 'add_1099_sa', field: 'income1099SA', group: 'income',
    ask: 'confirm whether this distribution paid qualified medical expenses; until then it is not on the return.' },
  { id: 'home-sale', tool: 'add_1099_s', field: 'homeSale', group: 'income',
    ask: 'say whether this was the main home and enter its basis and months owned and used (§121); until then it is not on the return.' },
];

/** Evidence recorded by the record tools that the return does not hold yet. */
function recordItems(facts: TaxFact[], taxReturn: TaxReturn): ReviewItem[] {
  const items: ReviewItem[] = [];
  const labelOf = (formKey: string) => facts.find((f) => formKeyOf(f) === formKey)?.sourceFileName ?? formKey;
  const documentOf = (formKey: string) => formKey.split('#')[0];
  const typeLabel = (t: string) => t.replace('_', '-');

  for (const person of resolveDependents(facts, taxReturn.taxYear)) {
    if (person.ready) continue;
    const key = person.formKeys[0]!;
    const answerable = person.missing.filter((f): f is 'relationship' | 'monthsLivedWithYou' => f === 'relationship' || f === 'monthsLivedWithYou');
    const canComplete = person.fields.firstName && person.fields.lastName && answerable.length === person.missing.length
      && person.conflicts.length === 0 && person.problems.length === 0;
    items.push({ id: `record:dependent:${key}`, category: 'REVIEW', group: 'dependents', source: 'document', documentId: documentOf(key),
      message: `${dependentWaitReason(person)} (${person.formKeys.map(labelOf).join(', ')})`,
      ...(canComplete ? { action: { kind: 'dependent' as const, firstName: person.fields.firstName!, lastName: person.fields.lastName!, missing: answerable } } : {}) });
  }

  for (const c of resolveW2Corrections(facts, taxReturn.taxYear)) {
    const who = c.employerName ? ` from ${c.employerName}` : '';
    if (!c.ready) {
      items.push({ id: `record:w2c:${c.formKey}`, category: 'REVIEW', group: 'income', source: 'document', documentId: documentOf(c.formKey),
        message: `The W-2c${who} (${labelOf(c.formKey)}) is not applied: ${c.problems.join(' ')}` });
    } else if (c.identityOnly) {
      items.push({ id: `record:w2c:${c.formKey}`, category: 'REVIEW', group: 'personal', source: 'document', documentId: documentOf(c.formKey),
        message: `The W-2c${who} (${labelOf(c.formKey)}) corrects the employee's SSN or name only: check the taxpayer's identity on the return.` });
    }
  }

  const payments = resolveEstimatedPayments(facts, taxReturn.taxYear);
  for (const w of payments.waiting) {
    items.push({ id: `record:estimated-payment:${w.formKey}`, category: 'REVIEW', group: 'payments', source: 'document', documentId: documentOf(w.formKey),
      message: `${w.jurisdiction === 'federal' ? 'Federal' : w.jurisdiction ?? 'An'} estimated payment (${labelOf(w.formKey)}) is not counted: ${w.reason}` });
  }
  for (const e of payments.excluded) {
    items.push({ id: `record:estimated-payment:${e.formKey}`, category: 'INFORMATIONAL', group: 'payments', source: 'document', documentId: documentOf(e.formKey),
      message: `Estimated payment (${labelOf(e.formKey)}) is left out: ${e.reason}` });
  }
  const configs = taxReturn.stateReturns ?? [];
  for (const stateCode of Object.keys(payments.states)) {
    if (configs.some((c) => c.stateCode === stateCode)) continue;
    items.push({ id: `record:state-payments:${stateCode}`, category: 'REVIEW', group: 'state', source: 'document',
      message: `${stateCode} estimated payments are recorded, but the case has no ${stateCode} state return. Record ${stateCode} residency or add the state.` });
  }

  for (const r of resolveStateResidency(facts)) {
    const key = r.formKeys[0]!;
    if (!r.ready) {
      const why = [...r.problems, ...r.conflicts.map((c) => `Sources disagree on the ${c.field} (${c.values.map((v) => String(v.value)).join(' vs ')}).`)];
      items.push({ id: `record:residency:${r.stateCode}`, category: 'REVIEW', group: 'state', source: 'document', documentId: documentOf(key),
        message: `${r.stateCode} residency is not set: ${why.join(' ')}` });
      continue;
    }
    const config = configs.find((c) => c.stateCode === r.stateCode);
    const byHand = config && typeof (config as unknown as Record<string, unknown>)[SOURCE_FORM_KEY] !== 'string';
    if (byHand && (config.residencyType !== r.residencyType || (r.residencyType === 'part_year' && config.daysLivedInState !== r.daysLivedInState))) {
      items.push({ id: `record:residency:${r.stateCode}`, category: 'REVIEW', group: 'state', source: 'document', documentId: documentOf(key),
        message: `The return has ${r.stateCode} as ${typeLabel(config.residencyType)} (entered by hand), but ${r.formKeys.map(labelOf).join(', ')} says ${typeLabel(r.residencyType!)}.` });
    }
  }

  // A filing status the client states (§25) is a candidate: eligibility is the
  // engine's, and the preparer puts it on the return.
  const stated = [...facts].reverse().find((f) => f.factType === 'FILING_STATUS_CANDIDATE' && f.status === 'extracted' && typeof f.value === 'string');
  const candidate = stated ? filingStatusOf(stated.value as string) : undefined;
  if (stated && candidate !== undefined && taxReturn.filingStatus !== candidate) {
    const label = (stated.value as string).replace(/_/g, ' ');
    items.push({
      id: `record:filing-status:${formKeyOf(stated)}`, category: 'REVIEW', group: 'personal', source: 'document', documentId: stated.sourceDocumentId,
      message: `${stated.sourceFileName} states the filing status ${label}${stated.rawText ? ` ("${stated.rawText}")` : ''}${taxReturn.filingStatus ? ', which is not the status on the return' : ''}.`,
      action: { kind: 'filing_status', status: candidate, label },
    });
  }
  return items;
}

const FILING_STATUS_OF: Record<string, FilingStatus> = {
  single: FilingStatus.Single,
  married_filing_jointly: FilingStatus.MarriedFilingJointly,
  married_filing_separately: FilingStatus.MarriedFilingSeparately,
  head_of_household: FilingStatus.HeadOfHousehold,
  qualifying_surviving_spouse: FilingStatus.QualifyingSurvivingSpouse,
};

/** The return's filing status for a stated candidate ("married_filing_jointly"). */
export function filingStatusOf(candidate: string): FilingStatus | undefined {
  return FILING_STATUS_OF[candidate];
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
  const items = [...documentItems(input.facts, input.documents, input.taxReturn), ...recordItems(input.facts, input.taxReturn), ...engineItems]
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
