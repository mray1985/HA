/**
 * Unit tests for the LFM tool-caller contract (work-order §5).
 *
 * These tests do NOT download or require multi-gigabyte weights.
 * A missing model directory must not crash the suite.
 */

import { describe, expect, it } from 'vitest';
import {
  LFM_TOOL_MODEL_REPO_ID,
  LFM_TOOL_RUNTIME,
  createLfmBackedToolCaller,
  parseLfmToolCallText,
  parseToolCallJson,
  proposeToolCallWithLfm,
  resolveLfmModelDir,
} from '../src/taxfacts/lfmToolCaller.js';

describe('LFM tool-caller contract (no weights required)', () => {
  it('records the exact work-order model id and transformers runtime', () => {
    expect(LFM_TOOL_MODEL_REPO_ID).toBe('LiquidAI/LFM2-1.2B-Tool');
    expect(LFM_TOOL_RUNTIME).toBe('transformers');
    const caller = createLfmBackedToolCaller();
    expect(caller.modelRepoId).toBe('LiquidAI/LFM2-1.2B-Tool');
    expect(caller.runtime).toBe('transformers');
  });

  it('parses LFM Pythonic tool-call text into an allowed proposal', () => {
    const text =
      '<|tool_call_start|>[add_w2(employerName="Acme", wages=40000, federalTaxWithheld=0)]<|tool_call_end|>';
    const { proposals, rejected } = parseLfmToolCallText(text);
    expect(rejected).toEqual([]);
    expect(proposals).toEqual([
      {
        tool: 'add_w2',
        args: {
          employerName: 'Acme',
          wages: 40000,
          federalTaxWithheld: 0,
        },
      },
    ]);
  });

  it('keeps a real numeric 0 and drops null/None (UNKNOWN must not become zero)', () => {
    const text =
      '<|tool_call_start|>[add_1099_int(payerName="Bank", amount=0, federalTaxWithheld=None)]<|tool_call_end|>';
    const { proposals } = parseLfmToolCallText(text);
    expect(proposals[0]?.args).toEqual({
      payerName: 'Bank',
      amount: 0,
    });
    expect(proposals[0]?.args).not.toHaveProperty('federalTaxWithheld');
  });

  it('rejects tool-call JSON that is not a known tool', () => {
    const parsed = parseToolCallJson({
      tool: 'calculate_return',
      args: { wages: 1 },
    });
    expect(parsed.proposal).toBeNull();
    expect(parsed.error).toMatch(/Unknown or unsupported tool/);
  });

  it('rejects hallucinated tool names in LFM text', () => {
    const { proposals, rejected } = parseLfmToolCallText(
      '<|tool_call_start|>[add_imaginary_form(wages=1)]<|tool_call_end|>',
    );
    expect(proposals).toEqual([]);
    expect(rejected).toContain('add_imaginary_form');
  });

  it('accepts known-tool JSON', () => {
    const parsed = parseToolCallJson({
      tool: 'set_filing_status_candidate',
      args: { status: 'single' },
    });
    expect(parsed.proposal).toEqual({
      tool: 'set_filing_status_candidate',
      args: { status: 'single' },
    });
  });

  it('does not crash when the model directory is missing', async () => {
    const missing = resolveLfmModelDir({
      modelDir: 'C:\\definitely-missing-lfm-model-dir-for-ci',
    });
    expect(missing).toBeNull();

    const result = await proposeToolCallWithLfm(
      {
        userMessage: 'W-2 Acme wages 40000',
        structuredFallback: {
          incomeType: 'w2',
          args: { employerName: 'Acme', wages: 40000 },
        },
      },
      {
        modelDir: 'C:\\definitely-missing-lfm-model-dir-for-ci',
        forceFallback: true,
      },
    );

    expect(result.source).toBe('deterministic_fallback');
    expect(result.ok).toBe(true);
    expect(result.proposal).toEqual({
      tool: 'add_w2',
      args: { employerName: 'Acme', wages: 40000 },
    });
  });

  it('missing model without structured fallback returns a soft failure (no throw)', async () => {
    const result = await proposeToolCallWithLfm(
      { userMessage: 'evidence only' },
      {
        modelDir: 'C:\\definitely-missing-lfm-model-dir-for-ci',
      },
    );
    expect(result.source).toBe('deterministic_fallback');
    expect(result.proposal).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toMatch(/missing/i);
  });
});
