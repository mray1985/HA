/**
 * Preferred OCR path (work-order OCR models / HA-AI-014).
 *
 * Spec models:
 *   Tier 1: ibm-granite/granite-docling-258M  → granite-docling-258M-Q4_K_M.gguf
 *   Tier 2: lightonai/LightOnOCR-2-1B        → LightOnOCR-2-1B-Q4_K_M.gguf
 * Runtime: llama-cpp-python (same as LFM / gguf_invoke).
 *
 * Cascade: Granite Docling Q4_K_M → LightOnOCR Q4_K_M → soft fail
 * (callers then use Tesseract). Missing GGUF never crashes.
 *
 * The model only proposes text. Tax tools / validation still decide writes.
 * Empty OCR text stays unclassified and must not become zero.
 *
 * Node-only (spawn + fs). Import from this path in Node/tests — do not
 * barrel-export for the Vite client (same rule as lfmToolCaller).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  selectOcrBackend,
  type OcrBackend,
} from './documentOcr.js';
import {
  HA_GGUF_RUNTIME,
  HA_QUANTIZATION,
  getWorkOrderModel,
  resolveQ4KmPath,
} from './modelCatalog.js';

export type { OcrBackend };
export { selectOcrBackend };

export const OCR_GRANITE_REPO_ID = 'ibm-granite/granite-docling-258M' as const;
export const OCR_LIGHTON_REPO_ID = 'lightonai/LightOnOCR-2-1B' as const;

export const OCR_GRANITE_Q4_K_M_FILENAME = 'granite-docling-258M-Q4_K_M.gguf' as const;
export const OCR_LIGHTON_Q4_K_M_FILENAME = 'LightOnOCR-2-1B-Q4_K_M.gguf' as const;

export const OCR_GGUF_RUNTIME = HA_GGUF_RUNTIME;
export const OCR_QUANTIZATION = HA_QUANTIZATION;

export type OcrModelEngine = 'granite-docling' | 'lightonocr';

export interface OcrModelPresence {
  granitePresent: boolean;
  lightonPresent: boolean;
  granitePath: string | null;
  lightonPath: string | null;
}

export interface GgufOcrResult {
  ok: boolean;
  engine: OcrBackend;
  runtime: typeof HA_GGUF_RUNTIME | 'tesseract' | null;
  quantization: typeof HA_QUANTIZATION | null;
  modelPath: string | null;
  text?: string;
  error?: string;
  /** Why a lower tier / Tesseract should run. */
  fallbackReason?: string;
}

function repoRootFromThisModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../..');
}

export function ggufOcrScriptPath(repoRoot?: string): string {
  const root = repoRoot ?? repoRootFromThisModule();
  return join(root, 'local-ai', 'scripts', 'gguf_ocr.py');
}

/**
 * Soft-resolve local Q4_K_M OCR GGUFs. Missing files → null paths, never throws.
 */
export function resolveOcrModelPresence(options?: {
  repoRoot?: string;
  granitePath?: string;
  lightonPath?: string;
}): OcrModelPresence {
  const graniteEntry = getWorkOrderModel(OCR_GRANITE_REPO_ID);
  const lightonEntry = getWorkOrderModel(OCR_LIGHTON_REPO_ID);

  const granitePath =
    options?.granitePath !== undefined
      ? existsSync(resolve(options.granitePath))
        ? resolve(options.granitePath)
        : null
      : resolveQ4KmPath(graniteEntry, { repoRoot: options?.repoRoot });

  const lightonPath =
    options?.lightonPath !== undefined
      ? existsSync(resolve(options.lightonPath))
        ? resolve(options.lightonPath)
        : null
      : resolveQ4KmPath(lightonEntry, { repoRoot: options?.repoRoot });

  return {
    granitePresent: granitePath !== null,
    lightonPresent: lightonPath !== null,
    granitePath,
    lightonPath,
  };
}

async function runGgufOcrScript(input: {
  scriptPath: string;
  modelPath: string;
  imagePath?: string;
  prompt?: string;
  pythonPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const python = input.pythonPath ?? process.env.HA_PYTHON ?? 'python';
  const payload = JSON.stringify({
    model_path: input.modelPath,
    image_path: input.imagePath ?? '',
    prompt:
      input.prompt ??
      'Extract all readable text from this tax document. Output plain text only.',
    max_tokens: 512,
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
        error: `OCR GGUF invoke timed out after ${input.timeoutMs ?? 600_000}ms`,
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
      resolvePromise({ ok: false, error: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      if (!line) {
        resolvePromise({
          ok: false,
          error: stderr.trim() || 'OCR GGUF invoke empty stdout',
        });
        return;
      }
      try {
        const parsed = JSON.parse(line) as {
          ok?: boolean;
          text?: string;
          error?: string;
        };
        if (!parsed.ok) {
          resolvePromise({ ok: false, error: parsed.error ?? 'ocr failed' });
          return;
        }
        resolvePromise({ ok: true, text: parsed.text ?? '' });
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
 * Run preferred OCR: Granite Docling Q4_K_M, then LightOnOCR Q4_K_M.
 * Soft-fails with engine 'tesseract' when both GGUFs / runtime are unavailable
 * so callers can fall through to Tesseract without crashing.
 */
export async function runPreferredGgufOcr(options?: {
  imagePath?: string;
  prompt?: string;
  repoRoot?: string;
  granitePath?: string;
  lightonPath?: string;
  pythonPath?: string;
  timeoutMs?: number;
  /** Resolve only — do not spawn (CI-safe). */
  resolveOnly?: boolean;
}): Promise<GgufOcrResult> {
  const presence = resolveOcrModelPresence({
    repoRoot: options?.repoRoot,
    granitePath: options?.granitePath,
    lightonPath: options?.lightonPath,
  });
  const backend = selectOcrBackend(presence);

  if (backend === 'tesseract') {
    return {
      ok: false,
      engine: 'tesseract',
      runtime: 'tesseract',
      quantization: null,
      modelPath: null,
      fallbackReason:
        'Granite Docling and LightOnOCR Q4_K_M GGUFs absent — use Tesseract fallback',
      error: 'OCR Q4_K_M GGUFs missing',
    };
  }

  const tiers: Array<{
    engine: OcrModelEngine;
    path: string;
  }> = [];
  if (presence.granitePath) {
    tiers.push({ engine: 'granite-docling', path: presence.granitePath });
  }
  if (presence.lightonPath) {
    tiers.push({ engine: 'lightonocr', path: presence.lightonPath });
  }

  if (options?.resolveOnly) {
    const first = tiers[0]!;
    return {
      ok: true,
      engine: first.engine,
      runtime: OCR_GGUF_RUNTIME,
      quantization: OCR_QUANTIZATION,
      modelPath: first.path,
    };
  }

  const scriptPath = ggufOcrScriptPath(options?.repoRoot);
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      engine: 'tesseract',
      runtime: 'tesseract',
      quantization: null,
      modelPath: null,
      fallbackReason: `OCR script missing at ${scriptPath}`,
      error: 'gguf_ocr.py missing',
    };
  }

  const errors: string[] = [];
  for (const tier of tiers) {
    const runtime = await runGgufOcrScript({
      scriptPath,
      modelPath: tier.path,
      imagePath: options?.imagePath,
      prompt: options?.prompt,
      pythonPath: options?.pythonPath,
      timeoutMs: options?.timeoutMs,
    });
    if (runtime.ok) {
      return {
        ok: true,
        engine: tier.engine,
        runtime: OCR_GGUF_RUNTIME,
        quantization: OCR_QUANTIZATION,
        modelPath: tier.path,
        text: runtime.text ?? '',
      };
    }
    errors.push(`${tier.engine}: ${runtime.error ?? 'failed'}`);
  }

  return {
    ok: false,
    engine: 'tesseract',
    runtime: 'tesseract',
    quantization: null,
    modelPath: null,
    fallbackReason: errors.join('; ') || 'OCR GGUF runtime failed',
    error: errors.join('; ') || 'OCR GGUF runtime failed',
  };
}
