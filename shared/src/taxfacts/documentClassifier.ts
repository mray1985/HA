/**
 * Deterministic document classifier (work-order step 4 / HA-AI-013).
 * Identifies IRS form type from text / importer markers already produced by
 * the existing PDF extract path. No OCR engine, no model download, no guessing.
 *
 * UNKNOWN / unclassified must never become a form type or a zero amount.
 * Every classified result cites which marker matched.
 */

/** Form types the classifier can assert from markers. */
export const CLASSIFIABLE_FORM_TYPES = [
  'W-2',
  'W-2G',
  '1099-INT',
  '1099-DIV',
  '1099-NEC',
  '1099-R',
  '1099-MISC',
  '1099-G',
  '1099-B',
  '1099-K',
  'SSA-1099',
  '1099-SA',
  '1099-Q',
  '1099-C',
  '1099-S',
  '1098',
  '1098-T',
  '1098-E',
  '1095-A',
  'K-1',
] as const;

export type ClassifiableFormType = (typeof CLASSIFIABLE_FORM_TYPES)[number];

/** Income-item keys used by the tax-tool / add-income path. */
export type ClassifiedIncomeType =
  | 'w2'
  | 'w2g'
  | '1099int'
  | '1099div'
  | '1099nec'
  | '1099r'
  | '1099misc'
  | '1099g'
  | '1099b'
  | '1099k'
  | 'ssa1099'
  | '1099sa'
  | '1099q'
  | '1099c'
  | '1099s'
  | '1098'
  | '1098t'
  | '1098e'
  | '1095a'
  | 'k1';

export type ClassificationConfidence = 'high' | 'medium' | 'low';

export type ClassificationSource =
  | 'text_markers'
  | 'importer_markers'
  | 'none';

interface FormMarkerSignature {
  formType: ClassifiableFormType;
  incomeType: ClassifiedIncomeType;
  /** Titles / form ids — at least one required to classify. */
  primaryMarkers: string[];
  /** Corroborating field labels. */
  secondaryMarkers: string[];
}

/**
 * Ordering matters: more-specific forms before substring parents
 * (W-2G before W-2, 1098-T/E before 1098, K-1 before 1099-INT).
 * Mirrors client pdfExtractHelpers FORM_SIGNATURES keywords.
 */
const FORM_MARKER_SIGNATURES: FormMarkerSignature[] = [
  {
    formType: 'K-1',
    incomeType: 'k1',
    primaryMarkers: ['schedule k-1', 'form 1065', 'form 1120-s', 'form 1041'],
    secondaryMarkers: [
      'ordinary business income',
      'guaranteed payments',
      "partner's share",
      'net rental real estate',
    ],
  },
  {
    formType: 'W-2G',
    incomeType: 'w2g',
    primaryMarkers: ['w-2g', 'certain gambling winnings'],
    secondaryMarkers: ['reportable winnings', 'gross winnings', 'type of wager', 'winnings'],
  },
  {
    formType: 'W-2',
    incomeType: 'w2',
    primaryMarkers: ['wage and tax statement', 'form w-2'],
    secondaryMarkers: ['employer', 'wages', 'federal income tax withheld', 'social security'],
  },
  {
    formType: '1099-NEC',
    incomeType: '1099nec',
    primaryMarkers: ['1099-nec', 'nonemployee compensation'],
    secondaryMarkers: ['payer', 'compensation', 'recipient'],
  },
  {
    formType: '1099-INT',
    incomeType: '1099int',
    primaryMarkers: ['1099-int', 'interest income'],
    secondaryMarkers: ['payer', 'interest', 'early withdrawal'],
  },
  {
    formType: '1099-DIV',
    incomeType: '1099div',
    primaryMarkers: ['1099-div', 'dividends and distributions'],
    secondaryMarkers: ['ordinary dividends', 'qualified dividends', 'capital gain'],
  },
  {
    formType: '1099-R',
    incomeType: '1099r',
    primaryMarkers: ['1099-r', 'distributions from pensions'],
    secondaryMarkers: ['gross distribution', 'taxable amount', 'distribution code'],
  },
  {
    formType: '1099-MISC',
    incomeType: '1099misc',
    primaryMarkers: ['1099-misc', 'miscellaneous information'],
    secondaryMarkers: ['rents', 'royalties', 'other income', 'payer'],
  },
  {
    formType: '1099-G',
    incomeType: '1099g',
    primaryMarkers: ['1099-g', 'certain government payments'],
    secondaryMarkers: ['unemployment', 'state tax refund', 'payer'],
  },
  {
    formType: '1099-B',
    incomeType: '1099b',
    primaryMarkers: ['1099-b', 'proceeds from broker'],
    secondaryMarkers: ["broker's name", 'cost basis', 'short-term', 'long-term', 'date sold'],
  },
  {
    formType: '1099-K',
    incomeType: '1099k',
    primaryMarkers: ['1099-k', 'payment card and third party'],
    secondaryMarkers: ['payment settlement', 'gross amount', 'card not present', 'third party network'],
  },
  {
    formType: 'SSA-1099',
    incomeType: 'ssa1099',
    primaryMarkers: ['ssa-1099', 'social security benefit statement'],
    secondaryMarkers: ['social security administration', 'net benefits', 'benefits paid'],
  },
  {
    formType: '1099-SA',
    incomeType: '1099sa',
    primaryMarkers: ['1099-sa', 'distributions from an hsa'],
    secondaryMarkers: ['health savings', 'gross distribution', 'distribution code', 'archer msa'],
  },
  {
    formType: '1099-Q',
    incomeType: '1099q',
    primaryMarkers: ['1099-q', 'payments from qualified education'],
    secondaryMarkers: ['education program', 'gross distribution', 'earnings', 'basis'],
  },
  {
    formType: '1098-T',
    incomeType: '1098t',
    primaryMarkers: ['1098-t', 'tuition statement'],
    secondaryMarkers: ['qualified tuition', 'scholarships', 'institution'],
  },
  {
    formType: '1098-E',
    incomeType: '1098e',
    primaryMarkers: ['1098-e', 'student loan interest statement'],
    secondaryMarkers: ['student loan', 'interest received by lender'],
  },
  {
    formType: '1098',
    incomeType: '1098',
    primaryMarkers: ['form 1098', 'mortgage interest statement'],
    secondaryMarkers: ['mortgage interest received', 'outstanding mortgage', 'mortgage insurance'],
  },
  {
    formType: '1095-A',
    incomeType: '1095a',
    primaryMarkers: ['1095-a', 'health insurance marketplace'],
    secondaryMarkers: ['enrollment premium', 'slcsp', 'advance payment'],
  },
  {
    formType: '1099-C',
    incomeType: '1099c',
    primaryMarkers: ['1099-c', 'cancellation of debt'],
    secondaryMarkers: ['amount of debt', 'discharged', 'identifiable event'],
  },
  {
    formType: '1099-S',
    incomeType: '1099s',
    primaryMarkers: ['1099-s', 'proceeds from real estate'],
    secondaryMarkers: ['gross proceeds', 'date of closing', 'transferor'],
  },
];

export interface ClassifiedDocumentResult {
  status: 'classified';
  formType: ClassifiableFormType;
  incomeType: ClassifiedIncomeType;
  confidence: ClassificationConfidence;
  /** Human-readable explanation citing the matched marker(s). */
  reason: string;
  matchedMarkers: string[];
  source: Exclude<ClassificationSource, 'none'>;
}

export interface UnclassifiedDocumentResult {
  status: 'unclassified';
  formType: null;
  incomeType: null;
  confidence: 'low';
  reason: string;
  matchedMarkers: string[];
  source: 'none';
}

export type DocumentClassification = ClassifiedDocumentResult | UnclassifiedDocumentResult;

export interface ClassifyDocumentInput {
  /** Raw / OCR text from the existing extract path (preferred). */
  text?: string | null;
  /** Form type the importer already detected (signal only — never enough alone). */
  detectedFormType?: string | null;
  /** Keywords the importer reported as matched. */
  matchedMarkers?: readonly string[] | null;
  /** Importer confidence for the detected type. */
  detectedConfidence?: ClassificationConfidence | null;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchSignatureFromText(
  haystack: string,
  sig: FormMarkerSignature,
): { primary: string[]; secondary: string[] } {
  const primary = sig.primaryMarkers.filter((m) => haystack.includes(m));
  const secondary = sig.secondaryMarkers.filter((m) => haystack.includes(m));
  return { primary, secondary };
}

function matchSignatureFromMarkers(
  markers: readonly string[],
  sig: FormMarkerSignature,
): { primary: string[]; secondary: string[] } {
  const lower = markers.map((m) => m.toLowerCase());
  const primary = sig.primaryMarkers.filter((m) => lower.includes(m));
  const secondary = sig.secondaryMarkers.filter((m) => lower.includes(m));
  return { primary, secondary };
}

function classifiedFromMatch(input: {
  sig: FormMarkerSignature;
  primary: string[];
  secondary: string[];
  source: Exclude<ClassificationSource, 'none'>;
  confidenceOverride?: ClassificationConfidence;
}): ClassifiedDocumentResult {
  const matched = [...input.primary, ...input.secondary];
  const confidence =
    input.confidenceOverride ??
    (input.primary.length > 0 && input.secondary.length >= 2 ? 'high' : 'medium');
  const primaryList = input.primary.map((m) => `"${m}"`).join(', ');
  return {
    status: 'classified',
    formType: input.sig.formType,
    incomeType: input.sig.incomeType,
    confidence,
    reason: `Matched primary marker(s) ${primaryList} for ${input.sig.formType}.`,
    matchedMarkers: matched,
    source: input.source,
  };
}

function unclassified(reason: string, matchedMarkers: string[] = []): UnclassifiedDocumentResult {
  return {
    status: 'unclassified',
    formType: null,
    incomeType: null,
    confidence: 'low',
    reason,
    matchedMarkers,
    source: 'none',
  };
}

/**
 * Ordered first-match against form signatures (same ordering as the PDF importer).
 * More-specific forms (W-2G, 1098-T) come before substring parents. No guessing.
 */
function classifyFromHaystack(
  haystack: string,
  source: Exclude<ClassificationSource, 'none'>,
): DocumentClassification {
  if (!haystack) {
    return unclassified('No extractable text or form markers were available.');
  }

  for (const sig of FORM_MARKER_SIGNATURES) {
    const { primary, secondary } = matchSignatureFromText(haystack, sig);
    if (primary.length === 0) continue;
    return classifiedFromMatch({
      sig,
      primary,
      secondary,
      source,
    });
  }

  return unclassified('No primary form markers were found in the document text.');
}

/**
 * Classify a document from signals the existing extractor already produces.
 * Never invents a form type: missing / conflicting / marker-less signals → unclassified.
 */
export function classifyDocument(input: ClassifyDocumentInput): DocumentClassification {
  const text = typeof input.text === 'string' ? normalizeText(input.text) : '';
  const markers = (input.matchedMarkers ?? [])
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length > 0);
  const detected =
    typeof input.detectedFormType === 'string' && input.detectedFormType.trim()
      ? input.detectedFormType.trim()
      : null;

  let textMiss: UnclassifiedDocumentResult | null = null;

  // Prefer full text when present.
  if (text) {
    const fromText = classifyFromHaystack(text, 'text_markers');
    if (fromText.status === 'classified') {
      // Conflict with importer label → do not guess.
      if (detected && detected !== fromText.formType) {
        return unclassified(
          `Text markers indicate ${fromText.formType} but importer reported ${detected}; type left unclassified.`,
          fromText.matchedMarkers,
        );
      }
      return fromText;
    }
    // Text present but no primary markers — try importer markers next.
    textMiss = fromText;
  }

  // No decisive text match: require importer markers that map to a known primary signature.
  if (markers.length > 0) {
    for (const sig of FORM_MARKER_SIGNATURES) {
      const { primary, secondary } = matchSignatureFromMarkers(markers, sig);
      if (primary.length === 0) continue;

      if (detected && detected !== sig.formType) {
        return unclassified(
          `Importer markers indicate ${sig.formType} but detected type was ${detected}; type left unclassified.`,
          markers,
        );
      }

      return classifiedFromMatch({
        sig,
        primary,
        secondary,
        source: 'importer_markers',
        confidenceOverride: input.detectedConfidence ?? undefined,
      });
    }

    return unclassified(
      'Importer markers did not include a primary form title; type left unclassified.',
      markers,
    );
  }

  // Bare detected label without markers is not a classification.
  if (detected) {
    return unclassified(
      `Importer reported ${detected} without citing matched markers; type left unclassified.`,
    );
  }

  if (textMiss) return textMiss;

  return unclassified('No extractable text or form markers were available.');
}

/** True when classification is allowed to drive tax-tool / income writes. */
export function classificationAllowsIncomeWrite(
  classification: DocumentClassification,
): boolean {
  return classification.status === 'classified';
}

export function isClassifiableFormType(value: string | null | undefined): value is ClassifiableFormType {
  if (!value) return false;
  return (CLASSIFIABLE_FORM_TYPES as readonly string[]).includes(value);
}
