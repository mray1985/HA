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
import type { PDFExtractResult } from './pdfExtractHelpers';
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

  if (tool) {
    const structured = extractStructuredFields(
      input.extracted.incomeType,
      input.extracted.extractedData,
      input.extracted.fieldRawTokens,
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
    input.extracted.fieldRawTokens,
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
  });
  return {
    facts,
    toolFields: fieldsForToolCall(generic.fields),
    incomeType: input.extracted.incomeType,
  };
}
