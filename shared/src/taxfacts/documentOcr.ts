/**
 * OCR bridge (work-order step 5 / HA-AI-014 development-order OCR).
 *
 * Does NOT download models or add a new OCR engine. Callers run the existing
 * client extractors (extractFromPDFWithOCR / extractFromImage / digital PDF)
 * and pass those signals here before classification and tax tools.
 *
 * Invariants:
 * - OCR confidence is preserved and never upgraded through classification.
 * - When OCR was used and confidence is missing, treat it as low.
 * - Empty / unreadable OCR text clears form labels so income is not invented.
 *   Missing per-piece text (null/undefined) does not wipe markers from a
 *   successful OCR read of a secondary form in the same file.
 * - Missing numeric boxes stay omitted (handled by tax tools); printed 0 stays 0.
 */

import type {
  ClassificationConfidence,
  ClassifyDocumentInput,
} from './documentClassifier.js';

const CONFIDENCE_RANK: Record<ClassificationConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Which existing client extract path should run for a dropped file. */
export type DocumentExtractKind = 'image' | 'scanned_pdf' | 'digital_pdf';

/**
 * Signals produced by the existing PDF / image extractors (Tesseract OCR or
 * digital text layer). Shared code stays free of DOM / File APIs.
 */
export interface OcrExtractionSignals {
  /** Raw OCR or extract text (preferred classification haystack). */
  text?: string | null;
  /** True when Tesseract (or equivalent existing local OCR) produced the text. */
  ocrUsed?: boolean;
  /** Extractor-reported form / field confidence. */
  confidence?: ClassificationConfidence | null;
  detectedFormType?: string | null;
  matchedMarkers?: readonly string[] | null;
}

export interface OcrClassificationBridge {
  /** Input ready for classifyDocument — empty OCR never invents a type. */
  classifyInput: ClassifyDocumentInput;
  /** True when OCR ran but yielded no usable text. */
  emptyOcrText: boolean;
  /** True when the existing OCR path was used. */
  ocrUsed: boolean;
}

/**
 * Source confidence for classification.
 * OCR must never claim better than the extractor reported; missing OCR → low.
 * Digital (non-OCR) paths pass through reported confidence unchanged.
 */
export function ocrSourceConfidence(input: {
  ocrUsed?: boolean;
  confidence?: ClassificationConfidence | null;
}): ClassificationConfidence | null {
  if (!input.ocrUsed) {
    return input.confidence ?? null;
  }
  // Existing Tesseract path reports low; never upgrade past that floor policy.
  const reported = input.confidence ?? 'low';
  return CONFIDENCE_RANK[reported] <= CONFIDENCE_RANK.low ? reported : 'low';
}

/** True when OCR / extract text is missing or whitespace-only. */
export function isEmptyOcrText(text?: string | null): boolean {
  return typeof text !== 'string' || text.trim().length === 0;
}

/**
 * True when OCR produced an explicit empty/whitespace string.
 * Missing (null/undefined) is not "known empty" — multi-form OCR pieces may
 * omit rawOCRText even though classification markers came from real OCR text.
 */
export function isBlankOcrText(text?: string | null): boolean {
  return typeof text === 'string' && text.trim().length === 0;
}

/**
 * Normalize extractor/OCR signals into a classifyDocument input.
 * Known-empty OCR clears bare form labels and markers so income tools stay off.
 * Missing text alone does not wipe valid per-piece markers / form types.
 */
export function classificationInputFromOcr(
  signals: OcrExtractionSignals,
): OcrClassificationBridge {
  const ocrUsed = Boolean(signals.ocrUsed);
  const blankOcrText = isBlankOcrText(signals.text);
  const emptyOcrText = isEmptyOcrText(signals.text);

  // Only clear evidence when OCR is known to have produced zero text for this
  // piece. Do not erase secondary multi-form results that lack rawOCRText.
  if (ocrUsed && blankOcrText) {
    return {
      classifyInput: {
        text: null,
        detectedFormType: null,
        matchedMarkers: [],
        detectedConfidence: 'low',
      },
      emptyOcrText: true,
      ocrUsed: true,
    };
  }

  return {
    classifyInput: {
      text: emptyOcrText ? null : signals.text!.trim(),
      detectedFormType: signals.detectedFormType ?? null,
      matchedMarkers: [...(signals.matchedMarkers ?? [])],
      detectedConfidence: ocrSourceConfidence({
        ocrUsed,
        confidence: signals.confidence,
      }),
    },
    emptyOcrText: blankOcrText,
    ocrUsed,
  };
}

/**
 * Choose the existing extract path. Does not run OCR.
 * Images and scanned PDFs use extractFromImage / extractFromPDFWithOCR;
 * digital PDFs stay on extractFromPDF.
 */
export function selectDocumentExtractKind(input: {
  mimeType?: string | null;
  fileName?: string | null;
  /** Result of a digital PDF probe (ocrAvailable / scan errors). */
  digital?: {
    ocrAvailable?: boolean;
    errors?: readonly string[];
  } | null;
}): DocumentExtractKind {
  const mime = (input.mimeType || '').toLowerCase().trim();
  const name = (input.fileName || '').toLowerCase();
  const isImage =
    mime.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|tiff?|heic|heif)$/i.test(name);

  if (isImage) return 'image';

  const digital = input.digital;
  if (
    digital?.ocrAvailable ||
    digital?.errors?.some((e) => /scan/i.test(e))
  ) {
    return 'scanned_pdf';
  }

  return 'digital_pdf';
}

/** Extractor stamp for provenance when OCR was used. */
export function ocrExtractorLabel(ocrUsed: boolean, aiEnhanced?: boolean): string {
  if (aiEnhanced) return ocrUsed ? 'local-ocr+byok' : 'local-pdf+byok';
  return ocrUsed ? 'local-ocr' : 'local-pdf';
}
