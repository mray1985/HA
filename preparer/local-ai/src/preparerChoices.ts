/**
 * Preparer decisions a form cannot make (work order §38, §40).
 *
 * A 1098-T, 1099-Q, 1099-SA or 1099-S is recorded but not applied: the engine
 * needs a fact the form does not print (the education credit, the qualified
 * expenses a distribution paid, whether an HSA distribution paid medical
 * expenses, the basis and ownership of a sold home). The preparer's answer is
 * schema-validated and kept as facts of the same form (source kind
 * "preparer_correction"), and the engine item is built from the form's facts
 * and the answer together — never from a default.
 *
 * Also: correcting a held form's field (a value the page could not read), which
 * is the same kind of recorded preparer fact.
 */

import { z } from 'zod';
import { factsFromFields, type TaxFact, type TaxFactValue } from './taxFact.js';
import { formKeyOf } from './factValidation.js';
import {
  factPrefixOf,
  fieldSchemaFor,
  FORM_TOOL_NAMES,
  TOOL_APPLICATION,
  type DocumentToolName,
  type TaxToolCallContext,
} from './taxTools.js';

export type ChoiceTool = 'add_education_expense' | 'add_1099_q' | 'add_1099_sa' | 'add_1099_s';

export const CHOICE_TOOLS: readonly ChoiceTool[] = ['add_education_expense', 'add_1099_q', 'add_1099_sa', 'add_1099_s'];

export function isChoiceTool(tool: string): tool is ChoiceTool {
  return (CHOICE_TOOLS as readonly string[]).includes(tool);
}

const money = z.number().finite().nonnegative();
const months = z.number().int().min(0).max(60);

/** The answers each form needs, validated before anything is recorded. */
export const CHOICE_SCHEMAS: Record<ChoiceTool, z.ZodTypeAny> = {
  add_education_expense: z
    .object({
      creditType: z.enum(['american_opportunity', 'lifetime_learning']),
      /** Form 8863 line 24, when box 8 did not settle it. */
      enrolledHalfTime: z.boolean().optional(),
      /** Form 8863 lines 23, 25 and 26 — required for the American Opportunity credit. */
      aotcClaimedPrior4Years: z.boolean().optional(),
      completedFirst4Years: z.boolean().optional(),
      felonyDrugConviction: z.boolean().optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.creditType !== 'american_opportunity') return;
      for (const f of ['aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction'] as const) {
        if (c[f] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'required for the American Opportunity credit (Form 8863 lines 23–26)' });
      }
    }),
  add_1099_q: z
    .object({
      qualifiedExpenses: money,
      taxFreeAssistance: money.optional(),
      expensesClaimedForCredit: money.optional(),
      /** Box 6, when the page did not settle it. */
      recipientNotDesignatedBeneficiary: z.boolean().optional(),
    })
    .strict(),
  add_1099_sa: z
    .object({
      /** The engine takes the whole distribution as used or not used; a partial use is entered by hand. */
      usedForQualifiedMedicalExpenses: z.boolean(),
    })
    .strict(),
  add_1099_s: z
    .object({
      /** The sale was of the taxpayer's main home (IRC §121). Other property is reported by hand. */
      mainHome: z.boolean(),
      costBasis: money.optional(),
      sellingExpenses: money.optional(),
      ownedMonths: months.optional(),
      usedAsResidenceMonths: months.optional(),
      priorExclusionUsedWithin2Years: z.boolean().optional(),
      reducedMaximumReason: z.enum(['change_of_employment', 'health', 'unforeseen_circumstances']).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (!c.mainHome) return;
      for (const f of ['costBasis', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years'] as const) {
        if (c[f] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'required for a main-home sale' });
      }
    }),
};

/** The answer fields of each choice form (a new answer replaces all of them). */
export const CHOICE_FIELDS: Record<ChoiceTool, readonly string[]> = {
  add_education_expense: ['creditType', 'enrolledHalfTime', 'aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction'],
  add_1099_q: ['qualifiedExpenses', 'taxFreeAssistance', 'expensesClaimedForCredit', 'recipientNotDesignatedBeneficiary'],
  add_1099_sa: ['usedForQualifiedMedicalExpenses'],
  add_1099_s: ['mainHome', 'costBasis', 'sellingExpenses', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years', 'reducedMaximumReason'],
};

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(answer)'}: ${i.message}`).join('; ');
}

export type RecordedFacts = { ok: true; facts: TaxFact[] } | { ok: false; error: string };

/** Validate a preparer's answer for one form and turn it into facts of that form. */
export function recordPreparerChoice(tool: ChoiceTool, answer: Record<string, unknown>, context: TaxToolCallContext): RecordedFacts {
  const parsed = CHOICE_SCHEMAS[tool].safeParse(answer);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const fields = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([, v]) => v !== undefined));
  return { ok: true, facts: preparerFacts(tool, fields, context) };
}

/**
 * Validate a preparer's value for one field of a form (a box the page could
 * not read, or a value validation holds) against the form tool's own schema.
 */
export function recordFieldCorrection(tool: DocumentToolName, field: string, value: unknown, context: TaxToolCallContext): RecordedFacts {
  const shape = fieldSchemaFor(tool).shape as Record<string, z.ZodTypeAny>;
  const schema = shape[field];
  if (!schema) return { ok: false, error: `${field} is not a field of this form` };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `${field}: ${formatIssues(parsed.error)}` };
  if (parsed.data === undefined) return { ok: false, error: `${field}: a value is required` };
  return { ok: true, facts: preparerFacts(tool, { [field]: parsed.data }, context) };
}

/**
 * A client's confirmed answer to one fact a form needs (§25: the qualified
 * expenses a 1099-Q paid), validated against that answer field's own schema
 * and kept as a verified client-response fact of the form. The rest of the
 * form's decision stays with the preparer; a later preparer decision replaces
 * it.
 */
export function recordClientChoiceAnswer(tool: ChoiceTool, field: string, value: unknown, context: TaxToolCallContext): RecordedFacts {
  const schema = CHOICE_SCHEMAS[tool];
  const object = (schema instanceof z.ZodEffects ? schema.innerType() : schema) as z.ZodObject<z.ZodRawShape>;
  const fieldSchema = object.shape[field] as z.ZodTypeAny | undefined;
  if (!fieldSchema || !CHOICE_FIELDS[tool].includes(field)) return { ok: false, error: `${field} is not a question of this form` };
  const parsed = fieldSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `${field}: ${formatIssues(parsed.error)}` };
  if (parsed.data === undefined) return { ok: false, error: `${field}: a value is required` };
  return { ok: true, facts: formFacts(tool, { [field]: parsed.data }, { ...context, sourceKind: 'client_response', verified: true }) };
}

function preparerFacts(tool: DocumentToolName, fields: Record<string, unknown>, context: TaxToolCallContext): TaxFact[] {
  return formFacts(tool, fields, { ...context, sourceKind: 'preparer_correction', verified: true });
}

function formFacts(tool: DocumentToolName, fields: Record<string, unknown>, context: TaxToolCallContext): TaxFact[] {
  const prefix = factPrefixOf(tool);
  return factsFromFields({
    returnId: context.returnId,
    taxYear: context.taxYear,
    documentId: context.sourceDocumentId,
    fileName: context.sourceFileName,
    extractor: context.extractor,
    formIndex: context.sourceFormIndex,
    sourceKind: context.sourceKind,
    ...(context.modelRunId ? { modelRunId: context.modelRunId } : {}),
    verified: context.verified,
    fields,
    factTypeFor: (field) => `${prefix}${field}`,
    rawText: context.rawText,
  });
}

/** The form tool whose facts these are (by fact-type prefix), when one is. */
export function formToolOfFacts(facts: readonly TaxFact[]): DocumentToolName | null {
  const factType = facts[0]?.factType ?? '';
  // Longest prefix first: "1099SA_" before "1099S_", "1098T_" before "1098_".
  const tools = [...FORM_TOOL_NAMES].sort((a, b) => factPrefixOf(b).length - factPrefixOf(a).length);
  return tools.find((t) => factType.startsWith(factPrefixOf(t))) ?? null;
}

/** One form's facts by field: the extracted value from the highest source, preparer corrections first. */
export function formFieldValues(facts: readonly TaxFact[]): Map<string, TaxFactValue> {
  const tool = formToolOfFacts(facts);
  const prefix = tool ? factPrefixOf(tool) : '';
  const out = new Map<string, TaxFactValue>();
  const ordered = [...facts].sort((a, b) => Number(a.sourceKind === 'preparer_correction') - Number(b.sourceKind === 'preparer_correction'));
  for (const f of ordered) {
    if (f.status !== 'extracted') continue;
    out.set(f.factType.slice(prefix.length), f.value);
  }
  return out;
}

/** A form's current tool fields, from its facts (preparer corrections included). */
export function toolFieldsFromFacts(tool: DocumentToolName, facts: readonly TaxFact[]): Record<string, unknown> {
  const shape = fieldSchemaFor(tool).shape as Record<string, unknown>;
  const values = formFieldValues(facts);
  return Object.fromEntries([...values].filter(([field]) => Object.prototype.hasOwnProperty.call(shape, field)));
}

export type ChoiceItem =
  | { state: 'ready'; target: 'educationCredits' | 'income1099Q' | 'income1099SA'; item: Record<string, unknown> }
  | { state: 'ready'; target: 'homeSale'; item: Record<string, unknown> }
  | { state: 'needs_answer'; missing: string[] }
  | { state: 'manual'; reason: string };

const str = (v: TaxFactValue | undefined) => (typeof v === 'string' ? v : undefined);
const num = (v: TaxFactValue | undefined) => (typeof v === 'number' ? v : undefined);
const bool = (v: TaxFactValue | undefined) => (typeof v === 'boolean' ? v : undefined);
const firstLine = (text: string | undefined) => text?.split(/\r?\n/)[0]!.trim();

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * The engine item for a choice form, from its facts and the preparer's
 * answers — or what is still needed, or why it must be entered by hand.
 */
export function buildChoiceItem(tool: ChoiceTool, facts: readonly TaxFact[]): ChoiceItem {
  const v = formFieldValues(facts);
  const needs = (fields: string[]): ChoiceItem | null => {
    const missing = fields.filter((f) => !v.has(f));
    return missing.length > 0 ? { state: 'needs_answer', missing } : null;
  };

  switch (tool) {
    case 'add_education_expense': {
      const wait = needs(['creditType', 'tuitionPaid']);
      if (wait) return wait;
      const aotc = v.get('creditType') === 'american_opportunity';
      const halfTime = bool(v.get('enrolledHalfTime')) ?? bool(v.get('halfTimeStudent'));
      if (aotc) {
        const more = needs(['aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction']);
        if (more) return more;
        if (halfTime === undefined) return { state: 'needs_answer', missing: ['enrolledHalfTime'] };
      }
      return {
        state: 'ready',
        target: 'educationCredits',
        item: stripUndefined({
          type: v.get('creditType'),
          studentName: str(v.get('studentName')) ?? '',
          institution: firstLine(str(v.get('institutionName'))) ?? '',
          institutionEIN: str(v.get('institutionEin'))?.replace(/\D/g, ''),
          received1098T: true,
          tuitionPaid: num(v.get('tuitionPaid')),
          scholarships: num(v.get('scholarships')),
          enrolledHalfTime: halfTime,
          aotcClaimedPrior4Years: bool(v.get('aotcClaimedPrior4Years')),
          completedFirst4Years: bool(v.get('completedFirst4Years')),
          felonyDrugConviction: bool(v.get('felonyDrugConviction')),
        }),
      };
    }
    case 'add_1099_q': {
      const wait = needs(['grossDistribution', 'earnings', 'basisReturn', 'qualifiedExpenses', 'recipientNotDesignatedBeneficiary']);
      if (wait) return wait;
      const gross = num(v.get('grossDistribution'))!;
      const qualified = num(v.get('qualifiedExpenses'))!;
      const assistance = num(v.get('taxFreeAssistance'));
      const claimed = num(v.get('expensesClaimedForCredit'));
      const transfer = bool(v.get('trusteeToTrusteeTransfer')) === true || bool(v.get('qtpToRothIra')) === true;
      const adjusted = qualified - (assistance ?? 0) - (claimed ?? 0);
      return {
        state: 'ready',
        target: 'income1099Q',
        item: stripUndefined({
          payerName: firstLine(str(v.get('payerName'))) ?? '',
          grossDistribution: gross,
          earnings: num(v.get('earnings')),
          basisReturn: num(v.get('basisReturn')),
          qualifiedExpenses: qualified,
          taxFreeAssistance: assistance,
          expensesClaimedForCredit: claimed,
          distributionType: transfer ? 'rollover' : adjusted >= gross ? 'qualified' : 'non_qualified',
          // Box 6 checked: paid to the account owner, not the student (IRC §529(c)(3)(A)).
          recipientType: v.get('recipientNotDesignatedBeneficiary') === true ? 'accountOwner' : 'beneficiary',
        }),
      };
    }
    case 'add_1099_sa': {
      const account = str(v.get('accountType'));
      if (account && account !== 'HSA') {
        return { state: 'manual', reason: `${account} distributions are reported on Form 8853, which the engine does not compute from a 1099-SA; enter it by hand.` };
      }
      const wait = needs(['grossDistribution', 'distributionCode', 'usedForQualifiedMedicalExpenses']);
      if (wait) return wait;
      return {
        state: 'ready',
        target: 'income1099SA',
        item: stripUndefined({
          payerName: firstLine(str(v.get('payerName'))) ?? '',
          grossDistribution: num(v.get('grossDistribution')),
          distributionCode: str(v.get('distributionCode'))?.trim(),
          qualifiedMedicalExpenses: bool(v.get('usedForQualifiedMedicalExpenses')),
        }),
      };
    }
    case 'add_1099_s': {
      const wait = needs(['grossProceeds', 'mainHome']);
      if (wait) return wait;
      if (v.get('mainHome') !== true) {
        return { state: 'manual', reason: 'Not the main home: report the sale on Form 8949 / 4797 by hand (the home-sale exclusion does not apply).' };
      }
      const more = needs(['costBasis', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years']);
      if (more) return more;
      return {
        state: 'ready',
        target: 'homeSale',
        item: stripUndefined({
          salePrice: num(v.get('grossProceeds')),
          costBasis: num(v.get('costBasis')),
          sellingExpenses: num(v.get('sellingExpenses')),
          ownedMonths: num(v.get('ownedMonths')),
          usedAsResidenceMonths: num(v.get('usedAsResidenceMonths')),
          priorExclusionUsedWithin2Years: bool(v.get('priorExclusionUsedWithin2Years')),
          reducedMaximumReason: str(v.get('reducedMaximumReason')),
        }),
      };
    }
  }
}

/** Facts grouped by form key, for the forms of one choice tool. */
export function choiceForms(facts: readonly TaxFact[], tool: ChoiceTool): Map<string, TaxFact[]> {
  const prefix = factPrefixOf(tool);
  const out = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (!f.factType.startsWith(prefix)) continue;
    // "1099S_" must not take "1099SA_" facts.
    if (formToolOfFacts([f]) !== tool) continue;
    const key = formKeyOf(f);
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

/** True when the tool's forms wait for a preparer decision. */
export function needsChoice(tool: DocumentToolName): tool is ChoiceTool {
  return TOOL_APPLICATION[tool].kind === 'needs_preparer_choice';
}

export type FieldInput =
  | { kind: 'number'; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'text' }
  | { kind: 'enum'; options: string[] };

/** How a preparer enters one field of a form, read from the form tool's schema. */
export function fieldInput(tool: DocumentToolName, field: string): FieldInput | null {
  let schema = (fieldSchemaFor(tool).shape as Record<string, z.ZodTypeAny>)[field];
  while (schema) {
    const def = schema._def as { typeName: string } & Record<string, unknown>;
    if (def.typeName === 'ZodEffects') schema = def.schema as z.ZodTypeAny;
    else if (def.typeName === 'ZodOptional') schema = def.innerType as z.ZodTypeAny;
    else break;
  }
  if (!schema) return null;
  const def = schema._def as { typeName: string; checks?: Array<{ kind: string; value?: number }>; values?: string[] };
  switch (def.typeName) {
    case 'ZodNumber': {
      const checks = def.checks ?? [];
      return {
        kind: 'number',
        integer: checks.some((c) => c.kind === 'int'),
        ...(checks.find((c) => c.kind === 'min') ? { min: checks.find((c) => c.kind === 'min')!.value } : {}),
        ...(checks.find((c) => c.kind === 'max') ? { max: checks.find((c) => c.kind === 'max')!.value } : {}),
      };
    }
    case 'ZodBoolean': return { kind: 'boolean' };
    case 'ZodEnum': return { kind: 'enum', options: [...(def.values ?? [])] };
    case 'ZodString': return { kind: 'text' };
    default: return null;
  }
}
