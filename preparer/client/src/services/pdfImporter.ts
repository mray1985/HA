/**
 * PDF Importer — extracts data from W-2 and 1099 PDFs.
 *
 * Uses Syncfusion (@syncfusion/ej2-pdf + ej2-pdf-data-extract) for:
 * - Form field reading — captures values from digitally-filled forms
 *   that traditional text extraction misses
 * - Structured text extraction — bounding boxes for proximity matching
 *
 * Scanned PDFs and images are read with Tesseract.js (ocrService).
 * Uses pdf-lib for PDF generation (unchanged).
 *
 * All processing runs client-side. Data never leaves the browser.
 *
 * LIMITATIONS:
 * - OCR accuracy on tax forms is ~60-70% — always requires user verification
 * - Accuracy depends on the PDF layout matching expected IRS patterns
 * - Always requires user review before importing
 */

import { FORM_EXTRACTION_SCHEMAS, readBox12Entry, TOOL_MAPPINGS, type ClassifiableFormType } from '@hatax/local-ai';
import { extractWithSyncfusion } from './syncfusionExtractor';
import { readCheckboxOnPage, readRowAmountOnPage, renderedPage, type CellAmountReading } from './checkboxRaster';

// Re-export everything from the pure logic module so consumers can import
// from either file. Tests import directly from pdfExtractHelpers to avoid
// browser dependencies.
export {
  detectFormType,
  detectFormPages,
  extractW2Fields,
  extract1099INTFields,
  extract1099DIVFields,
  extract1099RFields,
  extract1099NECFields,
  extract1099MISCFields,
  extract1099GFields,
  extract1099BFields,
  extract1099KFields,
  extract1099OIDFields,
  extractW2CFields,
  extractSSA1099Fields,
  extract1099SAFields,
  extract1099QFields,
  extract1098Fields,
  extract1098TFields,
  extract1098EFields,
  extract1095AFields,
  extractK1Fields,
  extractW2GFields,
  extract1099CFields,
  extract1099SFields,
  generateImportTrace,
  FORM_TYPE_LABELS,
  INCOME_TYPE_STEP_MAP,
  INCOME_DISCOVERY_KEYS,
} from './pdfExtractHelpers';

export type {
  SupportedFormType,
  TextBlock,
  PDFExtractResult,
  FieldSourceLocation,
  FieldSourceLocationValue,
  ImportTrace,
  ImportTraceEntry,
  FormDetectionTrace,
  FormPageSpan,
} from './pdfExtractHelpers';

import { printedTaxYear,
  detectFormType,
  detectFormPages,
  extractW2Fields,
  extract1099INTFields,
  extract1099DIVFields,
  extract1099RFields,
  extract1099NECFields,
  extract1099MISCFields,
  extract1099GFields,
  extract1099BFields,
  extract1099KFields,
  extract1099OIDFields,
  extractW2CFields,
  extractSSA1099Fields,
  extract1099SAFields,
  extract1099QFields,
  extract1098Fields,
  extract1098TFields,
  extract1098EFields,
  extract1095AFields,
  extractK1Fields,
  extractW2GFields,
  extract1099CFields,
  extract1099SFields,
  generateImportTrace,
  FORM_TYPE_LABELS,
  type TextBlock,
  type PDFExtractResult,
  type FieldSourceLocationValue,
} from './pdfExtractHelpers';

export type { OCRStage } from './ocrService';
import { w2EmployeeFromTextLayer } from './w2EmployeeText';
import { buildPrintIndex, verifyAgainstPrint, type PrintIndex, type RejectedRead } from './extractionVerification';
import { buildBoxLedger, summariseBoxLedger, type BoxLedger } from './boxLedger';

// ─── Shared Processing Logic ──────────────────────

/**
 * Extract fields for a given form type from text blocks.
 * Factored out so both primary and additional form spans can use it.
 */
function extractFormData(
  formType: ReturnType<typeof detectFormType>['type'],
  blocks: TextBlock[],
  /** Box key → whether its printed square is ticked, where that could be proved. */
  checkboxes: Record<string, boolean> = {},
): {
  extractedData: Record<string, unknown>;
  payerName: string;
  fieldRawTokens: Record<string, string>;
  fieldSourceLocations: Record<string, FieldSourceLocationValue>;
  /** Reads the page does not support. Held for a person; never written. */
  rejectedReads: RejectedRead[];
  /** What the page prints, so the check can run at the write boundary. */
  printIndex: PrintIndex;
  /** Every box the form prints, and what became of it. */
  boxLedger: BoxLedger;
  /** The text of the pages this form was read from. */
  pageText: string;
} {
  let extractedData: Record<string, unknown> = {};
  let payerName = '';
  const fieldRawTokens: Record<string, string> = {};
  const fieldSourceLocations: Record<string, FieldSourceLocationValue> = {};
  switch (formType) {
    case 'W-2':
      extractedData = extractW2Fields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.employerName as string) || '';
      break;
    case '1099-INT':
      extractedData = extract1099INTFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-DIV':
      extractedData = extract1099DIVFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-R':
      extractedData = extract1099RFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-NEC':
      extractedData = extract1099NECFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-MISC':
      extractedData = extract1099MISCFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-G':
      extractedData = extract1099GFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-B':
      extractedData = extract1099BFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.brokerName as string) || '';
      break;
    case '1099-K':
      extractedData = extract1099KFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.platformName as string) || '';
      break;
    case 'W-2C':
      extractedData = extractW2CFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.employerName as string) || '';
      break;
    case '1099-OID':
      extractedData = extract1099OIDFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case 'SSA-1099':
      extractedData = extractSSA1099Fields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = 'Social Security Administration';
      break;
    case '1099-SA':
      extractedData = extract1099SAFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-Q':
      extractedData = extract1099QFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1098':
      extractedData = extract1098Fields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.lenderName as string) || '';
      break;
    case '1098-T':
      extractedData = extract1098TFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.institutionName as string) || '';
      break;
    case '1098-E':
      extractedData = extract1098EFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.lenderName as string) || '';
      break;
    case '1095-A':
      extractedData = extract1095AFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.marketplaceName as string) || '';
      break;
    case 'K-1':
      extractedData = extractK1Fields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.entityName as string) || '';
      break;
    case 'W-2G':
      extractedData = extractW2GFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-C':
      extractedData = extract1099CFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.payerName as string) || '';
      break;
    case '1099-S':
      extractedData = extract1099SFields(blocks, fieldRawTokens, fieldSourceLocations);
      payerName = (extractedData.filerName as string) || '';
      break;
  }

  // The squares the ink reader proved, as fields on the form.
  applyCheckboxStates(formType, checkboxes, extractedData, fieldRawTokens, fieldSourceLocations);
  applyMeasuredChoices(formType, checkboxes, extractedData);

  // What the page prints, carried forward. The deterministic check runs on this
  // at the write boundary, where the form type being written is known — so a
  // later classification pass cannot relabel a form under values already checked
  // against a different one, and a new extractor cannot skip the check.
  const printIndex = buildPrintIndex(blocks);

  // payerName is a printed name and is verified with everything else.
  const verifiedPayer = verifyAgainstPrint(formType, payerName ? { __payer: payerName } : {}, printIndex);

  return {
    extractedData,
    payerName: typeof verifiedPayer.data.__payer === 'string' ? verifiedPayer.data.__payer : '',
    fieldRawTokens,
    fieldSourceLocations,
    printIndex,
rejectedReads: verifiedPayer.rejected.map((r) => ({ ...r, field: 'payerName' })),
      pageText: blocks.map((b) => b.text).join(' '),
      boxLedger: buildBoxLedger(formType, extractedData, verifiedPayer.rejected, blocks.map((b) => b.text).join(' ')),
    };
  }

/**
 * Process text blocks through the detection + extraction pipeline.
 * Shared by digital PDF, OCR, and image extraction paths.
 *
 * For multi-page documents, scans each page independently to skip non-IRS
 * intro/summary pages (common in TurboTax/H&R Block exports) and extract
 * only from the pages containing a supported IRS form.
 */
function processTextBlocks(
  textBlocks: TextBlock[],
  pagesScanned: number,
  meta?: { ocrUsed?: boolean; ocrEngine?: PDFExtractResult['ocrEngine']; canvases?: HTMLCanvasElement[]; dpi?: number },
): PDFExtractResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ocrUsed = meta?.ocrUsed ?? false;
  const ocrEngine = meta?.ocrEngine;

  if (ocrUsed) {
    warnings.push('This data was extracted using OCR from a scanned document. Accuracy is limited — please carefully verify every value.');
  }

  // ── Per-page form detection for multi-page documents ──
  //
  // TurboTax and similar exports include intro/summary pages before the
  // actual IRS forms. Instead of pooling all text and hoping for the best,
  // scan each page independently and extract only from the form's pages.
  let type: ReturnType<typeof detectFormType>['type'] = null;
  let incomeType: string | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let matchedKeywords: string[] = [];
  let effectiveBlocks = textBlocks;
  let pageRangeInfo: {
    formPageRange?: { start: number; end: number };
    additionalForms?: Array<{ type: string; pages: string }>;
  } | undefined;

  const spans = detectFormPages(textBlocks, ocrUsed);

  if (spans.length > 0) {
    // Use the first detected form span
    const primary = spans[0];
    type = primary.type;
    incomeType = primary.incomeType;
    confidence = primary.confidence;
    matchedKeywords = primary.matchedKeywords;

    // Filter text blocks to only the primary form's pages
    effectiveBlocks = textBlocks.filter(
      b => b.page >= primary.startPage && b.page <= primary.endPage,
    );

    const skippedPages = pagesScanned - (primary.endPage - primary.startPage + 1);
    if (skippedPages > 0) {
      warnings.push(
        `Scanned ${pagesScanned} pages — found ${FORM_TYPE_LABELS[primary.type]} on ` +
        `page${primary.startPage === primary.endPage ? ` ${primary.startPage}` : `s ${primary.startPage}–${primary.endPage}`}` +
        `, skipped ${skippedPages} non-form page(s).`,
      );
    }

    // Note additional forms found on other pages
    if (spans.length > 1) {
      const others = spans.slice(1).map(s => {
        const label = FORM_TYPE_LABELS[s.type] || s.type;
        const pages = s.startPage === s.endPage ? `page ${s.startPage}` : `pages ${s.startPage}–${s.endPage}`;
        return `${label} (${pages})`;
      });
      warnings.push(`This PDF also contains: ${others.join(', ')}. These forms will also be extracted automatically.`);
    }

    pageRangeInfo = {
      formPageRange: { start: primary.startPage, end: primary.endPage },
      additionalForms: spans.slice(1).map(s => ({
        type: s.type,
        pages: s.startPage === s.endPage ? `${s.startPage}` : `${s.startPage}–${s.endPage}`,
      })),
    };
  } else {
    // Single-page or no per-page match — fall back to legacy all-pages detection
    ({ type, incomeType, confidence, matchedKeywords } = detectFormType(textBlocks, ocrUsed));
  }

  // Scope raw OCR text to only the effective (form) pages for AI enhancement
  const rawOCRText = ocrUsed ? effectiveBlocks.map(b => b.text).join('\n') : undefined;

  // ── The printed squares ──
  //
  // A tick is not text, so the text layer cannot say whether a checkbox is
  // marked — on a digital form the mark extracts as a symbol-font glyph (a real
  // 1098-T prints "4"), and reading that would be worse than reading nothing.
  // When the page was rendered for OCR the raster is already here, so each square
  // the form declares is measured on its own ink.
  const checkboxStates = meta?.canvases?.length
    ? readFormCheckboxes(type, meta.canvases, meta.dpi ?? 300, effectiveBlocks)
    : {};

  if (!type) {
    return {
      formType: null,
      confidence: 'low',
      extractedData: {},
      incomeType: null,
      payerName: '',
      warnings,
      errors: ['Could not determine the form type. Supported forms: W-2, 1099-INT, 1099-DIV, 1099-R, 1099-NEC, 1099-MISC, 1099-G, 1099-B, 1099-K, SSA-1099, 1099-SA, 1099-Q, 1098, 1098-T, 1098-E, 1095-A, K-1, W-2G, 1099-C, 1099-S.'],
      textBlockCount: textBlocks.length,
      trace: generateImportTrace(null, 'low', matchedKeywords, {}, textBlocks.length, pagesScanned, pageRangeInfo),
      ocrUsed,
      ocrEngine,
    };
  }

  if (confidence === 'low') {
    warnings.push('Low confidence in form type detection. Please verify the form type is correct.');
  }

  // Extract fields based on form type — using effectiveBlocks (scoped to form pages)
  const { extractedData, payerName, fieldRawTokens, fieldSourceLocations, rejectedReads, printIndex } =
    extractFormData(type, effectiveBlocks, checkboxStates);
  // Money boxes are then re-read from the ruled row each one's printed label
  // names. Only a value that row confirms survives: proximity alone invents a
  // number for an empty box, and a held box reaches the preparer while an
  // invented one does not.
  if (meta?.canvases?.length) {
    if (type === 'W-2') applyW2Box12(meta.canvases, meta.dpi ?? 300, effectiveBlocks, extractedData);
    const rows = readFormRowAmounts(type, meta.canvases, meta.dpi ?? 300, effectiveBlocks);
    applyRowAmountConfirmations(
      type,
      rows,
      TOOL_MAPPINGS[type as ClassifiableFormType]?.direct,
      extractedData,
      fieldRawTokens,
      fieldSourceLocations,
      rejectedReads,
    );
  }
  // The employee on a W-2: confirmed from a text layer; one OCR reading is not.
  const identity = type === 'W-2' ? w2EmployeeFromTextLayer(effectiveBlocks, !ocrUsed) : null;
  // The tax year the form prints, checked against the case's year in the review.
  const taxYearPrinted = printedTaxYear(effectiveBlocks, type, extractedData);

  // Add form-specific warnings
  if (type === '1099-B') {
    warnings.push('PDF import captures summary totals only. For individual transactions, use CSV or TXF import.');
  } else if (type === '1095-A') {
    warnings.push('Monthly values may need manual entry. Annual totals are more reliable from OCR.');
} else if (type === 'K-1') {
      warnings.push('K-1 import captures 13 common boxes (1, 2, 4, 5, 6a, 7, 8, 9a, 9b, 9c, 10, 14A and the name). Verify for additional entries.');
}

  // Account for every box the form prints, so a form the reader mostly failed
    // on cannot look like a form with two boxes on it.
    const pageText = effectiveBlocks.map((b) => b.text).join(' ');
    const boxLedger = buildBoxLedger(type, extractedData, rejectedReads, pageText);
    const ledgerNote = summariseBoxLedger(boxLedger);
    if (ledgerNote) warnings.push(`${type ?? 'This form'}: ${ledgerNote}`);
  if (!payerName) {
    warnings.push('Could not extract payer/employer name. Please enter it manually.');
  }

  const numericFields = Object.entries(extractedData).filter(
    ([, v]) => typeof v === 'number' && v > 0,
  );
  if (numericFields.length === 0) {
    warnings.push('No numeric values were extracted. The PDF layout may not be in a recognized format.');
  }

  // ── Extract additional forms from multi-form PDFs ──
  // Process each additional form span independently so consolidated brokerage
  // statements (UBS, Fidelity, etc.) import all forms in one upload.
  let additionalResults: PDFExtractResult[] | undefined;
  if (spans.length > 1) {
    additionalResults = [];
    for (const span of spans.slice(1)) {
      const spanBlocks = textBlocks.filter(
        b => b.page >= span.startPage && b.page <= span.endPage,
      );
      const spanChecks = meta?.canvases?.length
        ? readFormCheckboxes(span.type, meta.canvases, meta.dpi ?? 300, spanBlocks)
        : {};
      const spanData = extractFormData(span.type, spanBlocks, spanChecks);
      if (meta?.canvases?.length) {
        const spanRows = readFormRowAmounts(span.type, meta.canvases, meta.dpi ?? 300, spanBlocks);
        applyRowAmountConfirmations(
          span.type,
          spanRows,
          TOOL_MAPPINGS[span.type as ClassifiableFormType]?.direct,
          spanData.extractedData,
          spanData.fieldRawTokens,
          spanData.fieldSourceLocations,
          spanData.rejectedReads,
        );
        spanData.boxLedger = buildBoxLedger(span.type, spanData.extractedData, spanData.rejectedReads, spanData.pageText);
      }
      const spanIdentity = span.type === 'W-2' ? w2EmployeeFromTextLayer(spanBlocks, !ocrUsed) : null;
      const spanNumericFields = Object.entries(spanData.extractedData).filter(
        ([, v]) => typeof v === 'number' && v > 0,
      );
      const spanWarnings: string[] = [];
      if (!spanData.payerName) {
        spanWarnings.push('Could not extract payer/employer name. Please enter it manually.');
      }
      if (spanNumericFields.length === 0) {
        spanWarnings.push('No numeric values were extracted. The PDF layout may not be in a recognized format.');
      }
      // Scope OCR text to this form's pages — classifyExtractionPiece needs
      // per-piece rawOCRText or it treats missing text as an empty scan and
      // wipes detectedFormType / matchedMarkers for secondary forms.
      const spanRawOCRText = ocrUsed
        ? spanBlocks.map((b) => b.text).join('\n')
        : undefined;
      additionalResults.push({
        formType: span.type,
        confidence: span.confidence,
        extractedData: spanData.extractedData,
        fieldRawTokens: Object.keys(spanData.fieldRawTokens).length > 0
          ? spanData.fieldRawTokens
          : undefined,
        fieldSourceLocations: Object.keys(spanData.fieldSourceLocations).length > 0
          ? spanData.fieldSourceLocations
          : undefined,
        incomeType: span.incomeType,
        payerName: spanData.payerName,
        warnings: spanWarnings,
        errors: [],
        textBlockCount: spanBlocks.length,
        trace: generateImportTrace(span.type, span.confidence, span.matchedKeywords, spanData.extractedData, spanBlocks.length, span.endPage - span.startPage + 1),
        ocrUsed,
        ocrEngine,
        rawOCRText: spanRawOCRText,
        // A secondary form is applied exactly like a primary one, so it carries
        // the same print index and ledger. Without these the write boundary has
        // nothing to check the span's pages against and lets them through.
        printIndex: spanData.printIndex,
        pageText: spanData.pageText,
        boxLedger: spanData.boxLedger,
        ...(spanData.rejectedReads.length > 0 ? { rejectedReads: spanData.rejectedReads } : {}),
        ...(spanIdentity ? { identity: spanIdentity } : {}),
      });
    }
    // Filter out results with zero extracted values (non-form pages)
    additionalResults = additionalResults.filter(r =>
      Object.values(r.extractedData).some(v => typeof v === 'number' && v > 0) ||
      r.formType !== null,
    );
    if (additionalResults.length === 0) additionalResults = undefined;
  }

  return {
    formType: type,
    ...(taxYearPrinted ? { taxYearPrinted } : {}),
    confidence,
    extractedData,
    ...(printIndex ? { printIndex } : {}),
    ...(rejectedReads.length > 0 ? { rejectedReads } : {}),
    boxLedger,
    pageText,
    fieldRawTokens: Object.keys(fieldRawTokens).length > 0 ? fieldRawTokens : undefined,
    fieldSourceLocations: Object.keys(fieldSourceLocations).length > 0
      ? fieldSourceLocations
      : undefined,
    incomeType,
    payerName,
    warnings,
    errors,
    textBlockCount: effectiveBlocks.length,
    trace: generateImportTrace(type, confidence, matchedKeywords, extractedData, effectiveBlocks.length, pagesScanned, pageRangeInfo),
    ocrUsed,
    ocrEngine,
    rawOCRText,
    additionalResults,
    ...(identity ? { identity } : {}),
  };
}

/**
 * Render the pages of a digital PDF when a form on it has a square or a money box.
 *
 * A tick is ink, not text: on a digital form it extracts as a symbol-font glyph
 * (a real 1098-T prints "4" for its half-time box), so the text layer cannot say
 * whether a box is marked. Rendering is the only way to see the mark, and it is
 * not cheap — so it happens when there is a square to read, and a failure to
 * render leaves every square unread, which the gap list reports rather than hides.
 */
async function renderForCheckboxes(
  file: File,
  textBlocks: TextBlock[],
): Promise<{ canvases: HTMLCanvasElement[]; dpi: number } | null> {
  // Every span, not only the first form. A W-2 followed by a 1098-T still has
  // squares to measure on the later pages.
  const spans = detectFormPages(textBlocks);
  const types = spans.length > 0
    ? spans.map((s) => s.type)
    : [detectFormType(textBlocks).type].filter((t): t is NonNullable<typeof t> => t !== null);
  // A money box needs the page too: the ruled row is what confirms its amount.
  // SSA-1099 has money boxes and no checkbox, and used to skip rendering entirely.
  const needsPage = types.some((t) => {
    const declared = FORM_EXTRACTION_SCHEMAS[t as ClassifiableFormType];
    return declared?.boxes.some((b) => (b.kind === 'checkbox' && b.checkbox) || b.kind === 'money') ?? false;
  });
  if (!needsPage) return null;
  try {
    const { renderPDFToImages } = await import('./pdfToImages');
    const dpi = 200;
    return { canvases: await renderPDFToImages(file, 10, dpi), dpi };
  } catch {
    // No canvas, no squares: the boxes stay unread and are reported.
    return null;
  }
}

// ─── Public API ────────────────────────────────────

/**
 * Extract data from a digitally-generated PDF file.
 *
 * Uses Syncfusion for both text extraction and form field reading.
 * Form field values (from employer/institution-filled W-2s and 1099s)
 * are injected as TextBlocks so the existing proximity pipeline captures
 * data that pdfjs-dist's text extraction would miss.
 *
 * Returns ocrAvailable: true when the PDF appears to be scanned.
 */
export async function extractFromPDF(file: File): Promise<PDFExtractResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfBytes = new Uint8Array(arrayBuffer);

    const { textBlocks, pagesScanned, isScanned, isPasswordProtected, formFieldsWithValues } =
      extractWithSyncfusion(pdfBytes);

    if (isPasswordProtected) {
      return {
        formType: null,
        confidence: 'low',
        extractedData: {},
        incomeType: null,
        payerName: '',
        warnings: [],
        errors: ['This PDF is password-protected. Please remove the password and try again.'],
        textBlockCount: 0,
      };
    }

    // Check for scanned/image PDF — offer OCR instead of dead-end error
    if (isScanned) {
      return {
        formType: null,
        confidence: 'low',
        extractedData: {},
        incomeType: null,
        payerName: '',
        warnings: [],
        errors: [],
        textBlockCount: textBlocks.length,
        ocrAvailable: true,
      };
    }

    // The printed squares need pixels, and a digital PDF has none until it is
    // rendered. Only rendered when the form declares a checkbox box — otherwise
    // there is nothing to measure and the page is not worth drawing.
    const canvases = await renderForCheckboxes(file, textBlocks);
    const result = processTextBlocks(textBlocks, pagesScanned, canvases ? { canvases: canvases.canvases, dpi: canvases.dpi } : undefined);

    // If Syncfusion found form field values, note it in the trace
    if (formFieldsWithValues > 0 && result.trace) {
      result.trace.formDetection.reasoning +=
        ` (${formFieldsWithValues} form field values also extracted)`;
    }

    return result;
  } catch (err: unknown) {
    const msg = (err as Error)?.message || 'Unknown error';
    return {
      formType: null,
      confidence: 'low',
      extractedData: {},
      incomeType: null,
      payerName: '',
      warnings: [],
      errors: [`Failed to read PDF: ${msg}`],
      textBlockCount: 0,
    };
  }
}

/**
 * Measure every square this form declares, on the pages that were rendered.
 *
 * Each box is read beside its own printed label, so a tick is attributed to the
 * box whose label it sits with. A square that cannot be proved either way is left
 * out entirely rather than guessed at: an unproved square must not settle an
 * eligibility answer, and the gap list reports it as unread.
 */
function readFormCheckboxes(
  formType: ReturnType<typeof detectFormType>['type'],
  canvases: readonly HTMLCanvasElement[],
  dpi: number,
  blocks: readonly TextBlock[],
): Record<string, boolean> {
  if (!formType) return {};
  const schema = FORM_EXTRACTION_SCHEMAS[formType as ClassifiableFormType];
  if (!schema) return {};
  const squares = schema.boxes.filter((b) => b.kind === 'checkbox' && b.checkbox);
  if (squares.length === 0) return {};

  const out: Record<string, boolean> = {};
  const byPage = new Map<number, TextBlock[]>();
  for (const b of blocks) {
    const list = byPage.get(b.page);
    if (list) list.push(b);
    else byPage.set(b.page, [b]);
  }
  // One grayscale conversion per page. A letter page at 300 DPI is millions of
  // pixels, and a form with several squares used to repeat that for each one.
  const rendered = new Map<number, ReturnType<typeof renderedPage>>();
  const pageOf = (pageNumber: number) => {
    const cached = rendered.get(pageNumber);
    if (cached) return cached;
    const canvas = canvases[pageNumber - 1];
    const pageBlocks = byPage.get(pageNumber);
    if (!canvas || !pageBlocks) return undefined;
    const page = renderedPage(canvas, pageBlocks, dpi, 'ocr');
    rendered.set(pageNumber, page);
    return page;
  };

  for (const box of squares) {
    // The form's own pages: canvases are in page order, blocks are not.
    const pageNumber = [...byPage.keys()].sort((a, b) => a - b).find((p) => {
      const canvas = canvases[p - 1];
      return canvas && byPage.get(p)!.length > 0;
    });
    if (pageNumber === undefined) continue;
    try {
      const page = pageOf(pageNumber);
      if (!page) continue;
      // A page often prints the form more than once. The copy at the top is the
      // one being read; without a hint every repeated label is "unknown".
      const reading = readCheckboxOnPage(page, box.checkbox!, [0, 0, 1, 1]);
      if (reading.state === 'checked' || reading.state === 'unchecked') {
        out[box.key] = reading.state === 'checked';
      }
    } catch {
      // A page that cannot be rendered leaves its squares unread, which the gap
      // list reports. Never a value.
    }
  }
  return out;
}

/**
 * Put the proved squares onto the form's fields.
 *
 * Only boxes the schema maps to a field are written, and only a proved square is
 * written — a missing one leaves the field absent, which the tools read as
 * unknown rather than as unticked.
 */
/**
 * Choices the schema records as a group of squares, not as one boolean field.
 * W-2 box 13, the 1099-B holding period, and the 1099-SA account type.
 */
function applyMeasuredChoices(
  formType: ReturnType<typeof detectFormType>['type'],
  checks: Record<string, boolean>,
  data: Record<string, unknown>,
): void {
  if (formType === 'W-2') {
    const box13: Record<string, boolean> = {};
    for (const [key, field] of [
      ['13.statutory', 'statutoryEmployee'],
      ['13.retirement', 'retirementPlan'],
      ['13.sickPay', 'thirdPartySickPay'],
    ] as const) {
      if (checks[key] !== undefined) box13[field] = checks[key]!;
    }
    if (Object.keys(box13).length === 3) data.box13 = box13;
  }
  if (formType === '1099-B' && checks['2.long'] !== undefined && checks['2.short'] !== undefined && checks['2.long'] !== checks['2.short']) {
    data.isLongTerm = checks['2.long'];
  }
  if (formType === '1099-SA') {
    const options = [['5.hsa', 'HSA'], ['5.archer', 'Archer MSA'], ['5.ma', 'MA MSA']] as const;
    const checked = options.filter(([key]) => checks[key] === true);
    if (options.every(([key]) => checks[key] !== undefined) && checked.length === 1) data.accountType = checked[0]![1];
  }
}

/** Box 12 entries printed under 12a–12d: an official code and its amount. */
function applyW2Box12(
  canvases: readonly HTMLCanvasElement[],
  dpi: number,
  blocks: readonly TextBlock[],
  data: Record<string, unknown>,
): void {
  const byPage = new Map<number, TextBlock[]>();
  for (const b of blocks) {
    const list = byPage.get(b.page);
    if (list) list.push(b);
    else byPage.set(b.page, [b]);
  }
  const pageNumber = [...byPage.keys()].sort((a, b) => a - b).find((p) => canvases[p - 1] && byPage.get(p)!.length > 0);
  if (pageNumber === undefined) return;
  const page = renderedPage(canvases[pageNumber - 1]!, byPage.get(pageNumber)!, dpi, 'pdf-text');
  // The first copy is the one at the top of the page. Later copies repeat "12a".
  const near: readonly [number, number, number, number] = [0, 0, 1, 1];
  const entries: Array<{ code: string; amount: number }> = [];
  for (const slot of ['12a', '12b', '12c', '12d']) {
    const entry = readBox12Entry(slot, page.words, near);
    if (!entry) continue;
    const amount = Number(entry.amount.replace(/[$,]/g, ''));
    if (!Number.isFinite(amount)) continue;
    entries.push({ code: entry.code, amount });
  }
  if (entries.length > 0) data.box12 = entries;
}

function applyCheckboxStates(
  formType: ReturnType<typeof detectFormType>['type'],
  checkboxes: Record<string, boolean>,
  extractedData: Record<string, unknown>,
  fieldRawTokens: Record<string, string>,
  fieldSourceLocations: Record<string, FieldSourceLocationValue>,
): void {
  if (!formType || Object.keys(checkboxes).length === 0) return;
  const mapping = TOOL_MAPPINGS[formType as ClassifiableFormType];
  const fields = mapping?.checkboxes;
  if (!fields) return;
  for (const [boxKey, field] of Object.entries(fields)) {
    const state = checkboxes[boxKey];
    if (state === undefined) continue;
    extractedData[field] = state;
    fieldRawTokens[field] = state ? 'ticked' : 'not ticked';
    // A square is a mark, not a value: it has no field location to point at.
    delete fieldSourceLocations[field];
  }
}

/**
 * Read every money box on a form from the ruled row its printed label names.
 *
 * Keys are the form's schema box keys, so a reading can be matched back to the
 * field it fills. 'empty' and 'unknown' are both returned: the caller needs to
 * know that a box was checked and found blank, which is different from never
 * having looked.
 */
function readFormRowAmounts(
  formType: ReturnType<typeof detectFormType>['type'],
  canvases: readonly HTMLCanvasElement[],
  dpi: number,
  blocks: readonly TextBlock[],
): Record<string, CellAmountReading> {
  if (!formType) return {};
  const schema = FORM_EXTRACTION_SCHEMAS[formType as ClassifiableFormType];
  if (!schema) return {};
  const money = schema.boxes.filter((b) => b.kind === 'money' && b.label.trim().length > 0);
  if (money.length === 0) return {};

  const byPage = new Map<number, TextBlock[]>();
  for (const b of blocks) {
    const list = byPage.get(b.page);
    if (list) list.push(b);
    else byPage.set(b.page, [b]);
  }
  const pageNumbers = [...byPage.keys()].sort((a, b) => a - b);
  const rendered = new Map<number, ReturnType<typeof renderedPage>>();
  const pageOf = (pageNumber: number) => {
    const cached = rendered.get(pageNumber);
    if (cached) return cached;
    const canvas = canvases[pageNumber - 1];
    const pageBlocks = byPage.get(pageNumber);
    if (!canvas || !pageBlocks) return undefined;
    const page = renderedPage(canvas, pageBlocks, dpi, 'ocr');
    rendered.set(pageNumber, page);
    return page;
  };

  const out: Record<string, CellAmountReading> = {};
  for (const box of money) {
    for (const pageNumber of pageNumbers) {
      const page = pageOf(pageNumber);
      if (!page) continue;
      // The printed label is the row. A bare box number ("1 ") matches too many
      // places, and an empty hit on one of those was wiping a real amount.
      const reading = box.label.trim().length > 0
        ? readRowAmountOnPage(page, { anchors: [box.label] })
        : { state: 'unknown' as const, reason: 'this box has no printed label' };
      if (reading.state === 'read' || reading.state === 'empty') {
        out[box.key] = reading;
        break;
      }
      if (box.box.trim().length > 0) {
        const numbered = readRowAmountOnPage(page, { anchors: [`${box.box} `] });
        if (numbered.state === 'read') {
          out[box.key] = numbered;
          break;
        }
      }
      if (!out[box.key]) out[box.key] = reading;
    }
  }
  return out;
}

/**
 * Hold back any money value the ruled row did not confirm.
 *
 * A blank row removes the proximity amount and records it as held. A row that
 * could not be bounded does not: removing it would hold a real W-2, and the
 * W-2c that corrects that W-2 would never apply.
 */
function applyRowAmountConfirmations(
  formType: ReturnType<typeof detectFormType>['type'],
  rows: Record<string, CellAmountReading>,
  mapping: Record<string, string> | undefined,
  extractedData: Record<string, unknown>,
  fieldRawTokens: Record<string, string>,
  fieldSourceLocations: Record<string, FieldSourceLocationValue>,
  rejectedReads: RejectedRead[],
): void {
  if (!formType || !mapping) return;
  for (const [boxKey, reading] of Object.entries(rows)) {
    const field = mapping[boxKey];
    if (!field) continue;
    if (reading.state === 'read' && typeof reading.value === 'number') {
      extractedData[field] = reading.value;
      if (reading.raw !== undefined) fieldRawTokens[field] = reading.raw;
      delete fieldSourceLocations[field];
      continue;
    }
    // A blank ruled row removes the proximity amount. A row that could not be
    // bounded does not. Measured both ways over the 23 stress documents whose
    // values are known:
    //
    //   keep an unbounded row's amount   19/23 matching, 1 fabricated
    //   hold an unbounded row too        10/23 matching, 0 fabricated
    //
    // Holding every unbounded row is not a small loss: on a W-2 most rows come
    // back unbounded, so it discards most of the suite, digital PDFs included.
    // The one fabrication it costs is a 1098-T whose box 5 row cannot be bounded
    // and so keeps a decorative figure printed nearby (scholarships 25, where
    // the form prints nothing).
    //
    // The way out is not to choose here but to bound those rows. OCR reads a
    // photographed form in whole page strips, so one text run carries several
    // boxes' amounts at once ("94-3216540 68,250.00 7,120.00" is box 1 and box 2),
    // and moneyItemsIn separates and places them. Telling those figures apart
    // needs the form's printed columns: picking by proximity was measured and
    // reinstates the same fabricated 1098-T box 5.
    if (reading.state !== 'empty') continue;
    const prior = extractedData[field];
    if (prior !== undefined && prior !== null && prior !== '') {
      rejectedReads.push({
        field,
        value: String(prior),
        reason: 'not-printed',
        detail: reading.reason,
      });
    }
    delete extractedData[field];
    delete fieldRawTokens[field];
    delete fieldSourceLocations[field];
  }
}

/**
 * Extract data from a scanned/image-based PDF using OCR.
 * Renders pages to canvas at 300 DPI, then runs preferred OCR
 * (Tesseract).
 */
export async function extractFromPDFWithOCR(
  file: File,
  onProgress?: (stage: import('./ocrService').OCRStage, pct: number) => void,
): Promise<PDFExtractResult> {
  const canvases: HTMLCanvasElement[] = [];
  try {
    // Lazy-load OCR modules to keep them out of the main bundle
    const [{ renderPDFToImages }, { recognizeImages, getLastOcrEngine }] = await Promise.all([
      import('./pdfToImages'),
      import('./ocrService'),
    ]);

    const dpi = 300;
    onProgress?.('loading', 5);
    canvases.push(...await renderPDFToImages(file, 10, dpi));
    onProgress?.('loading', 10);

    // scaleFactor normalizes 300 DPI pixel coords → 72 DPI PDF-point space
    // BEFORE groupWordsToLines(), so yTolerance=5 operates in point space
    // and findNearbyAmount(maxDistance=200) searches the expected range.
    const textBlocks = await recognizeImages(canvases, onProgress, dpi / 72);
    const ocrEngine = getLastOcrEngine();

    if (textBlocks.length === 0) {
      return {
        formType: null,
        confidence: 'low',
        extractedData: {},
        incomeType: null,
        payerName: '',
        warnings: [],
        errors: ['OCR could not extract any text from this document. The image quality may be too low.'],
        textBlockCount: 0,
        ocrUsed: true,
        ocrEngine,
      };
    }

    // The canvases come along so the printed squares can be measured on them: a tick
    // is ink, not text, and OCR cannot see one either.
    return processTextBlocks(textBlocks, canvases.length, { ocrUsed: true, ocrEngine, canvases, dpi });
  } catch (err: any) {
    return {
      formType: null,
      confidence: 'low',
      extractedData: {},
      incomeType: null,
      payerName: '',
      warnings: [],
      errors: [`OCR failed: ${err.message || 'Unknown error'}`],
      textBlockCount: 0,
      ocrUsed: true,
    };
  } finally {
    // Release canvas pixel buffers (~33 MB each at 300 DPI)
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * Check if a file is HEIC/HEIF format (common on iPhones).
 */
function isHEIC(file: File): boolean {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.heic$/i.test(file.name) ||
    /\.heif$/i.test(file.name)
  );
}

/**
 * Convert HEIC/HEIF file to JPEG blob via lazy-loaded heic2any.
 * Returns the original file as-is if not HEIC.
 */
async function ensureJPEG(file: File): Promise<Blob> {
  if (!isHEIC(file)) return file;

  try {
    const heic2any = (await import('heic2any')).default;
    const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    // heic2any may return a single blob or an array
    return Array.isArray(blob) ? blob[0] : blob;
  } catch {
    throw new Error(
      'Could not convert HEIC image. Please save this image as JPEG or PNG first.',
    );
  }
}

/**
 * Extract data from a photo/image file using OCR.
 * Supports .jpg, .jpeg, .png, .tiff, .heic, .heif.
 *
 * Uses createImageBitmap with imageOrientation and resizeWidth for
 * native off-thread EXIF rotation and downscaling (avoids main-thread blocking).
 */
export async function extractFromImage(
  file: File,
  onProgress?: (stage: import('./ocrService').OCRStage, pct: number) => void,
): Promise<PDFExtractResult> {
  let imageBitmap: ImageBitmap | null = null;
  try {
    // Lazy-load OCR module
    const { recognizeImage, getLastOcrEngine } = await import('./ocrService');

    onProgress?.('loading', 5);

    // Convert HEIC → JPEG if needed (lazy-loads heic2any only when required)
    const imageBlob = await ensureJPEG(file);

    // Create ImageBitmap with EXIF orientation auto-rotation.
    // For large photos (>2MB, likely 12MP+), also apply native off-thread downscaling
    // to 3000px to reduce memory. We use file size as a proxy for resolution to
    // avoid a double createImageBitmap call (which would decode the image twice).
    const bitmapOptions: ImageBitmapOptions = {
      imageOrientation: 'from-image',
    };
    if (imageBlob.size > 2 * 1024 * 1024) {
      (bitmapOptions as any).resizeWidth = 3000;
      (bitmapOptions as any).resizeQuality = 'high';
    }
    imageBitmap = await createImageBitmap(imageBlob, bitmapOptions);

    onProgress?.('loading', 10);

    // Normalize photo pixel coordinates to PDF-point space (letter page = 612pt wide).
    // Without this, findNearbyAmount(maxDistance=200) would search only ~40 points
    // on a 3000px-wide photo because coordinates are ~4.9× larger than expected.
    const PDF_LETTER_WIDTH = 612;
    const scaleFactor = imageBitmap.width > 0 ? imageBitmap.width / PDF_LETTER_WIDTH : 1;

    const textBlocks = await recognizeImage(imageBitmap, onProgress, scaleFactor);
    const ocrEngine = getLastOcrEngine();
    // Keep a raster of the photo. Closing the bitmap first would leave checkbox
    // measurement with no pixels, so a photographed 1098-T could never be ticked.
    const pixelWidth = imageBitmap.width;
    const photo = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (photo) {
      photo.width = imageBitmap.width;
      photo.height = imageBitmap.height;
      photo.getContext('2d')?.drawImage(imageBitmap, 0, 0);
    }
    const dpi = pixelWidth > 0 ? (pixelWidth * 72) / 612 : 72;

    // Close bitmap immediately after OCR — free GPU/memory before processing results
    imageBitmap.close();
    imageBitmap = null;

    if (textBlocks.length === 0) {
      return {
        formType: null,
        confidence: 'low',
        extractedData: {},
        incomeType: null,
        payerName: '',
        warnings: [],
        errors: ['OCR could not extract any text from this image. Try a clearer photo with good lighting.'],
        textBlockCount: 0,
        ocrUsed: true,
        ocrEngine,
      };
    }

    return processTextBlocks(textBlocks, 1, {
      ocrUsed: true,
      ocrEngine,
      ...(photo ? { canvases: [photo], dpi } : {}),
    });
  } catch (err: any) {
    return {
      formType: null,
      confidence: 'low',
      extractedData: {},
      incomeType: null,
      payerName: '',
      warnings: [],
      errors: [`OCR failed: ${err.message || 'Unknown error'}`],
      textBlockCount: 0,
      ocrUsed: true,
    };
  } finally {
    // Release ImageBitmap GPU/memory resources
    if (imageBitmap) {
      imageBitmap.close();
    }
  }
}
