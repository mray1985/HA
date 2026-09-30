/**
 * Tool definitions for tool-calling models (work order §5).
 *
 * The JSON Schemas shown to a model are generated from the same zod schemas
 * that validate every call (taxTools.ts), so a model can never be told a field
 * name the validator rejects. Descriptions state the no-guessing rules; the
 * schemas themselves forbid extra properties.
 */

import { z } from 'zod';
import {
  SetFilingStatusCandidateSchema,
  TAX_TOOL_NAMES,
  TOOL_FIELD_SCHEMAS,
  type TaxToolName,
} from './taxTools.js';

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: TaxToolName;
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
      const checks = (def.checks as Array<{ kind: string; value?: number }>) ?? [];
      const min = checks.find((c) => c.kind === 'min');
      return min ? { type: 'string', minLength: min.value } : { type: 'string' };
    }
    case 'ZodNumber':
      return { type: 'number' };
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

const DESCRIPTIONS: Record<TaxToolName, string> = {
  add_w2: `Add one Form W-2 to the return. ${NO_GUESSING}`,
  add_1099_int: `Add one Form 1099-INT (interest income). ${NO_GUESSING}`,
  add_1099_div: `Add one Form 1099-DIV (dividends and distributions). ${NO_GUESSING}`,
  add_1099_nec: `Add one Form 1099-NEC (nonemployee compensation). ${NO_GUESSING}`,
  add_1099_r: `Add one Form 1099-R (retirement distribution). ${NO_GUESSING}`,
  add_ssa_1099: `Add one Form SSA-1099 (Social Security benefit statement). Net benefits (box 5) may be negative. ${NO_GUESSING}`,
  add_mortgage_interest: `Add one Form 1098 (mortgage interest statement). ${NO_GUESSING}`,
  add_education_expense: `Add one Form 1098-T (tuition statement). This records the statement; which education credit applies is decided separately. ${NO_GUESSING}`,
  set_filing_status_candidate:
    'Record a filing-status candidate stated in the evidence. This does not set the final filing status; the tax engine and preparer decide that.',
};

export function taxToolDefinitions(): ToolDefinition[] {
  return TAX_TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters:
      name === 'set_filing_status_candidate'
        ? zodToJsonSchema(SetFilingStatusCandidateSchema)
        : zodToJsonSchema(TOOL_FIELD_SCHEMAS[name]),
  }));
}

/** OpenAI-style `tools` array (llama-server /v1/chat/completions). */
export function openAiTools(definitions: readonly ToolDefinition[] = taxToolDefinitions()) {
  return definitions.map((d) => ({
    type: 'function' as const,
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}
