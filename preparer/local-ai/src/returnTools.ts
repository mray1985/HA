/**
 * Return tools (work order §5): calculate the return and run its diagnostics.
 * They take no arguments from a model — the return and the case's facts are
 * the input — and they never change the return. The engine owns every number;
 * these tools only run it and report.
 */

import { z } from 'zod';
import {
  calculateForm1040,
  DIAGNOSTIC_CATEGORIES,
  runReturnDiagnostics,
  type CalculationResult,
  type Diagnostic,
  type DiagnosticCategory,
  type TaxReturn,
} from '@hatax/engine';
import { validateImportedFacts, type FactValidationIssue } from './factValidation.js';
import type { TaxFact } from './taxFact.js';

export const RETURN_TOOL_NAMES = ['calculate_return', 'run_diagnostics'] as const;

export type ReturnToolName = (typeof RETURN_TOOL_NAMES)[number];

export function isReturnTool(name: string): name is ReturnToolName {
  return (RETURN_TOOL_NAMES as readonly string[]).includes(name);
}

/** Both return tools take no arguments; anything passed is rejected. */
export const ReturnToolArgsSchema = z.object({}).strict();

/** The return's bottom line, from the engine's Form 1040. */
export interface ReturnSummary {
  agi: number;
  taxableIncome: number;
  totalTax: number;
  totalPayments: number;
  refundAmount: number;
  amountOwed: number;
}

export type ReturnToolResult =
  | { ok: true; tool: 'calculate_return'; calculation: CalculationResult; summary: ReturnSummary }
  | {
      ok: true;
      tool: 'run_diagnostics';
      /** Engine diagnostics, most severe first. */
      diagnostics: Diagnostic[];
      counts: Record<DiagnosticCategory, number>;
      /** Evidence issues from the case's facts. */
      factIssues: FactValidationIssue[];
      /** Forms validation holds out of the return. */
      heldForms: string[];
    }
  | { ok: false; tool: ReturnToolName; error: string };

export interface InvokeReturnToolInput {
  tool: ReturnToolName;
  args: Record<string, unknown>;
  taxReturn: TaxReturn;
  /** The case's facts (run_diagnostics). */
  facts?: TaxFact[];
  /** A calculation of this same return, when the caller already has one (run_diagnostics). */
  calculation?: CalculationResult | null;
}

export function summarizeCalculation(calculation: CalculationResult): ReturnSummary {
  const f = calculation.form1040;
  return {
    agi: f.agi,
    taxableIncome: f.taxableIncome,
    totalTax: f.totalTax,
    totalPayments: f.totalPayments,
    refundAmount: f.refundAmount,
    amountOwed: f.amountOwed,
  };
}

export function invokeReturnTool(input: InvokeReturnToolInput): ReturnToolResult {
  const { tool } = input;
  const parsed = ReturnToolArgsSchema.safeParse(input.args);
  if (!parsed.success) {
    return { ok: false, tool, error: `${tool} takes no arguments (got ${Object.keys(input.args).join(', ')}).` };
  }

  let calculation: CalculationResult | null = null;
  if (tool === 'calculate_return' || input.calculation === undefined) {
    try {
      calculation = calculateForm1040(input.taxReturn);
    } catch (err) {
      if (tool === 'calculate_return') {
        return { ok: false, tool, error: `The engine could not calculate the return: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  } else {
    calculation = input.calculation;
  }

  if (tool === 'calculate_return') {
    return { ok: true, tool, calculation: calculation!, summary: summarizeCalculation(calculation!) };
  }

  const diagnostics = runReturnDiagnostics(input.taxReturn, calculation);
  const counts = Object.fromEntries(DIAGNOSTIC_CATEGORIES.map((c) => [c, 0])) as Record<DiagnosticCategory, number>;
  for (const d of diagnostics) counts[d.category] += 1;
  const validation = validateImportedFacts(input.facts ?? [], { taxYear: input.taxReturn.taxYear });
  return { ok: true, tool, diagnostics, counts, factIssues: validation.issues, heldForms: validation.heldForms };
}
