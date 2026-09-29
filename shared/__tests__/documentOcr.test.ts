import { describe, expect, it } from 'vitest';
import {
  classificationAllowsIncomeWrite,
  classifyDocument,
} from '../src/taxfacts/documentClassifier.js';
import {
  classificationInputFromOcr,
  isEmptyOcrText,
  ocrExtractorLabel,
  ocrSourceConfidence,
  selectDocumentExtractKind,
  selectOcrBackend,
} from '../src/taxfacts/documentOcr.js';
import { invokeTaxTool } from '../src/taxfacts/taxTools.js';

describe('document OCR bridge (work-order step 5)', () => {
  it('keeps OCR source confidence low and never upgrades it', () => {
    expect(ocrSourceConfidence({ ocrUsed: true, confidence: 'low' })).toBe('low');
    expect(ocrSourceConfidence({ ocrUsed: true, confidence: null })).toBe('low');
    expect(ocrSourceConfidence({ ocrUsed: true, confidence: 'high' })).toBe('low');
    expect(ocrSourceConfidence({ ocrUsed: false, confidence: 'high' })).toBe('high');
    expect(ocrSourceConfidence({ ocrUsed: false })).toBeNull();
  });

  it('classifies scanned OCR text with markers and keeps low confidence', () => {
    const bridge = classificationInputFromOcr({
      text: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
      ocrUsed: true,
      confidence: 'low',
      detectedFormType: 'W-2',
      matchedMarkers: ['wage and tax statement', 'employer', 'wages'],
    });

    expect(bridge.ocrUsed).toBe(true);
    expect(bridge.emptyOcrText).toBe(false);
    expect(bridge.classifyInput.detectedConfidence).toBe('low');

    const result = classifyDocument(bridge.classifyInput);
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('W-2');
    expect(result.confidence).toBe('low');
    expect(classificationAllowsIncomeWrite(result)).toBe(true);
  });

  it('leaves empty OCR text unclassified and does not allow income writes', () => {
    expect(isEmptyOcrText('')).toBe(true);
    expect(isEmptyOcrText('   ')).toBe(true);
    expect(isEmptyOcrText(null)).toBe(true);

    const bridge = classificationInputFromOcr({
      text: '   ',
      ocrUsed: true,
      // A stale form label must not invent a type when OCR text is empty.
      detectedFormType: 'W-2',
      matchedMarkers: ['wage and tax statement'],
      confidence: 'low',
    });

    expect(bridge.emptyOcrText).toBe(true);
    expect(bridge.classifyInput.detectedFormType).toBeNull();
    expect(bridge.classifyInput.matchedMarkers).toEqual([]);

    const result = classifyDocument(bridge.classifyInput);
    expect(result.status).toBe('unclassified');
    expect(classificationAllowsIncomeWrite(result)).toBe(false);
  });

  it('keeps markers when OCR was used but per-piece text is missing (not blank)', () => {
    // Multi-form additionalResults historically omitted rawOCRText while still
    // setting ocrUsed + form markers. Missing text must not wipe that evidence.
    const bridge = classificationInputFromOcr({
      text: null,
      ocrUsed: true,
      confidence: 'low',
      detectedFormType: '1099-INT',
      matchedMarkers: ['1099-int', 'interest income', 'payer', 'interest'],
    });

    expect(bridge.emptyOcrText).toBe(false);
    expect(bridge.classifyInput.detectedFormType).toBe('1099-INT');
    expect(bridge.classifyInput.matchedMarkers).toEqual([
      '1099-int',
      'interest income',
      'payer',
      'interest',
    ]);
    expect(bridge.classifyInput.detectedConfidence).toBe('low');

    const result = classifyDocument(bridge.classifyInput);
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('1099-INT');
    expect(result.confidence).toBe('low');
    expect(result.matchedMarkers.length).toBeGreaterThan(0);
    expect(classificationAllowsIncomeWrite(result)).toBe(true);
  });

  it('keeps explicit numeric 0 from OCR-backed tool fields and omits missing boxes', () => {
    const result = invokeTaxTool({
      tool: 'add_w2',
      args: {
        employerName: 'Acme',
        socialSecurityWages: 0,
        wages: undefined,
      },
      context: {
        returnId: 'ret-1',
        taxYear: 2026,
        sourceDocumentId: 'DOC-ocr-1',
        sourceFileName: 'scan-w2.png',
        extractor: 'local-ocr',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.socialSecurityWages).toBe(0);
    expect(result.fields).not.toHaveProperty('wages');
    const ss = result.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    const wages = result.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('unknown');
  });

  it('routes images and scanned PDFs to OCR paths; digital PDFs stay digital', () => {
    expect(
      selectDocumentExtractKind({ mimeType: 'image/jpeg', fileName: 'scan.jpg' }),
    ).toBe('image');
    expect(
      selectDocumentExtractKind({
        mimeType: 'application/pdf',
        fileName: 'form.pdf',
        digital: { ocrAvailable: true },
      }),
    ).toBe('scanned_pdf');
    expect(
      selectDocumentExtractKind({
        mimeType: 'application/pdf',
        fileName: 'form.pdf',
        digital: { errors: ['This appears to be a scanned PDF'] },
      }),
    ).toBe('scanned_pdf');
    expect(
      selectDocumentExtractKind({
        mimeType: 'application/pdf',
        fileName: 'form.pdf',
        digital: { ocrAvailable: false, errors: [] },
      }),
    ).toBe('digital_pdf');
  });

  it('stamps local-ocr for OCR provenance and local-pdf for digital', () => {
    expect(ocrExtractorLabel(true)).toBe('local-ocr');
    expect(ocrExtractorLabel(false)).toBe('local-pdf');
    expect(ocrExtractorLabel(true, true)).toBe('local-ocr+byok');
    expect(ocrExtractorLabel(false, true)).toBe('local-pdf+byok');
    expect(ocrExtractorLabel(true, false, 'granite-docling')).toBe(
      'local-ocr-granite-docling',
    );
    expect(ocrExtractorLabel(true, false, 'lightonocr')).toBe(
      'local-ocr-lightonocr',
    );
  });

  it('selects Granite then LightOn then Tesseract from presence', () => {
    expect(
      selectOcrBackend({ granitePresent: true, lightonPresent: false }),
    ).toBe('granite-docling');
    expect(
      selectOcrBackend({ granitePresent: false, lightonPresent: true }),
    ).toBe('lightonocr');
    expect(
      selectOcrBackend({ granitePresent: false, lightonPresent: false }),
    ).toBe('tesseract');
  });
});
