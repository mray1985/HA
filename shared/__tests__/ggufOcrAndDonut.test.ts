/**
 * Donut classifier + GGUF OCR cascade contracts (no weight download in CI).
 *
 * Missing model files must fall back without crashing.
 * Stubbed model results must still respect unknown vs zero / unclassified.
 */

import { describe, expect, it } from 'vitest';
import {
  classificationAllowsIncomeWrite,
  classifyDocument,
} from '../src/taxfacts/documentClassifier.js';
import {
  DONUT_CLASSIFIER_REPO_ID,
  DONUT_CLASSIFIER_RUNTIME,
  classifyDocumentPreferred,
  mapDonutLabelToFormType,
  resolveDonutModelDir,
} from '../src/taxfacts/donutClassifier.js';
import {
  OCR_GRANITE_Q4_K_M_FILENAME,
  OCR_LIGHTON_Q4_K_M_FILENAME,
  OCR_GGUF_RUNTIME,
  OCR_QUANTIZATION,
  resolveOcrModelPresence,
  runPreferredGgufOcr,
  selectOcrBackend,
} from '../src/taxfacts/ggufOcr.js';
import { ocrExtractorLabel } from '../src/taxfacts/documentOcr.js';
import { invokeTaxTool } from '../src/taxfacts/taxTools.js';

describe('Donut classifier contract (no weights required)', () => {
  it('records the work-order Donut repo and transformers runtime (not Q4_K_M GGUF)', () => {
    expect(DONUT_CLASSIFIER_REPO_ID).toBe('hsarfraz/donut-irs-tax-docs-classifier');
    expect(DONUT_CLASSIFIER_RUNTIME).toBe('transformers-donut');
  });

  it('maps known Donut labels and leaves unrecognized labels unmapped', () => {
    expect(mapDonutLabelToFormType('w2')).toEqual({
      formType: 'W-2',
      incomeType: 'w2',
    });
    expect(mapDonutLabelToFormType('1040')).toBeNull();
    expect(mapDonutLabelToFormType('other_misc')).toBeNull();
    expect(mapDonutLabelToFormType('letter')).toBeNull();
  });

  it('does not crash when Donut weights are missing — keyword fallback', async () => {
    const missing = resolveDonutModelDir({
      modelDir: 'C:\\definitely-missing-donut-model-dir-for-ci',
    });
    expect(missing).toBeNull();

    const result = await classifyDocumentPreferred(
      {
        text: 'Form W-2 Wage and Tax Statement Employer wages Federal income tax withheld Social security',
      },
      { modelDir: 'C:\\definitely-missing-donut-model-dir-for-ci' },
    );
    expect(result.source).toBe('text_markers');
    expect(result.classification.status).toBe('classified');
    if (result.classification.status !== 'classified') return;
    expect(result.classification.formType).toBe('W-2');
    expect(classificationAllowsIncomeWrite(result.classification)).toBe(true);
  });

  it('stubbed unrecognized Donut label stays unclassified (no income write)', async () => {
    const result = await classifyDocumentPreferred(
      { text: '' },
      { stubDonutLabel: { label: 'other_misc', score: 0.99 } },
    );
    expect(result.ok).toBe(false);
    expect(result.classification.status).toBe('unclassified');
    expect(result.classification.formType).toBeNull();
    expect(classificationAllowsIncomeWrite(result.classification)).toBe(false);
  });

  it('stubbed w2 Donut label classifies without inventing amounts', async () => {
    const result = await classifyDocumentPreferred(
      { text: '' },
      { stubDonutLabel: { label: 'w2', score: 0.9 } },
    );
    expect(result.source).toBe('donut_model');
    expect(result.classification.status).toBe('classified');
    if (result.classification.status !== 'classified') return;
    expect(result.classification.formType).toBe('W-2');
    expect(result.classification.source).toBe('donut_model');

    // Classification alone never invents wages — tax tools still need fields.
    const tool = invokeTaxTool({
      tool: 'add_w2',
      args: { employerName: 'Acme', wages: undefined, socialSecurityWages: 0 },
      context: {
        returnId: 'ret-donut',
        taxYear: 2026,
        sourceDocumentId: 'DOC-1',
        sourceFileName: 'w2.png',
        extractor: 'donut',
      },
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) return;
    expect(tool.fields.socialSecurityWages).toBe(0);
    expect(tool.fields).not.toHaveProperty('wages');
  });
});

describe('GGUF OCR cascade contract (no weights required)', () => {
  it('requests Q4_K_M filenames and llama-cpp-python runtime', () => {
    expect(OCR_GRANITE_Q4_K_M_FILENAME).toContain('Q4_K_M');
    expect(OCR_LIGHTON_Q4_K_M_FILENAME).toContain('Q4_K_M');
    expect(OCR_GGUF_RUNTIME).toBe('llama-cpp-python');
    expect(OCR_QUANTIZATION).toBe('Q4_K_M');
  });

  it('selects Granite → LightOn → Tesseract from presence flags', () => {
    expect(
      selectOcrBackend({ granitePresent: true, lightonPresent: true }),
    ).toBe('granite-docling');
    expect(
      selectOcrBackend({ granitePresent: false, lightonPresent: true }),
    ).toBe('lightonocr');
    expect(
      selectOcrBackend({ granitePresent: false, lightonPresent: false }),
    ).toBe('tesseract');
  });

  it('missing GGUFs soft-fail to Tesseract without crashing', async () => {
    const presence = resolveOcrModelPresence({
      granitePath: 'C:\\missing\\granite-docling-258M-Q4_K_M.gguf',
      lightonPath: 'C:\\missing\\LightOnOCR-2-1B-Q4_K_M.gguf',
    });
    expect(presence.granitePresent).toBe(false);
    expect(presence.lightonPresent).toBe(false);

    const result = await runPreferredGgufOcr({
      granitePath: 'C:\\missing\\granite-docling-258M-Q4_K_M.gguf',
      lightonPath: 'C:\\missing\\LightOnOCR-2-1B-Q4_K_M.gguf',
      resolveOnly: true,
    });
    expect(result.ok).toBe(false);
    expect(result.engine).toBe('tesseract');
    expect(result.fallbackReason).toMatch(/absent|Tesseract/i);
  });

  it('stamps model OCR provenance labels', () => {
    expect(ocrExtractorLabel(true, false, 'granite-docling')).toBe(
      'local-ocr-granite-docling',
    );
    expect(ocrExtractorLabel(true, false, 'lightonocr')).toBe(
      'local-ocr-lightonocr',
    );
    expect(ocrExtractorLabel(true, false, 'tesseract')).toBe('local-ocr');
  });

  it('empty OCR classification still blocks income; printed 0 stays 0', () => {
    const empty = classifyDocument({ text: '   ' });
    expect(empty.status).toBe('unclassified');
    expect(classificationAllowsIncomeWrite(empty)).toBe(false);

    const tool = invokeTaxTool({
      tool: 'add_w2',
      args: { employerName: 'Acme', socialSecurityWages: 0, wages: undefined },
      context: {
        returnId: 'ret-ocr',
        taxYear: 2026,
        sourceDocumentId: 'DOC-ocr',
        sourceFileName: 'scan.png',
        extractor: 'local-ocr-granite-docling',
      },
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) return;
    expect(tool.fields.socialSecurityWages).toBe(0);
    expect(tool.fields).not.toHaveProperty('wages');
  });
});
