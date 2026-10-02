/**
 * Tool caller (development-order step 9 / work-order §5).
 *
 * Turns a classified form's structured fields into a schema-validated tax
 * tool call; `invokeTaxTool` and validation decide what is written. A model
 * may propose calls only through `groundedToolCall.ts`, where every argument
 * is a grammar constant taken from the extracted facts. (The work order's
 * LiquidAI LFM2-1.2B-Tool was tested and rejected — see gauntlet/README.md.)
 *
 * Responsibilities:
 * - Accept model (or fallback) proposals for `add_w2`, `add_1099_*`,
 *   `set_filing_status_candidate` (candidate fact only)
 * - Never invoke a tool with a field that validation rejected
 * - Never calculate tax / never call calculate_return
 * - Preserve UNKNOWN != ZERO; keep a real numeric 0; leave invalid fields unwritten
 *
 * This is not automatic return population, reconciliation, diagnostics,
 * review queue, RAG, ModelManager, e-file, or the copilot.
 */

import {
  omitInvalidToolFields,
  validateImportedFacts,
  type FactValidationResult,
} from './factValidation.js';
import type { TaxFact } from './taxFact.js';
import {
  FORM_TOOL_NAMES,
  formToolForIncomeType,
  invokeTaxTool,
  type TaxToolCallContext,
  type TaxToolName,
  type TaxToolResult,
} from './taxTools.js';

/**
 * Tools this caller may invoke: one form's boxes → its form tool, and the
 * filing-status candidate. Record tools take evidence that is not a form
 * (client/recordTools), and the return tools run after the return changes.
 */
export const TOOL_CALLER_ALLOWED_TOOLS = [...FORM_TOOL_NAMES, 'set_filing_status_candidate'] as const;

export type ToolCallerAllowedTool = (typeof TOOL_CALLER_ALLOWED_TOOLS)[number];

/** Refused here: record tools, return tools, and anything that would set the filing status or calculate tax. */
const BLOCKED_TOOL_NAMES = new Set([
  'calculate_return',
  'calculate_tax',
  'run_diagnostics',
  'add_dependent',
  'add_schedule_c_income',
  'add_estimated_payment',
  'set_state_residency',
  'set_document_expected',
  'set_filing_status',
]);

/**
 * A proposed tool call — from a model through groundedToolCall, or from the
 * deterministic mapping of a form's fields. Models never write return tables.
 */
export interface ToolCallProposal {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolCallerExecuteInput {
  proposal: ToolCallProposal;
  context: TaxToolCallContext;
  /**
   * Optional precomputed facts + validation. When omitted, the deterministic
   * caller materializes facts from `proposal.args` only to validate, then
   * invokes the tax-engine tool with rejected fields stripped.
   */
  facts?: TaxFact[];
  validation?: FactValidationResult;
}

export interface ToolCallerExecuteResult {
  ok: boolean;
  tool: TaxToolName | null;
  /** Tax-engine result from the call that used only validation-clean args. */
  result: TaxToolResult | null;
  /**
   * Full fact set for review/storage — includes structurally invalid extracted
   * values so the preparer can see what was rejected. Never rewrite them to 0.
   */
  facts: TaxFact[];
  validation: FactValidationResult;
  /** Arguments actually passed to the tax-engine tool (rejected keys omitted). */
  appliedArgs: Record<string, unknown>;
  skippedFields: string[];
  error?: string;
}

/** Caller interface: `execute` always validates, then invokes the tax-engine tool. */
export interface ToolCaller {
  execute(input: ToolCallerExecuteInput): ToolCallerExecuteResult;
}

function isAllowedTool(tool: string): tool is ToolCallerAllowedTool {
  return (TOOL_CALLER_ALLOWED_TOOLS as readonly string[]).includes(tool);
}

function skippedKeys(
  original: Record<string, unknown>,
  applied: Record<string, unknown>,
): string[] {
  return Object.keys(original).filter(
    (key) => !Object.prototype.hasOwnProperty.call(applied, key),
  );
}

function schemaFailureValidation(message: string): FactValidationResult {
  return {
    ready: false,
    issues: [
      {
        code: 'TOOL_SCHEMA',
        severity: 'error',
        message,
      },
    ],
    heldForms: [],
  };
}

/**
 * Propose the form tool for a classified form type.
 * Returns null when no tool reads that form.
 */
export function proposeIncomeToolCall(
  incomeType: string | null | undefined,
  args: Record<string, unknown>,
): ToolCallProposal | null {
  const tool = formToolForIncomeType(incomeType);
  if (!tool) return null;
  return { tool, args };
}

/**
 * Filing-status candidate only — never sets final filing status.
 */
export function proposeFilingStatusCandidate(
  status: string,
): ToolCallProposal {
  return {
    tool: 'set_filing_status_candidate',
    args: { status },
  };
}

/**
 * Validate → strip rejected fields → invokeTaxTool. Model proposals come
 * through groundedToolCall; this path runs the deterministic proposal.
 * Does not invent amounts or calculate tax.
 */
export function executeDeterministicToolCall(
  input: ToolCallerExecuteInput,
): ToolCallerExecuteResult {
  const { proposal, context } = input;
  const toolName = proposal.tool;

  if (BLOCKED_TOOL_NAMES.has(toolName)) {
    return {
      ok: false,
      tool: null,
      result: null,
      facts: [],
      validation: schemaFailureValidation(
        `Tool "${toolName}" does not take a form's fields; it is not called from a document.`,
      ),
      appliedArgs: {},
      skippedFields: Object.keys(proposal.args),
      error: `Blocked tool: ${toolName}`,
    };
  }

  if (!isAllowedTool(toolName)) {
    return {
      ok: false,
      tool: null,
      result: null,
      facts: [],
      validation: schemaFailureValidation(`Unknown or unsupported tool: ${toolName}`),
      appliedArgs: {},
      skippedFields: Object.keys(proposal.args),
      error: `Unsupported tool: ${toolName}`,
    };
  }

  const tool: TaxToolName = toolName;

  // Filing-status candidate: schema-validated candidate fact only.
  if (tool === 'set_filing_status_candidate') {
    const result = invokeTaxTool({ tool, args: proposal.args, context });
    if (!result.ok) {
      return {
        ok: false,
        tool,
        result,
        facts: [],
        validation: schemaFailureValidation(result.error),
        appliedArgs: {},
        skippedFields: Object.keys(proposal.args),
        error: result.error,
      };
    }
    return {
      ok: true,
      tool,
      result,
      facts: result.facts,
      validation: input.validation ?? { ready: true, issues: [], heldForms: [] },
      appliedArgs: { ...proposal.args },
      skippedFields: [],
    };
  }

  // Income tools: materialize facts for validation, then invoke with clean args only.
  let reviewFacts = input.facts;
  let validation = input.validation;

  if (!reviewFacts || !validation) {
    const provisional = invokeTaxTool({ tool, args: proposal.args, context });
    if (!provisional.ok) {
      return {
        ok: false,
        tool,
        result: provisional,
        facts: reviewFacts ?? [],
        validation: validation ?? schemaFailureValidation(provisional.error),
        appliedArgs: {},
        skippedFields: Object.keys(proposal.args),
        error: provisional.error,
      };
    }
    reviewFacts = reviewFacts ?? provisional.facts;
    validation =
      validation ?? validateImportedFacts(reviewFacts, { taxYear: context.taxYear });
  }

  const appliedArgs = omitInvalidToolFields(proposal.args, reviewFacts, validation);
  const skipped = skippedKeys(proposal.args, appliedArgs);

  // Official tool call — never includes validation-rejected fields.
  const result = invokeTaxTool({ tool, args: appliedArgs, context });
  if (!result.ok) {
    return {
      ok: false,
      tool,
      result,
      facts: reviewFacts,
      validation,
      appliedArgs: {},
      skippedFields: skipped,
      error: result.error,
    };
  }

  return {
    ok: true,
    tool,
    result,
    // Keep full review facts (including rejected extracted values) for the preparer.
    facts: reviewFacts,
    validation,
    appliedArgs: result.fields,
    skippedFields: skipped,
  };
}

/** The deterministic caller: extracted fields → validated tool call. */
export const deterministicToolCaller: ToolCaller = {
  execute: executeDeterministicToolCall,
};

/**
 * Convenience: classified income type + structured fields → deterministic call.
 */
export function callIncomeToolFromStructuredFields(input: {
  incomeType: string | null | undefined;
  args: Record<string, unknown>;
  context: TaxToolCallContext;
  facts?: TaxFact[];
  validation?: FactValidationResult;
}): ToolCallerExecuteResult {
  const proposal = proposeIncomeToolCall(input.incomeType, input.args);
  if (!proposal) {
    return {
      ok: false,
      tool: null,
      result: null,
      facts: [],
      validation: schemaFailureValidation(
        `No tax-engine form tool for income type "${input.incomeType ?? ''}"`,
      ),
      appliedArgs: {},
      skippedFields: Object.keys(input.args),
      error: `Unsupported income type: ${input.incomeType ?? '(none)'}`,
    };
  }
  return executeDeterministicToolCall({
    proposal,
    context: input.context,
    facts: input.facts,
    validation: input.validation,
  });
}
