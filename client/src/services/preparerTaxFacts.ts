import type { TaxFact } from '@hatax/engine';
import {
  extractStructuredFields,
  factsFromFields,
  fieldsForToolCall,
  invokeTaxTool,
  normalizeGenericFields,
  ocrExtractorLabel,
  toolNameForIncomeType,
} from '@hatax/engine';
import type { FieldSourceLocationValue, PDFExtractResult } from './pdfExtractHelpers';
import { taxFactStorageKey } from './storageScope';

export function loadTaxFacts(returnId: string): TaxFact[] {
  const raw = localStorage.getItem(taxFactStorageKey(returnId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TaxFact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTaxFacts(returnId: string, facts: TaxFact[]): void {
  localStorage.setItem(taxFactStorageKey(returnId), JSON.stringify(facts));
}

export function appendTaxFacts(returnId: string, facts: TaxFact[]): TaxFact[] {
  const next = [...loadTaxFacts(returnId), ...facts];
  saveTaxFacts(returnId, next);
  return next;
}

function extractorLabel(extracted: PDFExtractResult): string {
  return ocrExtractorLabel(extracted.ocrUsed === true, extracted.aiEnhanced === true);
}

/**
 * True when the accepted field value still matches the located OCR/PDF token.
 * Used so AI overrides that change a value drop stale rawText/source boxes,
 * while overrides that keep the same text preserve provenance.
 */
export function acceptedValueAgreesWithRawToken(
  accepted: unknown,
  raw: string,
): boolean {
  if (typeof accepted === 'number') {
    const cleaned = raw.replace(/[$,()\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return false;
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) && parsed === accepted;
  }
  if (typeof accepted === 'string') {
    return accepted.trim() === raw.trim();
  }
  if (typeof accepted === 'boolean') {
    const lower = raw.trim().toLowerCase();
    if (accepted) return /^(true|yes|y|1|x|checked)$/i.test(lower);
    return /^(false|no|n|0)$/i.test(lower);
  }
  // Structured values cannot be verified against a single scalar token.
  return false;
}

/**
 * Drop stale raw tokens and source locations when an AI override (or any later
 * edit) changes a field so it no longer matches the located text block.
 * Preserve them when the accepted value still agrees with that token.
 * Unreadable/missing amounts (undefined + raw token) keep their provenance.
 */
export function reconcileFieldProvenance(
  extractedData: Record<string, unknown>,
  fieldRawTokens?: Record<string, string>,
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>,
): {
  fieldRawTokens?: Record<string, string>;
  fieldSourceLocations?: Record<string, FieldSourceLocationValue>;
} {
  if (!fieldRawTokens && !fieldSourceLocations) {
    return { fieldRawTokens, fieldSourceLocations };
  }

  const nextRaw: Record<string, string> = {};
  const nextLoc: Record<string, FieldSourceLocationValue> = {};
  const keys = new Set([
    ...Object.keys(fieldRawTokens ?? {}),
    ...Object.keys(fieldSourceLocations ?? {}),
  ]);

  for (const key of keys) {
    const raw = fieldRawTokens?.[key];
    const loc = fieldSourceLocations?.[key];
    const hasValue = Object.prototype.hasOwnProperty.call(extractedData, key);
    const accepted = hasValue ? extractedData[key] : undefined;

    // Missing / unreadable amount: keep the located token and its box.
    if (!hasValue || accepted === undefined || accepted === null) {
      if (raw !== undefined) nextRaw[key] = raw;
      if (loc !== undefined) nextLoc[key] = loc;
      continue;
    }

    // Per-entry locations (box12): keep only when there is no conflicting raw,
    // or when a scalar raw still agrees. Structured AI replacements clear both.
    if (Array.isArray(loc)) {
      if (raw === undefined) {
        // No scalar token to disagree with — keep per-entry locations.
        nextLoc[key] = loc;
      } else if (acceptedValueAgreesWithRawToken(accepted, raw)) {
        nextRaw[key] = raw;
        nextLoc[key] = loc;
      }
      continue;
    }

    if (raw !== undefined) {
      if (acceptedValueAgreesWithRawToken(accepted, raw)) {
        nextRaw[key] = raw;
        if (loc !== undefined) nextLoc[key] = loc;
      }
      // Disagreement: drop both stale raw and stale box.
      continue;
    }

    // Location without a raw token cannot be verified against the text block.
    // Do not keep a box for an unverified override.
  }

  return {
    fieldRawTokens: Object.keys(nextRaw).length > 0 ? nextRaw : undefined,
    fieldSourceLocations: Object.keys(nextLoc).length > 0 ? nextLoc : undefined,
  };
}

/**
 * Build TaxFacts and add-income fields from an extraction.
 * Supported W-2 / 1099 forms go through the schema-validated tax-tool API.
 * Other forms keep the generic fact builder (still omit missing amounts).
 */
export function factsForExtraction(input: {
  returnId: string;
  taxYear: number;
  documentId: string;
  fileName: string;
  extracted: PDFExtractResult;
}): {
  facts: TaxFact[];
  toolFields: Record<string, unknown>;
  incomeType: string | null;
  toolError?: string;
} {
  const extractor = extractorLabel(input.extracted);
  const tool = toolNameForIncomeType(input.extracted.incomeType);
  const reconciled = reconcileFieldProvenance(
    input.extracted.extractedData,
    input.extracted.fieldRawTokens,
    input.extracted.fieldSourceLocations,
  );

  if (tool) {
    const structured = extractStructuredFields(
      input.extracted.incomeType,
      input.extracted.extractedData,
      reconciled.fieldRawTokens,
    );
    const result = invokeTaxTool({
      tool,
      // Unreadable amounts are undefined arguments, so the tool records them as unknown.
      // Direct model tool calls still reject unknown fields via invokeTaxTool.
      args: structured.args,
      context: {
        returnId: input.returnId,
        taxYear: input.taxYear,
        sourceDocumentId: input.documentId,
        sourceFileName: input.fileName,
        extractor,
        rawText: structured.rawText,
        sourceLocation: reconciled.fieldSourceLocations,
      },
    });
    if (!result.ok) {
      return {
        facts: [],
        toolFields: {},
        incomeType: null,
        toolError: result.error,
      };
    }
    return {
      facts: result.facts,
      toolFields: result.fields,
      incomeType: result.incomeType ?? input.extracted.incomeType,
    };
  }

  const prefix = (input.extracted.incomeType || input.extracted.formType || 'DOC').toUpperCase();
  const generic = normalizeGenericFields(
    input.extracted.extractedData,
    reconciled.fieldRawTokens,
  );
  const facts = factsFromFields({
    returnId: input.returnId,
    taxYear: input.taxYear,
    documentId: input.documentId,
    fileName: input.fileName,
    extractor,
    fields: generic.fields,
    factTypeFor: (field) => `${prefix}_${field}`,
    rawText: generic.rawText,
    sourceLocation: reconciled.fieldSourceLocations,
  });
  return {
    facts,
    toolFields: fieldsForToolCall(generic.fields),
    incomeType: input.extracted.incomeType,
  };
}
