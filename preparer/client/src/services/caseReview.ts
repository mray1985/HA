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

import type { CalculationResult, Diagnostic, DiagnosticCategory, StateQuestion, TaxReturn } from '@hatax/engine';
import { DIAGNOSTIC_CATEGORIES, FilingStatus, getStateName, runReturnDiagnostics, stateQuestions } from '@hatax/engine';
import {
  buildChoiceItem,
  choiceForms,
  fieldSchemaFor,
  formKeyOf,
  formToolOfFacts,
  missingDocumentTitle,
  resolveDependents,
  resolveEstimatedPayments,
  resolveStateResidency,
  resolveW2Corrections,
  validateImportedFacts,
  type ChoiceTool,
  type DocumentToolName,
  type IngestedDocument,
  type MissingDocument,
  type TaxFact,
} from '@hatax/local-ai';
import { dependentWaitReason, SOURCE_FORM_KEY } from './returnApplier';
import { returnFieldSpec } from './returnFields';
import type { RolloverRecord } from './caseRollover';
import { planIdentity, type IdentityItem } from './caseIdentity';

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

/** Stored per case: decisions on review items, the approval, and what was carried from last year's case. */
export interface CaseReviewRecord {
  resolutions: Record<string, ReviewResolution>;
  approval?: CaseApproval;
  rollover?: RolloverRecord;
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
  | { kind: 'filing_status'; status: FilingStatus; label: string }
  /** The date a depreciation asset (or the vehicle) was acquired, which sets its special depreciation (§168(k)). */
  | { kind: 'acquisition_date'; assetId: string | 'vehicle' }
  /** A fact a state rule needs (the engine's question), kept on the state return; `current` is the answer given. */
  | { kind: 'state_answer'; question: StateQuestion; current?: boolean | number | string }
  /** A return field the readiness check reports missing (name, SSN, address, filing status), filled in place. */
  | { kind: 'return_field'; field: string }
  /** Last year's refund account, put on the return once the preparer confirms it. */
  | { kind: 'use_bank'; label: string }
  /** The taxpayer's identity from the documents: a reading to use, a person to place, an address to choose. */
  | NonNullable<IdentityItem['action']>
  /** The spouse's own case (services/spouseCases), joined to this one as a joint return. */
  | { kind: 'join_spouse_case'; returnId: string; name: string; documents: number };

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
        message: `${doc.fileName} has not been read yet. Drop the file on the case again to read it.` });
    }
    // A form for another tax year: its amounts belong on that year's return.
    (doc.taxYearsPrinted ?? []).forEach((year, index) => {
      if (!year || year === String(taxReturn.taxYear)) return;
      // classifications are one per piece, like the years; formTypes leaves out pieces that are not forms.
      const form = doc.classifications?.[index]?.formType ?? doc.formTypes?.[index] ?? 'form';
      items.push({ id: `document:year:${doc.documentId}#${index}`, category: 'WARNING', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName} is a ${year} ${form}; this is the ${taxReturn.taxYear} return. It is held and not on the return: its amounts belong on the ${year} return — move it to that case, or mark it checked and correct with why it belongs here and it is added. Not applicable keeps it off.` });
    });
    (doc.appliedAs ?? []).forEach((outcome, index) => {
      const form = doc.classifications?.[index]?.formType ?? doc.formTypes?.[index] ?? 'form';
      if (outcome === 'not_applied') {
        items.push({ id: `document:not-applied:${doc.documentId}#${index}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
          message: `${doc.fileName}: the ${form} was read but is not entered automatically — enter it on the return.` });
        return;
      }
      // A total that is waiting on another form, or on a decision the form
      // cannot make, leaves the return short without saying why. The reason the
      // applier recorded is the only thing that explains the missing amount.
      if (outcome !== 'aggregate_waiting') return;
      const why = doc.applyReasons?.[index]?.trim();
      items.push({ id: `document:aggregate-waiting:${doc.documentId}#${index}`, category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName}: the ${form} was read but its amount is not on the return yet — ${why || 'it waits for the preparer'}.` });
    });
    // Boxes the reader could not place by itself.
    //
    // This is the only list that says a document is incomplete, so it has to be
    // acknowledged before the case can be approved. A preparer inspecting the
    // return cannot know which boxes the app was unsure about unless the case
    // says so — the Documents tab holds the detail, and approval can be reached
    // without that tab ever being open. REVIEW rather than BLOCKING: an unplaced
    // box does not make the return wrong on its own (a blank W-2 tip box is
    // nothing to fix), but it must be seen rather than passed over silently.
    //
    // The box count is in the id, so a re-read that leaves a different number of
    // boxes opens a new item instead of inheriting the old acknowledgement.
    const gaps = (doc.boxGaps ?? []).flatMap((g) => g.boxes);
    if (doc.status === 'extracted' && gaps.length > 0) {
      const forms = [...new Set((doc.boxGaps ?? []).map((g) => g.formType ?? 'this form'))];
      const named = gaps.slice(0, 3).map((b) => (b.box ? `box ${b.box}` : b.label)).join(', ');
      items.push({
        id: `document:gaps:${doc.documentId}:${gaps.length}`,
        category: 'REVIEW', group: 'documents', source: 'document', documentId: doc.documentId,
        message: `${doc.fileName}: ${gaps.length} box${gaps.length === 1 ? '' : 'es'} on ${forms.join(' and ')} could not be added by itself — ${named}${gaps.length > 3 ? ', and more' : ''}. Check them against the form, then mark this checked.`,
      });
    }
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

/**
 * §23: each of last year's documents the case lacks is *possibly* missing. It
 * is asked about on the Client tab; the client's "no" leaves a note, and their
 * "yes" waits for the upload.
 */
function missingDocumentItems(missing: readonly MissingDocument[]): ReviewItem[] {
  return missing.map((m): ReviewItem => {
    const title = missingDocumentTitle(m);
    const words = m.answer ? ` ("${m.answer.words}", ${m.answer.source})` : '';
    const from = m.issuer ? ` from ${m.issuer}` : '';
    return {
      id: `missing-document:${m.id}`,
      category: m.status === 'client_says_none' ? 'INFORMATIONAL' : 'REVIEW',
      group: 'documents',
      source: 'document',
      message: m.status === 'possibly_missing'
        ? `${title}: ${m.lastYear}. Upload it, or ask the client (Client tab).`
        : m.status === 'client_says_received'
          ? `The client says they received the ${m.formType}${from}${words}: upload it (${m.lastYear}).`
          : `The client says there is no ${m.formType}${from} this year${words}; ${m.lastYear}.`,
    };
  });
}

const ROLLOVER_GROUP: Record<string, ReviewGroup> = {
  'capital-loss': 'income', nol: 'income', 'home-office': 'income', 'section-179': 'income', 'depreciation-assets': 'income',
  'section-1231': 'income', charitable: 'deductions', 'investment-interest': 'deductions', 'form-8801': 'credits', adoption: 'credits',
};

/**
 * §14: a case started from last year's case — what was carried (for the
 * record), what to confirm with the client, the carryovers to enter, and last
 * year's refund account until the preparer uses or declines it.
 */
function rolloverItems(record: CaseReviewRecord, taxReturn: TaxReturn): ReviewItem[] {
  const r = record.rollover;
  if (!r) return [];
  const items: ReviewItem[] = [{
    id: 'rollover:carried', category: 'INFORMATIONAL', group: 'personal', source: 'document',
    message: `Started from the ${r.fromYear} case: carried ${r.carried.join('; ')}.`,
  }];
  if (!r.approved) {
    items.push({ id: 'rollover:not-approved', category: 'REVIEW', group: 'other', source: 'document',
      message: `The ${r.fromYear} case was not approved when this case started, so no carryovers were carried from it. Check the ${r.fromYear} return as filed for carryovers.` });
  }
  for (const c of r.confirm) {
    items.push({ id: `rollover:confirm:${c.id}`, category: 'REVIEW', group: 'personal', source: 'document', message: c.text });
  }
  for (const m of r.manual) {
    items.push({ id: `rollover:manual:${m.id}`, category: 'REVIEW', group: ROLLOVER_GROUP[m.id.split(':')[0]!] ?? 'income', source: 'document', message: `From the ${r.fromYear} case — ${m.text}` });
  }
  if (r.bank && !taxReturn.directDeposit) {
    const label = `${r.bank.accountType} account ending ${r.bank.accountNumber.slice(-4)}`;
    items.push({ id: 'rollover:bank', category: 'REVIEW', group: 'payments', source: 'document',
      message: `Last year's refund went to the ${label} (routing ${r.bank.routingNumber}). Confirm it with the client before using it for ${taxReturn.taxYear}.`,
      action: { kind: 'use_bank', label } });
  }
  return items;
}

/** State questions already answered: shown with the answer, which the preparer can change. */
function answeredStateItems(taxReturn: TaxReturn, calculation: CalculationResult | null | undefined, engineItems: readonly ReviewItem[]): ReviewItem[] {
  const open = new Set(engineItems.flatMap((i) => (i.action?.kind === 'state_answer' ? [`${i.action.question.stateCode}:${i.action.question.key}`] : [])));
  return stateQuestions(taxReturn, calculation).filter((q) => !open.has(`${q.stateCode}:${q.key}`)).flatMap((q): ReviewItem[] => {
    const value = (taxReturn.stateReturns ?? []).find((c) => c.stateCode.toUpperCase() === q.stateCode)?.stateSpecificData?.[q.key];
    if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') return [];
    const shown = typeof value === 'boolean' ? (value ? 'Yes' : 'No')
      : typeof value === 'string' ? (q.options?.find((o) => o.value === value)?.label ?? value)
      : q.kind === 'count' ? String(value)
      : `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US')}`;
    return [{
      id: `state-answer:${q.stateCode}:${q.key}`, category: 'INFORMATIONAL', group: groupForSection(`state_${q.stateCode.toLowerCase()}`), source: 'unsupported',
      message: `${getStateName(q.stateCode)}: ${q.prompt}${q.prompt.endsWith('?') ? '' : ':'} ${shown}.`,
      action: { kind: 'state_answer', question: q, current: value },
    }];
  });
}

/** The engine's finding for special depreciation it cannot figure without the date acquired. */
const BONUS_RULE = 'FED.BONUS_DEPRECIATION.168K';

/** Engine findings one return field settles, filled from the review item. */
const FIELD_FINDINGS: Record<string, string> = {
  'unsupported:FED.VEHICLE.STANDARD_MILEAGE_SPLIT:vehicle': 'vehicle.businessMilesFromJuly1',
  'unsupported:FED.FORM8829.LINE41:homeOffice': 'homeOffice.dateFirstUsedForBusiness',
  'unsupported:FED.170P.NON_ITEMIZER:charitable': 'nonItemizerCharitableCash',
};

/** The Form 8615 answer or parent's figure a FED.8615 finding asks for, as a return field path. */
function form8615Field(id: string): string | undefined {
  const match = /^unsupported:FED\.8615\.(?:APPLIES|PARENT):(\w+)$/.exec(id);
  return match ? `form8615.${match[1]}` : undefined;
}

/** The K-1 whose kind a FED.K1.ENTITY_TYPE finding asks for, as a return field path. */
function k1EntityField(id: string, taxReturn: TaxReturn): string | undefined {
  const prefix = 'unsupported:FED.K1.ENTITY_TYPE:';
  if (!id.startsWith(prefix)) return undefined;
  const index = (taxReturn.incomeK1 ?? []).findIndex((k) => k.id === id.slice(prefix.length));
  return index >= 0 ? `incomeK1.${index}.entityType` : undefined;
}

export function buildCaseReview(input: {
  taxReturn: TaxReturn;
  calculation?: CalculationResult | null;
  facts: TaxFact[];
  documents: IngestedDocument[];
  record?: CaseReviewRecord;
  /** Last year's documents this case does not have (§23), from services/missingDocuments. */
  missingDocuments?: readonly MissingDocument[];
  /** Other cases of the year that may be this return's spouse (services/spouseCases). */
  spouseCases?: ReadonlyArray<{ returnId: string; name: string; documents: number; why: 'spouse_ssn' | 'household' }>;
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
    ...(d.source === 'unsupported' && d.id.startsWith(`unsupported:${BONUS_RULE}:`)
      ? { action: { kind: 'acquisition_date' as const, assetId: d.id.slice(`unsupported:${BONUS_RULE}:`.length) } }
      : {}),
    ...(d.question ? { action: { kind: 'state_answer' as const, question: d.question } } : {}),
    ...(d.source === 'readiness' && d.field && returnFieldSpec(d.field, input.taxReturn) ? { action: { kind: 'return_field' as const, field: d.field } } : {}),
    ...(FIELD_FINDINGS[d.id] ? { action: { kind: 'return_field' as const, field: FIELD_FINDINGS[d.id]! } } : {}),
    ...(k1EntityField(d.id, input.taxReturn) ? { action: { kind: 'return_field' as const, field: k1EntityField(d.id, input.taxReturn)! } } : {}),
    ...(form8615Field(d.id) ? { action: { kind: 'return_field' as const, field: form8615Field(d.id)! } } : {}),
  }));
  // No date of birth reads as under 65: an older client would lose the additional
  // standard deduction and the senior deduction without anyone deciding it.
  const birthDates: ReviewItem[] = ([
    ['dateOfBirth', 'The taxpayer', true],
    ['spouseDateOfBirth', 'The spouse', input.taxReturn.filingStatus === FilingStatus.MarriedFilingJointly],
  ] as const).filter(([field, , applies]) => applies && !input.taxReturn[field]).map(([field, who]) => ({
    id: `case:${field}`, category: 'REVIEW', group: 'personal', source: 'readiness', field,
    message: `${who}'s date of birth is not entered: the return treats them as under 65 (no additional standard deduction for 65 or older, no senior deduction).`,
    action: { kind: 'return_field' as const, field },
  }));
  // The spouse's documents in a case of their own: joined to this return when the preparer says so.
  const spouseCases: ReviewItem[] = (input.spouseCases ?? []).map((c) => ({
    id: `case:spouse-case:${c.returnId}`, category: 'REVIEW', group: 'personal', source: 'readiness',
    message: c.why === 'spouse_ssn'
      ? `${c.name}, the spouse on this return, has a ${input.taxReturn.taxYear} case of their own with ${c.documents} document${c.documents === 1 ? '' : 's'}: join it to this joint return.`
      : `${c.name}'s ${input.taxReturn.taxYear} case has the same last name and address. If they are the spouse, join that case to this return as a joint return — the documents come with it.`,
    action: { kind: 'join_spouse_case' as const, returnId: c.returnId, name: c.name, documents: c.documents },
  }));
  const identity: ReviewItem[] = planIdentity(input.taxReturn, input.documents).items.map((i) => ({
    id: i.id, category: 'REVIEW', group: 'personal', source: 'document', message: i.message,
    ...(i.documentId ? { documentId: i.documentId } : {}), ...(i.action ? { action: i.action } : {}),
  }));
  const items = [...rolloverItems(record, input.taxReturn), ...identity, ...spouseCases, ...birthDates, ...documentItems(input.facts, input.documents, input.taxReturn), ...missingDocumentItems(input.missingDocuments ?? []), ...recordItems(input.facts, input.taxReturn), ...engineItems, ...answeredStateItems(input.taxReturn, input.calculation, engineItems)]
    .map((item) => {
      const resolution = RESOLVABLE.has(item.category) ? record.resolutions[item.id] : undefined;
      return resolution ? { ...item, resolution } : item;
    })
    .sort((a, b) => DIAGNOSTIC_CATEGORIES.indexOf(a.category) - DIAGNOSTIC_CATEGORIES.indexOf(b.category));

  const open = items.filter((i) => i.category !== 'INFORMATIONAL' && !i.resolution);
  const canApprove = open.length === 0;
  // An approval stands for the return it approved and only while nothing is open:
  // new evidence (a held or unread document) can open items without changing the return.
  const approval = canApprove && record.approval && record.approval.returnFingerprint === returnFingerprint(input.taxReturn) ? record.approval : undefined;

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
