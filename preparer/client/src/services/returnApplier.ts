/**
 * The return builder's applier (work order §26): turns schema-validated
 * tax-tool results into changes to a case's return. It never writes form
 * lines — the engine owns those.
 *
 * - income_item: one engine item per document form, tagged with the form it
 *   came from. Applying the same form again replaces its item, so a document
 *   read twice never counts twice.
 * - aggregate: the engine keeps one total for the return (Social Security
 *   benefits, mortgage interest). The total is recomputed from every fact of
 *   that kind in the case. While any form of that kind is held by validation
 *   or lacks its required amount, the total is not recomputed — an unknown
 *   amount is never counted as zero, and a partial total is never written.
 * - dependent: one engine dependent per person, merged from every source that
 *   names them (recordResolution.resolveDependents). A person missing what the
 *   engine requires (months at home, relationship) is not added — never
 *   defaulted — and the case review asks for it.
 * - estimated payments and state residency are totals too: federal payments
 *   by installment, and each state's return (residency, days, payments).
 * - needs_preparer_choice / candidate_fact: recorded as facts only; the case
 *   review asks the preparer.
 *
 * Entries the evidence put on the return carry SOURCE_FORM_KEY and are
 * rewritten from the facts. Entries a preparer typed (no key) are never
 * overwritten: when the evidence disagrees with one, that is reported.
 *
 * A document proves its income or deduction exists, so a "no" answer to the
 * matching discovery question (which makes the engine ignore that section)
 * becomes "yes".
 *
 * Forms with no tax tool (W-2G, 1099-DA, K-1, …) are applied the same way
 * when their type is a return item; anything else is left for the preparer.
 *
 * Call after the result's facts are saved (preparerTaxFacts.appendTaxFacts):
 * holds and totals are computed from the saved facts.
 */

import type { Dependent, StateReturnConfig, TaxReturn } from '@hatax/engine';
import {
  amountFromFact,
  applyW2Corrections,
  buildChoiceItem,
  choiceForms,
  dependentLabel,
  formKeyOf,
  resolveDependents,
  resolveEstimatedPayments,
  resolveStateResidency,
  resolveW2Corrections,
  toolFieldsFromFacts,
  engineItemFields,
  formToolForIncomeType,
  TOOL_APPLICATION,
  validateImportedFacts,
  type AggregateTarget,
  type ChoiceTool,
  type PreparerChoiceTarget,
  type DocumentPieceOutcome,
  type ResolvedDependent,
  type TaxFact,
  type TaxToolApplication,
  type TaxToolSuccess,
} from '@hatax/local-ai';
import { ARRAY_FIELD_MAP, getReturn, updateReturn, upsertItemized, upsertSSA1099 } from '../api/client';
import { upsertDocument, type ApplyExtractionResult } from './documentIngestion';
import { INCOME_DISCOVERY_KEYS } from './pdfExtractHelpers';
import { loadTaxFacts } from './preparerTaxFacts';

/** Property on an engine item naming the document form it was built from. */
export const SOURCE_FORM_KEY = 'sourceFormKey';

export type ApplyOutcome =
  | { kind: 'income_item'; itemType: string; itemId: string; replaced: boolean }
  | { kind: 'aggregate'; target: AggregateTarget; applied: true; forms: number }
  | { kind: 'aggregate'; target: AggregateTarget; applied: false; reason: string }
  | { kind: 'dependent'; applied: true; dependentId: string }
  | { kind: 'dependent'; applied: false; reason: string }
  /** A form that needed a preparer decision, now on the return. */
  | { kind: 'decided'; itemId: string }
  /** A W-2c: the W-2 it corrects (on the return, corrected), or why it waits. */
  | { kind: 'correction'; applied: true; w2FormKey: string }
  | { kind: 'correction'; applied: false; reason: string }
  | { kind: 'held'; reason: string }
  | { kind: 'recorded' };

/** What the applier needs from a tool result: where it goes and its validated fields. */
export type ApplicableResult = Pick<TaxToolSuccess, 'application' | 'fields'>;

const AGGREGATE_DISCOVERY: Partial<Record<AggregateTarget, string>> = {
  socialSecurityBenefits: INCOME_DISCOVERY_KEYS.ssa1099!,
  mortgageInterest: INCOME_DISCOVERY_KEYS['1098']!,
};

export function applyToolResult(
  returnId: string,
  result: ApplicableResult,
  source: { documentId: string; formIndex?: number },
): ApplyOutcome {
  const app = result.application;
  switch (app.kind) {
    case 'income_item': {
      const formKey = formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.formIndex });
      if (heldForms(returnId).has(formKey)) {
        return { kind: 'held', reason: 'Validation holds this form until a preparer reviews it.' };
      }
      markDiscovered(returnId, INCOME_DISCOVERY_KEYS[app.itemType]);
      const fields = app.itemType === 'business-receipts' ? businessReceiptItem(returnId, result.fields)
        // A W-2 read again keeps the corrections its W-2cs make.
        : app.itemType === 'w2' ? applyW2Corrections(formKey, result.fields, resolveW2Corrections(loadTaxFacts(returnId), getReturn(returnId).taxYear))
        : result.fields;
      return putIncomeItem(returnId, app.itemType, formKey, fields);
    }
    case 'aggregate': {
      markDiscovered(returnId, AGGREGATE_DISCOVERY[app.target]);
      const formKey = formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.formIndex });
      if (app.target === 'estimatedPayments') return recomputeEstimatedPayments(returnId, formKey);
      if (app.target === 'stateResidency') return syncStateReturns(returnId).get(formKey) ?? { kind: 'recorded' };
      return recomputeAggregate(returnId, app.target);
    }
    case 'dependent':
      return recomputeDependents(returnId).get(formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.formIndex })) ?? { kind: 'recorded' };
    case 'w2_correction':
      return recomputeW2Corrections(returnId).get(formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.formIndex })) ?? { kind: 'recorded' };
    case 'needs_preparer_choice':
      return applyChoiceForm(returnId, CHOICE_TOOL[app.target], formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.formIndex }));
    case 'candidate_fact':
      return { kind: 'recorded' };
  }
}

/** Where one extracted form goes: its tool's application, or a return item when HATax reads the type deterministically. */
function applicationFor(incomeType: string | null): TaxToolApplication | null {
  const tool = formToolForIncomeType(incomeType);
  if (tool) return TOOL_APPLICATION[tool];
  if (incomeType && ARRAY_FIELD_MAP[incomeType]) return { kind: 'income_item', itemType: incomeType } as TaxToolApplication;
  return null;
}

export function outcomeOfApply(outcome: ApplyOutcome): DocumentPieceOutcome {
  switch (outcome.kind) {
    case 'income_item': return 'income_item';
    case 'aggregate': return outcome.applied ? 'aggregate' : 'aggregate_waiting';
    case 'dependent': return outcome.applied ? 'dependent' : 'dependent_waiting';
    case 'decided': return 'income_item';
    case 'correction': return outcome.applied ? 'correction' : 'correction_waiting';
    case 'held': return 'held';
    case 'recorded': return 'recorded';
  }
}

/**
 * Apply every form of an extracted document to the return, and record on the
 * document how each form got there.
 */
export function applyExtraction(returnId: string, extraction: ApplyExtractionResult): DocumentPieceOutcome[] {
  if (extraction.unclassified || extraction.provenanceError) return [];
  const outcomes = extraction.pieces.map((piece, formIndex): DocumentPieceOutcome => {
    if (piece.toolError || !piece.incomeType) return 'not_applied';
    const application = applicationFor(piece.incomeType);
    if (!application) return 'not_applied';
    if ((application.kind === 'income_item' || application.kind === 'w2_correction') && Object.keys(piece.toolFields).length === 0) return 'not_applied';
    return outcomeOfApply(applyToolResult(returnId, { application, fields: piece.toolFields },
      { documentId: extraction.document.documentId, formIndex }));
  });
  upsertDocument(returnId, { ...extraction.document, appliedAs: outcomes });
  return outcomes;
}

function heldForms(returnId: string): Set<string> {
  return new Set(validateImportedFacts(loadTaxFacts(returnId)).heldForms);
}

function markDiscovered(returnId: string, key: string | undefined): void {
  if (!key) return;
  const tr = getReturn(returnId);
  if (tr.incomeDiscovery?.[key] !== 'no') return;
  updateReturn(returnId, { incomeDiscovery: { ...tr.incomeDiscovery, [key]: 'yes' } });
}

function putIncomeItem(returnId: string, itemType: string, formKey: string, fields: Record<string, unknown>): ApplyOutcome {
  const field = ARRAY_FIELD_MAP[itemType];
  if (!field) throw new Error(`No return field for item type ${itemType}`);
  const tr = getReturn(returnId);
  const items = ((tr[field] as unknown as Array<Record<string, unknown>> | undefined) ?? []);
  const index = items.findIndex((i) => i[SOURCE_FORM_KEY] === formKey);
  // The whole item is rewritten: a box read before but unknown now must not linger.
  const id = index >= 0 ? String(items[index]!.id) : crypto.randomUUID();
  const item = { ...engineItemFields(itemType, fields), [SOURCE_FORM_KEY]: formKey, id };
  const next = index >= 0 ? items.map((existing, i) => (i === index ? item : existing)) : [...items, item];
  updateReturn(returnId, { [field]: next });
  return { kind: 'income_item', itemType, itemId: id, replaced: index >= 0 };
}

/** Facts of one kind, by form, as field → fact, and which of those forms validation holds. */
function factsByForm(returnId: string, factPrefix: string): { forms: Map<string, Map<string, TaxFact>>; held: string[] } {
  const facts = loadTaxFacts(returnId);
  const heldForms = new Set(validateImportedFacts(facts).heldForms);
  const forms = new Map<string, Map<string, TaxFact>>();
  for (const fact of facts) {
    if (!fact.factType.startsWith(factPrefix)) continue;
    const key = formKeyOf(fact);
    const fields = forms.get(key) ?? new Map<string, TaxFact>();
    fields.set(fact.factType.slice(factPrefix.length), fact);
    forms.set(key, fields);
  }
  return { forms, held: [...forms.keys()].filter((k) => heldForms.has(k)) };
}

function sumPresent(forms: Iterable<Map<string, TaxFact>>, field: string): number | undefined {
  let total: number | undefined;
  for (const fields of forms) {
    const fact = fields.get(field);
    const amount = fact ? amountFromFact(fact) : undefined;
    if (amount !== undefined) total = (total ?? 0) + amount;
  }
  return total;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function recomputeAggregate(returnId: string, target: 'socialSecurityBenefits' | 'mortgageInterest'): ApplyOutcome {
  if (target === 'socialSecurityBenefits') {
    const { forms, held } = factsByForm(returnId, 'SSA1099_');
    if (held.length > 0) {
      return { kind: 'aggregate', target, applied: false, reason: `SSA-1099 ${held.join(', ')} is held for review; the total waits for it.` };
    }
    for (const [key, fields] of forms) {
      const net = fields.get('netBenefits');
      if (!net || amountFromFact(net) === undefined) {
        return { kind: 'aggregate', target, applied: false, reason: `SSA-1099 ${key} has no readable net benefits (box 5).` };
      }
    }
    if (forms.size === 0) return { kind: 'aggregate', target, applied: false, reason: 'No SSA-1099 can be applied.' };
    const withheld = sumPresent(forms.values(), 'federalTaxWithheld');
    upsertSSA1099(returnId, {
      totalBenefits: round2(sumPresent(forms.values(), 'netBenefits')!),
      federalTaxWithheld: round2(withheld ?? 0),
    });
    return { kind: 'aggregate', target, applied: true, forms: forms.size };
  }

  const { forms, held } = factsByForm(returnId, '1098_');
  if (held.length > 0) {
    return { kind: 'aggregate', target, applied: false, reason: `Form 1098 ${held.join(', ')} is held for review; the total waits for it.` };
  }
  for (const [key, fields] of forms) {
    const interest = fields.get('mortgageInterest');
    if (!interest || amountFromFact(interest) === undefined) {
      return { kind: 'aggregate', target, applied: false, reason: `Form 1098 ${key} has no readable mortgage interest (box 1).` };
    }
  }
  if (forms.size === 0) return { kind: 'aggregate', target, applied: false, reason: 'No Form 1098 can be applied.' };
  // The outstanding balance limits the deduction; a partial sum would understate
  // it, so it is written only when every form reports it.
  const everyBalance = [...forms.values()].every((f) => f.get('outstandingPrincipal') && amountFromFact(f.get('outstandingPrincipal')!) !== undefined);
  const balance = everyBalance ? sumPresent(forms.values(), 'outstandingPrincipal') : undefined;
  const existing: Partial<TaxReturn['itemizedDeductions']> = getReturn(returnId).itemizedDeductions ?? {};
  upsertItemized(returnId, {
    mortgageInterest: round2(sumPresent(forms.values(), 'mortgageInterest')!),
    mortgageInsurancePremiums: round2(sumPresent(forms.values(), 'mortgageInsurancePremiums') ?? 0),
    ...(balance !== undefined ? { mortgageBalance: round2(balance) } : existing?.mortgageBalance !== undefined ? { mortgageBalance: undefined } : {}),
  });
  return { kind: 'aggregate', target, applied: true, forms: forms.size };
}

// ─── Business receipts ───────────────────────────────────────

const normName = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The engine's receipt item. It is routed to a business only when the name
 * matches exactly one business on the return, or the return has just one
 * business and the records name none.
 */
function businessReceiptItem(returnId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const businessName = typeof fields.businessName === 'string' ? fields.businessName : undefined;
  const description = typeof fields.description === 'string' ? fields.description : undefined;
  const tr = getReturn(returnId);
  const businesses = tr.businesses?.length ? tr.businesses : tr.business ? [tr.business] : [];
  const named = businessName ? businesses.filter((b) => b.businessName && normName(b.businessName) === normName(businessName)) : [];
  const businessId = named.length === 1 ? named[0]!.id : !businessName && businesses.length === 1 ? businesses[0]!.id : undefined;
  return {
    description: description ?? (businessName ? `Receipts not on a 1099 (${businessName})` : 'Receipts not on a 1099'),
    ...(typeof fields.amount === 'number' ? { amount: fields.amount } : {}),
    ...(businessId ? { businessId } : {}),
  };
}

// ─── Dependents ──────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  relationship: 'relationship',
  monthsLivedWithYou: 'months lived with the taxpayer',
};

/** Why a person named in the evidence is not on the return. */
export function dependentWaitReason(person: ResolvedDependent): string {
  const parts: string[] = [];
  if (person.missing.length > 0) parts.push(`the evidence does not give the ${person.missing.map((f) => FIELD_LABEL[f] ?? f).join(', ')}`);
  for (const c of person.conflicts) parts.push(`sources disagree on the ${FIELD_LABEL[c.field] ?? c.field} (${c.values.map((v) => String(v.value)).join(' vs ')})`);
  parts.push(...person.problems.map((p) => p.replace(/\.$/, '')));
  return `${dependentLabel(person)} is not on the return: ${parts.join('; ')}.`;
}

function ownerKey(entry: object): string | undefined {
  const key = (entry as Record<string, unknown>)[SOURCE_FORM_KEY];
  return typeof key === 'string' ? key : undefined;
}

const isEvidenceOwned = (entry: object) => ownerKey(entry) !== undefined;

/** A preparer-entered dependent that is this person (same SSN, or same name). */
function enteredByHand(dependents: Dependent[], person: ResolvedDependent): Dependent | undefined {
  const digits = (t?: string) => (t ?? '').replace(/\D/g, '');
  return dependents.find((d) => {
    if (isEvidenceOwned(d)) return false;
    if (person.fields.ssn && digits(d.ssn).length === 9) return digits(d.ssn) === person.fields.ssn;
    return normName(d.firstName ?? '') === normName(person.fields.firstName ?? '') && normName(d.lastName ?? '') === normName(person.fields.lastName ?? '');
  });
}

/**
 * Rewrite the evidence-owned dependents from the facts, keeping each one's id
 * and its place in the list. Returns the outcome for every record, by form key.
 */
export function recomputeDependents(returnId: string): Map<string, ApplyOutcome> {
  const tr = getReturn(returnId);
  const existing = tr.dependents ?? [];
  const people = resolveDependents(loadTaxFacts(returnId), tr.taxYear);
  const outcomes = new Map<string, ApplyOutcome>();
  const replacement = new Map<string, Dependent | null>(); // owner key → new entry (null: remove)
  const added: Dependent[] = [];

  for (const person of people) {
    let outcome: ApplyOutcome;
    const prior = existing.find((d) => person.formKeys.includes(ownerKey(d) ?? ''));
    if (!person.ready) {
      outcome = { kind: 'dependent', applied: false, reason: dependentWaitReason(person) };
    } else if (enteredByHand(existing, person)) {
      outcome = { kind: 'dependent', applied: false, reason: `${dependentLabel(person)} is already on the return, entered by hand; the evidence is recorded but the person is not added twice.` };
    } else {
      const f = person.fields;
      const entry = {
        id: prior?.id ?? crypto.randomUUID(),
        firstName: f.firstName!,
        lastName: f.lastName!,
        relationship: f.relationship!,
        monthsLivedWithYou: f.monthsLivedWithYou!,
        ...(f.ssn ? { ssn: f.ssn } : {}),
        ...(f.ssnLastFour ? { ssnLastFour: f.ssnLastFour } : {}),
        ...(f.dateOfBirth ? { dateOfBirth: f.dateOfBirth } : {}),
        ...(f.isStudent !== undefined ? { isStudent: f.isStudent } : {}),
        ...(f.isDisabled !== undefined ? { isDisabled: f.isDisabled } : {}),
        [SOURCE_FORM_KEY]: person.formKeys[0]!,
      } as Dependent;
      if (prior) replacement.set(ownerKey(prior)!, entry);
      else added.push(entry);
      outcome = { kind: 'dependent', applied: true, dependentId: entry.id };
    }
    if (prior && !(outcome.kind === 'dependent' && outcome.applied)) replacement.set(ownerKey(prior)!, null);
    for (const key of person.formKeys) outcomes.set(key, outcome);
  }

  const next: Dependent[] = [];
  for (const d of existing) {
    const key = ownerKey(d);
    if (key === undefined) next.push(d);
    else if (replacement.get(key)) next.push(replacement.get(key)!);
    // Evidence-owned entries whose person no longer resolves are dropped.
  }
  next.push(...added);
  if (JSON.stringify(next) !== JSON.stringify(existing)) updateReturn(returnId, { dependents: next });
  return outcomes;
}

// ─── Estimated payments and state returns ────────────────────

function recomputeEstimatedPayments(returnId: string, formKey: string): ApplyOutcome {
  const tr = getReturn(returnId);
  const facts = loadTaxFacts(returnId);
  const resolved = resolveEstimatedPayments(facts, tr.taxYear);
  if (resolved.federal) {
    updateReturn(returnId, {
      estimatedQuarterlyPayments: resolved.federal.quarters,
      estimatedPaymentsMade: resolved.federal.total,
      estimatedPaymentSchedule: resolved.federal.schedule,
    });
  }
  const stateOutcomes = syncStateReturns(returnId);

  const target = 'estimatedPayments' as const;
  const waiting = resolved.waiting.find((w) => w.formKey === formKey);
  if (waiting) return { kind: 'aggregate', target, applied: false, reason: waiting.reason };
  const excluded = resolved.excluded.find((e) => e.formKey === formKey);
  if (excluded) return { kind: 'aggregate', target, applied: false, reason: `Not counted: ${excluded.reason}` };
  const jurisdiction = facts.find((f) => formKeyOf(f) === formKey && f.sourceField === 'jurisdiction' && f.status === 'extracted')?.value;
  if (jurisdiction === 'federal') {
    return resolved.federal
      ? { kind: 'aggregate', target, applied: true, forms: resolved.federal.payments }
      : { kind: 'aggregate', target, applied: false, reason: 'Another federal payment cannot be placed yet; the federal total waits for it.' };
  }
  return stateOutcomes.get(formKey) ?? { kind: 'aggregate', target, applied: false, reason: `The ${String(jurisdiction)} total waits for another ${String(jurisdiction)} payment.` };
}

/**
 * Set each state's return from the evidence: residency and days from the
 * residency records, and the state's estimated payments. Returns the outcome
 * for every residency and state-payment record, by form key.
 */
export function syncStateReturns(returnId: string): Map<string, ApplyOutcome> {
  const tr = getReturn(returnId);
  const facts = loadTaxFacts(returnId);
  const residencies = resolveStateResidency(facts);
  const payments = resolveEstimatedPayments(facts, tr.taxYear);
  const outcomes = new Map<string, ApplyOutcome>();
  const existing = tr.stateReturns ?? [];
  let next: StateReturnConfig[] = existing.map((c) => ({ ...c }));
  const residency = 'stateResidency' as const;
  const typeLabel = (t: string) => t.replace('_', '-');

  for (const r of residencies) {
    const index = next.findIndex((c) => c.stateCode === r.stateCode);
    const current = index >= 0 ? next[index] : undefined;
    let outcome: ApplyOutcome;
    if (!r.ready) {
      const why = [
        ...r.problems.map((p) => p.replace(/\.$/, '')),
        ...r.conflicts.map((c) => `sources disagree on the ${c.field} (${c.values.map((v) => String(v.value)).join(' vs ')})`),
      ];
      outcome = { kind: 'aggregate', target: residency, applied: false, reason: `${r.stateCode} residency is not set: ${why.join('; ')}.` };
      if (current && isEvidenceOwned(current)) next = next.filter((_, i) => i !== index);
    } else if (current && !isEvidenceOwned(current)
      && (current.residencyType !== r.residencyType || (r.residencyType === 'part_year' && current.daysLivedInState !== r.daysLivedInState))) {
      outcome = { kind: 'aggregate', target: residency, applied: false,
        reason: `The return has ${r.stateCode} as ${typeLabel(current.residencyType)}, entered by hand; the evidence says ${typeLabel(r.residencyType!)}. The preparer's entry is kept.` };
    } else {
      if (!current || isEvidenceOwned(current)) {
        const { daysLivedInState: _days, ...rest } = current ?? ({} as Partial<StateReturnConfig>);
        const config = {
          ...rest,
          stateCode: r.stateCode,
          residencyType: r.residencyType!,
          ...(r.daysLivedInState !== undefined ? { daysLivedInState: r.daysLivedInState } : {}),
          [SOURCE_FORM_KEY]: r.formKeys[0]!,
        } as StateReturnConfig;
        next = index >= 0 ? next.map((c, i) => (i === index ? config : c)) : [...next, config];
      }
      outcome = { kind: 'aggregate', target: residency, applied: true, forms: r.formKeys.length };
    }
    for (const key of r.formKeys) outcomes.set(key, outcome);
  }
  // Evidence-owned state returns whose residency records are gone.
  next = next.filter((c) => !isEvidenceOwned(c) || residencies.some((r) => r.stateCode === c.stateCode));

  const paymentRecords = new Map<string, string[]>();
  for (const f of facts) {
    if (f.factType === 'ESTPAY_jurisdiction' && f.status === 'extracted' && f.value !== 'federal') {
      paymentRecords.set(String(f.value), [...(paymentRecords.get(String(f.value)) ?? []), formKeyOf(f)]);
    }
  }
  for (const [stateCode, total] of Object.entries(payments.states)) {
    const index = next.findIndex((c) => c.stateCode === stateCode);
    const outcome: ApplyOutcome = index >= 0
      ? { kind: 'aggregate', target: 'estimatedPayments', applied: true, forms: total.payments }
      : { kind: 'aggregate', target: 'estimatedPayments', applied: false, reason: `The case has no ${stateCode} state return yet; the ${stateCode} payments are counted once ${stateCode} residency is recorded.` };
    if (index >= 0) next = next.map((c, i) => (i === index ? { ...c, estimatedPayments: total.total } : c));
    for (const key of paymentRecords.get(stateCode) ?? []) {
      if (!payments.waiting.some((w) => w.formKey === key) && !payments.excluded.some((e) => e.formKey === key)) outcomes.set(key, outcome);
    }
  }

  if (JSON.stringify(next) !== JSON.stringify(existing)) updateReturn(returnId, { stateReturns: next });
  return outcomes;
}

// ─── Forms that wait for a preparer decision ─────────────────

const CHOICE_TOOL: Record<PreparerChoiceTarget, ChoiceTool> = {
  educationCredit: 'add_education_expense',
  qualifiedTuitionProgram: 'add_1099_q',
  hsaDistribution: 'add_1099_sa',
  homeSale: 'add_1099_s',
};

/** Item-type keys (ARRAY_FIELD_MAP) of the list targets. */
const CHOICE_LIST: Record<'educationCredits' | 'income1099Q' | 'income1099SA', string> = {
  educationCredits: 'education-credits',
  income1099Q: '1099q',
  income1099SA: '1099sa',
};

const CHOICE_TARGET_FIELD: Record<ChoiceTool, keyof TaxReturn> = {
  add_education_expense: 'educationCredits',
  add_1099_q: 'income1099Q',
  add_1099_sa: 'income1099SA',
  add_1099_s: 'homeSale',
};

/** Take a form's entry off the return (its answer changed, or it can no longer be applied). */
function withdrawChoiceItem(returnId: string, tool: ChoiceTool, formKey: string): void {
  const field = CHOICE_TARGET_FIELD[tool];
  const tr = getReturn(returnId);
  const current = tr[field] as unknown;
  if (Array.isArray(current)) {
    const next = current.filter((e) => (e as Record<string, unknown>)[SOURCE_FORM_KEY] !== formKey);
    if (next.length !== current.length) updateReturn(returnId, { [field]: next });
  } else if (current && (current as Record<string, unknown>)[SOURCE_FORM_KEY] === formKey) {
    updateReturn(returnId, { [field]: undefined });
  }
}

/**
 * Apply a decided form: its engine item is built from the form's facts and the
 * preparer's answers. Until the answers are complete it is only recorded; an
 * item applied earlier is withdrawn when the answers no longer produce one.
 */
export function applyChoiceForm(returnId: string, tool: ChoiceTool, formKey: string): ApplyOutcome {
  const facts = choiceForms(loadTaxFacts(returnId), tool).get(formKey) ?? [];
  if (heldForms(returnId).has(formKey)) {
    withdrawChoiceItem(returnId, tool, formKey);
    return { kind: 'held', reason: 'Validation holds this form until a preparer reviews it.' };
  }
  const built = buildChoiceItem(tool, facts);
  if (built.state !== 'ready') {
    withdrawChoiceItem(returnId, tool, formKey);
    return { kind: 'recorded' };
  }
  if (built.target === 'homeSale') {
    const current = getReturn(returnId).homeSale as unknown as Record<string, unknown> | undefined;
    if (current && current[SOURCE_FORM_KEY] !== formKey) {
      return { kind: 'held', reason: current[SOURCE_FORM_KEY] ? 'The return already has a home sale from another 1099-S; the engine takes one.' : 'The return already has a home sale entered by hand.' };
    }
    updateReturn(returnId, { homeSale: { ...built.item, [SOURCE_FORM_KEY]: formKey } });
    return { kind: 'decided', itemId: formKey };
  }
  markDiscovered(returnId, INCOME_DISCOVERY_KEYS[CHOICE_LIST[built.target]] ?? (built.target === 'educationCredits' ? INCOME_DISCOVERY_KEYS['1098t'] : undefined));
  const put = putIncomeItem(returnId, CHOICE_LIST[built.target], formKey, built.item);
  return put.kind === 'income_item' ? { kind: 'decided', itemId: put.itemId } : put;
}

// ─── W-2c corrections ────────────────────────────────────────

/**
 * Rewrite every W-2 on the return from its own facts and the W-2cs that
 * correct it (a correction that no longer resolves drops out). Returns the
 * outcome for each W-2c, by form key.
 */
export function recomputeW2Corrections(returnId: string): Map<string, ApplyOutcome> {
  const facts = loadTaxFacts(returnId);
  const tr = getReturn(returnId);
  const corrections = resolveW2Corrections(facts, tr.taxYear);
  const held = heldForms(returnId);
  const onReturn = new Set((tr.w2Income ?? []).map((w) => ownerKey(w)).filter((k): k is string => Boolean(k)));
  const w2Facts = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (!f.factType.startsWith('W2_')) continue;
    w2Facts.set(formKeyOf(f), [...(w2Facts.get(formKeyOf(f)) ?? []), f]);
  }
  for (const [key, fs] of w2Facts) {
    if (!onReturn.has(key) || held.has(key)) continue;
    putIncomeItem(returnId, 'w2', key, applyW2Corrections(key, toolFieldsFromFacts('add_w2', fs), corrections));
  }

  const outcomes = new Map<string, ApplyOutcome>();
  for (const c of corrections) {
    let outcome: ApplyOutcome;
    if (held.has(c.formKey)) outcome = { kind: 'held', reason: 'Validation holds this W-2c until a preparer reviews it.' };
    else if (!c.ready) outcome = { kind: 'correction', applied: false, reason: c.problems.join(' ') };
    else if (c.identityOnly) outcome = { kind: 'recorded' };
    else if (c.targetKey && held.has(c.targetKey)) outcome = { kind: 'correction', applied: false, reason: 'The W-2 it corrects is held for review; the correction waits for it.' };
    else if (c.targetKey && !onReturn.has(c.targetKey)) outcome = { kind: 'correction', applied: false, reason: 'The W-2 it corrects is not on the return yet.' };
    else outcome = { kind: 'correction', applied: true, w2FormKey: c.targetKey! };
    outcomes.set(c.formKey, outcome);
  }
  return outcomes;
}
