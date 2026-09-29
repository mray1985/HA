/**
 * LFM tool-calling model path (work-order §5 / HA-AI-010).
 *
 * Spec (work order #5 TOOL-CALLING / AUTOMATION MODEL):
 *   Primary candidate HF repo id: `LiquidAI/LFM2-1.2B-Tool`
 *
 * The work order does not name a quantization or runtime string. The Hub
 * model card for that exact repo lists under "How to run":
 *   - Hugging Face (transformers) — this path
 *   - llama.cpp — separate `LFM2-1.2B-Tool-GGUF` repo (not substituted here)
 *   - LEAP
 * Weights in `LiquidAI/LFM2-1.2B-Tool` ship as BF16 safetensors.
 *
 * Spec path = local LFM proposes a schema-validated tool call.
 * Deterministic mapping is FALLBACK ONLY when the model directory is absent
 * or the transformers runtime fails to load / run.
 *
 * The model must not calculate tax and must not invent amounts.
 * UNKNOWN must not become zero; a real numeric 0 is kept.
 * Existing invokeTaxTool / validation still decide what is written.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_CALLER_ALLOWED_TOOLS,
  executeDeterministicToolCall,
  proposeIncomeToolCall,
  type ToolCallProposal,
  type ToolCaller,
  type ToolCallerExecuteInput,
  type ToolCallerExecuteResult,
} from './toolCaller.js';

/** Exact Hugging Face repo id from work-order §5. */
export const LFM_TOOL_MODEL_REPO_ID = 'LiquidAI/LFM2-1.2B-Tool' as const;

/**
 * Runtime used for that repo (model card "How to run" → Hugging Face).
 * Not llama.cpp/ONNX/MLX — those are not named for this Hub repo id.
 */
export const LFM_TOOL_RUNTIME = 'transformers' as const;

/** Relative path under the repo where weights are downloaded (gitignored). */
export const LFM_TOOL_MODEL_RELATIVE_DIR = join(
  'models',
  'LiquidAI',
  'LFM2-1.2B-Tool',
);

export type LfmProposeSource = 'lfm' | 'deterministic_fallback';

export interface LfmProposeResult {
  ok: boolean;
  source: LfmProposeSource;
  proposal: ToolCallProposal | null;
  /** Raw model text when the LFM path ran. */
  raw?: string;
  error?: string;
  /** Why deterministic fallback was used (model absent / runtime failure). */
  fallbackReason?: string;
}

export interface LfmEvidenceInput {
  /** Natural-language evidence / instruction for the model. */
  userMessage: string;
  /**
   * Optional structured fields already extracted. Used only by the
   * deterministic FALLBACK path — the model receives `userMessage`.
   */
  structuredFallback?: {
    incomeType?: string | null;
    args?: Record<string, unknown>;
    filingStatusCandidate?: string;
  };
}

const TOOL_SCHEMAS: ReadonlyArray<{
  name: (typeof TOOL_CALLER_ALLOWED_TOOLS)[number];
  description: string;
  parameters: Record<string, unknown>;
}> = [
  {
    name: 'add_w2',
    description: 'Add a Form W-2. Pass only fields present in the evidence.',
    parameters: {
      type: 'object',
      properties: {
        employerName: { type: 'string' },
        employerEIN: { type: 'string' },
        wages: { type: 'number' },
        federalTaxWithheld: { type: 'number' },
        socialSecurityWages: { type: 'number' },
        socialSecurityTaxWithheld: { type: 'number' },
        medicareWages: { type: 'number' },
        medicareTaxWithheld: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_1099_int',
    description: 'Add Form 1099-INT interest income.',
    parameters: {
      type: 'object',
      properties: {
        payerName: { type: 'string' },
        amount: { type: 'number' },
        federalTaxWithheld: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_1099_div',
    description: 'Add Form 1099-DIV dividend income.',
    parameters: {
      type: 'object',
      properties: {
        payerName: { type: 'string' },
        ordinaryDividends: { type: 'number' },
        qualifiedDividends: { type: 'number' },
        federalTaxWithheld: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_1099_nec',
    description: 'Add Form 1099-NEC nonemployee compensation.',
    parameters: {
      type: 'object',
      properties: {
        payerName: { type: 'string' },
        amount: { type: 'number' },
        federalTaxWithheld: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_1099_r',
    description: 'Add Form 1099-R retirement distribution.',
    parameters: {
      type: 'object',
      properties: {
        payerName: { type: 'string' },
        grossDistribution: { type: 'number' },
        taxableAmount: { type: 'number' },
        federalTaxWithheld: { type: 'number' },
        distributionCode: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_filing_status_candidate',
    description:
      'Record a filing-status candidate fact only (not final filing status).',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string' },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
];

const ALLOWED = new Set<string>(TOOL_CALLER_ALLOWED_TOOLS);

function repoRootFromThisModule(): string {
  // shared/src/taxfacts → shared/src → shared → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..');
}

/**
 * Resolve the local LiquidAI/LFM2-1.2B-Tool directory.
 * Returns null when weights are absent (CI / machines without the download).
 *
 * When `modelDir` is passed explicitly, only that path is checked (no
 * fall-through to the repo `models/` tree) so tests can assert missing-file
 * behavior without requiring a clean machine.
 */
export function resolveLfmModelDir(options?: {
  modelDir?: string;
  repoRoot?: string;
}): string | null {
  if (options?.modelDir !== undefined) {
    const abs = resolve(options.modelDir);
    if (existsSync(join(abs, 'config.json')) && existsSync(join(abs, 'model.safetensors'))) {
      return abs;
    }
    return null;
  }

  const envDir = process.env.HA_LFM_TOOL_MODEL_DIR?.trim();
  const candidates = [
    envDir,
    options?.repoRoot
      ? join(options.repoRoot, LFM_TOOL_MODEL_RELATIVE_DIR)
      : undefined,
    join(repoRootFromThisModule(), LFM_TOOL_MODEL_RELATIVE_DIR),
    join(process.cwd(), LFM_TOOL_MODEL_RELATIVE_DIR),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const dir of candidates) {
    const abs = resolve(dir);
    if (existsSync(join(abs, 'config.json')) && existsSync(join(abs, 'model.safetensors'))) {
      return abs;
    }
  }
  return null;
}

export function lfmRuntimeScriptPath(repoRoot?: string): string {
  const root = repoRoot ?? repoRootFromThisModule();
  return join(root, 'scripts', 'lfm_tool_call.py');
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  if (s === 'None' || s === 'null') return undefined;
  if (s === 'True' || s === 'true') return true;
  if (s === 'False' || s === 'false') return false;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  const num = Number(s);
  if (!Number.isNaN(num) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    return num;
  }
  return s;
}

function splitTopLevel(body: string, sep: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  let escape = false;
  for (const ch of body) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      buf += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (ch === sep && depth === 0) {
      const piece = buf.trim();
      if (piece) parts.push(piece);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Parse LFM Pythonic tool-call text into proposals.
 * Rejects unknown tool names (caller contract for CI without weights).
 */
export function parseLfmToolCallText(text: string): {
  proposals: ToolCallProposal[];
  rejected: string[];
} {
  const proposals: ToolCallProposal[] = [];
  const rejected: string[] = [];
  const markerRe = /<\|tool_call_start\|>(.*?)<\|tool_call_end\|>/gs;
  const fragments: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    fragments.push(m[1] ?? '');
  }
  if (fragments.length === 0 && text.trim()) {
    fragments.push(text);
  }

  for (const fragment of fragments) {
    let body = fragment.trim();
    if (body.startsWith('[') && body.endsWith(']')) {
      body = body.slice(1, -1).trim();
    }
    if (!body) continue;

    for (const rawCall of splitTopLevel(body, ',')) {
      const callMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/s.exec(rawCall.trim());
      if (!callMatch) continue;
      const tool = callMatch[1]!;
      const argBody = callMatch[2] ?? '';
      if (!ALLOWED.has(tool)) {
        rejected.push(tool);
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const part of splitTopLevel(argBody, ',')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        const parsed = parseScalar(part.slice(eq + 1));
        // Drop null/undefined so UNKNOWN stays omitted; keep real 0.
        if (parsed === undefined || parsed === null) continue;
        args[key] = parsed;
      }
      proposals.push({ tool, args });
    }
  }

  return { proposals, rejected };
}

/**
 * Validate a loose JSON tool-call object from tests / runtime.
 * Unknown tools are rejected (not executed).
 */
export function parseToolCallJson(value: unknown): {
  proposal: ToolCallProposal | null;
  error?: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { proposal: null, error: 'Tool call must be a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  const tool = obj.tool ?? obj.name;
  if (typeof tool !== 'string' || !tool) {
    return { proposal: null, error: 'Tool call missing tool name' };
  }
  if (!ALLOWED.has(tool)) {
    return { proposal: null, error: `Unknown or unsupported tool: ${tool}` };
  }
  const argsRaw = obj.args ?? obj.arguments ?? {};
  if (argsRaw === null || typeof argsRaw !== 'object' || Array.isArray(argsRaw)) {
    return { proposal: null, error: 'Tool call args must be an object' };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argsRaw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    args[k] = v;
  }
  return { proposal: { tool, args } };
}

async function runPythonRuntime(input: {
  modelDir: string;
  userMessage: string;
  scriptPath: string;
  pythonPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; raw?: string; calls?: unknown[]; error?: string }> {
  const python = input.pythonPath ?? process.env.HA_PYTHON ?? 'python';
  const payload = JSON.stringify({
    model_dir: input.modelDir,
    user_message: input.userMessage,
    tools: TOOL_SCHEMAS,
    max_new_tokens: 128,
  });

  return new Promise((resolvePromise) => {
    const child = spawn(python, [input.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({
        ok: false,
        error: `LFM transformers runtime timed out after ${input.timeoutMs ?? 600_000}ms`,
      });
    }, input.timeoutMs ?? 600_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        error: `Failed to start LFM runtime (${python}): ${err.message}`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      if (!line) {
        resolvePromise({
          ok: false,
          error:
            stderr.trim() ||
            `LFM runtime exited ${code ?? 'unknown'} with empty stdout`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(line) as {
          ok?: boolean;
          raw?: string;
          calls?: unknown[];
          error?: string;
        };
        if (!parsed.ok) {
          resolvePromise({
            ok: false,
            error: parsed.error ?? 'LFM runtime returned ok:false',
            raw: parsed.raw,
          });
          return;
        }
        resolvePromise({
          ok: true,
          raw: parsed.raw,
          calls: parsed.calls,
        });
      } catch {
        resolvePromise({
          ok: false,
          error: `LFM runtime returned non-JSON: ${line.slice(0, 200)}`,
        });
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

function deterministicFallbackProposal(
  structured?: LfmEvidenceInput['structuredFallback'],
): ToolCallProposal | null {
  if (!structured) return null;
  if (structured.filingStatusCandidate) {
    return {
      tool: 'set_filing_status_candidate',
      args: { status: structured.filingStatusCandidate },
    };
  }
  if (structured.incomeType && structured.args) {
    return proposeIncomeToolCall(structured.incomeType, structured.args);
  }
  return null;
}

/**
 * Spec path: ask LiquidAI/LFM2-1.2B-Tool (transformers) for a tool proposal.
 * Falls back to deterministic mapping only when the model file is absent or
 * the runtime fails — never invents tax amounts.
 */
export async function proposeToolCallWithLfm(
  evidence: LfmEvidenceInput,
  options?: {
    modelDir?: string;
    repoRoot?: string;
    pythonPath?: string;
    timeoutMs?: number;
    /** Force fallback (tests). */
    forceFallback?: boolean;
  },
): Promise<LfmProposeResult> {
  if (options?.forceFallback) {
    const proposal = deterministicFallbackProposal(evidence.structuredFallback);
    return {
      ok: Boolean(proposal),
      source: 'deterministic_fallback',
      proposal,
      fallbackReason: 'forced fallback (tests)',
      error: proposal ? undefined : 'No deterministic fallback proposal available',
    };
  }

  const modelDir = resolveLfmModelDir({
    modelDir: options?.modelDir,
    repoRoot: options?.repoRoot,
  });

  if (!modelDir) {
    // FALLBACK: model weights absent (CI / fresh clone without download).
    const proposal = deterministicFallbackProposal(evidence.structuredFallback);
    return {
      ok: Boolean(proposal),
      source: 'deterministic_fallback',
      proposal,
      fallbackReason: `LFM model directory missing for ${LFM_TOOL_MODEL_REPO_ID} (expected under models/ or HA_LFM_TOOL_MODEL_DIR)`,
      error: proposal
        ? undefined
        : `LFM model absent and no deterministic fallback proposal`,
    };
  }

  const scriptPath = lfmRuntimeScriptPath(options?.repoRoot);
  if (!existsSync(scriptPath)) {
    const proposal = deterministicFallbackProposal(evidence.structuredFallback);
    return {
      ok: Boolean(proposal),
      source: 'deterministic_fallback',
      proposal,
      fallbackReason: `LFM runtime script missing at ${scriptPath}`,
      error: proposal ? undefined : 'LFM runtime script missing',
    };
  }

  const runtime = await runPythonRuntime({
    modelDir,
    userMessage: evidence.userMessage,
    scriptPath,
    pythonPath: options?.pythonPath,
    timeoutMs: options?.timeoutMs,
  });

  if (!runtime.ok) {
    // FALLBACK: transformers runtime failed to load or run.
    const proposal = deterministicFallbackProposal(evidence.structuredFallback);
    return {
      ok: Boolean(proposal),
      source: 'deterministic_fallback',
      proposal,
      fallbackReason: runtime.error ?? 'LFM transformers runtime failed',
      raw: runtime.raw,
      error: proposal
        ? undefined
        : runtime.error ?? 'LFM runtime failed and no deterministic fallback',
    };
  }

  // Prefer structured calls from the Python runtime; re-parse raw as safety net.
  let proposal: ToolCallProposal | null = null;
  const rejected: string[] = [];

  if (Array.isArray(runtime.calls)) {
    for (const call of runtime.calls) {
      const parsed = parseToolCallJson(call);
      if (parsed.proposal) {
        proposal = parsed.proposal;
        break;
      }
      if (parsed.error?.startsWith('Unknown')) {
        const tool =
          call && typeof call === 'object' && 'tool' in call
            ? String((call as { tool?: unknown }).tool)
            : 'unknown';
        rejected.push(tool);
      }
    }
  }

  if (!proposal && runtime.raw) {
    const fromText = parseLfmToolCallText(runtime.raw);
    rejected.push(...fromText.rejected);
    proposal = fromText.proposals[0] ?? null;
  }

  if (!proposal) {
    const fallback = deterministicFallbackProposal(evidence.structuredFallback);
    return {
      ok: Boolean(fallback),
      source: 'deterministic_fallback',
      proposal: fallback,
      raw: runtime.raw,
      fallbackReason:
        rejected.length > 0
          ? `LFM proposed unknown tool(s): ${rejected.join(', ')}`
          : 'LFM produced no parseable allowed tool call',
      error: fallback
        ? undefined
        : rejected.length > 0
          ? `Unknown or unsupported tool: ${rejected[0]}`
          : 'LFM produced no tool call',
    };
  }

  return {
    ok: true,
    source: 'lfm',
    proposal,
    raw: runtime.raw,
  };
}

/**
 * ToolCaller that executes through the same validate → invokeTaxTool path.
 * Use `proposeToolCallWithLfm` first (spec path); `execute` never invents amounts.
 */
export function createLfmBackedToolCaller(): ToolCaller & {
  propose: typeof proposeToolCallWithLfm;
  modelRepoId: typeof LFM_TOOL_MODEL_REPO_ID;
  runtime: typeof LFM_TOOL_RUNTIME;
} {
  return {
    modelRepoId: LFM_TOOL_MODEL_REPO_ID,
    runtime: LFM_TOOL_RUNTIME,
    propose: proposeToolCallWithLfm,
    execute(input: ToolCallerExecuteInput): ToolCallerExecuteResult {
      return executeDeterministicToolCall(input);
    },
  };
}

export const lfmToolCaller = createLfmBackedToolCaller();
