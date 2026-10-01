/**
 * Tool definitions for tool-calling models (work order §5): every fact tool
 * and both return tools.
 *
 * The JSON Schemas shown to a model are generated from the same zod schemas
 * that validate every call (taxTools.ts), so a model can never be told a field
 * name the validator rejects. Descriptions state the no-guessing rules; the
 * schemas themselves forbid extra properties.
 */

import { z } from 'zod';
import { RETURN_TOOL_NAMES, ReturnToolArgsSchema, type ReturnToolName } from './returnTools.js';
import {
  fieldSchemaFor,
  SetFilingStatusCandidateSchema,
  TAX_TOOL_NAMES,
  type TaxToolName,
} from './taxTools.js';

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: TaxToolName | ReturnToolName;
  description: string;
  parameters: JsonSchema;
}

/**
 * Convert the zod types the tax tools use into JSON Schema. Unsupported zod
 * types throw so a new schema construct cannot silently produce a loose schema.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case 'ZodEffects':
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    case 'ZodString': {
      const checks = (def.checks as Array<{ kind: string; value?: number; regex?: RegExp }>) ?? [];
      const min = checks.find((c) => c.kind === 'min');
      const regex = checks.find((c) => c.kind === 'regex');
      return {
        type: 'string',
        ...(min ? { minLength: min.value } : {}),
        ...(regex?.regex ? { pattern: regex.regex.source } : {}),
      };
    }
    case 'ZodNumber': {
      const checks = (def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) ?? [];
      const out: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out[c.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = c.value;
        if (c.kind === 'max') out[c.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type as z.ZodTypeAny) };
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
        if (!isOptional(value as z.ZodTypeAny)) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type ${def.typeName}`);
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  if (def.typeName === 'ZodOptional') return true;
  if (def.typeName === 'ZodEffects') return isOptional(def.schema as z.ZodTypeAny);
  return false;
}

const NO_GUESSING =
  'Pass only values present in the evidence, copied exactly. Omit any field the evidence does not contain — never pass 0 or an empty value for a missing field.';

const DESCRIPTIONS: Record<TaxToolName | ReturnToolName, string> = {
  add_w2: `Add one Form W-2 to the return. ${NO_GUESSING}`,
  add_1099_int: `Add one Form 1099-INT (interest income). ${NO_GUESSING}`,
  add_1099_div: `Add one Form 1099-DIV (dividends and distributions). ${NO_GUESSING}`,
  add_1099_nec: `Add one Form 1099-NEC (nonemployee compensation). ${NO_GUESSING}`,
  add_1099_r: `Add one Form 1099-R (retirement distribution). ${NO_GUESSING}`,
  add_ssa_1099: `Add one Form SSA-1099 (Social Security benefit statement). Net benefits (box 5) may be negative. ${NO_GUESSING}`,
  add_1099_misc: `Add one Form 1099-MISC (rents, royalties, other income). ${NO_GUESSING}`,
  add_1099_g: `Add one Form 1099-G (unemployment compensation). A state refund in box 2 is reviewed by the preparer, not passed here. ${NO_GUESSING}`,
  add_1099_b: `Add one Form 1099-B sale. isLongTerm is true only when box 2 "Long-term" is checked and false only when "Short-term" is checked. ${NO_GUESSING}`,
  add_1099_k: `Add one Form 1099-K (payment card and third party network transactions). ${NO_GUESSING}`,
  add_1099_oid: `Add one Form 1099-OID (original issue discount). ${NO_GUESSING}`,
  add_1099_c: `Add one Form 1099-C (cancellation of debt). ${NO_GUESSING}`,
  add_1099_q: `Record one Form 1099-Q (qualified education program payment). The qualified expenses it paid are decided separately. ${NO_GUESSING}`,
  add_1099_sa: `Record one Form 1099-SA (HSA / MSA distribution). Whether it paid qualified medical expenses is decided separately. ${NO_GUESSING}`,
  add_w2c: `Add one Form W-2c (corrected wage and tax statement). Pass only the boxes printed on it, each as previously reported and as corrected; it corrects the W-2 with the same employer EIN. ${NO_GUESSING}`,
  add_1099_s: `Record one Form 1099-S (real estate sale). Basis and the home-sale exclusion are decided separately. ${NO_GUESSING}`,
  add_mortgage_interest: `Add one Form 1098 (mortgage interest statement). ${NO_GUESSING}`,
  add_education_expense: `Add one Form 1098-T (tuition statement). This records the statement; which education credit applies is decided separately. ${NO_GUESSING}`,
  set_filing_status_candidate:
    'Record a filing-status candidate stated in the evidence. This does not set the final filing status; the tax engine and preparer decide that.',
  add_dependent: `Record one dependent named in the evidence (a prior-year return, the client's answers, an intake sheet). Call once per person. Whether they qualify is decided by the engine and the preparer. ${NO_GUESSING}`,
  add_schedule_c_income: `Record business gross receipts that no Form 1099-NEC or 1099-K reports (cash, checks, direct deposits), from the business's income records. Never include amounts a 1099 already reports. ${NO_GUESSING}`,
  add_estimated_payment: `Record one estimated tax payment (federal Form 1040-ES or a state's), or the prior year's overpayment applied to this year. Call once per payment. ${NO_GUESSING}`,
  set_state_residency: `Record the taxpayer's residency in one state for the tax year, as the evidence states it. ${NO_GUESSING}`,
  set_document_expected: `Record whether the client received a tax document they received last year (the payer's form this year), as the client states it. ${NO_GUESSING}`,
  set_spouse: `Record the client's spouse on a joint return (name, SSN, date of birth) as the evidence states them. ${NO_GUESSING}`,
  add_business_expense: `Record one business (Schedule C) expense the evidence states, with its amount and what it was for; the preparer gives its Schedule C line and category, and its business when the return has more than one. ${NO_GUESSING}`,
  calculate_return: 'Calculate the return with the tax engine and report its totals. Takes no arguments and changes nothing.',
  run_diagnostics: "Run the return's diagnostics and the evidence checks, and report what needs attention. Takes no arguments and changes nothing.",
};

export function taxToolDefinitions(): ToolDefinition[] {
  const factTools: ToolDefinition[] = TAX_TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters:
      name === 'set_filing_status_candidate'
        ? zodToJsonSchema(SetFilingStatusCandidateSchema)
        : zodToJsonSchema(fieldSchemaFor(name)),
  }));
  const returnTools: ToolDefinition[] = RETURN_TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: zodToJsonSchema(ReturnToolArgsSchema),
  }));
  return [...factTools, ...returnTools];
}

/** OpenAI-style `tools` array (llama-server /v1/chat/completions). */
export function openAiTools(definitions: readonly ToolDefinition[] = taxToolDefinitions()) {
  return definitions.map((d) => ({
    type: 'function' as const,
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}
