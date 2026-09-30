/**
 * Preparer decisions on a case (work order §38, §40): the answer a form could
 * not give (education credit, qualified expenses, HSA use, home sale), a value
 * for a held form's field, and what a waiting dependent still needs.
 *
 * Each is schema-validated, kept as facts of the form with source kind
 * "preparer_correction", applied to the return by the same applier as the
 * documents, and written to the case's audit trail.
 */

import {
  CHOICE_FIELDS,
  factPrefixOf,
  formKeyOf,
  formToolOfFacts,
  needsChoice,
  recordClientChoiceAnswer,
  recordFieldCorrection,
  recordPreparerChoice,
  TOOL_APPLICATION,
  toolFieldsFromFacts,
  type ChoiceTool,
  type TaxFact,
  type TaxToolCallContext,
} from '@hatax/local-ai';
import type { FilingStatus, StateQuestion } from '@hatax/engine';
import { getReturn, updateReturn } from '../api/client';
import { appendAudit } from './caseAudit';
import { loadDocuments, upsertDocument } from './documentIngestion';
import { loadTaxFacts, saveTaxFacts } from './preparerTaxFacts';
import { recordEvidence } from './recordTools';
import { applyChoiceForm, applyToolResult, outcomeOfApply, type ApplyOutcome } from './returnApplier';

export type DecisionResult = { ok: true; outcome: ApplyOutcome } | { ok: false; error: string };

function formFacts(returnId: string, formKey: string): TaxFact[] {
  return loadTaxFacts(returnId).filter((f) => formKeyOf(f) === formKey);
}

function contextFor(returnId: string, formKey: string, facts: TaxFact[]): TaxToolCallContext {
  const [documentId, index] = formKey.split('#');
  return {
    returnId,
    taxYear: getReturn(returnId).taxYear,
    sourceDocumentId: documentId!,
    ...(Number(index) > 0 ? { sourceFormIndex: Number(index) } : {}),
    sourceFileName: facts[0]?.sourceFileName ?? documentId!,
    extractor: 'preparer',
  };
}

/** Save facts for a form, replacing that form's earlier facts of the same fields. */
function replaceFormFacts(returnId: string, formKey: string, next: TaxFact[]): void {
  const types = new Set(next.map((f) => f.factType));
  saveTaxFacts(returnId, [
    ...loadTaxFacts(returnId).filter((f) => !(formKeyOf(f) === formKey && types.has(f.factType))),
    ...next,
  ]);
}

/** Record on the document how this form now reaches the return. */
function noteDocumentOutcome(returnId: string, formKey: string, outcome: ApplyOutcome): void {
  const [documentId, index] = formKey.split('#');
  const doc = loadDocuments(returnId).find((d) => d.documentId === documentId);
  if (!doc?.appliedAs) return;
  const appliedAs = [...doc.appliedAs];
  appliedAs[Number(index)] = outcomeOfApply(outcome);
  upsertDocument(returnId, { ...doc, appliedAs });
}

/** Re-apply one form from its facts (after a decision or a correction). */
function reapplyForm(returnId: string, formKey: string): ApplyOutcome | null {
  const facts = formFacts(returnId, formKey);
  const tool = formToolOfFacts(facts);
  if (!tool) return null;
  const [documentId, index] = formKey.split('#');
  const source = { documentId: documentId!, formIndex: Number(index) > 0 ? Number(index) : undefined };
  const outcome = needsChoice(tool)
    ? applyChoiceForm(returnId, tool, formKey)
    : applyToolResult(returnId, { application: TOOL_APPLICATION[tool], fields: toolFieldsFromFacts(tool, facts) }, source);
  noteDocumentOutcome(returnId, formKey, outcome);
  return outcome;
}

const describeAnswer = (answer: Record<string, unknown>) =>
  Object.entries(answer).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${String(v)}`).join(', ');

/** The preparer's answer for a form that needs a decision. */
export function recordChoice(returnId: string, formKey: string, tool: ChoiceTool, answer: Record<string, unknown>): DecisionResult {
  const facts = formFacts(returnId, formKey);
  if (facts.length === 0) return { ok: false, error: 'The form is not on this case.' };
  const recorded = recordPreparerChoice(tool, answer, contextFor(returnId, formKey, facts));
  if (!recorded.ok) return recorded;
  // A new answer replaces every earlier answer field, so a cleared field does not linger.
  const answerTypes = new Set(CHOICE_FIELDS[tool].map((f) => `${factPrefixOf(tool)}${f}`));
  saveTaxFacts(returnId, loadTaxFacts(returnId).filter((f) => !(formKeyOf(f) === formKey && f.sourceKind === 'preparer_correction' && answerTypes.has(f.factType))));
  replaceFormFacts(returnId, formKey, recorded.facts);
  const outcome = reapplyForm(returnId, formKey)!;
  appendAudit(returnId, { kind: 'decision', subject: `${facts[0]!.sourceFileName} (${formKey})`, detail: describeAnswer(answer) });
  return { ok: true, outcome };
}

/** Where a client's confirmed answer came from (work order §25). */
export interface ClientAnswerSource {
  /** "Client reply of Sep 30, 2026" */
  label: string;
  /** The client's words that give the answer. */
  quote: string;
  modelRunId?: string;
  /** What read the reply ("Qwen3.5-0.8B + the client's words"). */
  extractor: string;
}

/**
 * A client's confirmed answer to a fact a form needs (the qualified expenses a
 * 1099-Q paid): a verified client-response fact of the form, which is then
 * applied like a preparer decision once the form has everything it needs.
 */
export function recordClientFormAnswer(returnId: string, formKey: string, tool: ChoiceTool, field: string, value: unknown, source: ClientAnswerSource): DecisionResult {
  const facts = formFacts(returnId, formKey);
  if (facts.length === 0) return { ok: false, error: 'The form is not on this case.' };
  const recorded = recordClientChoiceAnswer(tool, field, value, {
    ...contextFor(returnId, formKey, facts),
    extractor: `${source.extractor} (${source.label})`,
    rawText: { [field]: source.quote },
    ...(source.modelRunId ? { modelRunId: source.modelRunId } : {}),
  });
  if (!recorded.ok) return recorded;
  replaceFormFacts(returnId, formKey, recorded.facts);
  return { ok: true, outcome: reapplyForm(returnId, formKey)! };
}

/** What sets an asset's special depreciation rate (§168(k)), entered by the preparer. */
export interface AcquisitionFacts {
  acquisitionDate: string;
  longProductionPeriod?: boolean;
  electOutOfBonus?: boolean;
}

/** The date a depreciation asset (or the vehicle) was acquired, and its special depreciation facts. */
export function recordAcquisition(returnId: string, assetId: string | 'vehicle', facts: AcquisitionFacts): DecisionResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.acquisitionDate)) return { ok: false, error: 'Enter the date acquired.' };
  const tr = getReturn(returnId);
  if (assetId === 'vehicle') {
    if (!tr.vehicle) return { ok: false, error: 'The return has no vehicle.' };
    updateReturn(returnId, { vehicle: { ...tr.vehicle, acquisitionDate: facts.acquisitionDate } });
  } else {
    const assets = tr.depreciationAssets ?? [];
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return { ok: false, error: 'The asset is not on the return.' };
    if (facts.acquisitionDate > asset.dateInService) return { ok: false, error: 'The date acquired cannot be after the date placed in service.' };
    updateReturn(returnId, {
      depreciationAssets: assets.map((a) => (a.id === assetId ? {
        ...a,
        acquisitionDate: facts.acquisitionDate,
        longProductionPeriod: facts.longProductionPeriod || undefined,
        electOutOfBonus: facts.electOutOfBonus || undefined,
      } : a)),
    });
  }
  appendAudit(returnId, { kind: 'correction', field: assetId === 'vehicle' ? 'vehicle.acquisitionDate' : `depreciationAssets[${assetId}].acquisitionDate`, from: 'not set', to: facts.acquisitionDate });
  return { ok: true, outcome: { kind: 'recorded' } };
}

/** The preparer's answer to a state rule's question, kept on that state's return. */
export function recordStateAnswer(returnId: string, question: StateQuestion, value: unknown): DecisionResult {
  if (question.kind === 'yes_no' && typeof value !== 'boolean') return { ok: false, error: 'Answer yes or no.' };
  if (question.kind === 'amount') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'Enter the amount.' };
    if (value < 0 && !question.allowNegative) return { ok: false, error: 'The amount cannot be negative.' };
  }
  const configs = getReturn(returnId).stateReturns ?? [];
  const config = configs.find((c) => c.stateCode.toUpperCase() === question.stateCode);
  if (!config) return { ok: false, error: `The return has no ${question.stateCode} state return.` };
  const before = config.stateSpecificData?.[question.key];
  updateReturn(returnId, {
    stateReturns: configs.map((c) => (c === config ? { ...c, stateSpecificData: { ...(c.stateSpecificData ?? {}), [question.key]: value } } : c)),
  });
  appendAudit(returnId, { kind: 'correction', field: `${question.stateCode}: ${question.prompt}`, from: before ?? 'not answered', to: value });
  return { ok: true, outcome: { kind: 'recorded' } };
}

/** The preparer puts the filing status a client's reply states on the return. */
export function applyStatedFilingStatus(returnId: string, status: FilingStatus, label: string): DecisionResult {
  const before = getReturn(returnId).filingStatus;
  updateReturn(returnId, { filingStatus: status });
  appendAudit(returnId, { kind: 'correction', field: 'filingStatus', from: before ?? 'not set', to: `${label} (as the client's reply states)` });
  return { ok: true, outcome: { kind: 'recorded' } };
}

/** The preparer's value for a field of a held form (a box the page could not read, or a misread value). */
export function correctFormField(returnId: string, formKey: string, field: string, value: unknown): DecisionResult {
  const facts = formFacts(returnId, formKey);
  const tool = formToolOfFacts(facts);
  if (!tool) return { ok: false, error: 'The form is not on this case.' };
  const before = facts.find((f) => f.sourceField === field);
  const recorded = recordFieldCorrection(tool, field, value, contextFor(returnId, formKey, facts));
  if (!recorded.ok) return recorded;
  // The unread or misread fact is replaced; the audit trail keeps what the page said.
  saveTaxFacts(returnId, loadTaxFacts(returnId).filter((f) => !(formKeyOf(f) === formKey && f.sourceField === field)));
  replaceFormFacts(returnId, formKey, recorded.facts);
  const outcome = reapplyForm(returnId, formKey)!;
  appendAudit(returnId, {
    kind: 'correction',
    field: `${facts[0]!.sourceFileName} ${field}`,
    from: before?.status === 'extracted' ? before.value : before?.rawText ? `unreadable "${before.rawText}"` : 'not read',
    to: value,
  });
  return { ok: true, outcome };
}

/** What a waiting dependent still needs, entered by the preparer. */
export function completeDependent(
  returnId: string,
  person: { firstName: string; lastName: string },
  answer: { relationship?: string; monthsLivedWithYou?: number },
): DecisionResult {
  const key = `${person.firstName} ${person.lastName}`.trim().toLowerCase().replace(/\s+/g, '-');
  const { result, outcome } = recordEvidence(
    returnId,
    'add_dependent',
    { firstName: person.firstName, lastName: person.lastName, ...answer },
    { documentId: `preparer-dependent:${key}`, label: 'Preparer entry', kind: 'preparer_correction', extractor: 'preparer' },
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, outcome: outcome! };
}
