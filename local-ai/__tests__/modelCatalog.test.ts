/**
 * Work-order model catalog + Q4_K_M GGUF resolve contract (no weight download).
 */

import { describe, expect, it } from 'vitest';
import {
  HA_GGUF_RUNTIME,
  HA_QUANTIZATION,
  WORK_ORDER_MODEL_REPO_IDS,
  WORK_ORDER_MODELS,
  getWorkOrderModel,
  listQ4KmStatus,
  resolveQ4KmPath,
} from '../src/modelCatalog.js';
import {
  invokeWorkOrderModel,
  q4KmFilenamesRequested,
  resolveWorkOrderQ4Km,
} from '../src/ggufRuntime.js';

describe('work-order Q4_K_M model catalog (no weights required)', () => {
  it('lists every work-order model id exactly once', () => {
    expect(WORK_ORDER_MODEL_REPO_IDS).toEqual([
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
    ]);
    expect(WORK_ORDER_MODELS).toHaveLength(WORK_ORDER_MODEL_REPO_IDS.length);
    expect(new Set(WORK_ORDER_MODELS.map((m) => m.repoId)).size).toBe(
      WORK_ORDER_MODEL_REPO_IDS.length,
    );
  });

  it('policy quantization and runtime are Q4_K_M / llama-cpp-python', () => {
    expect(HA_QUANTIZATION).toBe('Q4_K_M');
    expect(HA_GGUF_RUNTIME).toBe('llama-cpp-python');
  });

  it('LFM loader entry requests the official Q4_K_M filename', () => {
    const lfm = getWorkOrderModel('LiquidAI/LFM2-1.2B-Tool');
    expect(lfm.ggufRepoId).toBe('LiquidAI/LFM2-1.2B-Tool-GGUF');
    expect(lfm.q4FileName).toBe('LFM2-1.2B-Tool-Q4_K_M.gguf');
    expect(lfm.q4FileName).toContain('Q4_K_M');
  });

  it('every configured q4 filename contains Q4_K_M', () => {
    for (const name of q4KmFilenamesRequested()) {
      expect(name.toUpperCase().replace(/-/g, '_')).toContain('Q4_K_M');
    }
  });

  it('missing GGUF resolve does not crash', () => {
    const status = listQ4KmStatus('C:\\definitely-no-ha-models-root');
    expect(status.length).toBe(WORK_ORDER_MODELS.length);
    for (const row of status) {
      expect(row.present).toBe(false);
      expect(row.localPath).toBeNull();
    }
    const path = resolveQ4KmPath(getWorkOrderModel('LiquidAI/LFM2-1.2B-Tool'), {
      modelPath: 'C:\\missing\\LFM2-1.2B-Tool-Q4_K_M.gguf',
    });
    expect(path).toBeNull();
  });

  it('invoke soft-fails when GGUF missing (no throw)', async () => {
    const result = await invokeWorkOrderModel('LiquidAI/LFM2-1.2B-Tool', {
      modelPath: 'C:\\missing\\LFM2-1.2B-Tool-Q4_K_M.gguf',
      resolveOnly: true,
    });
    expect(result.ok).toBe(false);
    expect(result.q4FileName).toBe('LFM2-1.2B-Tool-Q4_K_M.gguf');
    expect(result.error).toMatch(/missing|Q4_K_M/i);

    const unavailable = resolveWorkOrderQ4Km(
      'hsarfraz/donut-irs-tax-docs-classifier',
    );
    expect(unavailable.path).toBeNull();
    expect(unavailable.entry.availability).toBe('unavailable');
  });
});
