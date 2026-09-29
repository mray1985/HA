/**
 * Fact validation (development-order step 8).
 *
 * Deterministic checks on imported TaxFacts before they are treated as ready
 * for later tool-caller / return-population steps.
 *
 * Invariants:
 * - UNKNOWN != ZERO — an unknown fact never becomes a numeric 0.
 * - A real extracted 0 is kept.
 * - Structural failures are recorded for the preparer; values are never rewritten
 *   or invented to "fix" a problem.
 *
 * This is not the diagnostics engine, review queue, or reconciliation.
 */

import { getForm4137 } from '../constants/taxConstants.js';
import type { TaxFact, TaxFactValue } from './taxFact.js';

/** Rounding tolerance for FICA percentage checks (cents). */
const FICA_TOLERANCE = 1;

/** Additional Medicare Tax rate and threshold (IRC §3101(b)(2)). */
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLD = 200_000;

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

/**
 * Source fields that structurally cannot be negative on imported income docs.
 * Covers tax-tool forms and generic classified-form money fields the pipeline extracts.
 */
const NON_NEGATIVE_AMOUNT_FIELDS = new Set([
  'wages',
  'federalTaxWithheld',
  'socialSecurityWages',
  'socialSecurityTax',
  'medicareWages',
  'medicareTax',
  'stateWages',
  'stateTaxWithheld',
  'amount',
  'ordinaryDividends',
  'qualifiedDividends',
  'capitalGainDistributions',
  'foreignTaxPaid',
  'foreignSourceIncome',
  'earlyWithdrawalPenalty',
  'usBondInterest',
  'taxExemptInterest',
  'grossDistribution',
  'taxableAmount',
  'rothContributionBasis',
  'qcdAmount',
  'earlyDistributionExceptionAmount',
  // Generic classified-form money fields (W-2G, 1099-G, 1099-K, 1098, …).
  'grossWinnings',
  'unemploymentCompensation',
  'grossAmount',
  'mortgageInterest',
  'rents',
  'royalties',
  'otherIncome',
  'proceeds',
  'costBasis',
  'cardNotPresent',
  'totalBenefits',
  'earnings',
  'basisReturn',
  'outstandingPrincipal',
  'mortgageInsurance',
  'tuitionPayments',
  'scholarships',
  'interestPaid',
  'annualEnrollmentPremium',
  'annualSLCSP',
  'annualAdvancePTC',
]);

/** Monetary members of a 1099-R simplifiedMethod object. */
const SIMPLIFIED_METHOD_MONEY_FIELDS = [
  'totalContributions',
  'paymentsThisYear',
  'priorYearTaxFreeRecovery',
] as const;

export type FactValidationSeverity = 'error' | 'warning';

export interface FactValidationIssue {
  code: string;
  severity: FactValidationSeverity;
  message: string;
  factId?: string;
  sourceField?: string;
  sourceDocumentId?: string;
  /**
   * Observed value (or "unknown"). Never a replacement / invented fix.
   */
  observed?: TaxFactValue | 'unknown';
}

export interface FactValidationResult {
  /**
   * True when every extracted amount passes structural checks.
   * Unknown facts do not block readiness by themselves — they simply stay unknown
   * and must not be read as zero.
   */
  ready: boolean;
  issues: FactValidationIssue[];
}

/**
 * Read a fact as a tool/return amount without guessing.
 * Unknown → undefined (never 0). Extracted finite number → that number, including 0.
 */
export function amountFromFact(fact: TaxFact): number | undefined {
  if (fact.status === 'unknown') return undefined;
  if (typeof fact.value !== 'number') return undefined;
  if (!Number.isFinite(fact.value)) return undefined;
  return fact.value;
}

/**
 * Coerce a fact for math only when it is a known extracted number.
 * Unknown stays missing — never silently zeroed.
 */
export function numericOrMissing(fact: TaxFact | undefined): number | undefined {
  if (!fact) return undefined;
  return amountFromFact(fact);
}

function issue(
  partial: Omit<FactValidationIssue, 'severity'> & { severity?: FactValidationSeverity },
): FactValidationIssue {
  return {
    severity: partial.severity ?? 'error',
    code: partial.code,
    message: partial.message,
    factId: partial.factId,
    sourceField: partial.sourceField,
    sourceDocumentId: partial.sourceDocumentId,
    observed: partial.observed,
  };
}

function byDocAndField(facts: TaxFact[]): Map<string, Map<string, TaxFact>> {
  const docs = new Map<string, Map<string, TaxFact>>();
  for (const fact of facts) {
    let fields = docs.get(fact.sourceDocumentId);
    if (!fields) {
      fields = new Map();
      docs.set(fact.sourceDocumentId, fields);
    }
    fields.set(fact.sourceField, fact);
  }
  return docs;
}

function isW2Document(fields: Map<string, TaxFact>): boolean {
  return [...fields.values()].some((f) => f.factType.startsWith('W2_'));
}

function pushNegativeAmount(
  fact: TaxFact,
  sourceField: string,
  amount: number,
  issues: FactValidationIssue[],
): void {
  issues.push(
    issue({
      code: 'NEGATIVE_AMOUNT',
      message: `Field "${sourceField}" is negative (${amount}). Recorded as extracted; not rewritten.`,
      factId: fact.factId,
      sourceField: fact.sourceField,
      sourceDocumentId: fact.sourceDocumentId,
      observed: amount,
    }),
  );
}

function validateSimplifiedMethodAmounts(fact: TaxFact, issues: FactValidationIssue[]): void {
  if (fact.sourceField !== 'simplifiedMethod') return;
  if (fact.status === 'unknown') return;
  if (!fact.value || typeof fact.value !== 'object' || Array.isArray(fact.value)) return;

  const row = fact.value as Record<string, unknown>;
  for (const key of SIMPLIFIED_METHOD_MONEY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const amount = row[key];
    if (typeof amount !== 'number') continue;
    if (!Number.isFinite(amount)) {
      issues.push(
        issue({
          code: 'NON_FINITE_AMOUNT',
          message: `Field "simplifiedMethod.${key}" is not a finite number and cannot be used as a tax amount.`,
          factId: fact.factId,
          sourceField: fact.sourceField,
          sourceDocumentId: fact.sourceDocumentId,
          observed: fact.value,
        }),
      );
      continue;
    }
    if (amount < 0) {
      pushNegativeAmount(fact, `simplifiedMethod.${key}`, amount, issues);
    }
  }
}

function validateScalarAmounts(facts: TaxFact[], issues: FactValidationIssue[]): void {
  for (const fact of facts) {
    if (fact.status === 'unknown') {
      // Explicit: unknown is not zero. No rewrite. No issue unless a later
      // consumer treats it as zero — that is prevented by amountFromFact.
      continue;
    }

    if (typeof fact.value === 'number') {
      if (!Number.isFinite(fact.value)) {
        issues.push(
          issue({
            code: 'NON_FINITE_AMOUNT',
            message: `Field "${fact.sourceField}" is not a finite number and cannot be used as a tax amount.`,
            factId: fact.factId,
            sourceField: fact.sourceField,
            sourceDocumentId: fact.sourceDocumentId,
            observed: fact.value,
          }),
        );
        continue;
      }
      if (NON_NEGATIVE_AMOUNT_FIELDS.has(fact.sourceField) && fact.value < 0) {
        pushNegativeAmount(fact, fact.sourceField, fact.value, issues);
      }
    }

    if (fact.sourceField === 'state' || fact.sourceField === 'stateCode') {
      if (typeof fact.value === 'string') {
        const code = fact.value.trim().toUpperCase();
        if (code && !US_STATE_CODES.has(code)) {
          issues.push(
            issue({
              code: 'INVALID_STATE_IDENTIFIER',
              message: `State identifier "${fact.value}" is not a recognized US state/DC code.`,
              factId: fact.factId,
              sourceField: fact.sourceField,
              sourceDocumentId: fact.sourceDocumentId,
              observed: fact.value,
            }),
          );
        }
      } else {
        // Non-string extracted identifiers (e.g. state: 12) are not state codes.
        // Do not invent a two-letter replacement.
        issues.push(
          issue({
            code: 'INVALID_STATE_IDENTIFIER',
            message: `State identifier is not a recognized US state/DC code (observed non-string value).`,
            factId: fact.factId,
            sourceField: fact.sourceField,
            sourceDocumentId: fact.sourceDocumentId,
            observed: fact.value,
          }),
        );
      }
    }

    validateSimplifiedMethodAmounts(fact, issues);

    if (fact.sourceField === 'box12' && Array.isArray(fact.value)) {
      for (const entry of fact.value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const amount = (entry as { amount?: unknown }).amount;
        if (typeof amount === 'number' && !Number.isFinite(amount)) {
          issues.push(
            issue({
              code: 'NON_FINITE_AMOUNT',
              message: `W-2 box12 entry has a non-finite amount and cannot be used.`,
              factId: fact.factId,
              sourceField: 'box12',
              sourceDocumentId: fact.sourceDocumentId,
              observed: fact.value,
            }),
          );
        } else if (typeof amount === 'number' && amount < 0) {
          pushNegativeAmount(fact, 'box12', amount, issues);
        }
      }
    }
  }
}

/**
 * W-2 box relationship checks from the work-order validation examples.
 * Failures are flagged; amounts are never adjusted.
 */
function validateW2Relationships(
  fields: Map<string, TaxFact>,
  taxYear: number,
  issues: FactValidationIssue[],
): void {
  let form4137: { SS_RATE: number; MEDICARE_RATE: number; SS_WAGE_BASE: number };
  try {
    form4137 = getForm4137(taxYear);
  } catch {
    // Unsupported year: skip year-based FICA caps rather than inventing constants.
    return;
  }

  const wages = numericOrMissing(fields.get('wages'));
  const ssWages = numericOrMissing(fields.get('socialSecurityWages'));
  const ssTax = numericOrMissing(fields.get('socialSecurityTax'));
  const medicareWages = numericOrMissing(fields.get('medicareWages'));
  const medicareTax = numericOrMissing(fields.get('medicareTax'));

  const docId = [...fields.values()][0]?.sourceDocumentId;

  // Box 3 must not exceed the Social Security wage base.
  if (ssWages !== undefined && ssWages > form4137.SS_WAGE_BASE) {
    const fact = fields.get('socialSecurityWages')!;
    issues.push(
      issue({
        code: 'W2_BOX3_EXCEEDS_WAGE_BASE',
        severity: 'warning',
        message: `Box 3 Social Security wages (${ssWages}) exceed the ${taxYear} wage base (${form4137.SS_WAGE_BASE}).`,
        factId: fact.factId,
        sourceField: 'socialSecurityWages',
        sourceDocumentId: docId,
        observed: ssWages,
      }),
    );
  }

  // Box 1 vs Box 3: when both known and Box 3 is below Box 1 while still under the
  // wage base, the relationship is structurally inconsistent (SS wages are normally
  // at least Box 1 unless capped). Flag — do not invent a corrected Box 3.
  if (
    wages !== undefined &&
    ssWages !== undefined &&
    ssWages < wages &&
    ssWages < form4137.SS_WAGE_BASE
  ) {
    const fact = fields.get('socialSecurityWages')!;
    issues.push(
      issue({
        code: 'W2_BOX1_BOX3_RELATIONSHIP',
        severity: 'warning',
        message: `Box 3 Social Security wages (${ssWages}) are below Box 1 wages (${wages}) without hitting the wage base. Flagged for preparer review; values not changed.`,
        factId: fact.factId,
        sourceField: 'socialSecurityWages',
        sourceDocumentId: docId,
        observed: ssWages,
      }),
    );
  }

  // Box 4 maximum: Box 3 × employee SS rate.
  if (ssTax !== undefined && ssWages !== undefined) {
    const maxSSTax = ssWages * form4137.SS_RATE;
    if (ssTax > maxSSTax + FICA_TOLERANCE) {
      const fact = fields.get('socialSecurityTax')!;
      issues.push(
        issue({
          code: 'W2_BOX4_EXCEEDS_MAX',
          severity: 'warning',
          message: `Box 4 SS tax (${ssTax}) exceeds 6.2% of Box 3 (${maxSSTax.toFixed(2)}).`,
          factId: fact.factId,
          sourceField: 'socialSecurityTax',
          sourceDocumentId: docId,
          observed: ssTax,
        }),
      );
    }
  }

  // Box 5 vs Box 3: Medicare wages are normally at least SS wages.
  if (medicareWages !== undefined && ssWages !== undefined && medicareWages < ssWages) {
    const fact = fields.get('medicareWages')!;
    issues.push(
      issue({
        code: 'W2_BOX5_BELOW_BOX3',
        severity: 'warning',
        message: `Box 5 Medicare wages (${medicareWages}) are below Box 3 Social Security wages (${ssWages}).`,
        factId: fact.factId,
        sourceField: 'medicareWages',
        sourceDocumentId: docId,
        observed: medicareWages,
      }),
    );
  }

  // Box 6 relationship: regular Medicare + Additional Medicare Tax ceiling.
  if (medicareTax !== undefined && medicareWages !== undefined) {
    const regular = medicareWages * form4137.MEDICARE_RATE;
    const additional =
      Math.max(0, medicareWages - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;
    const maxMedicare = regular + additional;
    if (medicareTax > maxMedicare + FICA_TOLERANCE) {
      const fact = fields.get('medicareTax')!;
      issues.push(
        issue({
          code: 'W2_BOX6_EXCEEDS_MAX',
          severity: 'warning',
          message: `Box 6 Medicare tax (${medicareTax}) exceeds the expected maximum (${maxMedicare.toFixed(2)}) for Box 5 wages.`,
          factId: fact.factId,
          sourceField: 'medicareTax',
          sourceDocumentId: docId,
          observed: medicareTax,
        }),
      );
    }
  }
}

/**
 * Validate imported TaxFacts. Does not mutate facts or invent replacement amounts.
 */
export function validateImportedFacts(
  facts: TaxFact[],
  options?: { taxYear?: number },
): FactValidationResult {
  const issues: FactValidationIssue[] = [];
  validateScalarAmounts(facts, issues);

  const byDoc = byDocAndField(facts);
  for (const fields of byDoc.values()) {
    if (!isW2Document(fields)) continue;
    const year =
      options?.taxYear ??
      [...fields.values()][0]?.taxYear ??
      2025;
    validateW2Relationships(fields, year, issues);
  }

  const ready = !issues.some((i) => i.severity === 'error');
  return { ready, issues };
}

/** True when an error-level issue targets this exact fact (not another document's field). */
export function factHasValidationError(
  fact: TaxFact,
  validation: FactValidationResult,
): boolean {
  return validation.issues.some(
    (i) =>
      i.severity === 'error' &&
      (i.factId === fact.factId ||
        (i.sourceDocumentId === fact.sourceDocumentId &&
          i.sourceField === fact.sourceField)),
  );
}

/**
 * True when a fact may be treated as a known tool/return value.
 * Unknown facts are never ready as amounts (including never as zero).
 * Structurally invalid extracted amounts are also not ready.
 * Matching is scoped to the fact identity / same document — never by sourceField alone.
 */
export function isFactAmountReady(
  fact: TaxFact,
  validation: FactValidationResult = validateImportedFacts([fact]),
): boolean {
  if (fact.status === 'unknown') return false;
  if (typeof fact.value === 'number' && !Number.isFinite(fact.value)) return false;
  return !factHasValidationError(fact, validation);
}

/**
 * Drop tool/return fields that failed structural validation.
 * Does not rewrite values — invalid keys are omitted so they stay unapplied.
 * Valid fields on the same form are kept. Missing amounts stay omitted (not zero).
 */
export function omitInvalidToolFields(
  toolFields: Record<string, unknown>,
  facts: TaxFact[],
  validation: FactValidationResult,
): Record<string, unknown> {
  if (validation.ready) return toolFields;
  const byField = new Map(facts.map((f) => [f.sourceField, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolFields)) {
    const fact = byField.get(key);
    if (fact && factHasValidationError(fact, validation)) continue;
    out[key] = value;
  }
  return out;
}
