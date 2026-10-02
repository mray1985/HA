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

import { getForm4137 } from '@hatax/engine';
import type { TaxFact, TaxFactValue } from './taxFact.js';
import { isLongTermHolding } from './holdingPeriod.js';
import { HSA_DISTRIBUTION_CODES, IDENTIFIABLE_EVENT_CODES, US_STATE_CODES as STATE_CODE_LIST } from './taxTools.js';

/** Rounding tolerance for FICA percentage checks (cents). */
const FICA_TOLERANCE = 1;

/** Additional Medicare Tax rate and threshold (IRC §3101(b)(2)). */
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLD = 200_000;

const US_STATE_CODES: ReadonlySet<string> = new Set(STATE_CODE_LIST);

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
  'localWages',
  'localTaxWithheld',
  'amount',
  'ordinaryDividends',
  'qualifiedDividends',
  'capitalGainDistributions',
  'unrecapturedSection1250Gain',
  'collectiblesGain',
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
  'originalIssueDiscount',
  'otherPeriodicInterest',
  'marketDiscount',
  'acquisitionPremium',
  'washSaleLossDisallowed',
  'amountCancelled',
  'interestIncluded',
  'grossProceeds',
  'buyerRealEstateTax',
  'proceeds',
  'costBasis',
  'cardNotPresent',
  'totalBenefits',
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
  /**
   * The whole form must be held for review: applying some of its fields would
   * leave a required amount missing (read by the engine as zero), or the form
   * contradicts itself or duplicates another. Dropping one field is not enough.
   */
  holdsForm?: boolean;
  /** Form this issue belongs to: `${sourceDocumentId}#${formIndex}`. */
  formKey?: string;
}

export interface FactValidationResult {
  /**
   * True when every extracted amount passes structural checks.
   * Unknown facts do not block readiness by themselves — they simply stay unknown
   * and must not be read as zero.
   */
  ready: boolean;
  issues: FactValidationIssue[];
  /** Forms (`${sourceDocumentId}#${formIndex}`) that must not be applied until reviewed. */
  heldForms: string[];
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

/** One map per form (document + position in a multi-form file), keyed by field. */
function byFormAndField(facts: TaxFact[]): Map<string, Map<string, TaxFact>> {
  const forms = new Map<string, Map<string, TaxFact>>();
  for (const fact of facts) {
    const key = formKeyOf(fact);
    let fields = forms.get(key);
    if (!fields) {
      fields = new Map();
      forms.set(key, fields);
    }
    fields.set(fact.sourceField, fact);
  }
  return forms;
}

/** `${sourceDocumentId}#${formIndex}` — identifies one form inside one file. */
export function formKeyOf(fact: Pick<TaxFact, 'sourceDocumentId' | 'sourceFormIndex'>): string {
  return `${fact.sourceDocumentId}#${fact.sourceFormIndex ?? 0}`;
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

  const byDoc = byFormAndField(facts);
  for (const fields of byDoc.values()) {
    if (!isW2Document(fields)) continue;
    const year =
      options?.taxYear ??
      [...fields.values()][0]?.taxYear ??
      2025;
    validateW2Relationships(fields, year, issues);
  }

  validateForms(facts, issues);

  const ready = !issues.some((i) => i.severity === 'error');
  const heldForms = [...new Set(issues.filter((i) => i.holdsForm && i.formKey).map((i) => i.formKey!))];
  return { ready, issues, heldForms };
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

// ─── Form-level checks (work order §15, §16, §34, §59) ──────────

/** Fact-type prefix → form, as written by the tax tools. */
const FORM_BY_PREFIX: ReadonlyArray<[string, string]> = [
  ['W2_', 'W-2'],
  ['W2C_', 'W-2C'],
  ['1099INT_', '1099-INT'],
  ['1099DIV_', '1099-DIV'],
  ['1099NEC_', '1099-NEC'],
  ['1099R_', '1099-R'],
  ['SSA1099_', 'SSA-1099'],
  ['1098T_', '1098-T'],
  ['1098_', '1098'],
  ['1099MISC_', '1099-MISC'],
  ['1099G_', '1099-G'],
  ['1099B_', '1099-B'],
  ['1099K_', '1099-K'],
  ['1099OID_', '1099-OID'],
  ['1099C_', '1099-C'],
  ['1099Q_', '1099-Q'],
  ['1099SA_', '1099-SA'],
  ['1099S_', '1099-S'],
  ['SCHC_RECEIPTS_', 'Business receipts'],
  ['ESTPAY_', 'Estimated payment'],
];

function formOf(fields: Map<string, TaxFact>): string | null {
  const factType = [...fields.values()][0]?.factType ?? '';
  return FORM_BY_PREFIX.find(([prefix]) => factType.startsWith(prefix))?.[1] ?? null;
}

/**
 * Amounts the engine requires for each form. The engine reads a missing
 * required amount as zero, so a form whose required amount is unknown or
 * absent is held — never applied with the box silently zeroed.
 */
export const REQUIRED_FORM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'W-2': ['wages', 'federalTaxWithheld'],
  '1099-INT': ['amount'],
  '1099-DIV': ['ordinaryDividends', 'qualifiedDividends'],
  '1099-NEC': ['amount'],
  '1099-R': ['grossDistribution', 'taxableAmount'],
  'SSA-1099': ['netBenefits'],
  '1098': ['mortgageInterest'],
  '1098-T': ['tuitionPaid'],
  // A blank cost basis (a noncovered security) would be read as zero basis.
  '1099-B': ['proceeds', 'costBasis', 'isLongTerm'],
  '1099-K': ['grossAmount'],
  '1099-C': ['amountCancelled'],
  // Box 1 is box 2 plus box 3; with only fair market value shown, earnings are figured (Pub. 970).
  '1099-Q': ['grossDistribution', 'earnings', 'basisReturn'],
  '1099-SA': ['grossDistribution', 'distributionCode'],
  '1099-S': ['grossProceeds'],
  'Business receipts': ['amount'],
  'Estimated payment': ['amount', 'jurisdiction'],
  // Without the employer EIN a W-2c cannot be matched to the W-2 it corrects.
  'W-2C': ['employerEin'],
};

/** Records from record tools (any evidence), as opposed to one tax form. */
const RECORD_KINDS: ReadonlySet<string> = new Set(['Business receipts', 'Estimated payment']);

/** Required fields that are not amounts: missing, the record cannot be placed at all. */
const REQUIRED_NON_AMOUNT_FIELDS: ReadonlySet<string> = new Set(['jurisdiction', 'isLongTerm', 'distributionCode', 'employerEin']);

/**
 * Forms whose income may be in any of several boxes: at least one must be
 * read, or the form has nothing the engine can take.
 */
const ONE_OF_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  '1099-MISC': ['rents', 'royalties', 'otherIncome'],
  '1099-OID': ['originalIssueDiscount', 'otherPeriodicInterest'],
};

/** 1099-R box 7 distribution codes (Instructions for Forms 1099-R and 5498). */
export const DISTRIBUTION_CODES = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'W', 'Y',
]);

/** Date the TCJA $750,000 acquisition-debt limit starts (IRC §163(h)(3)(F)). */
const TCJA_MORTGAGE_DATE = '2017-12-16';
const TCJA_MORTGAGE_LIMIT = 750_000;

function amount(fields: Map<string, TaxFact>, field: string): number | undefined {
  return numericOrMissing(fields.get(field));
}

function formIssue(
  fields: Map<string, TaxFact>,
  formKey: string,
  partial: Omit<FactValidationIssue, 'severity' | 'formKey' | 'sourceDocumentId'> & { severity?: FactValidationSeverity },
): FactValidationIssue {
  const sourceDocumentId = [...fields.values()][0]?.sourceDocumentId;
  return { severity: 'error', ...partial, formKey, sourceDocumentId };
}

/** "03/14/2021" or "2021-03-14" → "2021-03-14"; anything else → null. */
function isoDate(text: string | undefined): string | null {
  if (!text) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  return iso ? text.trim() : null;
}

function validateForms(facts: TaxFact[], issues: FactValidationIssue[]): void {
  const forms = byFormAndField(facts);
  for (const [formKey, fields] of forms) {
    const form = formOf(fields);
    if (!form) continue;

    // Required amounts: unknown or absent holds the whole form.
    for (const field of REQUIRED_FORM_FIELDS[form] ?? []) {
      const fact = fields.get(field);
      if (fact?.status === 'extracted') continue;
      const consequence = REQUIRED_NON_AMOUNT_FIELDS.has(field)
        ? 'It is held until that is known.'
        : 'The form is held: the engine would read it as zero.';
      issues.push(formIssue(fields, formKey, {
        code: 'REQUIRED_AMOUNT_UNKNOWN',
        message: `${form} ${field} is ${fact ? 'unreadable' : RECORD_KINDS.has(form) ? 'not in the evidence' : 'not on the form'}. ${consequence}`,
        factId: fact?.factId,
        sourceField: field,
        observed: 'unknown',
        holdsForm: true,
      }));
    }

    const oneOf = ONE_OF_REQUIRED[form];
    if (oneOf && !oneOf.some((f) => fields.get(f)?.status === 'extracted')) {
      issues.push(formIssue(fields, formKey, {
        code: 'NO_INCOME_BOX_READ',
        message: `${form}: none of ${oneOf.join(', ')} was read. The form is held; boxes the engine cannot take are reviewed separately.`,
        sourceField: oneOf[0],
        observed: 'unknown',
        holdsForm: true,
      }));
    }

    const hold = (code: string, message: string, field: string, observed: number | undefined) =>
      issues.push(formIssue(fields, formKey, {
        code, message, sourceField: field, factId: fields.get(field)?.factId, observed, holdsForm: true,
      }));
    const warn = (code: string, message: string, field: string, observed?: TaxFactValue) =>
      issues.push(formIssue(fields, formKey, {
        code, message, sourceField: field, factId: fields.get(field)?.factId, observed, severity: 'warning',
      }));

    switch (form) {
      case 'W-2': {
        const wages = amount(fields, 'wages');
        const withheld = amount(fields, 'federalTaxWithheld');
        if (wages !== undefined && withheld !== undefined && withheld > wages) {
          warn('WITHHOLDING_EXCEEDS_WAGES', `W-2 box 2 withholding (${withheld}) exceeds box 1 wages (${wages}).`, 'federalTaxWithheld', withheld);
        }
        break;
      }
      case '1099-INT':
      case '1099-NEC': {
        const amt = amount(fields, 'amount');
        const withheld = amount(fields, 'federalTaxWithheld');
        if (amt !== undefined && withheld !== undefined && withheld > amt) {
          warn('WITHHOLDING_EXCEEDS_INCOME', `${form} withholding (${withheld}) exceeds the income amount (${amt}).`, 'federalTaxWithheld', withheld);
        }
        break;
      }
      case '1099-DIV': {
        const ordinary = amount(fields, 'ordinaryDividends');
        const qualified = amount(fields, 'qualifiedDividends');
        if (ordinary !== undefined && qualified !== undefined && qualified > ordinary) {
          hold('DIV_QUALIFIED_EXCEEDS_ORDINARY', `1099-DIV box 1b (${qualified}) exceeds box 1a (${ordinary}); one of them was misread. Form held.`, 'qualifiedDividends', qualified);
        }
        break;
      }
      case '1099-R': {
        const gross = amount(fields, 'grossDistribution');
        const taxable = amount(fields, 'taxableAmount');
        const withheld = amount(fields, 'federalTaxWithheld');
        if (gross !== undefined && taxable !== undefined && taxable > gross) {
          hold('R_TAXABLE_EXCEEDS_GROSS', `1099-R box 2a (${taxable}) exceeds box 1 (${gross}). Form held.`, 'taxableAmount', taxable);
        }
        if (gross !== undefined && withheld !== undefined && withheld > gross) {
          hold('R_WITHHOLDING_EXCEEDS_GROSS', `1099-R box 4 (${withheld}) exceeds box 1 (${gross}). Form held.`, 'federalTaxWithheld', withheld);
        }
        const code = fields.get('distributionCode');
        if (code?.status === 'extracted' && typeof code.value === 'string') {
          const codes = code.value.toUpperCase().replace(/[^0-9A-Z]/g, '').split('');
          const bad = codes.filter((c) => !DISTRIBUTION_CODES.has(c));
          if (codes.length === 0 || codes.length > 2 || bad.length > 0) {
            hold('R_INVALID_DISTRIBUTION_CODE', `1099-R box 7 "${code.value}" is not a valid distribution code. Form held.`, 'distributionCode', undefined);
          }
        }
        break;
      }
      case 'SSA-1099': {
        const paid = amount(fields, 'benefitsPaid');
        const repaid = amount(fields, 'benefitsRepaid');
        const net = amount(fields, 'netBenefits');
        if (paid !== undefined && repaid !== undefined && net !== undefined && Math.abs(paid - repaid - net) > 0.005) {
          hold('SSA_NET_MISMATCH', `SSA-1099 box 5 (${net}) is not box 3 (${paid}) minus box 4 (${repaid}); one was misread. Form held.`, 'netBenefits', net);
        }
        break;
      }
      case '1098': {
        const refund = amount(fields, 'refundOfOverpaidInterest');
        if (refund !== undefined && refund > 0) {
          warn('MORTGAGE_REFUND_REVIEW', `1098 box 4 refund of overpaid interest (${refund}) may be income if the interest was deducted in a prior year.`, 'refundOfOverpaidInterest', refund);
        }
        const balance = amount(fields, 'outstandingPrincipal');
        const origination = isoDate(typeof fields.get('originationDate')?.value === 'string' ? (fields.get('originationDate')!.value as string) : undefined);
        if (balance !== undefined && balance > TCJA_MORTGAGE_LIMIT && origination && origination < TCJA_MORTGAGE_DATE) {
          warn('MORTGAGE_GRANDFATHERED_DEBT', `1098 loan originated ${origination} with ${balance} outstanding: pre-TCJA debt may use the $1,000,000 limit, but the engine applies $750,000.`, 'outstandingPrincipal', balance);
        }
        break;
      }
      case '1099-MISC': {
        const income = ['rents', 'royalties', 'otherIncome'].reduce((sum, f) => sum + (amount(fields, f) ?? 0), 0);
        const withheld = amount(fields, 'federalTaxWithheld');
        if (withheld !== undefined && income > 0 && withheld > income) {
          warn('WITHHOLDING_EXCEEDS_INCOME', `1099-MISC withholding (${withheld}) exceeds boxes 1–3 (${income}).`, 'federalTaxWithheld', withheld);
        }
        break;
      }
      case '1099-G': {
        const unemployment = amount(fields, 'unemploymentCompensation');
        const withheld = amount(fields, 'federalTaxWithheld');
        if (unemployment !== undefined && withheld !== undefined && withheld > unemployment) {
          warn('WITHHOLDING_EXCEEDS_INCOME', `1099-G withholding (${withheld}) exceeds box 1 unemployment compensation (${unemployment}).`, 'federalTaxWithheld', withheld);
        }
        break;
      }
      case '1099-B': {
        const proceeds = amount(fields, 'proceeds');
        const withheld = amount(fields, 'federalTaxWithheld');
        const term = fields.get('isLongTerm');
        const fromDates = isLongTermHolding(
          fields.get('dateAcquired')?.status === 'extracted' ? String(fields.get('dateAcquired')!.value) : undefined,
          fields.get('dateSold')?.status === 'extracted' ? String(fields.get('dateSold')!.value) : undefined,
        );
        if (term?.status === 'extracted' && fromDates !== undefined && term.value !== fromDates) {
          issues.push(formIssue(fields, formKey, {
            code: 'B_TERM_CONTRADICTS_DATES',
            message: `1099-B box 2 says ${term.value ? 'long' : 'short'}-term but boxes 1b and 1c make it ${fromDates ? 'long' : 'short'}-term; one was misread. Form held.`,
            sourceField: 'isLongTerm', factId: term.factId, holdsForm: true,
          }));
        }
        if (proceeds !== undefined && withheld !== undefined && withheld > proceeds) {
          hold('B_WITHHOLDING_EXCEEDS_PROCEEDS', `1099-B box 4 (${withheld}) exceeds box 1d proceeds (${proceeds}); one was misread. Form held.`, 'federalTaxWithheld', withheld);
        }
        break;
      }
      case '1099-K': {
        const gross = amount(fields, 'grossAmount');
        const cardNotPresent = amount(fields, 'cardNotPresent');
        if (gross !== undefined && cardNotPresent !== undefined && cardNotPresent > gross) {
          hold('K_CARD_NOT_PRESENT_EXCEEDS_GROSS', `1099-K box 1b (${cardNotPresent}) is part of box 1a (${gross}) and cannot exceed it; one was misread. Form held.`, 'cardNotPresent', cardNotPresent);
        }
        break;
      }
      case '1099-C': {
        const discharged = amount(fields, 'amountCancelled');
        const interest = amount(fields, 'interestIncluded');
        if (discharged !== undefined && interest !== undefined && interest > discharged) {
          hold('C_INTEREST_EXCEEDS_DEBT', `1099-C box 3 interest (${interest}) is included in box 2 (${discharged}) and cannot exceed it. Form held.`, 'interestIncluded', interest);
        }
        const code = fields.get('identifiableEventCode');
        if (code?.status === 'extracted' && typeof code.value === 'string' && !(IDENTIFIABLE_EVENT_CODES as readonly string[]).includes(code.value.trim().toUpperCase())) {
          hold('C_INVALID_EVENT_CODE', `1099-C box 6 "${code.value}" is not an identifiable event code (A–H). Form held.`, 'identifiableEventCode', undefined);
        }
        const liable = fields.get('personallyLiable');
        if (liable?.status === 'extracted' && liable.value === false) {
          warn('C_NOT_PERSONALLY_LIABLE', '1099-C box 5 is not checked: for a nonrecourse debt the amount may not be cancellation-of-debt income (Pub. 4681).', 'personallyLiable', false);
        } else if (liable?.status !== 'extracted') {
          // Unread is not "checked": an unchecked box 5 changes what the cancelled amount is.
          warn('C_LIABILITY_UNREAD', '1099-C box 5 (the debtor was personally liable) was not read: check it on the form. If it is not checked, the debt is nonrecourse and the amount may not be cancellation-of-debt income (Pub. 4681).', 'personallyLiable');
        }
        break;
      }
      case '1099-Q': {
        const gross = amount(fields, 'grossDistribution');
        const earnings = amount(fields, 'earnings');
        const basis = amount(fields, 'basisReturn');
        if (gross !== undefined && earnings !== undefined && basis !== undefined && Math.abs(gross - earnings - basis) > 0.005) {
          hold('Q_BOXES_DO_NOT_ADD', `1099-Q box 1 (${gross}) is not box 2 (${earnings}) plus box 3 (${basis}); one was misread. Form held.`, 'grossDistribution', gross);
        }
        break;
      }
      case '1099-SA': {
        const code = fields.get('distributionCode');
        if (code?.status === 'extracted' && typeof code.value === 'string' && !(HSA_DISTRIBUTION_CODES as readonly string[]).includes(code.value.trim())) {
          hold('SA_INVALID_DISTRIBUTION_CODE', `1099-SA box 3 "${code.value}" is not a distribution code (1–6). Form held.`, 'distributionCode', undefined);
        }
        break;
      }
      default:
        break;
    }
  }
  detectReceiptsRepeating1099(forms, issues);
  checkReadings(forms, issues);
  // Last: a copy held for any reason above never stands in for a complete one.
  detectDuplicateForms(forms, issues);
}

/** A model reading below this agreement score goes to review (confirmed readings score 1). */
export const READING_REVIEW_THRESHOLD = 1;

/**
 * Model readings (work order §33): readers that disagree, or a box the page
 * prints that no reader read, hold the form; a value only one model read is
 * reviewed. Facts without a score (text layer, preparer entries) are not rated.
 */
function checkReadings(forms: Map<string, Map<string, TaxFact>>, issues: FactValidationIssue[]): void {
  for (const [formKey, fields] of forms) {
    if (!formOf(fields)) continue;
    for (const [field, fact] of fields) {
      if (fact.sourceKind === 'preparer_correction') continue;
      if (fact.secondReading && !fact.secondReading.agrees) {
        issues.push(formIssue(fields, formKey, {
          code: 'READERS_DISAGREE',
          message: `${field}: the readers disagree ("${fact.rawText}" vs "${fact.secondReading.text}"). Form held until the preparer enters the value.`,
          sourceField: field, factId: fact.factId, holdsForm: true,
        }));
      } else if (fact.status === 'unknown' && fact.rawText.trim() && fact.confidence === 0) {
        issues.push(formIssue(fields, formKey, {
          code: 'PRINTED_VALUE_UNREAD',
          message: `${field}: the page prints "${fact.rawText}" but no reader read it. Form held: the engine would read it as zero.`,
          sourceField: field, factId: fact.factId, observed: 'unknown', holdsForm: true,
        }));
      } else if (fact.status === 'extracted' && fact.confidence !== null && fact.confidence < READING_REVIEW_THRESHOLD) {
        issues.push(formIssue(fields, formKey, {
          code: 'UNCONFIRMED_READING',
          severity: 'warning',
          message: `${field} (${JSON.stringify(fact.value)}) was read by one model only; neither the page text nor the second reader confirmed it.`,
          sourceField: field, factId: fact.factId, observed: fact.value,
        }));
      }
    }
  }
}

/**
 * Business receipts are the income no 1099 reports. Receipts equal to a
 * 1099-NEC's amount were most likely counted from that 1099 again.
 */
function detectReceiptsRepeating1099(forms: Map<string, Map<string, TaxFact>>, issues: FactValidationIssue[]): void {
  const necAmounts = new Map<number, string>();
  for (const [formKey, fields] of forms) {
    if (formOf(fields) !== '1099-NEC') continue;
    const amt = amount(fields, 'amount');
    if (amt !== undefined && amt > 0) necAmounts.set(amt, formKey);
  }
  for (const [formKey, fields] of forms) {
    if (formOf(fields) !== 'Business receipts') continue;
    const amt = amount(fields, 'amount');
    const nec = amt !== undefined ? necAmounts.get(amt) : undefined;
    if (!nec) continue;
    issues.push(formIssue(fields, formKey, {
      code: 'RECEIPTS_MATCH_1099',
      severity: 'warning',
      message: `Business receipts of ${amt} equal the 1099-NEC ${nec}. Receipts must exclude amounts a 1099 reports; confirm this is not the same income.`,
      sourceField: 'amount',
      factId: fields.get('amount')?.factId,
      observed: amt,
    }));
  }
}

/**
 * Identity used to spot the same form imported twice from different files:
 * `required` fields must all be read; `optional` fields count as read or blank.
 */
const DUPLICATE_KEYS: Readonly<Record<string, { required: readonly string[]; optional?: readonly string[] }>> = {
  'W-2': { required: ['employerEin', 'wages', 'federalTaxWithheld'] },
  '1099-INT': { required: ['payerName', 'amount'] },
  '1099-DIV': { required: ['payerName', 'ordinaryDividends'] },
  '1099-NEC': { required: ['payerEin', 'amount'] },
  '1099-R': { required: ['payerName', 'grossDistribution', 'distributionCode'] },
  'SSA-1099': { required: ['netBenefits', 'beneficiaryName'] },
  '1098': { required: ['lenderTin', 'mortgageInterest'] },
  '1098-T': { required: ['institutionEin', 'tuitionPaid', 'studentName'] },
  '1099-MISC': { required: ['payerName'], optional: ['rents', 'royalties', 'otherIncome'] },
  '1099-G': { required: ['payerName'], optional: ['unemploymentCompensation', 'federalTaxWithheld'] },
  '1099-B': { required: ['brokerName', 'proceeds'], optional: ['description', 'dateSold', 'costBasis'] },
  '1099-K': { required: ['platformName', 'grossAmount'] },
  '1099-OID': { required: ['payerName'], optional: ['originalIssueDiscount', 'otherPeriodicInterest'] },
  '1099-C': { required: ['payerName', 'amountCancelled'], optional: ['dateOfCancellation'] },
  '1099-Q': { required: ['payerName', 'grossDistribution'] },
  '1099-SA': { required: ['payerName', 'grossDistribution'], optional: ['distributionCode'] },
  '1099-S': { required: ['grossProceeds'], optional: ['closingDate', 'propertyAddress'] },
  'Business receipts': { required: ['description', 'amount'] },
  'Estimated payment': { required: ['jurisdiction', 'amount', 'datePaid'] },
};

/**
 * The same form imported from two files (a PDF and a phone photo of it) has
 * different content hashes but identical identifying values. One copy is kept —
 * the first not already held for another reason (a misread photo never keeps
 * the clean PDF off the return) — and the others are held so it is never
 * counted twice; the preparer confirms which to keep.
 */
function detectDuplicateForms(forms: Map<string, Map<string, TaxFact>>, issues: FactValidationIssue[]): void {
  const heldAlready = new Set(issues.filter((i) => i.holdsForm && i.formKey).map((i) => i.formKey!));
  const copies = new Map<string, { keys: string[]; formKeys: string[]; fields: Map<string, Map<string, TaxFact>> }>();
  for (const [formKey, fields] of forms) {
    const form = formOf(fields);
    const identityKeys = form ? DUPLICATE_KEYS[form] : undefined;
    if (!form || !identityKeys) continue;
    const parts: string[] = [];
    let complete = true;
    for (const k of identityKeys.required) {
      const fact = fields.get(k);
      if (fact?.status !== 'extracted') { complete = false; break; }
      parts.push(JSON.stringify(fact.value));
    }
    if (!complete) continue;
    for (const k of identityKeys.optional ?? []) {
      const fact = fields.get(k);
      parts.push(fact?.status === 'extracted' ? JSON.stringify(fact.value) : '-');
    }
    const keys = [...identityKeys.required, ...(identityKeys.optional ?? [])];
    const identity = `${form}|${parts.join('|')}`;
    const group = copies.get(identity) ?? { keys, formKeys: [] as string[], fields: new Map<string, Map<string, TaxFact>>() };
    group.formKeys.push(formKey);
    group.fields.set(formKey, fields);
    copies.set(identity, group);
  }
  for (const [identity, { keys, formKeys, fields }] of copies) {
    if (formKeys.length < 2) continue;
    const form = identity.slice(0, identity.indexOf('|'));
    const kept = formKeys.find((k) => !heldAlready.has(k)) ?? formKeys[0]!;
    for (const formKey of formKeys) {
      if (formKey === kept) continue;
      issues.push(formIssue(fields.get(formKey)!, formKey, {
        code: 'DUPLICATE_FORM',
        severity: 'warning',
        message: `This ${form} matches ${kept} (${keys.join(', ')}). Held so it is not counted twice.`,
        holdsForm: true,
      }));
    }
  }
}
