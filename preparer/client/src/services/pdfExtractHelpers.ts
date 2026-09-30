/**
 * PDF Extract Helpers — pure logic for form type detection and field extraction.
 *
 * This module contains NO pdfjs-dist dependency, so it can be unit-tested
 * in Node.js without browser APIs. The main pdfImporter.ts re-exports
 * everything from here and adds the PDF loading/parsing layer.
 */

import { normalizeOCRText, fuzzyIncludes } from './ocrTextMatching';

// ─── Types ─────────────────────────────────────────

export type SupportedFormType = 'W-2' | 'W-2C' | '1099-INT' | '1099-DIV' | '1099-R' | '1099-NEC' | '1099-MISC' | '1099-G' | '1099-B' | '1099-K' | '1099-OID' | 'SSA-1099' | '1099-SA' | '1099-Q'
  | '1098' | '1098-T' | '1098-E' | '1095-A' | 'K-1' | 'W-2G' | '1099-C' | '1099-S';

export interface TextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

/** Located token geometry from a TextBlock. Coordinates are never invented. */
export interface FieldSourceLocation {
  page: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Per-field provenance. Scalars get one location.
 * W-2 box12 stores one entry per located code/amount pair (undefined when not located).
 */
export type FieldSourceLocationValue =
  | FieldSourceLocation
  | Array<FieldSourceLocation | undefined>;

export interface PDFExtractResult {
  formType: SupportedFormType | null;
  confidence: 'high' | 'medium' | 'low';
  extractedData: Record<string, unknown>;
  /**
   * Original OCR/PDF tokens per field. Preserved before numeric coercion so
   * structured extraction can keep "$61,482.17" as rawText and "12O.00" on
   * unknown facts. Absent when the extractor never saw a token for that field.
   */
  fieldRawTokens?: Record<string, string>;
  /**
   * Page + box per field when a text block was located for the token.
   * Absent for missing fields. A printed 0 keeps its box when found.
   * box12 uses a per-entry array instead of one arbitrary box for the whole list.
   */
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>;
  incomeType: string | null;     // The API type key: 'w2', '1099int', etc.
  payerName: string;
  warnings: string[];
  errors: string[];
  textBlockCount: number;
  trace?: ImportTrace;
  ocrUsed?: boolean;             // true when OCR was used (lower confidence)
  /** OCR engine that produced the text. */
  ocrEngine?: 'tesseract';
  ocrAvailable?: boolean;        // true when PDF appears scanned and OCR can be tried
  rawOCRText?: string;           // Raw OCR text for AI enhancement (only when ocrUsed)
  /** Additional forms extracted from a multi-form PDF (e.g., consolidated brokerage statement). */
  additionalResults?: PDFExtractResult[];
}

/** Nearby box amount: parsed value when readable, original token always. */
export interface BoxAmount {
  /** Finite number when the token parses. Undefined when amount-shaped but unreadable. */
  value?: number;
  /** Original source token — never rebuilt from the normalized number. */
  raw: string;
  /** Page of the located text block. Absent when no block was found. */
  page?: number;
  /** Geometry of the located text block. Absent when no block was found. */
  box?: { x: number; y: number; width: number; height: number };
}

/** Build a location only when page and box can identify a token. Never invent. */
export function sourceLocationFromBlock(block: TextBlock): FieldSourceLocation | undefined {
  if (!Number.isInteger(block.page) || block.page < 1) return undefined;
  if (
    !Number.isFinite(block.x) ||
    !Number.isFinite(block.y) ||
    !Number.isFinite(block.width) ||
    !Number.isFinite(block.height)
  ) {
    return undefined;
  }
  if (block.width <= 0 || block.height <= 0) return undefined;
  return {
    page: block.page,
    box: { x: block.x, y: block.y, width: block.width, height: block.height },
  };
}

function recordFieldLocation(
  fieldSourceLocations: Record<string, FieldSourceLocationValue> | undefined,
  fieldKey: string,
  block: TextBlock | undefined,
): void {
  if (!fieldSourceLocations || !block) return;
  const location = sourceLocationFromBlock(block);
  if (location) fieldSourceLocations[fieldKey] = location;
}

// ─── Import Trace Types ───────────────────────────

export interface ImportTraceEntry {
  field: string;                              // Key: "wages", "employerName", "formType"
  label: string;                              // Human-readable: "Wages (Box 1)"
  status: 'found' | 'not_found';
  value?: string;                             // Formatted value for display
  reasoning: string;                          // Brief explanation
}

export interface FormDetectionTrace {
  detectedType: SupportedFormType | null;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  reasoning: string;
}

export interface ImportTrace {
  formDetection: FormDetectionTrace;
  fields: ImportTraceEntry[];
  summary: string;                            // One-line summary: "Found 7 of 9 fields"
  textBlockCount: number;
  pagesScanned: number;
  formPageRange?: { start: number; end: number };              // Pages used for extraction
  additionalForms?: Array<{ type: string; pages: string }>;    // Other forms found in the PDF
}

// ─── Per-Page Form Scanning ──────────────────────────

export interface FormPageSpan {
  type: SupportedFormType;
  incomeType: string;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  startPage: number;   // 1-based inclusive
  endPage: number;     // 1-based inclusive (includes continuation pages)
}

// ─── Form Type Detection ───────────────────────────

interface FormSignature {
  type: SupportedFormType;
  incomeType: string;
  primaryKeywords: string[];
  secondaryKeywords: string[];
}

// ORDERING MATTERS: Forms with keywords that are substrings of other forms
// must come first to prevent false matches. Key ordering rules:
//   • K-1 before 1099-INT — K-1 box labels include "interest income"
//   • W-2G before W-2     — "form w-2" is a prefix of "form w-2g"
//   • 1098-T/E before 1098 — "1098" substring-matches "1098-t"/"1098-e"
const FORM_SIGNATURES: FormSignature[] = [
  {
    type: 'K-1',
    incomeType: 'k1',
    primaryKeywords: ['schedule k-1', 'form 1065', 'form 1120-s', 'form 1041'],
    secondaryKeywords: ['ordinary business income', 'guaranteed payments', "partner's share", 'net rental real estate'],
  },
  {
    type: 'W-2G',
    incomeType: 'w2g',
    primaryKeywords: ['w-2g', 'certain gambling winnings'],
    secondaryKeywords: ['reportable winnings', 'gross winnings', 'type of wager', 'winnings'],
  },
  // A W-2c prints "Corrected Wage and Tax Statement" and "Form W-2c", which hold
  // both W-2 keywords: it must be tried first, and its secondary keywords are a
  // superset of the W-2's so OCR scoring never prefers the W-2 for it.
  {
    type: 'W-2C',
    incomeType: 'w2c',
    primaryKeywords: ['w-2c', 'corrected wage and tax statement'],
    secondaryKeywords: ['previously reported', 'correct information', 'employer', 'wages', 'federal income tax withheld', 'social security'],
  },
  {
    type: 'W-2',
    incomeType: 'w2',
    primaryKeywords: ['wage and tax statement', 'form w-2'],
    secondaryKeywords: ['employer', 'wages', 'federal income tax withheld', 'social security'],
  },
  {
    type: '1099-NEC',
    incomeType: '1099nec',
    primaryKeywords: ['1099-nec', 'nonemployee compensation'],
    secondaryKeywords: ['payer', 'compensation', 'recipient'],
  },
  {
    type: '1099-INT',
    incomeType: '1099int',
    primaryKeywords: ['1099-int', 'interest income'],
    secondaryKeywords: ['payer', 'interest', 'early withdrawal'],
  },
  {
    type: '1099-DIV',
    incomeType: '1099div',
    primaryKeywords: ['1099-div', 'dividends and distributions'],
    secondaryKeywords: ['ordinary dividends', 'qualified dividends', 'capital gain'],
  },
  {
    type: '1099-R',
    incomeType: '1099r',
    primaryKeywords: ['1099-r', 'distributions from pensions'],
    secondaryKeywords: ['gross distribution', 'taxable amount', 'distribution code'],
  },
  {
    type: '1099-MISC',
    incomeType: '1099misc',
    primaryKeywords: ['1099-misc', 'miscellaneous information'],
    secondaryKeywords: ['rents', 'royalties', 'other income', 'payer'],
  },
  {
    type: '1099-G',
    incomeType: '1099g',
    primaryKeywords: ['1099-g', 'certain government payments'],
    secondaryKeywords: ['unemployment', 'state tax refund', 'payer'],
  },
  {
    type: '1099-B',
    incomeType: '1099b',
    primaryKeywords: ['1099-b', 'proceeds from broker'],
    secondaryKeywords: ["broker's name", 'cost basis', 'short-term', 'long-term', 'date sold'],
  },
  {
    type: '1099-K',
    incomeType: '1099k',
    primaryKeywords: ['1099-k', 'payment card and third party'],
    secondaryKeywords: ['payment settlement', 'gross amount', 'card not present', 'third party network'],
  },
  {
    type: '1099-OID',
    incomeType: '1099oid',
    primaryKeywords: ['1099-oid', 'original issue discount'],
    secondaryKeywords: ['other periodic interest', 'acquisition premium', 'market discount'],
  },
  {
    type: 'SSA-1099',
    incomeType: 'ssa1099',
    primaryKeywords: ['ssa-1099', 'social security benefit statement'],
    secondaryKeywords: ['social security administration', 'net benefits', 'benefits paid'],
  },
  {
    type: '1099-SA',
    incomeType: '1099sa',
    primaryKeywords: ['1099-sa', 'distributions from an hsa'],
    secondaryKeywords: ['health savings', 'gross distribution', 'distribution code', 'archer msa'],
  },
  {
    type: '1099-Q',
    incomeType: '1099q',
    primaryKeywords: ['1099-q', 'payments from qualified education'],
    secondaryKeywords: ['education program', 'gross distribution', 'earnings', 'basis'],
  },
  {
    type: '1098-T',
    incomeType: '1098t',
    primaryKeywords: ['1098-t', 'tuition statement'],
    secondaryKeywords: ['qualified tuition', 'scholarships', 'institution'],
  },
  {
    type: '1098-E',
    incomeType: '1098e',
    primaryKeywords: ['1098-e', 'student loan interest statement'],
    secondaryKeywords: ['student loan', 'interest received by lender'],
  },
  {
    type: '1098',
    incomeType: '1098',
    primaryKeywords: ['form 1098', 'mortgage interest statement'],
    secondaryKeywords: ['mortgage interest received', 'outstanding mortgage', 'mortgage insurance'],
  },
  {
    type: '1095-A',
    incomeType: '1095a',
    primaryKeywords: ['1095-a', 'health insurance marketplace'],
    secondaryKeywords: ['enrollment premium', 'slcsp', 'advance payment'],
  },
  {
    type: '1099-C',
    incomeType: '1099c',
    primaryKeywords: ['1099-c', 'cancellation of debt'],
    secondaryKeywords: ['amount of debt', 'discharged', 'identifiable event'],
  },
  {
    type: '1099-S',
    incomeType: '1099s',
    primaryKeywords: ['1099-s', 'proceeds from real estate'],
    secondaryKeywords: ['gross proceeds', 'date of closing', 'transferor'],
  },
];

// ─── Form Type Detection ──────────────────────────

/**
 * Detect form type from extracted text blocks.
 *
 * When `ocrMode` is true, uses fuzzy matching (Levenshtein distance ≤ 2)
 * for keyword detection instead of exact substring matching.
 * This compensates for OCR character recognition errors like "1099-NFC"
 * instead of "1099-NEC". Confidence is capped at 'low' for OCR results.
 *
 * When `ocrMode` is false/undefined, behavior is identical to pre-OCR
 * (exact substring matching via String.includes).
 */
export function detectFormType(textBlocks: TextBlock[], ocrMode?: boolean): {
  type: SupportedFormType | null;
  incomeType: string | null;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
} {
  let allText = textBlocks.map(b => b.text.toLowerCase()).join(' ');

  // OCR-specific preprocessing: normalize common artifacts
  if (ocrMode) {
    allText = normalizeOCRText(allText);

    // OCR fuzzy matching is lossy — "form 1099" matches "form 1065" at
    // distance 2, and "w-2 " matches "w-2g" at distance 1. Instead of
    // returning the first match, collect all matches and return the one
    // with the highest score (primary matches × 10 + secondary matches).
    let bestMatch: { type: SupportedFormType; incomeType: string; confidence: 'low'; matchedKeywords: string[] } | null = null;
    let bestScore = 0;

    for (const sig of FORM_SIGNATURES) {
      const matchedPrimary = sig.primaryKeywords.filter((kw: string) => fuzzyIncludes(allText, kw, 2));
      const matchedSecondary = sig.secondaryKeywords.filter((kw: string) => fuzzyIncludes(allText, kw, 2));
      const matched = [...matchedPrimary, ...matchedSecondary];

      if (matchedPrimary.length > 0) {
        const score = matchedPrimary.length * 10 + matchedSecondary.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { type: sig.type, incomeType: sig.incomeType, confidence: 'low', matchedKeywords: matched };
        }
      }
    }

    return bestMatch ?? { type: null, incomeType: null, confidence: 'low', matchedKeywords: [] };
  }

  // Digital PDF path: exact substring matching (unchanged)
  for (const sig of FORM_SIGNATURES) {
    const matchedPrimary = sig.primaryKeywords.filter(kw => allText.includes(kw));
    const matchedSecondary = sig.secondaryKeywords.filter(kw => allText.includes(kw));
    const matched = [...matchedPrimary, ...matchedSecondary];

    if (matchedPrimary.length > 0 && matchedSecondary.length >= 2) {
      return { type: sig.type, incomeType: sig.incomeType, confidence: 'high', matchedKeywords: matched };
    }
    if (matchedPrimary.length > 0) {
      return { type: sig.type, incomeType: sig.incomeType, confidence: 'medium', matchedKeywords: matched };
    }
  }

  return { type: null, incomeType: null, confidence: 'low', matchedKeywords: [] };
}

// ─── Per-Page Form Detection ─────────────────────────

/**
 * Scan a multi-page PDF page-by-page and return contiguous form spans.
 *
 * Each span represents one detected IRS form across one or more consecutive
 * pages. Pages that don't match any form before the first detected form are
 * skipped (intro/summary pages). Pages that don't match any form after a
 * detected form are treated as continuation pages (e.g., K-1 page 2, 1099-B
 * continuation sheets) and merged into the preceding span.
 *
 * Returns spans sorted by startPage. An empty array means no supported form
 * was detected on any page.
 */
export function detectFormPages(
  textBlocks: TextBlock[],
  ocrMode?: boolean,
): FormPageSpan[] {
  // Group blocks by page
  const pageMap = new Map<number, TextBlock[]>();
  for (const block of textBlocks) {
    let arr = pageMap.get(block.page);
    if (!arr) {
      arr = [];
      pageMap.set(block.page, arr);
    }
    arr.push(block);
  }

  const pages = [...pageMap.keys()].sort((a, b) => a - b);
  if (pages.length <= 1) return []; // Single-page — caller should use legacy detection

  // Detect form type on each page independently
  interface PageDetection {
    page: number;
    type: SupportedFormType | null;
    incomeType: string | null;
    confidence: 'high' | 'medium' | 'low';
    matchedKeywords: string[];
  }

  const detections: PageDetection[] = pages.map(page => {
    const blocks = pageMap.get(page)!;
    const result = detectFormType(blocks, ocrMode);
    return { page, ...result };
  });

  // Build contiguous form spans
  const spans: FormPageSpan[] = [];
  let currentSpan: FormPageSpan | null = null;

  for (const det of detections) {
    if (det.type !== null) {
      if (currentSpan && det.type === currentSpan.type) {
        // Same form type — extend the current span
        currentSpan.endPage = det.page;
        currentSpan.matchedKeywords = [
          ...new Set([...currentSpan.matchedKeywords, ...det.matchedKeywords]),
        ];
        // Upgrade confidence if this page had higher confidence
        if (det.confidence === 'high') currentSpan.confidence = 'high';
        else if (det.confidence === 'medium' && currentSpan.confidence === 'low')
          currentSpan.confidence = 'medium';
      } else {
        // Different form type — close current span, start new one
        if (currentSpan) spans.push(currentSpan);
        currentSpan = {
          type: det.type,
          incomeType: det.incomeType!,
          confidence: det.confidence,
          matchedKeywords: [...det.matchedKeywords],
          startPage: det.page,
          endPage: det.page,
        };
      }
    } else {
      // No form detected on this page
      if (currentSpan) {
        // Treat as continuation page of the preceding form
        currentSpan.endPage = det.page;
      }
      // If no current span, this is a leading intro page — skip it
    }
  }

  // Don't forget to push the last span
  if (currentSpan) spans.push(currentSpan);

  return spans;
}

// ─── Word-to-Phrase Grouping ─────────────────────────

/**
 * Group word-level TextBlocks into phrase-level TextBlocks.
 *
 * PDF text extractors (Syncfusion, pdfjs-dist) produce individual words
 * as separate TextBlocks. The extraction pipeline's findLabelBlock() needs
 * multi-word phrases like "wages, tips" to match keywords.
 *
 * Groups words that are:
 * 1. On the same page
 * 2. On the same Y line (within yTolerance)
 * 3. Horizontally adjacent (X gap < xGapThreshold)
 *
 * The X-gap splitting preserves column structure on IRS forms — labels
 * in the left column stay separate from labels in the right column.
 */
export function groupWordsToPhrases(
  words: TextBlock[],
  yTolerance = 5,
  xGapThreshold = 15,
): TextBlock[] {
  if (words.length === 0) return [];

  // Sort strictly by page, then Y (no tolerance in sort — avoids violating
  // strict weak ordering like groupWordsToLines in ocrService.ts)
  const sorted = [...words].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.y - b.y;
  });

  // Step 1: Group into rows by Y tolerance
  const rows: TextBlock[][] = [];
  let currentRow: TextBlock[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const word = sorted[i];
    if (word.page === currentRow[0].page && Math.abs(word.y - currentRow[0].y) <= yTolerance) {
      currentRow.push(word);
    } else {
      rows.push(currentRow);
      currentRow = [word];
    }
  }
  rows.push(currentRow);

  // Step 2: Within each row, sort by X and split into phrases by X gap
  const phrases: TextBlock[] = [];
  for (const row of rows) {
    const xSorted = [...row].sort((a, b) => a.x - b.x);
    let phraseWords: TextBlock[] = [xSorted[0]];

    for (let i = 1; i < xSorted.length; i++) {
      const word = xSorted[i];
      const prev = phraseWords[phraseWords.length - 1];
      const gap = word.x - (prev.x + prev.width);

      // IRS box-number boundary detection: when we encounter a standalone
      // 1-2 digit number (e.g., "1", "2a", "14") after an existing phrase
      // of 2+ words, force a phrase break. This prevents header text from
      // merging with box labels (e.g., "PAYER name address ZIP 1 Unemployment
      // compensation" should split at "1" into two phrases).
      const isBoxNumBoundary = phraseWords.length >= 2 &&
        /^\d{1,2}[a-z]?$/i.test(word.text.trim());

      if (gap < xGapThreshold && !isBoxNumBoundary) {
        phraseWords.push(word);
      } else {
        phrases.push(mergePhraseWords(phraseWords));
        phraseWords = [word];
      }
    }
    phrases.push(mergePhraseWords(phraseWords));
  }

  return phrases;
}

/** Merge an array of words into a single phrase TextBlock. */
function mergePhraseWords(words: TextBlock[]): TextBlock {
  if (words.length === 1) return words[0];

  const text = words.map(w => w.text).join(' ');
  const x = words[0].x;
  const y = Math.min(...words.map(w => w.y));
  const rightEdge = Math.max(...words.map(w => w.x + w.width));
  const width = rightEdge - x;
  const height = Math.max(...words.map(w => w.height));

  return { text, x, y, width, height, page: words[0].page };
}

// ─── Field Extraction ──────────────────────────────

/** Regex for "pure numeric" text — digits with optional $, comma, period, minus. */
const PURE_NUMERIC_RE = /^-?[\d,]+\.?\d*$/;

/**
 * Amount-shaped but not a clean number — OCR corruption like "12O.00" or "$1,2O3.00".
 * Excludes dates, EINs, and mixed value+date blocks.
 */
function isUnreadableAmountToken(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 32) return false;
  if (!/\d/.test(t)) return false;
  // Mixed content (value + date/words) uses other extraction strategies.
  if (/\s/.test(t)) return false;
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(t)) return false;
  if (/^\d{2}-\d{7}$/.test(t)) return false;
  // Must look money-like: $, decimal, grouping — with a non-digit OCR glitch
  if (/[$]/.test(t) || /\d[.,]\d/.test(t) || /[.,]\d{1,2}$/.test(t)) {
    const cleaned = t.replace(/[$,()]/g, '');
    return !PURE_NUMERIC_RE.test(cleaned) && /[^\d.\-]/.test(cleaned);
  }
  return false;
}

/**
 * Find the nearest amount near a label text.
 * Returns the original token plus a parsed value when readable.
 * Amount-shaped but unreadable tokens (e.g. "12O.00") return raw without a value.
 * Missing boxes return undefined — distinct from a printed $0.
 * When a text block is located, page + box come from that block (never invented).
 */
function findNearbyAmount(textBlocks: TextBlock[], labelBlock: TextBlock, maxDistance = 400): BoxAmount | undefined {
  const candidates: Array<{ value: number; raw: string; distance: number; block: TextBlock }> = [];
  const unreadable: Array<{ raw: string; distance: number; block: TextBlock }> = [];
  const rejected: Array<{ text: string; value: number; reason: string; dx: number; dy: number; dist: number }> = [];

  const labelLeft = labelBlock.x;
  const labelRight = labelBlock.x + labelBlock.width;

  for (const block of textBlocks) {
    if (block === labelBlock) continue;
    // Same-page only — a near-x/y match on another page must not win provenance.
    if (block.page !== labelBlock.page) continue;

    const trimmed = block.text.trim();

    // Calculate X distance from nearest point on label (not just right edge).
    let dx: number;
    if (block.x >= labelLeft && block.x <= labelRight) {
      dx = 0;
    } else if (block.x < labelLeft) {
      dx = block.x - labelLeft;
    } else {
      dx = block.x - labelRight;
    }

    const dy = block.y - labelBlock.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!(distance < maxDistance && (dx >= -20 || dy > 0))) {
      continue;
    }

    let belowBias = 0;
    if (dy < 0) {
      belowBias = dx === 0 ? 100 : 50;
    }
    const scoredDistance = distance + belowBias;

    // Intervening-label guard (same rules as before).
    const minY = Math.min(labelBlock.y, block.y);
    const maxY = Math.max(labelBlock.y, block.y);
    const labelMidX = labelBlock.x + labelBlock.width / 2;
    const yThreshold = dy < 0 ? 10 : (dx === 0 ? 120 : 30);
    const hasInterveningLabel = (maxY - minY > yThreshold) && textBlocks.some(b => {
      if (b === labelBlock || b === block) return false;
      if (b.y <= minY || b.y >= maxY) return false;
      if (Math.abs(b.x - labelMidX) > 150) return false;
      return /^\d{1,2}[a-z]?\s/i.test(b.text.trim());
    });
    if (hasInterveningLabel) {
      continue;
    }

    // Extract number from text — must be purely numeric (not a label containing a digit).
    // Fallback: mixed-content blocks with a leading dollar amount.
    const cleaned = block.text.replace(/[$,\s]/g, '');
    let num: number | undefined;
    let raw = trimmed;

    if (PURE_NUMERIC_RE.test(cleaned)) {
      const rawTokens = block.text.replace(/[$,]/g, '').trim().split(/\s+/);
      if (rawTokens.length > 1 && rawTokens.every(t => PURE_NUMERIC_RE.test(t))) {
        const fullText = block.text.replace(/[$,]/g, '').trim();
        let bestToken = rawTokens[0];
        let bestDist = Infinity;
        let charPos = 0;
        for (const token of rawTokens) {
          const tokenX = block.x + (charPos / fullText.length) * block.width;
          const dist = Math.abs(tokenX - labelBlock.x);
          if (dist < bestDist) { bestDist = dist; bestToken = token; }
          charPos += token.length + 1;
        }
        num = parseFloat(bestToken);
        raw = bestToken;
      } else {
        num = parseFloat(cleaned);
        raw = trimmed; // keep "$61,482.17" / "0.00" as printed
      }
    } else {
      // Prefer whole-token unreadable detection before partial dollar/leading parses
      // so "$12O.00" stays unknown instead of becoming 12.
      if (isUnreadableAmountToken(trimmed)) {
        unreadable.push({ raw: trimmed, distance: scoredDistance, block });
        continue;
      }
      const dollarMatch = block.text.match(/\$\s*([\d,]+\.?\d*)/);
      const leadingMatch = block.text.match(/^-?([\d,]+\.\d+)\s+[A-Za-z]/) ||
                           block.text.match(/^-?(\d{3}[\d,]*)\s+[A-Za-z]/);
      const dateTrailingMatch = block.text.match(/^-?([\d,]+\.?\d+)\s+\d{1,2}[\/\-]\d{1,2}/);
      if (dollarMatch && PURE_NUMERIC_RE.test(dollarMatch[1].replace(/,/g, ''))) {
        num = parseFloat(dollarMatch[1].replace(/,/g, ''));
        raw = dollarMatch[0].replace(/\s+/g, '');
      } else if (leadingMatch) {
        num = parseFloat(leadingMatch[1].replace(/,/g, ''));
        raw = leadingMatch[1];
      } else if (dateTrailingMatch) {
        num = parseFloat(dateTrailingMatch[1].replace(/,/g, ''));
        raw = dateTrailingMatch[1];
      } else {
        continue;
      }
    }

    if (num === undefined || isNaN(num)) {
      if (isUnreadableAmountToken(trimmed)) {
        unreadable.push({ raw: trimmed, distance: scoredDistance, block });
      }
      continue;
    }

    candidates.push({ value: num, raw, distance: scoredDistance, block });
  }

  // Rank readable and unreadable together by distance so a nearby OCR
  // corruption ("12O.00") is not overridden by a farther clean number.
  type Ranked = { distance: number; amount: BoxAmount };
  const ranked: Ranked[] = [
    ...candidates.map((c) => ({
      distance: c.distance,
      amount: {
        value: Math.round(c.value * 100) / 100,
        raw: c.raw,
        page: c.block.page,
        box: { x: c.block.x, y: c.block.y, width: c.block.width, height: c.block.height },
      } as BoxAmount,
    })),
    ...unreadable.map((u) => ({
      distance: u.distance,
      amount: {
        raw: u.raw,
        page: u.block.page,
        box: { x: u.block.x, y: u.block.y, width: u.block.width, height: u.block.height },
      } as BoxAmount,
    })),
  ];

  if (ranked.length > 0) {
    ranked.sort((a, b) => a.distance - b.distance);
    return ranked[0].amount;
  }

  if (rejected.length > 0) {
    console.debug(`[PDFExtract] Label "${labelBlock.text.substring(0, 40)}" — ${rejected.length} numeric blocks REJECTED:`, rejected);
  }
  return undefined;
}

/**
 * Find the nearest numeric value near a label text.
 * Searches to the right and below the label.
 *
 * Only considers blocks whose text is a pure number (after stripping $ and whitespace).
 * This prevents parsing labels like "2 Federal income tax withheld" as the number 2.
 *
 * Uses closest-point distance from the label (not just right edge) so values
 * under wide merged labels are still found. Adds a below-bias: on IRS forms,
 * box values are always below their labels, so values above get a 20px penalty.
 */
function findNearbyNumber(textBlocks: TextBlock[], labelBlock: TextBlock, maxDistance = 400): number | undefined {
  return findNearbyAmount(textBlocks, labelBlock, maxDistance)?.value;
}

/**
 * Extract a number associated with a box label (e.g., "Box 1", "1 Wages").
 * Returns undefined when the box/label or nearby value is absent, or when the
 * token is amount-shaped but unreadable (raw token is still recorded when asked).
 * A genuine printed $0 stays numeric 0 — never coerce missing → 0.
 * When a token is located, page + box are recorded from that TextBlock.
 */
function extractBoxValue(
  textBlocks: TextBlock[],
  boxKeywords: string[],
  fieldRawTokens?: Record<string, string>,
  fieldKey?: string,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): number | undefined {
  const label = findLabelBlock(textBlocks, boxKeywords);
  if (!label) {
    console.debug(`[PDFExtract] No label found for keywords: ${boxKeywords.join(', ')}`);
    return undefined;
  }
  const amount = findNearbyAmount(textBlocks, label);
  if (!amount) {
    console.debug(`[PDFExtract] Label "${label.text}" at (${Math.round(label.x)},${Math.round(label.y)}) page=${label.page} w=${Math.round(label.width)} — no value found. Keywords: ${boxKeywords[0]}`);
    const allBlocks = textBlocks
      .map(b => ({ text: b.text.substring(0, 60), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), p: b.page }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    console.debug(`[PDFExtract] ALL ${allBlocks.length} text blocks:`, allBlocks);
    return undefined;
  }
  if (fieldKey) {
    if (fieldRawTokens) {
      fieldRawTokens[fieldKey] = amount.raw;
    }
    if (
      fieldSourceLocations &&
      typeof amount.page === 'number' &&
      amount.box
    ) {
      const location = sourceLocationFromBlock({
        text: amount.raw,
        page: amount.page,
        x: amount.box.x,
        y: amount.box.y,
        width: amount.box.width,
        height: amount.box.height,
      });
      if (location) fieldSourceLocations[fieldKey] = location;
    }
  }
  return amount.value;
}

/**
 * Find a text block containing a keyword.
 *
 * Iterates keywords in order (most-specific first), then scans blocks for
 * each keyword. This ensures "employer's name" is matched before the more
 * generic "employer" — preventing the EIN label from being selected when
 * the actual employer-name label exists.
 */
function findLabelBlock(textBlocks: TextBlock[], keywords: string[]): TextBlock | null {
  for (const kw of keywords) {
    let fallback: TextBlock | null = null;
    const kwCompact = kw.replace(/\s+/g, '');
    for (const block of textBlocks) {
      const blockLower = block.text.toLowerCase();
      const blockCompact = blockLower.replace(/\s+/g, '');
      // Match normally OR via compact form (collapses letter-spaced IRS labels
      // like "4 F e d e r a l i n c o m e t a x w i t h h e l d")
      if (blockLower.includes(kw) || blockCompact.includes(kwCompact)) {
        // Reject merged form headers — wide blocks (>300px) containing multiple
        // header terms (payer, address, city, ZIP, OMB etc.) that happen to also
        // include a box keyword. These mega-blocks span the full form width and
        // make proximity-based value matching impossible.
        if (isMergedHeader(block)) continue;

        // Prefer blocks that start with an IRS box number (e.g. "1 Interest income")
        // over form titles (e.g. "Interest Income") — box labels are more precise.
        if (/^\d{1,2}[a-z]?\s/i.test(block.text.trim())) {
          return block;
        }
        if (!fallback) fallback = block;
      }
    }
    if (fallback) return fallback;
  }
  return null;
}

/** Detect merged form headers — wide blocks containing multiple header/boilerplate terms. */
function isMergedHeader(block: TextBlock): boolean {
  if (block.width < 250) return false;
  const lower = block.text.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const headerTerms = ['payer', 'address', 'city', 'state', 'zip', 'omb', 'street', 'employer', 'filer', 'borrower'];
  const matchCount = headerTerms.filter(t => lower.includes(t) || compact.includes(t)).length;
  return matchCount >= 3;
}

/**
 * Extract name from the top area of the PDF (typically payer/employer info).
 * When a name block is located, page + box are recorded under fieldKey.
 */
function extractPayerName(
  textBlocks: TextBlock[],
  keywords: string[],
  fieldRawTokens?: Record<string, string>,
  fieldKey?: string,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): string {
  /** Reject blocks that look like IRS labels/boilerplate rather than actual names.
   *  Strategy: use STRUCTURAL patterns (not word blocklists) so real company names
   *  like "Vanguard Retirement Plan Services" aren't falsely rejected. */
  const isLabelText = (text: string): boolean => {
    const lower = text.toLowerCase();
    const compact = lower.replace(/\s+/g, '');
    const trimmed = text.trim();

    // 1. Spaced-out text: if more than 3 single-char "words", it's letter-spaced label text
    const words = trimmed.split(/\s+/);
    if (words.filter(w => w.length === 1).length > 3) return true;

    // 2. Core IRS field labels that would NEVER be a company name on their own
    //    (these are form structure terms, not content descriptors)
    const coreLabels = /\b(employer'?s?|payer'?s?|recipient'?s?|filer'?s?|borrower'?s?|lender'?s?|student'?s?)\b.*\b(name|tin|address|identification)\b/;
    if (coreLabels.test(lower) || coreLabels.test(compact)) return true;

    // 3. Standalone IRS structural terms (would never be an entity name alone)
    const structuralPattern = /\b(address|zip\s*code|postal\s*code|telephone|province|city or town|corrected|if checked|void|identification|department of the treasury|internal revenue|nonemployee compensation|account\s*number|recipient(?!'s)|consumer products|resale|parachute|negligence|penalty|sanction|furnished|taxable|important tax)\b/;
    if (structuralPattern.test(lower) || structuralPattern.test(compact)) return true;

    // 4. Text ending with preposition/conjunction — clearly a fragment, not a name
    //    "Retirement or", "Distributions From", "Broker and", "qualified tuition and related"
    if (/\b(or|and|from|of|the|in|to|for|a|an|this|your|its?)\s*,?\s*$/i.test(trimmed)) return true;

    // 5. Text starting with IRS instruction verbs — "Report this", "Attach this", "See instructions"
    if (/^(report|attach|see|check|enter|include|if\b|do not|you\b|this\b)/i.test(trimmed)) return true;

    // 6. Specific IRS boilerplate phrases from various form descriptions
    if (/^(not determined|total distribution|copy [a-z]|miscellaneous|certain government)/i.test(trimmed)) return true;
    if (/^qualified\s+tuition/i.test(trimmed)) return true;
    if (/^(distributions?\s+from\s+pensions|pensions,?\s+annuities)/i.test(trimmed)) return true;

    // 7. Very short single-word text (≤8 chars) — almost never a real entity name
    //    Catches fragments like "Total", "Plans", "Copy", "etc."
    if (trimmed.length <= 8 && !/\s/.test(trimmed) && /^[a-z]+\.?$/i.test(trimmed)) return true;

    // 8. IRS box prefix like "c Employer's..." or "2b Taxable amount"
    if (/^[a-z]\s/i.test(text)) return true;
    if (/^\d{1,2}[a-z]?\s+[A-Z]/i.test(trimmed)) return true;

    return false;
  };

  let chosen: TextBlock | undefined;

  // Look for the label first
  const labelBlock = findLabelBlock(textBlocks, keywords);
  if (labelBlock) {
    // Find text below/near the label that looks like a name
    // Widened search: 150px horizontal, 80px vertical (real W-2 boxes are tall)
    const candidates = textBlocks.filter(b =>
      b !== labelBlock &&
      b.page === labelBlock.page &&
      Math.abs(b.x - labelBlock.x) < 150 &&
      b.y > labelBlock.y &&
      b.y < labelBlock.y + 80 &&
      b.text.length > 2 &&
      !/^\d/.test(b.text) &&
      !b.text.includes('Box') &&
      !b.text.includes('$') &&
      !b.text.toLowerCase().includes('form') &&
      !/\bOMB\b/i.test(b.text) &&
      !isLabelText(b.text),
    );
    if (candidates.length > 0) {
      chosen = candidates[0];
    }
  }

  // Fallback: look for company-like text in the top portion
  if (!chosen) {
    const topBlocks = textBlocks
      .filter(b => b.page === 1 && b.y < 200 && b.text.length > 3)
      .filter(b => b !== labelBlock) // exclude the label we already found
      .filter(b => !/^\d|form|copy|department|internal|treasury|statement|corrected|void/i.test(b.text))
      .filter(b => !b.text.includes('$'))
      .filter(b => !/\bOMB\b/i.test(b.text))
      .filter(b => !/\btotaling\b/i.test(b.text))
      .filter(b => !/\brequirement\b/i.test(b.text))
      .filter(b => !isLabelText(b.text));
    if (topBlocks.length > 0) chosen = topBlocks[0];
  }

  const text = chosen?.text ?? '';
  if (fieldKey && text && chosen) {
    if (fieldRawTokens) fieldRawTokens[fieldKey] = text;
    recordFieldLocation(fieldSourceLocations, fieldKey, chosen);
  }
  return text;
}

/** Located nearby text plus the block it came from (when found). */
interface LocatedText {
  text: string;
  block?: TextBlock;
}

/**
 * Find the nearest raw text value near a label.
 * Like findNearbyNumber but preserves the string — use for tax codes, not amounts.
 * Uses closest-point distance and below-bias (same as findNearbyNumber).
 * Candidates are restricted to the label's page.
 */
function findNearbyText(textBlocks: TextBlock[], labelBlock: TextBlock, maxDistance = 400): LocatedText {
  const candidates: Array<{ text: string; distance: number; block: TextBlock }> = [];

  const labelLeft = labelBlock.x;
  const labelRight = labelBlock.x + labelBlock.width;

  for (const block of textBlocks) {
    if (block === labelBlock) continue;
    if (block.page !== labelBlock.page) continue;

    // Skip blocks that look like IRS box labels (e.g., "5 Transaction type",
    // "7 W i n n i n g s..." where letter-spaced labels also start with a digit).
    // These are digit-prefixed labels for other boxes, not values.
    if (/^\d{1,2}[a-z]?\s+[A-Za-z]/i.test(block.text.trim()) && block.text.trim().length > 3) continue;

    // Skip standalone currency symbols, punctuation, or very short non-text noise
    const trimmed = block.text.trim();
    if (/^[$€£¥%#.,;:]+$/.test(trimmed)) continue;

    // Skip blocks that look like dollar amounts (e.g., "5000.00", "$1,200.00")
    // — findNearbyText is for text values like wager types, not numbers
    if (/^\$?[\d,]+\.\d{2}\b/.test(trimmed)) continue;

    let dx: number;
    if (block.x >= labelLeft && block.x <= labelRight) {
      dx = 0;
    } else if (block.x < labelLeft) {
      dx = block.x - labelLeft;
    } else {
      dx = block.x - labelRight;
    }

    const dy = block.y - labelBlock.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < maxDistance && (dx >= -20 || dy > 0)) {
      let belowBias = 0;
      if (dy < 0) {
        belowBias = dx === 0 ? 100 : 50;
      }
      candidates.push({ text: trimmed, distance: distance + belowBias, block });
    }
  }

  if (candidates.length === 0) return { text: '' };
  candidates.sort((a, b) => a.distance - b.distance);
  return { text: candidates[0].text, block: candidates[0].block };
}

/**
 * Extract a text (non-numeric) value associated with a box label.
 * Use for distribution codes, category codes, etc. — not dollar amounts.
 * When a block is located, page + box are recorded under fieldKey (never invented).
 */
function extractBoxText(
  textBlocks: TextBlock[],
  boxKeywords: string[],
  fieldRawTokens?: Record<string, string>,
  fieldKey?: string,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): string {
  const located = extractLocatedBoxText(textBlocks, boxKeywords);
  if (fieldKey && located.text) {
    if (fieldRawTokens) fieldRawTokens[fieldKey] = located.text;
    recordFieldLocation(fieldSourceLocations, fieldKey, located.block);
  }
  return located.text;
}

/** Locate box text and return the chosen block (if any) without recording. */
function extractLocatedBoxText(textBlocks: TextBlock[], boxKeywords: string[]): LocatedText {
  const label = findLabelBlock(textBlocks, boxKeywords);
  if (!label) return { text: '' };
  return findNearbyText(textBlocks, label);
}

// ─── Form-Specific Extractors ──────────────────────

const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY',
]);

export function extractW2Fields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);

  const fields: Record<string, unknown> = {
    employerName: extractPayerName(
      textBlocks,
      ["employer’s name", "employer's name", 'employer name', 'employer'],
      fieldRawTokens,
      'employerName',
      fieldSourceLocations,
    ),
    wages: box('wages', ['wages, tips', '1 wages', 'box 1']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '2 federal', 'box 2']),
    socialSecurityWages: box('socialSecurityWages', ['social security wages', '3 social security wages', 'box 3']),
    socialSecurityTax: box('socialSecurityTax', ['social security tax', '4 social security tax', 'box 4']),
    medicareWages: box('medicareWages', ['medicare wages', '5 medicare wages', 'box 5']),
    medicareTax: box('medicareTax', ['medicare tax', '6 medicare tax', 'box 6']),
  };
  const ein = extractEmployerEin(textBlocks, fieldRawTokens, fieldSourceLocations);
  if (ein) fields.employerEin = ein;

  // ── Boxes 15-17 (State section): Positional extraction ──
  //
  // The W-2 state section has boxes 15-20 on the same Y line with tiny X gaps
  // (5-15px), which causes groupWordsToPhrases to merge labels into one huge
  // phrase. The keyword→findNearbyNumber pipeline fails because the merged
  // label is wider than maxDistance=200. Instead, find the 2-letter state code
  // directly, then pick up numeric values to its right on the same line.
  const page1Blocks = textBlocks.filter(b => b.page === 1);
  const maxY = page1Blocks.length > 0 ? Math.max(...page1Blocks.map(b => b.y)) : 0;

  let stateBlock: TextBlock | null = null;
  for (const block of page1Blocks) {
    if (block.y < maxY * 0.55) continue; // Bottom ~45% of the form
    const text = block.text.trim().toUpperCase();
    if (text.length === 2 && US_STATE_CODES.has(text)) {
      fields.state = text;
      stateBlock = block;
      recordFieldLocation(fieldSourceLocations, 'state', block);
      break;
    }
  }

  if (stateBlock) {
    // Find pure numeric values on the same line as the state code, to its right.
    // On W-2s: first number = state wages (Box 16), second = state tax (Box 17).
    const sameLineNumbers = textBlocks.filter(b => {
      if (b.page !== stateBlock!.page) return false;
      if (Math.abs(b.y - stateBlock!.y) > 10) return false;
      if (b.x <= stateBlock!.x + stateBlock!.width) return false;
      const cleaned = b.text.replace(/[$,\s]/g, '');
      return PURE_NUMERIC_RE.test(cleaned);
    }).sort((a, b) => a.x - b.x);

    if (sameLineNumbers.length > 0) {
      fields.stateWages = parseFloat(sameLineNumbers[0].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.stateWages = sameLineNumbers[0].text.trim();
      recordFieldLocation(fieldSourceLocations, 'stateWages', sameLineNumbers[0]);
    }
    if (sameLineNumbers.length > 1) {
      fields.stateTaxWithheld = parseFloat(sameLineNumbers[1].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.stateTaxWithheld = sameLineNumbers[1].text.trim();
      recordFieldLocation(fieldSourceLocations, 'stateTaxWithheld', sameLineNumbers[1]);
    }
  } else {
    // Fallback: keyword approach (works when phrases are well-separated)
    fields.stateWages = box('stateWages', ['state wages', '16 state wages', 'box 16']);
    fields.stateTaxWithheld = box('stateTaxWithheld', ['state income tax', '17 state income tax', 'box 17']);

    const locatedState = extractLocatedBoxText(textBlocks, ['15 state', "employer's state", 'state id']);
    const stateCode = locatedState.text.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);
    if (US_STATE_CODES.has(stateCode)) {
      fields.state = stateCode;
      if (fieldRawTokens) fieldRawTokens.state = locatedState.text;
      recordFieldLocation(fieldSourceLocations, 'state', locatedState.block);
    }
  }

  // Box 12a-12d: Best-effort extraction of code + amount pairs.
  // Provenance is per entry — never one arbitrary box for the whole array.
  const box12: { code: string; amount: number }[] = [];
  const box12Locations: Array<FieldSourceLocation | undefined> = [];
  for (const suffix of ['12a', '12b', '12c', '12d']) {
    const located = extractLocatedBoxText(textBlocks, [suffix, `box ${suffix}`]);
    if (located.text) {
      // Expect format like "D 5000.00" or "DD 12000" or just a code letter
      const match = located.text.match(/^([A-Za-z]{1,2})\s+[\$]?([\d,]+\.?\d*)/);
      if (match) {
        box12.push({ code: match[1].toUpperCase(), amount: parseFloat(match[2].replace(/,/g, '')) });
        box12Locations.push(located.block ? sourceLocationFromBlock(located.block) : undefined);
      }
    }
  }
  if (box12.length > 0) {
    fields.box12 = box12;
    if (fieldSourceLocations) {
      fieldSourceLocations.box12 = box12Locations;
    }
    if (fieldRawTokens) {
      fieldRawTokens.box12 = box12
        .map((e, i) => {
          // Prefer the located token text when present; else code+amount summary.
          return `${e.code} ${e.amount}`;
        })
        .join('; ');
    }
  }

  // Box 13: Best-effort checkbox detection — carry the selected block's location.
  const box13: Record<string, boolean> = {};
  const locatedBox13 = extractLocatedBoxText(textBlocks, ['13', 'statutory', 'retirement']);
  if (locatedBox13.text) {
    const lower = locatedBox13.text.toLowerCase();
    if (lower.includes('statutory') && (lower.includes('x') || lower.includes('yes') || lower.includes('checked'))) {
      box13.statutoryEmployee = true;
    }
    if (lower.includes('retirement') && (lower.includes('x') || lower.includes('yes') || lower.includes('checked'))) {
      box13.retirementPlan = true;
    }
  }
  if (Object.keys(box13).length > 0) {
    fields.box13 = box13;
    if (fieldRawTokens) fieldRawTokens.box13 = locatedBox13.text;
    recordFieldLocation(fieldSourceLocations, 'box13', locatedBox13.block);
  }

  return fields;
}

export function extract1099INTFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    amount: box('amount', ['interest income', '1 interest', 'box 1']),
    earlyWithdrawalPenalty: box('earlyWithdrawalPenalty', ['early withdrawal penalty', '2 early withdrawal', 'box 2']),
    usBondInterest: box('usBondInterest', ['u.s. savings bond', '3 interest on u.s.', 'box 3']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
    taxExemptInterest: box('taxExemptInterest', ['tax-exempt interest', '8 tax-exempt', 'box 8']),
  };
}

export function extract1099DIVFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    ordinaryDividends: box('ordinaryDividends', ['ordinary dividends', '1a ordinary', 'box 1a']),
    qualifiedDividends: box('qualifiedDividends', ['qualified dividends', '1b qualified', 'box 1b']),
    capitalGainDistributions: box('capitalGainDistributions', ['capital gain distributions', 'capital gain distr', '2a total capital', '2a capital', 'box 2a']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
    foreignTaxPaid: box('foreignTaxPaid', ['foreign tax paid', '7 foreign', 'box 7']),
  };
}

export function extract1099RFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    grossDistribution: box('grossDistribution', ['gross distribution', '1 gross', 'box 1']),
    taxableAmount: box('taxableAmount', ['taxable amount', '2a taxable', 'box 2a']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
    distributionCode: extractBoxText(textBlocks, ['distribution code', '7 distribution code', 'box 7'], fieldRawTokens, 'distributionCode', fieldSourceLocations),
  };
}

export function extract1099NECFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    amount: extractBoxValue(
      textBlocks,
      ['nonemployee compensation', '1 nonemployee', 'box 1'],
      fieldRawTokens,
      'amount',
      fieldSourceLocations,
    ),
  };
}

export function extract1099MISCFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    rents: box('rents', ['rents', '1 rents', 'box 1']),
    royalties: box('royalties', ['royalties', '2 royalties', 'box 2']),
    otherIncome: box('otherIncome', ['other income', '3 other income', 'box 3']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
    stateTaxWithheld: box('stateTaxWithheld', ['state tax withheld', '16 state tax', 'box 16']),
  };
}

export function extract1099GFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    unemploymentCompensation: box('unemploymentCompensation', ['unemployment compensation', '1 unemployment', 'box 1']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
  };
}

// ─── W-2c (Rev. January 2026) ─────────────────────────────

/**
 * The W-2c boxes the return uses. Each is printed twice side by side — as
 * previously reported, then as corrected — and the state boxes four times
 * (two state lines, each previously reported / correct).
 */
const W2C_BOXES: ReadonlyArray<{ keyword: string; field: string; perRow: 2 | 4 }> = [
  { keyword: 'wages, tips, other compensation', field: 'Wages', perRow: 2 },
  { keyword: 'federal income tax withheld', field: 'FederalTaxWithheld', perRow: 2 },
  { keyword: 'social security wages', field: 'SocialSecurityWages', perRow: 2 },
  { keyword: 'social security tax withheld', field: 'SocialSecurityTax', perRow: 2 },
  { keyword: 'medicare wages and tips', field: 'MedicareWages', perRow: 2 },
  { keyword: 'medicare tax withheld', field: 'MedicareTax', perRow: 2 },
  { keyword: 'state wages, tips', field: 'StateWages', perRow: 4 },
  { keyword: 'state income tax', field: 'StateTaxWithheld', perRow: 4 },
];

const W2C_AMOUNT = /^\$?\s*-?[\d,]*\d(\.\d{1,2})?$/;

/** Label blocks for one printed box, in reading order. */
function labelOccurrences(textBlocks: TextBlock[], keyword: string): TextBlock[] {
  const kw = keyword.replace(/\s+/g, '');
  return textBlocks
    .filter((b) => !isMergedHeader(b) && b.text.toLowerCase().replace(/\s+/g, '').includes(kw))
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

/** A printed box label: "1 Wages, …", "12a See …", "b Employer …". */
const BOX_LABEL_RE = /^(\d{1,2}[a-z]?|[a-z])\s+[A-Za-z]/;

/**
 * The text printed in a label's own cell: below the label, left of the next
 * label on its line, and above the next box label under it. Never the
 * neighbouring column or row.
 */
function cellBlocks(textBlocks: TextBlock[], label: TextBlock): TextBlock[] {
  const h = Math.max(label.height, 6);
  const onPage = textBlocks.filter((b) => b !== label && b.page === label.page);
  const rightEdge = Math.min(Infinity, ...onPage
    .filter((b) => Math.abs(b.y - label.y) < h && b.x > label.x + 5 && BOX_LABEL_RE.test(b.text.trim()))
    .map((b) => b.x));
  const inColumn = (b: TextBlock) => b.x >= label.x - 12 && b.x < rightEdge - 2;
  const bottom = Math.min(label.y + h * 4.5, ...onPage
    .filter((b) => b.y > label.y + h * 0.5 && inColumn(b) && BOX_LABEL_RE.test(b.text.trim()))
    .map((b) => b.y));
  return onPage
    .filter((b) => b.y > label.y + h * 0.5 && b.y < bottom && inColumn(b) && !BOX_LABEL_RE.test(b.text.trim()))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Box b of a W-2 or W-2c: the employer identification number printed in the
 * box's own cell. Absent when no nine-digit EIN is there.
 */
function extractEmployerEin(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): string | undefined {
  const [label] = labelOccurrences(textBlocks, 'employer identification number');
  const value = label && cellBlocks(textBlocks, label).find((b) => /^\d{2}-?\d{7}$/.test(b.text.trim()));
  if (!value) return undefined;
  if (fieldRawTokens) fieldRawTokens.employerEin = value.text.trim();
  recordFieldLocation(fieldSourceLocations, 'employerEin', value);
  return value.text.trim();
}

/**
 * Form W-2c from its text layer: the employer, the year corrected, and each
 * corrected box as previously reported / correct information. Only the boxes
 * printed are read; the SSN/name checkbox (box e) is not text and is left to
 * the document model.
 */
export function extractW2CFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    employerName: extractPayerName(textBlocks, ["employer’s name", "employer's name", 'employer name'], fieldRawTokens, 'employerName', fieldSourceLocations),
  };

  const cellText = (keyword: string, pattern: RegExp): TextBlock | undefined => {
    const [label] = labelOccurrences(textBlocks, keyword);
    if (!label) return undefined;
    return cellBlocks(textBlocks, label).find((b) => pattern.test(b.text.trim()));
  };
  const ein = extractEmployerEin(textBlocks, fieldRawTokens, fieldSourceLocations);
  if (ein) out.employerEin = ein;
  const year = cellText('tax year/form corrected', /^(19|20)\d{2}\b/);
  if (year) {
    out.taxYearCorrected = year.text.trim().slice(0, 4);
    if (fieldRawTokens) fieldRawTokens.taxYearCorrected = year.text.trim();
    recordFieldLocation(fieldSourceLocations, 'taxYearCorrected', year);
  }

  for (const box of W2C_BOXES) {
    const labels = labelOccurrences(textBlocks, box.keyword);
    // The first printed row of this box: the occurrences sharing the top label's line.
    const row = labels.filter((l) => labels[0] && l.page === labels[0].page && Math.abs(l.y - labels[0].y) < Math.max(4, labels[0].height)).sort((a, b) => a.x - b.x);
    if (row.length !== box.perRow) continue; // not the printed layout: nothing is guessed
    for (const [i, side] of (['previous', 'correct'] as const).entries()) {
      const label = row[i]!;
      const cell = cellBlocks(textBlocks, label);
      const token = cell.find((b) => W2C_AMOUNT.test(b.text.trim()) || isUnreadableAmountToken(b.text.trim()));
      if (!token) continue;
      const key = `${side}${box.field}`;
      const raw = token.text.trim();
      const cleaned = raw.replace(/[$,\s]/g, '');
      out[key] = W2C_AMOUNT.test(raw) && PURE_NUMERIC_RE.test(cleaned) ? parseFloat(cleaned) : undefined;
      if (fieldRawTokens) fieldRawTokens[key] = raw;
      recordFieldLocation(fieldSourceLocations, key, token);
    }
  }

  // Box e (SSN and/or name corrected): a fillable form's checked box is an "X"
  // at the end of its label. A text layer shows no unchecked square, so an
  // absent mark leaves the box unknown, never "no".
  const [boxE] = labelOccurrences(textBlocks, 'corrected ssn and/or name');
  const mark = boxE && textBlocks.find((b) =>
    b.page === boxE.page && /^[Xx✓✔]$/.test(b.text.trim()) &&
    b.x >= boxE.x + boxE.width * 0.75 && b.x <= boxE.x + boxE.width + 12 &&
    b.y >= boxE.y - 2 && b.y <= boxE.y + Math.max(boxE.height, 6) * 3);
  if (mark) {
    out.correctsSsnOrName = true;
    if (fieldRawTokens) fieldRawTokens.correctsSsnOrName = mark.text.trim();
    recordFieldLocation(fieldSourceLocations, 'correctsSsnOrName', mark);
  }

  // State codes of the first state line (box 15).
  const states = labelOccurrences(textBlocks, '15 state').filter((l) => !/employer/i.test(l.text));
  const stateRow = states.filter((l) => states[0] && Math.abs(l.y - states[0].y) < Math.max(4, states[0].height)).sort((a, b) => a.x - b.x);
  if (stateRow.length === 4) {
    for (const [i, side] of (['previous', 'correct'] as const).entries()) {
      const code = cellBlocks(textBlocks, stateRow[i]!).find((b) => /^[A-Z]{2}\b/.test(b.text.trim()));
      if (!code) continue;
      out[`${side}State`] = code.text.trim().slice(0, 2);
      if (fieldRawTokens) fieldRawTokens[`${side}State`] = code.text.trim();
      recordFieldLocation(fieldSourceLocations, `${side}State`, code);
    }
  }
  return out;
}

export function extract1099OIDFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    originalIssueDiscount: box('originalIssueDiscount', ['original issue discount for', '1 original issue discount', 'box 1']),
    otherPeriodicInterest: box('otherPeriodicInterest', ['other periodic interest', '2 other periodic', 'box 2']),
    earlyWithdrawalPenalty: box('earlyWithdrawalPenalty', ['early withdrawal penalty', '3 early withdrawal', 'box 3']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
    marketDiscount: box('marketDiscount', ['market discount', '5 market discount', 'box 5']),
    acquisitionPremium: box('acquisitionPremium', ['acquisition premium', '6 acquisition premium', 'box 6']),
    description: extractBoxText(textBlocks, ['7 description', 'box 7'], fieldRawTokens, 'description', fieldSourceLocations),
  };
}

export function extract1099BFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  // Box 2's term squares are not text: the term stays unknown and the form is
  // held for the preparer, never assumed short-term.
  return {
    brokerName: extractPayerName(textBlocks, ["payer's name", 'payer name', "broker's name"], fieldRawTokens, 'brokerName', fieldSourceLocations),
    description: extractBoxText(textBlocks, ['description of property', '1a description', 'box 1a'], fieldRawTokens, 'description', fieldSourceLocations),
    dateAcquired: extractBoxText(textBlocks, ['date acquired', '1b date acquired', 'box 1b'], fieldRawTokens, 'dateAcquired', fieldSourceLocations),
    dateSold: extractBoxText(textBlocks, ['date sold or disposed', '1c date sold', 'box 1c'], fieldRawTokens, 'dateSold', fieldSourceLocations),
    proceeds: box('proceeds', ['total proceeds', '1d proceeds', '1d total']),
    costBasis: box('costBasis', ['total cost', 'cost or other basis', '1e cost', '1e total']),
    washSaleLossDisallowed: box('washSaleLossDisallowed', ['wash sale loss disallowed', '1g wash sale', 'box 1g']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
  };
}

export function extract1099KFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    platformName: extractPayerName(textBlocks, ["filer's name", "payer's name", 'payer name', 'filer'], fieldRawTokens, 'platformName', fieldSourceLocations),
    grossAmount: box('grossAmount', ['gross amount', '1a gross amount', 'box 1a']),
    cardNotPresent: box('cardNotPresent', ['card not present', '1b card not present', 'box 1b']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal', 'box 4']),
  };
}

export function extractSSA1099Fields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    netBenefits: box('netBenefits', ['net benefits', '5 net benefits', 'box 5']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '6 voluntary federal', 'box 6']),
  };
}

export function extract1099SAFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["trustee's name", "payer's name", 'trustee', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    grossDistribution: box('grossDistribution', ['gross distribution', '1 gross distribution', 'box 1']),
    distributionCode: extractBoxText(textBlocks, ['distribution code', '3 distribution code', 'box 3'], fieldRawTokens, 'distributionCode', fieldSourceLocations),
  };
}

export function extract1099QFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["trustee's name", "payer's name", 'trustee', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    grossDistribution: box('grossDistribution', ['gross distribution', '1 gross distribution', 'box 1']),
    earnings: box('earnings', ['earnings', '2 earnings', 'box 2']),
    basisReturn: box('basisReturn', ['basis', '3 basis', 'box 3']),
  };
}

export function extract1098Fields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    lenderName: extractPayerName(textBlocks, ["recipient's name", "lender's name", 'lender name', 'recipient'], fieldRawTokens, 'lenderName', fieldSourceLocations),
    mortgageInterest: box('mortgageInterest', ['mortgage interest received', '1 mortgage interest', 'box 1']),
    outstandingPrincipal: box('outstandingPrincipal', ['outstanding mortgage principal', '2 outstanding', 'box 2']),
    mortgageInsurancePremiums: box('mortgageInsurancePremiums', ['mortgage insurance premiums', '5 mortgage insurance', 'box 5']),
  };
}

export function extract1098TFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    institutionName: extractPayerName(textBlocks, ["filer's name", 'institution name', 'institution'], fieldRawTokens, 'institutionName', fieldSourceLocations),
    tuitionPaid: box('tuitionPaid', ['payments received', '1 payments received', 'box 1']),
    scholarships: box('scholarships', ['scholarships or grants', '5 scholarships', 'box 5']),
  };
}

export function extract1098EFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  return {
    lenderName: extractPayerName(textBlocks, ["recipient's name", "lender's name", 'lender name', 'recipient'], fieldRawTokens, 'lenderName', fieldSourceLocations),
    interestPaid: extractBoxValue(
      textBlocks,
      ['student loan interest', '1 student loan interest', 'box 1'],
      fieldRawTokens,
      'interestPaid',
      fieldSourceLocations,
    ),
  };
}

export function extract1095AFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  // Policy issuer name is Box 3 — use specific keywords first to avoid matching
  // the header "Health Insurance Marketplace Statement"
  // Annual totals not found stay absent (unknown), never zero.
  const fields: Record<string, unknown> = {
    marketplaceName: extractPayerName(textBlocks, ["policy issuer", "issuer's name", 'issuer name'], fieldRawTokens, 'marketplaceName', fieldSourceLocations),
  };

  // 1095-A annual totals are a TABLE row (Line 33) with 3 numbers left-to-right:
  //   Column A = Enrollment Premium, Column B = SLCSP, Column C = Advance PTC
  // Simple label→nearby-value fails here; use positional extraction instead.
  const annualLabel = findLabelBlock(textBlocks, ['annual total', '33 annual', 'annual']);
  if (annualLabel) {
    // Find all numbers on the same line, to the right of the label
    const sameLineNumbers = textBlocks.filter(b => {
      if (b.page !== annualLabel.page) return false;
      if (Math.abs(b.y - annualLabel.y) > 10) return false;
      if (b.x <= annualLabel.x + annualLabel.width) return false;
      const cleaned = b.text.replace(/[$,\s]/g, '');
      return PURE_NUMERIC_RE.test(cleaned);
    }).sort((a, b) => a.x - b.x);

    if (sameLineNumbers.length > 0) {
      fields.annualEnrollmentPremium = parseFloat(sameLineNumbers[0].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.annualEnrollmentPremium = sameLineNumbers[0].text.trim();
      recordFieldLocation(fieldSourceLocations, 'annualEnrollmentPremium', sameLineNumbers[0]);
    }
    if (sameLineNumbers.length > 1) {
      fields.annualSLCSP = parseFloat(sameLineNumbers[1].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.annualSLCSP = sameLineNumbers[1].text.trim();
      recordFieldLocation(fieldSourceLocations, 'annualSLCSP', sameLineNumbers[1]);
    }
    if (sameLineNumbers.length > 2) {
      fields.annualAdvancePTC = parseFloat(sameLineNumbers[2].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.annualAdvancePTC = sameLineNumbers[2].text.trim();
      recordFieldLocation(fieldSourceLocations, 'annualAdvancePTC', sameLineNumbers[2]);
    }
  }

  return fields;
}

export function extractK1Fields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    entityName: extractPayerName(textBlocks, ["partnership's name", "corporation's name", "estate's name", "trust's name", 'entity name'], fieldRawTokens, 'entityName', fieldSourceLocations),
    ordinaryBusinessIncome: box('ordinaryBusinessIncome', ['ordinary business income', '1 ordinary business', 'box 1']),
    rentalIncome: box('rentalIncome', ['net rental real estate', '2 net rental', 'box 2']),
    guaranteedPayments: box('guaranteedPayments', ['guaranteed payments', '4 guaranteed', 'box 4']),
    interestIncome: box('interestIncome', ['interest income', '5 interest', 'box 5']),
    ordinaryDividends: box('ordinaryDividends', ['ordinary dividends', '6a ordinary', 'box 6a']),
    royalties: box('royalties', ['royalties', '7 royalties', 'box 7']),
    shortTermCapitalGain: box('shortTermCapitalGain', ['short-term capital gain', '8 net short-term', 'box 8']),
    longTermCapitalGain: box('longTermCapitalGain', ['long-term capital gain', '9a net long-term', 'box 9a']),
    selfEmploymentIncome: box('selfEmploymentIncome', ['self-employment', '14a self-employment', '14 code a']),
  };
}

export function extractW2GFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  const fields: Record<string, unknown> = {
    payerName: extractPayerName(textBlocks, ["payer's name", 'payer name', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    grossWinnings: box('grossWinnings', ['reportable winnings', 'gross winnings', '1 reportable', '1 gross winnings', 'box 1']),
    federalTaxWithheld: box('federalTaxWithheld', ['federal income tax withheld', '4 federal income tax', '4 federal', 'income tax withheld', 'federal income tax', 'box 4']),
  };

  // Box 3: Type of Wager — extract and clean address prefixes
  const locatedWager = extractLocatedBoxText(textBlocks, ['type of wager', '3 type of wager', 'box 3']);
  let wagerType = locatedWager.text;
  // Strip leading address fragments (e.g., "Las Vegas, NV 89109 Slot Machine" → "Slot Machine")
  wagerType = wagerType.replace(/^[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\s*/, '');
  fields.typeOfWager = wagerType;
  if (locatedWager.text) {
    if (fieldRawTokens) fieldRawTokens.typeOfWager = locatedWager.text;
    recordFieldLocation(fieldSourceLocations, 'typeOfWager', locatedWager.block);
  }

  // State section (Boxes 13-15): Use the same approach as W-2 — find a standalone
  // 2-letter state code in the bottom portion, then pick up nearby numbers.
  // W-2G layout: Box 13 = State, Box 14 = State winnings, Box 15 = State tax withheld
  const page1Blocks = textBlocks.filter(b => b.page === 1);
  const maxY = page1Blocks.length > 0 ? Math.max(...page1Blocks.map(b => b.y)) : 0;

  let stateBlock: TextBlock | null = null;
  for (const block of page1Blocks) {
    // State code is in the bottom ~40% of the form
    if (block.y < maxY * 0.6) continue;
    const text = block.text.trim().toUpperCase();
    if (text.length === 2 && US_STATE_CODES.has(text)) {
      fields.stateCode = text;
      stateBlock = block;
      recordFieldLocation(fieldSourceLocations, 'stateCode', block);
      break;
    }
  }

  if (stateBlock) {
    // Find pure numeric values on the same line as the state code, to its right.
    // On W-2G: first number = state winnings (Box 14), second = state tax (Box 15).
    const sameLineNumbers = textBlocks.filter(b => {
      if (b.page !== stateBlock!.page) return false;
      if (Math.abs(b.y - stateBlock!.y) > 10) return false;
      if (b.x <= stateBlock!.x + stateBlock!.width) return false;
      const cleaned = b.text.replace(/[$,\s]/g, '');
      return PURE_NUMERIC_RE.test(cleaned);
    }).sort((a, b) => a.x - b.x);

    // Skip the first number (state winnings, Box 14) and take the second (state tax, Box 15)
    if (sameLineNumbers.length > 1) {
      fields.stateTaxWithheld = parseFloat(sameLineNumbers[1].text.replace(/[$,\s]/g, ''));
      if (fieldRawTokens) fieldRawTokens.stateTaxWithheld = sameLineNumbers[1].text.trim();
      recordFieldLocation(fieldSourceLocations, 'stateTaxWithheld', sameLineNumbers[1]);
    } else if (sameLineNumbers.length === 1) {
      // If only one number, it could be either — use keyword fallback
      fields.stateTaxWithheld = box('stateTaxWithheld', ['15 state income tax withheld', '15 state tax', 'state income tax withheld', 'box 15']);
    }
  } else {
    // Fallback: keyword approach
    fields.stateTaxWithheld = box('stateTaxWithheld', ['15 state income tax withheld', '15 state tax', 'state income tax withheld', 'state tax withheld', 'box 15']);
    const locatedState = extractLocatedBoxText(textBlocks, ['13 state', 'state/payer']);
    const stateMatch = locatedState.text.match(/\b([A-Z]{2})\b/i);
    const stateCode = stateMatch ? stateMatch[1].toUpperCase() : '';
    if (US_STATE_CODES.has(stateCode)) {
      fields.stateCode = stateCode;
      if (fieldRawTokens) fieldRawTokens.stateCode = locatedState.text;
      recordFieldLocation(fieldSourceLocations, 'stateCode', locatedState.block);
    }
  }

  return fields;
}

export function extract1099CFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    payerName: extractPayerName(textBlocks, ["creditor's name", "payer's name", 'creditor', 'payer'], fieldRawTokens, 'payerName', fieldSourceLocations),
    dateOfCancellation: extractBoxText(textBlocks, ['date of identifiable event', '1 date of identifiable', 'box 1'], fieldRawTokens, 'dateOfCancellation', fieldSourceLocations),
    amountCancelled: box('amountCancelled', ['amount of debt discharged', 'amount of debt', '2 amount of debt', 'box 2']),
    interestIncluded: box('interestIncluded', ['interest if included', '3 interest', 'box 3']),
    debtDescription: extractBoxText(textBlocks, ['debt description', '4 debt description', 'description of debt', 'box 4'], fieldRawTokens, 'debtDescription', fieldSourceLocations),
    identifiableEventCode: extractBoxText(textBlocks, ['identifiable event code', '6 identifiable', 'box 6'], fieldRawTokens, 'identifiableEventCode', fieldSourceLocations),
  };
}

export function extract1099SFields(
  textBlocks: TextBlock[],
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): Record<string, unknown> {
  const box = (key: string, keywords: string[]) =>
    extractBoxValue(textBlocks, keywords, fieldRawTokens, key, fieldSourceLocations);
  return {
    filerName: extractPayerName(textBlocks, ["filer's name", "transferee's name", 'settlement agent', 'filer'], fieldRawTokens, 'filerName', fieldSourceLocations),
    // Box 2a, not 2b (cash) or 2c (digital asset), which also say "gross proceeds".
    grossProceeds: box('grossProceeds', ['total gross proceeds', '2a total gross', 'box 2a']),
    closingDate: extractBoxText(textBlocks, ['date of closing', '1 date of closing', 'box 1'], fieldRawTokens, 'closingDate', fieldSourceLocations),
    propertyAddress: extractBoxText(textBlocks, ['address (including city', '3 address', 'box 3'], fieldRawTokens, 'propertyAddress', fieldSourceLocations),
    buyerRealEstateTax: box('buyerRealEstateTax', ["buyer's part of real estate tax", "4 buyer's part", 'box 4']),
  };
}

// ─── Utility: Form type display helpers ────────────

export const FORM_TYPE_LABELS: Record<SupportedFormType, string> = {
  'W-2': 'W-2 Wage and Tax Statement',
  'W-2C': 'W-2c Corrected Wage and Tax Statement',
  '1099-INT': '1099-INT Interest Income',
  '1099-DIV': '1099-DIV Dividends',
  '1099-R': '1099-R Retirement Distributions',
  '1099-NEC': '1099-NEC Nonemployee Compensation',
  '1099-MISC': '1099-MISC Miscellaneous Income',
  '1099-G': '1099-G Government Payments',
  '1099-B': '1099-B Broker Proceeds',
  '1099-K': '1099-K Payment Card Transactions',
  '1099-OID': '1099-OID Original Issue Discount',
  'SSA-1099': 'SSA-1099 Social Security Benefits',
  '1099-SA': '1099-SA HSA Distributions',
  '1099-Q': '1099-Q Education Program Payments',
  '1098': '1098 Mortgage Interest Statement',
  '1098-T': '1098-T Tuition Statement',
  '1098-E': '1098-E Student Loan Interest',
  '1095-A': '1095-A Health Insurance Marketplace',
  'K-1': 'Schedule K-1 Partner/Shareholder Income',
  'W-2G': 'W-2G Gambling Winnings',
  '1099-C': '1099-C Cancellation of Debt',
  '1099-S': '1099-S Proceeds from Real Estate',
};

export const INCOME_TYPE_STEP_MAP: Record<string, string> = {
  w2: 'w2_income',
  '1099int': '1099int_income',
  '1099div': '1099div_income',
  '1099r': '1099r_income',
  '1099nec': '1099nec_income',
  '1099misc': '1099misc_income',
  '1099g': '1099g_income',
  '1099b': '1099b_income',
  '1099k': '1099k_income',
  ssa1099: 'ssa1099_income',
  '1099sa': '1099sa_income',
  '1099q': '1099q_income',
  '1098': 'mortgage_interest_ded',
  '1098t': 'education_credits',
  '1098e': 'student_loan_ded',
  '1095a': 'premium_tax_credit',
  k1: 'k1_income',
  w2g: 'w2g_income',
  '1099c': '1099c_income',
  '1099s': 'home_sale',
};

export const INCOME_DISCOVERY_KEYS: Record<string, string> = {
  w2: 'w2',
  '1099int': '1099int',
  '1099div': '1099div',
  '1099r': '1099r',
  '1099nec': '1099nec',
  '1099misc': '1099misc',
  '1099g': '1099g',
  '1099b': '1099b',
  '1099k': '1099k',
  ssa1099: 'ssa1099',
  '1099sa': '1099sa',
  '1099q': '1099q',
  '1098': 'ded_mortgage',
  '1098t': 'education_credit',
  '1098e': 'ded_student_loan',
  '1095a': 'premium_tax_credit',
  k1: 'k1',
  w2g: 'w2g',
  '1099c': '1099c',
  '1099s': 'home_sale',
};

// ─── Import Trace Generation ─────────────────────

/** Human-readable field labels per form type (for trace entries). */
const FIELD_LABELS: Record<SupportedFormType, Record<string, string>> = {
  'W-2C': {
    employerName: 'Employer Name',
    employerEin: 'Employer EIN (Box b)',
    taxYearCorrected: 'Tax Year Corrected (Box c)',
    previousWages: 'Wages Previously Reported (Box 1)',
    correctWages: 'Wages Correct (Box 1)',
    previousFederalTaxWithheld: 'Federal Tax Withheld Previously Reported (Box 2)',
    correctFederalTaxWithheld: 'Federal Tax Withheld Correct (Box 2)',
    previousSocialSecurityWages: 'Social Security Wages Previously Reported (Box 3)',
    correctSocialSecurityWages: 'Social Security Wages Correct (Box 3)',
    previousSocialSecurityTax: 'Social Security Tax Previously Reported (Box 4)',
    correctSocialSecurityTax: 'Social Security Tax Correct (Box 4)',
    previousMedicareWages: 'Medicare Wages Previously Reported (Box 5)',
    correctMedicareWages: 'Medicare Wages Correct (Box 5)',
    previousMedicareTax: 'Medicare Tax Previously Reported (Box 6)',
    correctMedicareTax: 'Medicare Tax Correct (Box 6)',
    previousStateWages: 'State Wages Previously Reported (Box 16)',
    correctStateWages: 'State Wages Correct (Box 16)',
    previousStateTaxWithheld: 'State Income Tax Previously Reported (Box 17)',
    correctStateTaxWithheld: 'State Income Tax Correct (Box 17)',
  },
  'W-2': {
    employerName: 'Employer Name',
    employerEin: 'Employer EIN (Box b)',
    wages: 'Wages, Tips (Box 1)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 2)',
    socialSecurityWages: 'Social Security Wages (Box 3)',
    socialSecurityTax: 'Social Security Tax (Box 4)',
    medicareWages: 'Medicare Wages (Box 5)',
    medicareTax: 'Medicare Tax (Box 6)',
    stateTaxWithheld: 'State Tax Withheld (Box 17)',
    stateWages: 'State Wages (Box 16)',
  },
  '1099-INT': {
    payerName: 'Payer Name',
    amount: 'Interest Income (Box 1)',
    earlyWithdrawalPenalty: 'Early Withdrawal Penalty (Box 2)',
    usBondInterest: 'U.S. Savings Bond Interest (Box 3)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
    taxExemptInterest: 'Tax-Exempt Interest (Box 8)',
  },
  '1099-DIV': {
    payerName: 'Payer Name',
    ordinaryDividends: 'Ordinary Dividends (Box 1a)',
    qualifiedDividends: 'Qualified Dividends (Box 1b)',
    capitalGainDistributions: 'Capital Gain Distributions (Box 2a)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
    foreignTaxPaid: 'Foreign Tax Paid (Box 7)',
  },
  '1099-R': {
    payerName: 'Payer Name',
    grossDistribution: 'Gross Distribution (Box 1)',
    taxableAmount: 'Taxable Amount (Box 2a)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
  },
  '1099-NEC': {
    payerName: 'Payer Name',
    amount: 'Nonemployee Compensation (Box 1)',
  },
  '1099-MISC': {
    payerName: 'Payer Name',
    rents: 'Rents (Box 1)',
    royalties: 'Royalties (Box 2)',
    otherIncome: 'Other Income (Box 3)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
    stateTaxWithheld: 'State Tax Withheld (Box 16)',
  },
  '1099-G': {
    payerName: 'Payer Name',
    unemploymentCompensation: 'Unemployment Compensation (Box 1)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
  },
  '1099-B': {
    brokerName: 'Broker Name',
    description: 'Description (Box 1a)',
    dateAcquired: 'Date Acquired (Box 1b)',
    dateSold: 'Date Sold (Box 1c)',
    proceeds: 'Proceeds (Box 1d)',
    costBasis: 'Cost Basis (Box 1e)',
    washSaleLossDisallowed: 'Wash Sale Loss Disallowed (Box 1g)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
  },
  '1099-OID': {
    payerName: 'Payer Name',
    originalIssueDiscount: 'Original Issue Discount (Box 1)',
    otherPeriodicInterest: 'Other Periodic Interest (Box 2)',
    earlyWithdrawalPenalty: 'Early Withdrawal Penalty (Box 3)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
    marketDiscount: 'Market Discount (Box 5)',
    acquisitionPremium: 'Acquisition Premium (Box 6)',
    description: 'Description (Box 7)',
  },
  '1099-K': {
    platformName: 'Platform / Filer Name',
    grossAmount: 'Gross Amount (Box 1a)',
    cardNotPresent: 'Card Not Present (Box 1b)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
  },
  'SSA-1099': {
    netBenefits: 'Net Benefits (Box 5)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 6)',
  },
  '1099-SA': {
    payerName: 'Trustee / Payer Name',
    grossDistribution: 'Gross Distribution (Box 1)',
    distributionCode: 'Distribution Code (Box 3)',
  },
  '1099-Q': {
    payerName: 'Trustee / Payer Name',
    grossDistribution: 'Gross Distribution (Box 1)',
    earnings: 'Earnings (Box 2)',
    basisReturn: 'Basis (Box 3)',
  },
  '1098': {
    lenderName: 'Lender Name',
    mortgageInterest: 'Mortgage Interest Received (Box 1)',
    outstandingPrincipal: 'Outstanding Mortgage Principal (Box 2)',
    mortgageInsurancePremiums: 'Mortgage Insurance Premiums (Box 5)',
  },
  '1098-T': {
    institutionName: 'Institution Name',
    tuitionPaid: 'Tuition Payments (Box 1)',
    scholarships: 'Scholarships / Grants (Box 5)',
  },
  '1098-E': {
    lenderName: 'Lender Name',
    interestPaid: 'Student Loan Interest Paid (Box 1)',
  },
  '1095-A': {
    marketplaceName: 'Marketplace Name',
    annualEnrollmentPremium: 'Annual Enrollment Premium',
    annualSLCSP: 'Annual SLCSP Premium',
    annualAdvancePTC: 'Annual Advance PTC',
  },
  'K-1': {
    entityName: 'Entity Name',
    ordinaryBusinessIncome: 'Ordinary Business Income (Box 1)',
    rentalIncome: 'Net Rental Income (Box 2)',
    guaranteedPayments: 'Guaranteed Payments (Box 4)',
    interestIncome: 'Interest Income (Box 5)',
    ordinaryDividends: 'Ordinary Dividends (Box 6a)',
    royalties: 'Royalties (Box 7)',
    shortTermCapitalGain: 'Short-Term Capital Gain (Box 8)',
    longTermCapitalGain: 'Long-Term Capital Gain (Box 9a)',
    selfEmploymentIncome: 'Self-Employment Income (Box 14A)',
  },
  'W-2G': {
    payerName: 'Payer Name',
    grossWinnings: 'Gross Winnings (Box 1)',
    federalTaxWithheld: 'Federal Tax Withheld (Box 4)',
    typeOfWager: 'Type of Wager (Box 3)',
    stateCode: 'State (Box 13)',
    stateTaxWithheld: 'State Tax Withheld (Box 15)',
  },
  '1099-C': {
    payerName: 'Creditor Name',
    dateOfCancellation: 'Date of Identifiable Event (Box 1)',
    amountCancelled: 'Amount of Debt Cancelled (Box 2)',
    interestIncluded: 'Interest Included (Box 3)',
    debtDescription: 'Debt Description (Box 4)',
    identifiableEventCode: 'Identifiable Event Code (Box 6)',
  },
  '1099-S': {
    filerName: 'Filer / Settlement Agent',
    grossProceeds: 'Total Gross Proceeds (Box 2a)',
    closingDate: 'Date of Closing (Box 1)',
    propertyAddress: 'Property Address (Box 3)',
    buyerRealEstateTax: "Buyer's Part of Real Estate Tax (Box 4)",
  },
};

function formatTraceValue(value: unknown): string {
  if (typeof value === 'number') {
    return value === 0 ? '$0' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Trace "found" means a real extracted value, including numeric 0 — not missing/undefined. */
function isTraceFound(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return false;
}

/**
 * Generate a human-readable import trace explaining what was extracted
 * and how the form was detected.
 */
export function generateImportTrace(
  formType: SupportedFormType | null,
  confidence: 'high' | 'medium' | 'low',
  matchedKeywords: string[],
  extractedData: Record<string, unknown>,
  textBlockCount: number,
  pagesScanned: number,
  pageRangeInfo?: {
    formPageRange?: { start: number; end: number };
    additionalForms?: Array<{ type: string; pages: string }>;
  },
): ImportTrace {
  // ── Form detection trace ──
  let detectionReasoning: string;
  if (!formType) {
    detectionReasoning = 'No primary form keywords matched. Could not determine form type.';
  } else if (confidence === 'high') {
    detectionReasoning = `Matched primary keyword + ${matchedKeywords.length - 1} secondary keywords: "${matchedKeywords.join('", "')}"`;
  } else if (confidence === 'medium') {
    detectionReasoning = `Matched primary keyword "${matchedKeywords[0]}" but fewer than 2 secondary keywords`;
  } else {
    detectionReasoning = 'Low confidence — keyword match was weak';
  }

  const formDetection: FormDetectionTrace = {
    detectedType: formType,
    confidence,
    matchedKeywords,
    reasoning: detectionReasoning,
  };

  // ── Field-level trace ──
  const fieldLabels = formType ? FIELD_LABELS[formType] || {} : {};
  const fields: ImportTraceEntry[] = Object.entries(extractedData).map(([key, value]) => {
    const label = fieldLabels[key] || key;
    const isName = typeof value === 'string';
    const isFound = isTraceFound(value);

    return {
      field: key,
      label,
      status: isFound ? 'found' as const : 'not_found' as const,
      value: isFound ? formatTraceValue(value) : undefined,
      reasoning: isFound
        ? isName
          ? 'Matched label text and extracted nearby name'
          : 'Found numeric value near matching box label'
        : isName
          ? 'No name text found near label — enter manually'
          : 'No numeric value near label — check browser console for diagnostics',
    };
  });

  const found = fields.filter(f => f.status === 'found').length;
  const total = fields.length;
  const summary = formType
    ? `Extracted ${found} of ${total} fields from ${FORM_TYPE_LABELS[formType]}`
    : `Could not identify form type (${textBlockCount} text blocks scanned)`;

  return {
    formDetection,
    fields,
    summary,
    textBlockCount,
    pagesScanned,
    ...(pageRangeInfo?.formPageRange && { formPageRange: pageRangeInfo.formPageRange }),
    ...(pageRangeInfo?.additionalForms?.length && { additionalForms: pageRangeInfo.additionalForms }),
  };
}
