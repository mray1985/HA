/**
 * Schema-validated tax-engine tools for automation.
 * Models call these instead of writing Form 1040 line fields.
 * Successful calls return TaxFacts plus fields safe for addIncomeItem.
 * They do not calculate tax.
 */

import { z } from 'zod';
import {
  factsFromFields,
  fieldsForToolCall,
  type FieldConfidenceSource,
  type FieldRawTextSource,
  type FieldSourceLocationSource,
  type TaxFact,
} from './taxFact.js';

// ─── Tool names (work order HA-AI-011) ───────────────────────

export const TAX_TOOL_NAMES = [
  'add_w2',
  'add_1099_int',
  'add_1099_div',
  'add_1099_nec',
  'add_1099_r',
  'set_filing_status_candidate',
] as const;

export type TaxToolName = (typeof TAX_TOOL_NAMES)[number];

/** Income tools only (excludes filing-status candidate). */
export type TaxToolIncomeName = Exclude<TaxToolName, 'set_filing_status_candidate'>;

/** Income-item API keys used by addIncomeItem / intentExecutor. */
export type TaxToolIncomeType = 'w2' | '1099int' | '1099div' | '1099nec' | '1099r';

export const TAX_TOOL_INCOME_TYPE: Record<TaxToolIncomeName, TaxToolIncomeType> = {
  add_w2: 'w2',
  add_1099_int: '1099int',
  add_1099_div: '1099div',
  add_1099_nec: '1099nec',
  add_1099_r: '1099r',
};

const INCOME_TYPE_TO_TOOL: Record<string, TaxToolIncomeName> = {
  w2: 'add_w2',
  '1099int': 'add_1099_int',
  '1099div': 'add_1099_div',
  '1099nec': 'add_1099_nec',
  '1099r': 'add_1099_r',
};

export function toolNameForIncomeType(incomeType: string | null | undefined): TaxToolIncomeName | null {
  if (!incomeType) return null;
  return INCOME_TYPE_TO_TOOL[incomeType] ?? null;
}

// ─── Field schemas ───────────────────────────────────────────
// Optional amounts: missing stays omitted. Explicit 0 is kept.
// .strict() rejects unknown keys so the model cannot invent form lines.
// null / empty string from extractors are treated as missing, not zero.

function asMissing(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

const optionalAmount = z.preprocess(asMissing, z.number().finite().optional());
const optionalString = z.preprocess(asMissing, z.string().optional());
const optionalBoolean = z.preprocess(asMissing, z.boolean().optional());

/** W-2 Box 12a–d coded benefit entries (matches W2Box12Entry). */
const W2Box12EntrySchema = z
  .object({
    code: z.string().min(1),
    amount: z.number().finite(),
  })
  .strict();

/** W-2 Box 13 checkboxes (matches W2Box13). */
const W2Box13Schema = z
  .object({
    statutoryEmployee: optionalBoolean,
    retirementPlan: optionalBoolean,
    thirdPartySickPay: optionalBoolean,
  })
  .strict();

const optionalBox12 = z.preprocess(asMissing, z.array(W2Box12EntrySchema).optional());
const optionalBox13 = z.preprocess(asMissing, W2Box13Schema.optional());

/** 1099-R Simplified Method worksheet fields (matches Income1099R.simplifiedMethod). */
const SimplifiedMethodSchema = z
  .object({
    totalContributions: z.number().finite(),
    ageAtStartDate: z.number().finite(),
    isJointAndSurvivor: z.boolean(),
    combinedAge: optionalAmount,
    paymentsThisYear: z.number().finite(),
    priorYearTaxFreeRecovery: optionalAmount,
  })
  .strict();

const optionalSimplifiedMethod = z.preprocess(asMissing, SimplifiedMethodSchema.optional());

const AddW2FieldsSchema = z
  .object({
    employerName: optionalString,
    employerEin: optionalString,
    wages: optionalAmount,
    federalTaxWithheld: optionalAmount,
    socialSecurityWages: optionalAmount,
    socialSecurityTax: optionalAmount,
    medicareWages: optionalAmount,
    medicareTax: optionalAmount,
    stateTaxWithheld: optionalAmount,
    stateWages: optionalAmount,
    state: optionalString,
    box12: optionalBox12,
    box13: optionalBox13,
    isSpouse: optionalBoolean,
  })
  .strict();

const Add1099IntFieldsSchema = z
  .object({
    payerName: optionalString,
    amount: optionalAmount,
    earlyWithdrawalPenalty: optionalAmount,
    usBondInterest: optionalAmount,
    federalTaxWithheld: optionalAmount,
    taxExemptInterest: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099DivFieldsSchema = z
  .object({
    payerName: optionalString,
    ordinaryDividends: optionalAmount,
    qualifiedDividends: optionalAmount,
    capitalGainDistributions: optionalAmount,
    federalTaxWithheld: optionalAmount,
    foreignTaxPaid: optionalAmount,
    foreignSourceIncome: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099NecFieldsSchema = z
  .object({
    payerName: optionalString,
    payerEin: optionalString,
    amount: optionalAmount,
    federalTaxWithheld: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099RFieldsSchema = z
  .object({
    payerName: optionalString,
    grossDistribution: optionalAmount,
    taxableAmount: optionalAmount,
    federalTaxWithheld: optionalAmount,
    distributionCode: optionalString,
    isIRA: optionalBoolean,
    isRothIRA: optionalBoolean,
    rothContributionBasis: optionalAmount,
    qcdAmount: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
    isSpouse: optionalBoolean,
    earlyDistributionExceptionCode: optionalString,
    earlyDistributionExceptionAmount: optionalAmount,
    useSimplifiedMethod: optionalBoolean,
    simplifiedMethod: optionalSimplifiedMethod,
  })
  .strict();

export const FILING_STATUS_CANDIDATES = [
  'single',
  'married_filing_jointly',
  'married_filing_separately',
  'head_of_household',
  'qualifying_surviving_spouse',
] as const;

export const SetFilingStatusCandidateSchema = z
  .object({
    status: z.enum(FILING_STATUS_CANDIDATES),
  })
  .strict();

export const TOOL_FIELD_SCHEMAS: Record<TaxToolIncomeName, z.ZodObject<z.ZodRawShape>> = {
  add_w2: AddW2FieldsSchema,
  add_1099_int: Add1099IntFieldsSchema,
  add_1099_div: Add1099DivFieldsSchema,
  add_1099_nec: Add1099NecFieldsSchema,
  add_1099_r: Add1099RFieldsSchema,
};

/** Keep only schema-known keys (for OCR bridges). Direct tool calls still reject unknowns. */
export function pickToolFieldArgs(
  tool: TaxToolIncomeName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const shape = TOOL_FIELD_SCHEMAS[tool].shape as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      picked[key] = args[key];
    }
  }
  return picked;
}

const FACT_TYPE_PREFIX: Record<TaxToolName, string> = {
  add_w2: 'W2',
  add_1099_int: '1099INT',
  add_1099_div: '1099DIV',
  add_1099_nec: '1099NEC',
  add_1099_r: '1099R',
  set_filing_status_candidate: 'FILING_STATUS',
};

// ─── Call context / results ──────────────────────────────────

export interface TaxToolCallContext {
  returnId: string;
  taxYear: number;
  sourceDocumentId: string;
  sourceFileName: string;
  extractor: string;
  /** Per-field score. A missing field stays null. */
  confidence?: FieldConfidenceSource;
  /** Original source text by field. A missing field stays empty. */
  rawText?: FieldRawTextSource;
  /**
   * Page + box when the extractor located the token.
   * Absent when no text block was found. Never invent coordinates.
   */
  sourceLocation?: FieldSourceLocationSource;
}

export interface TaxToolSuccess {
  ok: true;
  tool: TaxToolName;
  /** Present for income tools; safe for addIncomeItem / add_income. */
  incomeType?: TaxToolIncomeType;
  /** Plain fields with missing amounts omitted (never zeroed). */
  fields: Record<string, unknown>;
  facts: TaxFact[];
  /**
   * Filing-status candidate only: records a fact. Does not set final filing status.
   * Final status remains a preparer/user choice.
   */
  appliesFilingStatus?: false;
}

export interface TaxToolFailure {
  ok: false;
  tool: TaxToolName;
  error: string;
}

export type TaxToolResult = TaxToolSuccess | TaxToolFailure;

export interface InvokeTaxToolInput {
  tool: TaxToolName;
  /** Raw tool arguments (document fields or { status }). */
  args: Record<string, unknown>;
  context: TaxToolCallContext;
}

function stripUndefined(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate and execute a tax-engine tool call.
 * Returns TaxFacts + fields for the add-income path. Does not calculate tax
 * and does not write Form 1040 lines.
 */
export function invokeTaxTool(input: InvokeTaxToolInput): TaxToolResult {
  const { tool, args, context } = input;

  if (tool === 'set_filing_status_candidate') {
    const parsed = SetFilingStatusCandidateSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, tool, error: formatZodError(parsed.error) };
    }
    const fields = fieldsForToolCall({ status: parsed.data.status });
    const facts = factsFromFields({
      returnId: context.returnId,
      taxYear: context.taxYear,
      documentId: context.sourceDocumentId,
      fileName: context.sourceFileName,
      extractor: context.extractor,
      fields,
      factTypeFor: () => 'FILING_STATUS_CANDIDATE',
      confidence: context.confidence,
      rawText: context.rawText,
      sourceLocation: context.sourceLocation,
    });
    return {
      ok: true,
      tool,
      fields,
      facts,
      appliesFilingStatus: false,
    };
  }

  const schema = TOOL_FIELD_SCHEMAS[tool];
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, tool, error: formatZodError(parsed.error) };
  }

  // Drop undefined keys so missing amounts never become zero defaults.
  const cleaned = stripUndefined(parsed.data as Record<string, unknown>);
  const fields = fieldsForToolCall(cleaned);

  // Facts cover every schema field the caller supplied. Missing/null values
  // become status "unknown" (no value). Tool fields omit those keys entirely.
  const shape = schema.shape as Record<string, unknown>;
  const factFields: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      factFields[key] = cleaned[key];
    }
  }

  const prefix = FACT_TYPE_PREFIX[tool];
  const facts = factsFromFields({
    returnId: context.returnId,
    taxYear: context.taxYear,
    documentId: context.sourceDocumentId,
    fileName: context.sourceFileName,
    extractor: context.extractor,
    fields: factFields,
    factTypeFor: (field) => `${prefix}_${field}`,
    confidence: context.confidence,
    rawText: context.rawText,
    sourceLocation: context.sourceLocation,
  });

  return {
    ok: true,
    tool,
    incomeType: TAX_TOOL_INCOME_TYPE[tool],
    fields,
    facts,
  };
}

/** Convenience wrappers matching work-order tool names. */
export function addW2(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_w2', args, context });
}

export function add1099Int(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_int', args, context });
}

export function add1099Div(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_div', args, context });
}

export function add1099Nec(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_nec', args, context });
}

export function add1099R(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_r', args, context });
}

/**
 * Records a filing-status candidate as a TaxFact only.
 * Does not set the return's final filing status (that remains a user choice).
 */
export function setFilingStatusCandidate(
  args: Record<string, unknown>,
  context: TaxToolCallContext,
): TaxToolResult {
  return invokeTaxTool({ tool: 'set_filing_status_candidate', args, context });
}
