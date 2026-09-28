import type { TaxFact } from '@hatax/engine';
import {
  factsFromFields,
  fieldsForToolCall,
  invokeTaxTool,
  pickToolFieldArgs,
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
  return extracted.aiEnhanced ? 'local-pdf+byok' : extracted.ocrUsed ? 'local-ocr' : 'local-pdf';
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
    const result = invokeTaxTool({
      tool,
      // Extraction may include extra AI keys; pick known fields before validation.
      // Direct model tool calls still reject unknown fields via invokeTaxTool.
      args: pickToolFieldArgs(tool, input.extracted.extractedData),
      context: {
        returnId: input.returnId,
        taxYear: input.taxYear,
        sourceDocumentId: input.documentId,
        sourceFileName: input.fileName,
        extractor,
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
  const facts = factsFromFields({
    returnId: input.returnId,
    taxYear: input.taxYear,
    documentId: input.documentId,
    fileName: input.fileName,
    extractor,
    fields: input.extracted.extractedData,
    factTypeFor: (field) => `${prefix}_${field}`,
  });
  return {
    facts,
    toolFields: fieldsForToolCall(input.extracted.extractedData),
    incomeType: input.extracted.incomeType,
  };
}
