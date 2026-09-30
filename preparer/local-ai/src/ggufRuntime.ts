/**
 * Minimal Q4_K_M GGUF invoke paths for work-order model roles.
 *
 * Loads catalog entries and optionally calls local-ai/scripts/gguf_invoke.py.
 * Does not build RAG corpus, e-file, or review queue — only load + invoke.
 * Missing GGUF never crashes; callers get ok:false.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HA_GGUF_RUNTIME,
  HA_QUANTIZATION,
  WORK_ORDER_MODELS,
  getWorkOrderModel,
  resolveQ4KmPath,
  type ModelRole,
  type WorkOrderModelRepoId,
} from './modelCatalog.js';

export interface GgufInvokeResult {
  ok: boolean;
  repoId: WorkOrderModelRepoId;
  role: ModelRole;
  runtime: typeof HA_GGUF_RUNTIME;
  quantization: typeof HA_QUANTIZATION;
  q4FileName: string | null;
  modelPath: string | null;
  text?: string;
  embedding?: number[];
  error?: string;
}

function repoRootFromThisModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../..');
}

export function ggufInvokeScriptPath(repoRoot?: string): string {
  const root = repoRoot ?? repoRootFromThisModule();
  return join(root, 'local-ai', 'scripts', 'gguf_invoke.py');
}

/**
 * Soft resolve for a work-order model's Q4_K_M file.
 * Returns null when unavailable — never throws.
 */
export function resolveWorkOrderQ4Km(
  repoId: WorkOrderModelRepoId,
  options?: { repoRoot?: string; modelPath?: string },
): { entry: ReturnType<typeof getWorkOrderModel>; path: string | null } {
  const entry = getWorkOrderModel(repoId);
  if (entry.availability === 'unavailable' || !entry.q4FileName) {
    return { entry, path: null };
  }
  return {
    entry,
    path: resolveQ4KmPath(entry, {
      repoRoot: options?.repoRoot,
      modelPath: options?.modelPath,
    }),
  };
}

async function runPythonInvoke(input: {
  scriptPath: string;
  modelPath: string;
  mode: 'generate' | 'embed' | 'smoke';
  prompt?: string;
  pythonPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; text?: string; embedding?: number[]; error?: string }> {
  const python = input.pythonPath ?? process.env.HA_PYTHON ?? 'python';
  const payload = JSON.stringify({
    model_path: input.modelPath,
    mode: input.mode,
    prompt: input.prompt ?? '',
    max_tokens: 64,
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
        error: `gguf invoke timed out after ${input.timeoutMs ?? 300_000}ms`,
      });
    }, input.timeoutMs ?? 300_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      if (!line) {
        resolvePromise({
          ok: false,
          error: stderr.trim() || 'gguf invoke empty stdout',
        });
        return;
      }
      try {
        const parsed = JSON.parse(line) as {
          ok?: boolean;
          text?: string;
          embedding?: number[];
          error?: string;
        };
        if (!parsed.ok) {
          resolvePromise({ ok: false, error: parsed.error ?? 'invoke failed' });
          return;
        }
        resolvePromise({
          ok: true,
          text: parsed.text,
          embedding: parsed.embedding,
        });
      } catch {
        resolvePromise({
          ok: false,
          error: `non-JSON: ${line.slice(0, 200)}`,
        });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * Minimal role invoke: OCR/explanation text generate, or embedding vector.
 * Missing GGUF → soft failure (ok:false), never throws.
 */
export async function invokeWorkOrderModel(
  repoId: WorkOrderModelRepoId,
  options?: {
    prompt?: string;
    repoRoot?: string;
    modelPath?: string;
    pythonPath?: string;
    timeoutMs?: number;
    /** Resolve only — do not spawn runtime (CI-safe). */
    resolveOnly?: boolean;
  },
): Promise<GgufInvokeResult> {
  const { entry, path } = resolveWorkOrderQ4Km(repoId, {
    repoRoot: options?.repoRoot,
    modelPath: options?.modelPath,
  });

  const base: GgufInvokeResult = {
    ok: false,
    repoId,
    role: entry.role,
    runtime: HA_GGUF_RUNTIME,
    quantization: HA_QUANTIZATION,
    q4FileName: entry.q4FileName,
    modelPath: path,
  };

  if (entry.availability === 'unavailable') {
    return {
      ...base,
      error: entry.unavailableReason ?? 'Q4_K_M unavailable',
    };
  }

  if (!entry.q4FileName) {
    return { ...base, error: 'No Q4_K_M filename configured' };
  }

  if (!path) {
    return {
      ...base,
      error: `Q4_K_M GGUF missing (loader requests ${entry.q4FileName})`,
    };
  }

  if (options?.resolveOnly) {
    return { ...base, ok: true };
  }

  const scriptPath = ggufInvokeScriptPath(options?.repoRoot);
  if (!existsSync(scriptPath)) {
    return { ...base, error: `gguf invoke script missing at ${scriptPath}` };
  }

  const mode =
    entry.role === 'embedding'
      ? 'embed'
      : entry.role === 'ocr' ||
          entry.role === 'tax_specialist' ||
          entry.role === 'tool_calling' ||
          entry.role === 'vlm_fallback'
        ? 'generate'
        : 'smoke';

  const runtime = await runPythonInvoke({
    scriptPath,
    modelPath: path,
    mode,
    prompt: options?.prompt ?? (mode === 'embed' ? 'tax embedding probe' : 'ok'),
    pythonPath: options?.pythonPath,
    timeoutMs: options?.timeoutMs,
  });

  if (!runtime.ok) {
    return { ...base, error: runtime.error };
  }

  return {
    ...base,
    ok: true,
    text: runtime.text,
    embedding: runtime.embedding,
  };
}

/** All catalog models that claim a Q4_K_M filename the loader would request. */
export function q4KmFilenamesRequested(): string[] {
  return WORK_ORDER_MODELS.map((m) => m.q4FileName).filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  );
}
