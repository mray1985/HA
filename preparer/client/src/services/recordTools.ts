/**
 * Running tax-engine tools for a case (work order §5, §47).
 *
 * - `recordEvidence` runs a record tool (add_dependent, add_schedule_c_income,
 *   add_estimated_payment, set_state_residency) on evidence that is not a tax
 *   form — a prior-year return, a client's answer, a payment confirmation,
 *   business income records. The call is schema-validated; its facts replace
 *   any earlier facts from the same record (recording it again never counts it
 *   twice); the result is applied to the return; and the call is audited.
 * - `runReturnChecks` runs calculate_return and run_diagnostics after the
 *   return changes, and audits what they report. They never change the return.
 */

import {
  canonicalRelationship,
  formKeyOf,
  invokeReturnTool,
  invokeTaxTool,
  type RecordToolName,
  type TaxFactSourceKind,
  type TaxToolResult,
} from '@hatax/local-ai';
import { FilingStatus } from '@hatax/engine';
import { getReturn } from '../api/client';
import { appendAudit } from './caseAudit';
import { loadTaxFacts, saveTaxFacts } from './preparerTaxFacts';
import { applyToolResult, type ApplyOutcome } from './returnApplier';

export interface RecordSource {
  /** The evidence's id: an uploaded document's id, or one made for an answer or import. */
  documentId: string;
  /** How the evidence is named to the preparer ("2024 return (prior-year import)"). */
  label: string;
  /** Position of this entry within its source (the second dependent on a prior-year return). */
  index?: number;
  kind: TaxFactSourceKind;
  /** What read the evidence ("prior-year-import", "preparer", a model name). */
  extractor: string;
  /** The source text by field, when there is one. */
  rawText?: Record<string, string>;
}

export interface RecordEvidenceResult {
  result: TaxToolResult;
  /** How the record reached the return; absent when validation rejected the call. */
  outcome?: ApplyOutcome;
}

export function describeOutcome(outcome: ApplyOutcome): string {
  switch (outcome.kind) {
    case 'income_item': return outcome.replaced ? 'replaced its return entry' : 'entered on the return';
    case 'aggregate': return outcome.applied ? `included in the return (${outcome.forms} record${outcome.forms === 1 ? '' : 's'})` : outcome.reason;
    case 'dependent': return outcome.applied ? 'added as a dependent' : outcome.reason;
    case 'decided': return 'decided and entered on the return';
    case 'held': return outcome.reason;
    case 'recorded': return 'recorded';
  }
}

export function recordEvidence(
  returnId: string,
  tool: RecordToolName,
  args: Record<string, unknown>,
  source: RecordSource,
): RecordEvidenceResult {
  const result = invokeTaxTool({
    tool,
    args,
    context: {
      returnId,
      taxYear: getReturn(returnId).taxYear,
      sourceDocumentId: source.documentId,
      ...(source.index !== undefined ? { sourceFormIndex: source.index } : {}),
      sourceFileName: source.label,
      sourceKind: source.kind,
      extractor: source.extractor,
      ...(source.rawText ? { rawText: source.rawText } : {}),
    },
  });
  if (!result.ok) {
    appendAudit(returnId, { kind: 'tool', tool, accepted: false, source: source.label, detail: result.error });
    return { result };
  }

  const key = formKeyOf({ sourceDocumentId: source.documentId, sourceFormIndex: source.index });
  saveTaxFacts(returnId, [...loadTaxFacts(returnId).filter((f) => formKeyOf(f) !== key), ...result.facts]);
  const outcome = applyToolResult(returnId, result, { documentId: source.documentId, formIndex: source.index });
  appendAudit(returnId, { kind: 'tool', tool, accepted: true, source: source.label, detail: describeOutcome(outcome) });
  return { result, outcome };
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Calculate the return and run its diagnostics through the return tools, and audit the result. */
export function runReturnChecks(returnId: string): { summary?: string; diagnostics?: string } {
  const taxReturn = getReturn(returnId);
  // Calculated as the case page shows it (single until a status is chosen);
  // diagnostics see the return as entered, so a missing status is reported.
  const calculated = invokeReturnTool({
    tool: 'calculate_return',
    args: {},
    taxReturn: { ...taxReturn, filingStatus: taxReturn.filingStatus || FilingStatus.Single },
  });
  const out: { summary?: string; diagnostics?: string } = {};
  if (calculated.ok && calculated.tool === 'calculate_return') {
    const s = calculated.summary;
    out.summary = `AGI ${money(s.agi)}, tax ${money(s.totalTax)}, ${s.amountOwed > 0 ? `owed ${money(s.amountOwed)}` : `refund ${money(s.refundAmount)}`}`;
    appendAudit(returnId, { kind: 'tool', tool: 'calculate_return', accepted: true, detail: out.summary });
  } else if (!calculated.ok) {
    appendAudit(returnId, { kind: 'tool', tool: 'calculate_return', accepted: false, detail: calculated.error });
  }

  const checked = invokeReturnTool({
    tool: 'run_diagnostics',
    args: {},
    taxReturn,
    facts: loadTaxFacts(returnId),
    calculation: calculated.ok && calculated.tool === 'calculate_return' ? calculated.calculation : null,
  });
  if (checked.ok && checked.tool === 'run_diagnostics') {
    const c = checked.counts;
    out.diagnostics = `${c.ERROR} error, ${c.BLOCKING} blocking, ${c.WARNING} warning, ${c.REVIEW} review; ${checked.heldForms.length} form(s) held`;
    appendAudit(returnId, { kind: 'tool', tool: 'run_diagnostics', accepted: true, detail: out.diagnostics });
  }
  return out;
}

/** A dependent as a prior-year return lists it. */
export interface PriorYearDependent {
  firstName: string;
  lastName: string;
  ssnLastFour?: string;
  relationship?: string;
}

/**
 * Record the dependents a prior-year return lists (work order §14: names carry
 * forward, eligibility is revalidated). The return does not say how many
 * months each lived at home this year, so nobody is added to the return until
 * that is known; the case review asks for it. Importing the same year again
 * replaces that import's records.
 */
export function recordPriorYearDependents(returnId: string, dependents: PriorYearDependent[], priorTaxYear?: number): RecordEvidenceResult[] {
  const documentId = `prior-year-return:${priorTaxYear ?? 'unknown-year'}`;
  const label = `${priorTaxYear ?? 'Prior-year'} return (import)`;
  saveTaxFacts(returnId, loadTaxFacts(returnId).filter((f) => f.sourceDocumentId !== documentId));
  return dependents.map((d, index) =>
    recordEvidence(
      returnId,
      'add_dependent',
      {
        firstName: d.firstName || undefined,
        lastName: d.lastName || undefined,
        ssnLastFour: d.ssnLastFour,
        // A printed relationship the return has no term for ("Child") stays unknown, with its text kept.
        relationship: canonicalRelationship(d.relationship),
      },
      {
        documentId,
        label,
        index,
        kind: 'document',
        extractor: 'prior-year-import',
        rawText: { firstName: d.firstName, lastName: d.lastName, ...(d.relationship ? { relationship: d.relationship } : {}) },
      },
    ),
  );
}
