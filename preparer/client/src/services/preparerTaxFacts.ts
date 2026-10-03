import type { FactValidationResult, TaxFact } from '@hatax/local-ai';
import {
  callIncomeToolFromStructuredFields,
  extractStructuredFields,
  factsFromFields,
  fieldsForToolCall,
  normalizeGenericFields,
  ocrExtractorLabel,
  omitInvalidToolFields,
  formToolForIncomeType,
  validateImportedFacts,
} from '@hatax/local-ai';
import type { FieldSourceLocationValue, PDFExtractResult } from './pdfExtractHelpers';
import { TAX_FACT_KEY_PREFIX, taxFactStorageKey } from './storageScope';
import { verifyAgainstPrint } from './extractionVerification';
import { buildBoxLedger } from './boxLedger';
import { readRecord, removeRecord, removeRecordsWithPrefix, writeRecord } from './caseRecords';

/** A case's TaxFacts, from the encrypted record cache (loaded when the vault unlocks). */
export function loadTaxFacts(returnId: string): TaxFact[] {
  const facts = readRecord<TaxFact[]>(taxFactStorageKey(returnId));
  return Array.isArray(facts) ? facts : [];
}

export function saveTaxFacts(returnId: string, facts: TaxFact[]): void {
  writeRecord(taxFactStorageKey(returnId), facts);
}

/** Remove a case's facts (paired with deleteReturn). */
export function deleteTaxFacts(returnId: string): void {
  removeRecord(taxFactStorageKey(returnId));
}

/** Remove every case's facts (paired with wipeAllData). */
export function deleteAllTaxFacts(): void {
  removeRecordsWithPrefix(TAX_FACT_KEY_PREFIX);
}

export function appendTaxFacts(returnId: string, facts: TaxFact[]): TaxFact[] {
  const next = [...loadTaxFacts(returnId), ...facts];
  saveTaxFacts(returnId, next);
  return next;
}

function extractorLabel(extracted: PDFExtractResult): string {
  return ocrExtractorLabel(extracted.ocrUsed === true);
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
  /** 0-based position of this form within the file. */
  formIndex?: number;
}): {
  facts: TaxFact[];
  toolFields: Record<string, unknown>;
  incomeType: string | null;
  toolError?: string;
  /** Structural validation of imported facts — never rewrites values. */
  validation: FactValidationResult;
} {
  const extractor = extractorLabel(input.extracted);
  const tool = formToolForIncomeType(input.extracted.incomeType);

  // The deterministic check, run here rather than inside an extractor: this is
  // the last point before a value reaches a return, and it is the first point
  // where the form type actually being written is known. A classification pass
  // can relabel a form after extraction, so verifying earlier would check the
  // values against one form and write them under another.
  const printIndex = input.extracted.printIndex;
  if (tool && printIndex) {
    const checked = verifyAgainstPrint(input.extracted.formType, input.extracted.extractedData, printIndex);
    for (const r of checked.rejected) {
      input.extracted.warnings.push(
        `Held ${r.field}: read as ${r.value}, but ${r.detail}. If it is on the form, it goes on the return only when you enter it.`,
      );
    }
    input.extracted.extractedData = checked.data;
    // The ledger is rebuilt against what actually survives, so a box the check
    // held is recorded as held rather than quietly counted as read. The page text
    // has to come along: without it every blank box would come back as a gap.
    input.extracted.boxLedger = buildBoxLedger(
      input.extracted.formType,
      checked.data,
      checked.rejected,
      input.extracted.pageText,
    );
  }

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
    // Development-order step 9: deterministic tool caller. Validates first,
    // then invokes tax-engine tools without rejected fields. No local LLM.
    const called = callIncomeToolFromStructuredFields({
      incomeType: input.extracted.incomeType,
      args: structured.args,
      context: {
        returnId: input.returnId,
        taxYear: input.taxYear,
        sourceDocumentId: input.documentId,
        sourceFormIndex: input.formIndex,
        sourceFileName: input.fileName,
        extractor,
        rawText: structured.rawText,
        sourceLocation: reconciled.fieldSourceLocations,
      },
    });
    if (!called.ok || !called.result?.ok) {
      const toolError =
        called.error ??
        (called.result && !called.result.ok ? called.result.error : 'Tool call failed');
      return {
        facts: called.facts,
        toolFields: {},
        incomeType: null,
        toolError,
        validation: called.validation,
      };
    }
    return {
      facts: called.facts,
      toolFields: called.appliedArgs,
      incomeType: called.result.incomeType ?? input.extracted.incomeType,
      validation: called.validation,
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
    formIndex: input.formIndex,
    fields: generic.fields,
    factTypeFor: (field) => `${prefix}_${field}`,
    rawText: generic.rawText,
    sourceLocation: reconciled.fieldSourceLocations,
  });
  const validation = validateImportedFacts(facts, { taxYear: input.taxYear });
  return {
    facts,
    toolFields: omitInvalidToolFields(
      fieldsForToolCall(generic.fields),
      facts,
      validation,
    ),
    incomeType: input.extracted.incomeType,
    validation,
  };
}
