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
 * - needs_preparer_choice / candidate_fact: recorded as facts only; the case
 *   review asks the preparer.
 *
 * A document proves its income or deduction exists, so a "no" answer to the
 * matching discovery question (which makes the engine ignore that section)
 * becomes "yes".
 *
 * Forms read by HATax's deterministic extractors that have no tax tool yet
 * (1099-G, 1099-MISC, 1099-B, …) are applied the same way when their type is a
 * return item; anything else is left for the preparer to enter.
 *
 * Call after the result's facts are saved (preparerTaxFacts.appendTaxFacts):
 * holds and totals are computed from the saved facts.
 */

import type { TaxReturn } from '@hatax/engine';
import {
  amountFromFact,
  formKeyOf,
  TOOL_APPLICATION,
  toolNameForIncomeType,
  validateImportedFacts,
  type DocumentPieceOutcome,
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

type AggregateTarget = 'socialSecurityBenefits' | 'mortgageInterest';

export type ApplyOutcome =
  | { kind: 'income_item'; itemType: string; itemId: string; replaced: boolean }
  | { kind: 'aggregate'; target: AggregateTarget; applied: true; forms: number }
  | { kind: 'aggregate'; target: AggregateTarget; applied: false; reason: string }
  | { kind: 'held'; reason: string }
  | { kind: 'recorded' };

/** What the applier needs from a tool result: where it goes and its validated fields. */
export type ApplicableResult = Pick<TaxToolSuccess, 'application' | 'fields'>;

const AGGREGATE_DISCOVERY: Record<AggregateTarget, string> = {
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
      return putIncomeItem(returnId, app.itemType, formKey, result.fields);
    }
    case 'aggregate':
      markDiscovered(returnId, AGGREGATE_DISCOVERY[app.target]);
      return recomputeAggregate(returnId, app.target);
    case 'needs_preparer_choice':
    case 'candidate_fact':
      return { kind: 'recorded' };
  }
}

/** Where one extracted form goes: its tool's application, or a return item when HATax reads the type deterministically. */
function applicationFor(incomeType: string | null): TaxToolApplication | null {
  const tool = toolNameForIncomeType(incomeType);
  if (tool) return TOOL_APPLICATION[tool];
  if (incomeType && ARRAY_FIELD_MAP[incomeType]) return { kind: 'income_item', itemType: incomeType } as TaxToolApplication;
  return null;
}

function outcomeOf(outcome: ApplyOutcome): DocumentPieceOutcome {
  switch (outcome.kind) {
    case 'income_item': return 'income_item';
    case 'aggregate': return outcome.applied ? 'aggregate' : 'aggregate_waiting';
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
    if (application.kind === 'income_item' && Object.keys(piece.toolFields).length === 0) return 'not_applied';
    return outcomeOf(applyToolResult(returnId, { application, fields: piece.toolFields },
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
  const item = { ...fields, [SOURCE_FORM_KEY]: formKey, id };
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

function recomputeAggregate(returnId: string, target: AggregateTarget): ApplyOutcome {
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
