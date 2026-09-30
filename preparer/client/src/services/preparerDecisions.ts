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
  recordFieldCorrection,
  recordPreparerChoice,
  TOOL_APPLICATION,
  toolFieldsFromFacts,
  type ChoiceTool,
  type TaxFact,
  type TaxToolCallContext,
} from '@hatax/local-ai';
import { getReturn } from '../api/client';
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
