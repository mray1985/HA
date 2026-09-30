/**
 * Tool caller (development-order step 9 / work-order §5).
 *
 * Spec path: local tool-calling model `LiquidAI/LFM2-1.2B-Tool` as GGUF
 * Q4_K_M via llama-cpp-python (see `lfmToolCaller.ts`). The model proposes
 * schema-validated calls; this module + `invokeTaxTool` / validation still
 * decide what is written.
 *
 * Deterministic mapping below is FALLBACK ONLY when the LFM Q4_K_M GGUF is
 * absent or the llama.cpp runtime fails to load — never the preferred path.
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
  TAX_TOOL_NAMES,
  invokeTaxTool,
  toolNameForIncomeType,
  type TaxToolCallContext,
  type TaxToolIncomeName,
  type TaxToolName,
  type TaxToolResult,
} from './taxTools.js';

/** Tools this caller may invoke. Tax calculation is intentionally absent. */
export const TOOL_CALLER_ALLOWED_TOOLS = TAX_TOOL_NAMES;

export type ToolCallerAllowedTool = (typeof TOOL_CALLER_ALLOWED_TOOLS)[number];

/** Explicitly refused — belong to later development-order steps. */
const BLOCKED_TOOL_NAMES = new Set([
  'calculate_return',
  'calculate_tax',
  'run_diagnostics',
  'add_dependent',
  'add_schedule_c_income',
  'add_estimated_payment',
  'set_state_residency',
  'set_filing_status',
]);

/**
 * A proposed tool call — from LiquidAI/LFM2-1.2B-Tool (spec) or the
 * deterministic FALLBACK when the model is absent/unloadable.
 * Models must not write return tables directly.
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

/**
 * Caller interface. Spec: LFM proposes; `execute` always validates then
 * invokes tax-engine tools. Deterministic proposal is fallback-only.
 */
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
 * Propose the income tool for a classified form type.
 * Returns null when the form is not one of the five supported income tools.
 */
export function proposeIncomeToolCall(
  incomeType: string | null | undefined,
  args: Record<string, unknown>,
): ToolCallProposal | null {
  const tool = toolNameForIncomeType(incomeType);
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
 * Deterministic FALLBACK path: validate → strip rejected fields → invokeTaxTool.
 * Prefer `proposeToolCallWithLfm` (LiquidAI/LFM2-1.2B-Tool Q4_K_M GGUF).
 * Use this proposal path only when the GGUF is absent or runtime fails.
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
        `Tool "${toolName}" is not allowed in the tool-caller phase (no tax calculation or later-phase tools).`,
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

/**
 * Shared deterministic FALLBACK caller (used when LFM weights are absent or
 * transformers fails). Spec path is `lfmToolCaller` / `proposeToolCallWithLfm`.
 */
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
        `No tax-engine income tool for income type "${input.incomeType ?? ''}"`,
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

/** Type guard for income tool names allowed here. */
export function isToolCallerIncomeTool(tool: string): tool is TaxToolIncomeName {
  return (
    tool === 'add_w2' ||
    tool === 'add_1099_int' ||
    tool === 'add_1099_div' ||
    tool === 'add_1099_nec' ||
    tool === 'add_1099_r'
  );
}
