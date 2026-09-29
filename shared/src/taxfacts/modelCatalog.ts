/**
 * Work-order model stack (§3–§7) with Q4_K_M GGUF policy.
 *
 * Every named Hugging Face repo id from the work order is listed here.
 * Quantization for every model is GGUF Q4_K_M. Official Hub Q4_K_M is
 * preferred; otherwise the project's official GGUF repo; otherwise local
 * llama.cpp quantize from base/F16/Q8 weights when available. Models with
 * no Q4_K_M path are recorded as unavailable — never silently kept as BF16.
 *
 * This module does not download weights (CI must stay offline for models).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact work-order Hugging Face repo ids (no extras, no drops). */
export const WORK_ORDER_MODEL_REPO_IDS = [
  'hsarfraz/donut-irs-tax-docs-classifier',
  'ibm-granite/granite-docling-258M',
  'lightonai/LightOnOCR-2-1B',
  'PaddlePaddle/PaddleOCR-VL-1.6',
  'Qwen/Qwen3.5-2B',
  'Qwen/Qwen3.5-4B',
  'LiquidAI/LFM2-1.2B-Tool',
  'google/functiongemma-270m-it',
  'ibm-granite/granite-3.2-2b-instruct',
  'dennisonb/qwen25-tax-3b',
  'nomic-ai/nomic-embed-text-v1.5',
  'Qwen/Qwen3-Embedding-0.6B',
  'BAAI/bge-m3',
] as const;

export type WorkOrderModelRepoId = (typeof WORK_ORDER_MODEL_REPO_IDS)[number];

export type ModelRole =
  | 'classifier'
  | 'ocr'
  | 'tool_calling'
  | 'tax_specialist'
  | 'embedding'
  | 'vlm_fallback';

/** Policy quantization for every work-order model. */
export const HA_QUANTIZATION = 'Q4_K_M' as const;

/** Runtime used for Q4_K_M GGUF weights on this stack. */
export const HA_GGUF_RUNTIME = 'llama-cpp-python' as const;

export type Q4Availability =
  | 'downloaded'
  | 'published'
  | 'local_quantize'
  | 'unavailable';

export interface WorkOrderModelEntry {
  /** Exact work-order model id. */
  repoId: WorkOrderModelRepoId;
  role: ModelRole;
  /** Hub repo that publishes (or will hold) the Q4_K_M GGUF. */
  ggufRepoId: string | null;
  /** Exact Q4_K_M filename the loader requests. */
  q4FileName: string | null;
  /** Relative directory under repo `models/` for the GGUF file. */
  localRelativeDir: string | null;
  availability: Q4Availability;
  /** Why Q4_K_M is missing when availability is unavailable. */
  unavailableReason?: string;
  /** Source used when Q4_K_M was obtained by local quantize. */
  quantizeSourceFile?: string;
}

/**
 * Catalog: one entry per work-order model id.
 * `q4FileName` is what resolvers request — never a BF16/safetensors path.
 */
export const WORK_ORDER_MODELS: readonly WorkOrderModelEntry[] = [
  {
    repoId: 'hsarfraz/donut-irs-tax-docs-classifier',
    role: 'classifier',
    ggufRepoId: null,
    q4FileName: null,
    localRelativeDir: null,
    availability: 'unavailable',
    unavailableReason:
      'No official GGUF or Q4_K_M published; Donut vision classifier is not a llama.cpp text GGUF target',
  },
  {
    repoId: 'ibm-granite/granite-docling-258M',
    role: 'ocr',
    ggufRepoId: 'ibm-granite/granite-docling-258M-GGUF',
    q4FileName: 'granite-docling-258M-Q4_K_M.gguf',
    localRelativeDir: join('models', 'ibm-granite', 'granite-docling-258M-GGUF'),
    availability: 'local_quantize',
    quantizeSourceFile: 'granite-docling-258M-BF16.gguf',
  },
  {
    repoId: 'lightonai/LightOnOCR-2-1B',
    role: 'ocr',
    ggufRepoId: 'ggml-org/LightOnOCR-2-1B-GGUF',
    q4FileName: 'LightOnOCR-2-1B-Q4_K_M.gguf',
    localRelativeDir: join('models', 'ggml-org', 'LightOnOCR-2-1B-GGUF'),
    availability: 'local_quantize',
    quantizeSourceFile: 'LightOnOCR-2-1B-f16.gguf',
  },
  {
    repoId: 'PaddlePaddle/PaddleOCR-VL-1.6',
    role: 'ocr',
    ggufRepoId: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF',
    q4FileName: null,
    localRelativeDir: join('models', 'PaddlePaddle', 'PaddleOCR-VL-1.6-GGUF'),
    availability: 'unavailable',
    unavailableReason:
      'Official GGUF repo ships PaddleOCR-VL-1.6-GGUF.gguf without a Q4_K_M filename; type not confirmed as Q4_K_M',
  },
  {
    repoId: 'Qwen/Qwen3.5-2B',
    role: 'vlm_fallback',
    ggufRepoId: null,
    q4FileName: 'Qwen3.5-2B-Q4_K_M.gguf',
    localRelativeDir: join('models', 'Qwen', 'Qwen3.5-2B-GGUF'),
    availability: 'unavailable',
    unavailableReason:
      'No official Qwen org GGUF repo; community Q4_K_M exists but was not substituted; local convert+quantize not run',
  },
  {
    repoId: 'Qwen/Qwen3.5-4B',
    role: 'vlm_fallback',
    ggufRepoId: null,
    q4FileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    localRelativeDir: join('models', 'Qwen', 'Qwen3.5-4B-GGUF'),
    availability: 'unavailable',
    unavailableReason:
      'No official Qwen org GGUF repo; community Q4_K_M exists but was not substituted; local convert+quantize not run',
  },
  {
    repoId: 'LiquidAI/LFM2-1.2B-Tool',
    role: 'tool_calling',
    ggufRepoId: 'LiquidAI/LFM2-1.2B-Tool-GGUF',
    q4FileName: 'LFM2-1.2B-Tool-Q4_K_M.gguf',
    localRelativeDir: join('models', 'LiquidAI', 'LFM2-1.2B-Tool-GGUF'),
    availability: 'published',
  },
  {
    repoId: 'google/functiongemma-270m-it',
    role: 'tool_calling',
    ggufRepoId: 'ggml-org/functiongemma-270m-it-GGUF',
    q4FileName: 'functiongemma-270m-it-Q4_K_M.gguf',
    localRelativeDir: join('models', 'ggml-org', 'functiongemma-270m-it-GGUF'),
    availability: 'local_quantize',
    quantizeSourceFile: 'functiongemma-270m-it-bf16.gguf',
  },
  {
    repoId: 'ibm-granite/granite-3.2-2b-instruct',
    role: 'tool_calling',
    ggufRepoId: 'ibm-research/granite-3.2-2b-instruct-GGUF',
    q4FileName: 'granite-3.2-2b-instruct-Q4_K_M.gguf',
    localRelativeDir: join(
      'models',
      'ibm-research',
      'granite-3.2-2b-instruct-GGUF',
    ),
    availability: 'published',
  },
  {
    repoId: 'dennisonb/qwen25-tax-3b',
    role: 'tax_specialist',
    ggufRepoId: 'dennisonb/qwen25-tax-3b-GGUF',
    q4FileName: 'qwen25-tax-3b-Q4_K_M.gguf',
    localRelativeDir: join('models', 'dennisonb', 'qwen25-tax-3b-GGUF'),
    availability: 'local_quantize',
    quantizeSourceFile: 'qwen25-tax-3b-q8_0.gguf',
  },
  {
    repoId: 'nomic-ai/nomic-embed-text-v1.5',
    role: 'embedding',
    ggufRepoId: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
    q4FileName: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    localRelativeDir: join('models', 'nomic-ai', 'nomic-embed-text-v1.5-GGUF'),
    availability: 'published',
  },
  {
    repoId: 'Qwen/Qwen3-Embedding-0.6B',
    role: 'embedding',
    ggufRepoId: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    q4FileName: 'Qwen3-Embedding-0.6B-Q4_K_M.gguf',
    localRelativeDir: join('models', 'Qwen', 'Qwen3-Embedding-0.6B-GGUF'),
    availability: 'local_quantize',
    quantizeSourceFile: 'Qwen3-Embedding-0.6B-f16.gguf',
  },
  {
    repoId: 'BAAI/bge-m3',
    role: 'embedding',
    ggufRepoId: null,
    q4FileName: 'bge-m3-Q4_K_M.gguf',
    localRelativeDir: join('models', 'BAAI', 'bge-m3-GGUF'),
    availability: 'unavailable',
    unavailableReason:
      'No official BAAI GGUF repo; third-party Q4_K_M not substituted; local convert+quantize not run',
  },
] as const;

function repoRootFromThisModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..');
}

/** Absolute path the loader requests for a catalog entry's Q4_K_M file. */
export function resolveQ4KmPath(
  entry: WorkOrderModelEntry,
  options?: { repoRoot?: string; modelPath?: string },
): string | null {
  if (options?.modelPath !== undefined) {
    const abs = resolve(options.modelPath);
    return existsSync(abs) ? abs : null;
  }
  if (!entry.q4FileName || !entry.localRelativeDir) return null;
  const root = options?.repoRoot ?? repoRootFromThisModule();
  const abs = resolve(root, entry.localRelativeDir, entry.q4FileName);
  return existsSync(abs) ? abs : null;
}

export function getWorkOrderModel(
  repoId: WorkOrderModelRepoId,
): WorkOrderModelEntry {
  const found = WORK_ORDER_MODELS.find((m) => m.repoId === repoId);
  if (!found) {
    throw new Error(`Unknown work-order model: ${repoId}`);
  }
  return found;
}

/** Snapshot of Q4_K_M status for tests / ModelManager stubs. */
export function listQ4KmStatus(repoRoot?: string): Array<{
  repoId: WorkOrderModelRepoId;
  role: ModelRole;
  q4FileName: string | null;
  ggufRepoId: string | null;
  availability: Q4Availability;
  localPath: string | null;
  present: boolean;
  unavailableReason?: string;
}> {
  return WORK_ORDER_MODELS.map((entry) => {
    const localPath = resolveQ4KmPath(entry, { repoRoot });
    return {
      repoId: entry.repoId,
      role: entry.role,
      q4FileName: entry.q4FileName,
      ggufRepoId: entry.ggufRepoId,
      availability: entry.availability,
      localPath,
      present: localPath !== null,
      unavailableReason: entry.unavailableReason,
    };
  });
}
