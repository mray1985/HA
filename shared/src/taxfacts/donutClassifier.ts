/**
 * Donut document classifier path (work-order step 4 / HA-AI-013).
 *
 * Spec model (exact HF repo id): hsarfraz/donut-irs-tax-docs-classifier
 *
 * Q4_K_M does not exist for this Donut vision architecture — no official
 * GGUF is published. Do not invent or substitute a community GGUF.
 * Runtime: native transformers / DonutSwin (scripts/donut_classify.py).
 *
 * When local Donut weights are present, the model proposes a form label.
 * Keyword markers in documentClassifier.ts remain the FALLBACK when the
 * model dir / safetensors are absent or the runtime fails.
 *
 * Unrecognized Donut labels stay unclassified and must not write income.
 * The model must not calculate tax.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDocument,
  type ClassifiableFormType,
  type ClassificationConfidence,
  type ClassifiedIncomeType,
  type ClassifyDocumentInput,
  type DocumentClassification,
} from './documentClassifier.js';

/** Exact Hugging Face repo id from the work order. */
export const DONUT_CLASSIFIER_REPO_ID =
  'hsarfraz/donut-irs-tax-docs-classifier' as const;

/**
 * Local gitignored directory for official Hub weights (safetensors).
 * Q4_K_M GGUF does not exist for this architecture.
 */
export const DONUT_CLASSIFIER_RELATIVE_DIR = join(
  'models',
  'hsarfraz',
  'donut-irs-tax-docs-classifier',
);

/** Native vision runtime (not llama.cpp). */
export const DONUT_CLASSIFIER_RUNTIME = 'transformers-donut' as const;

export type DonutClassifySource = 'donut_model' | 'text_markers' | 'importer_markers' | 'none';

export interface DonutClassifyResult {
  ok: boolean;
  source: DonutClassifySource;
  classification: DocumentClassification;
  /** Raw Donut label when the model path ran. */
  rawLabel?: string;
  score?: number;
  modelDir?: string | null;
  error?: string;
  fallbackReason?: string;
}

function repoRootFromThisModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..');
}

export function donutClassifyScriptPath(repoRoot?: string): string {
  const root = repoRoot ?? repoRootFromThisModule();
  return join(root, 'scripts', 'donut_classify.py');
}

/**
 * Soft-resolve local Donut weights directory.
 * Requires model.safetensors — never throws; returns null when absent (CI).
 */
export function resolveDonutModelDir(options?: {
  modelDir?: string;
  repoRoot?: string;
}): string | null {
  if (options?.modelDir !== undefined) {
    const abs = resolve(options.modelDir);
    if (existsSync(join(abs, 'model.safetensors'))) return abs;
    return null;
  }

  const envDir = process.env.HA_DONUT_MODEL_DIR?.trim();
  const candidates = [
    envDir,
    options?.repoRoot
      ? join(options.repoRoot, DONUT_CLASSIFIER_RELATIVE_DIR)
      : undefined,
    join(repoRootFromThisModule(), DONUT_CLASSIFIER_RELATIVE_DIR),
    join(process.cwd(), DONUT_CLASSIFIER_RELATIVE_DIR),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const dir of candidates) {
    const abs = resolve(dir);
    if (existsSync(join(abs, 'model.safetensors'))) return abs;
  }
  return null;
}

/**
 * Map a Donut id2label string onto our classifiable form types.
 * Unknown / schedule / 1040 labels → null (do not guess a form type).
 */
export function mapDonutLabelToFormType(
  label: string | null | undefined,
): {
  formType: ClassifiableFormType;
  incomeType: ClassifiedIncomeType;
} | null {
  if (!label) return null;
  const key = label.trim().toLowerCase().replace(/\s+/g, '_');

  const table: Record<
    string,
    { formType: ClassifiableFormType; incomeType: ClassifiedIncomeType }
  > = {
    w2: { formType: 'W-2', incomeType: 'w2' },
    w_2: { formType: 'W-2', incomeType: 'w2' },
    'form_w-2': { formType: 'W-2', incomeType: 'w2' },
    'form_w2': { formType: 'W-2', incomeType: 'w2' },
  };

  return table[key] ?? null;
}

function confidenceFromScore(score: number | undefined): ClassificationConfidence {
  if (score === undefined || Number.isNaN(score)) return 'low';
  if (score >= 0.85) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

async function runDonutScript(input: {
  scriptPath: string;
  modelDir: string;
  imagePath: string;
  pythonPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; label?: string; score?: number; error?: string }> {
  const python = input.pythonPath ?? process.env.HA_PYTHON ?? 'python';
  const payload = JSON.stringify({
    model_dir: input.modelDir,
    image_path: input.imagePath,
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
        error: `Donut classify timed out after ${input.timeoutMs ?? 600_000}ms`,
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
          error: stderr.trim() || 'Donut classify empty stdout',
        });
        return;
      }
      try {
        const parsed = JSON.parse(line) as {
          ok?: boolean;
          label?: string;
          score?: number;
          error?: string;
        };
        if (!parsed.ok) {
          resolvePromise({ ok: false, error: parsed.error ?? 'Donut failed' });
          return;
        }
        resolvePromise({
          ok: true,
          label: parsed.label,
          score: parsed.score,
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

function unclassifiedFromDonut(
  reason: string,
  rawLabel?: string,
): DocumentClassification {
  return {
    status: 'unclassified',
    formType: null,
    incomeType: null,
    confidence: 'low',
    reason,
    matchedMarkers: rawLabel ? [rawLabel] : [],
    source: 'none',
  };
}

/**
 * Prefer Donut when local weights + image exist; otherwise keyword markers.
 * Stubbed / unrecognized Donut labels stay unclassified (no income write).
 */
export async function classifyDocumentPreferred(
  input: ClassifyDocumentInput & {
    /** Local image for Donut. Without it, keyword markers run immediately. */
    imagePath?: string | null;
  },
  options?: {
    modelDir?: string;
    repoRoot?: string;
    pythonPath?: string;
    timeoutMs?: number;
    /** Force keyword fallback (tests). */
    forceKeywordFallback?: boolean;
    /**
     * Inject a Donut label without spawning (tests).
     * Unrecognized → unclassified; never invents income.
     */
    stubDonutLabel?: { label: string; score?: number };
  },
): Promise<DonutClassifyResult> {
  const keywordFallback = (): DonutClassifyResult => {
    const classification = classifyDocument(input);
    return {
      ok: classification.status === 'classified',
      source:
        classification.source === 'none'
          ? 'none'
          : classification.source === 'importer_markers'
            ? 'importer_markers'
            : 'text_markers',
      classification,
      modelDir: null,
      fallbackReason: 'keyword marker fallback',
    };
  };

  if (options?.forceKeywordFallback) {
    return {
      ...keywordFallback(),
      fallbackReason: 'forced keyword fallback (tests)',
    };
  }

  if (options?.stubDonutLabel) {
    const mapped = mapDonutLabelToFormType(options.stubDonutLabel.label);
    if (!mapped) {
      return {
        ok: false,
        source: 'none',
        classification: unclassifiedFromDonut(
          `Donut proposed unrecognized label "${options.stubDonutLabel.label}"; type left unclassified.`,
          options.stubDonutLabel.label,
        ),
        rawLabel: options.stubDonutLabel.label,
        score: options.stubDonutLabel.score,
        modelDir: options.modelDir ?? null,
      };
    }
    const confidence = confidenceFromScore(options.stubDonutLabel.score);
    return {
      ok: true,
      source: 'donut_model',
      rawLabel: options.stubDonutLabel.label,
      score: options.stubDonutLabel.score,
      modelDir: options.modelDir ?? null,
      classification: {
        status: 'classified',
        formType: mapped.formType,
        incomeType: mapped.incomeType,
        confidence,
        reason: `Donut classifier proposed "${options.stubDonutLabel.label}" → ${mapped.formType}.`,
        matchedMarkers: [options.stubDonutLabel.label],
        source: 'donut_model',
      },
    };
  }

  const modelDir = resolveDonutModelDir({
    modelDir: options?.modelDir,
    repoRoot: options?.repoRoot,
  });

  if (!modelDir) {
    const fb = keywordFallback();
    return {
      ...fb,
      fallbackReason: `Donut weights absent for ${DONUT_CLASSIFIER_REPO_ID} (expected model.safetensors under ${DONUT_CLASSIFIER_RELATIVE_DIR})`,
    };
  }

  const imagePath =
    typeof input.imagePath === 'string' && input.imagePath.trim()
      ? input.imagePath.trim()
      : null;

  if (!imagePath) {
    const fb = keywordFallback();
    return {
      ...fb,
      modelDir,
      fallbackReason: 'Donut weights present but no imagePath — keyword fallback',
    };
  }

  const scriptPath = donutClassifyScriptPath(options?.repoRoot);
  if (!existsSync(scriptPath)) {
    const fb = keywordFallback();
    return {
      ...fb,
      modelDir,
      fallbackReason: `Donut script missing at ${scriptPath}`,
    };
  }

  const runtime = await runDonutScript({
    scriptPath,
    modelDir,
    imagePath,
    pythonPath: options?.pythonPath,
    timeoutMs: options?.timeoutMs,
  });

  if (!runtime.ok || !runtime.label) {
    const fb = keywordFallback();
    return {
      ...fb,
      modelDir,
      fallbackReason: runtime.error ?? 'Donut runtime failed',
      error: runtime.error,
    };
  }

  const mapped = mapDonutLabelToFormType(runtime.label);
  if (!mapped) {
    return {
      ok: false,
      source: 'none',
      classification: unclassifiedFromDonut(
        `Donut proposed unrecognized label "${runtime.label}"; type left unclassified.`,
        runtime.label,
      ),
      rawLabel: runtime.label,
      score: runtime.score,
      modelDir,
    };
  }

  // Conflict with importer label → do not guess.
  const detected =
    typeof input.detectedFormType === 'string' && input.detectedFormType.trim()
      ? input.detectedFormType.trim()
      : null;
  if (detected && detected !== mapped.formType) {
    return {
      ok: false,
      source: 'none',
      classification: unclassifiedFromDonut(
        `Donut proposed ${mapped.formType} but importer reported ${detected}; type left unclassified.`,
        runtime.label,
      ),
      rawLabel: runtime.label,
      score: runtime.score,
      modelDir,
    };
  }

  return {
    ok: true,
    source: 'donut_model',
    rawLabel: runtime.label,
    score: runtime.score,
    modelDir,
    classification: {
      status: 'classified',
      formType: mapped.formType,
      incomeType: mapped.incomeType,
      confidence: confidenceFromScore(runtime.score),
      reason: `Donut classifier proposed "${runtime.label}" → ${mapped.formType}.`,
      matchedMarkers: [runtime.label],
      source: 'donut_model',
    },
  };
}
