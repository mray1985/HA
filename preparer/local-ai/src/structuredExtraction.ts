/**
 * Structured extraction (development-order step 6).
 * Turns raw extractor tokens into the fields the tax tools already accept.
 * A printed "$0.00" stays numeric 0. A missing or unreadable token stays unknown.
 * rawText is the original token, never a string rebuilt from the normalized number.
 * This step does not store coordinates, validate tax rules, or calculate tax.
 */

import {
  isDocumentTool,
  formToolForIncomeType,
  W2C_CORRECTABLE,
  W2C_TEXT_FIELDS,
  w2cField,
  type DocumentToolName,
} from './taxTools.js';
import { isLongTermHolding } from './holdingPeriod.js';

export type StructuredFieldStatus = 'extracted' | 'unknown';

export interface StructuredExtraction {
  tool: DocumentToolName | null;
  /**
   * Arguments for the tax tool. Unreadable supplied fields are present as
   * undefined so they become unknown facts. Keys the extractor never sent
   * are absent. Missing amounts are not zero.
   */
  args: Record<string, unknown>;
  /** Original source text by field. Absent when the extractor already passed a number. */
  rawText: Record<string, string>;
}

type FieldKind = 'money' | 'text' | 'boolean' | 'integer' | 'box12' | 'box13' | 'simplifiedMethod';

const W2_FIELDS: Record<string, FieldKind> = {
  employerName: 'text',
  employerEin: 'text',
  wages: 'money',
  federalTaxWithheld: 'money',
  socialSecurityWages: 'money',
  socialSecurityTax: 'money',
  medicareWages: 'money',
  medicareTax: 'money',
  stateTaxWithheld: 'money',
  stateWages: 'money',
  state: 'text',
  localWages: 'money',
  localTaxWithheld: 'money',
  localityName: 'text',
  box12: 'box12',
  box13: 'box13',
  isSpouse: 'boolean',
};

const INT_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  amount: 'money',
  earlyWithdrawalPenalty: 'money',
  usBondInterest: 'money',
  federalTaxWithheld: 'money',
  taxExemptInterest: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const DIV_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  ordinaryDividends: 'money',
  qualifiedDividends: 'money',
  capitalGainDistributions: 'money',
  unrecapturedSection1250Gain: 'money',
  collectiblesGain: 'money',
  federalTaxWithheld: 'money',
  foreignTaxPaid: 'money',
  foreignSourceIncome: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const NEC_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  payerEin: 'text',
  amount: 'money',
  federalTaxWithheld: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const R_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  grossDistribution: 'money',
  taxableAmount: 'money',
  federalTaxWithheld: 'money',
  distributionCode: 'text',
  isIRA: 'boolean',
  isRothIRA: 'boolean',
  rothContributionBasis: 'money',
  qcdAmount: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
  isSpouse: 'boolean',
  earlyDistributionExceptionCode: 'text',
  earlyDistributionExceptionAmount: 'money',
  useSimplifiedMethod: 'boolean',
  simplifiedMethod: 'simplifiedMethod',
};

const SSA_FIELDS: Record<string, FieldKind> = {
  beneficiaryName: 'text',
  benefitsPaid: 'money',
  benefitsRepaid: 'money',
  netBenefits: 'money',
  federalTaxWithheld: 'money',
  isSpouse: 'boolean',
};

const MORTGAGE_FIELDS: Record<string, FieldKind> = {
  lenderName: 'text',
  lenderTin: 'text',
  mortgageInterest: 'money',
  outstandingPrincipal: 'money',
  originationDate: 'text',
  refundOfOverpaidInterest: 'money',
  mortgageInsurancePremiums: 'money',
  points: 'money',
  propertyAddressSameAsBorrower: 'boolean',
  propertyAddress: 'text',
  numberOfProperties: 'integer',
  acquisitionDate: 'text',
};

const EDUCATION_FIELDS: Record<string, FieldKind> = {
  institutionName: 'text',
  institutionEin: 'text',
  studentName: 'text',
  tuitionPaid: 'money',
  priorYearAdjustments: 'money',
  scholarships: 'money',
  scholarshipAdjustments: 'money',
  includesNextPeriod: 'boolean',
  halfTimeStudent: 'boolean',
  graduateStudent: 'boolean',
  insuranceReimbursement: 'money',
};

const MISC_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  rents: 'money',
  royalties: 'money',
  otherIncome: 'money',
  federalTaxWithheld: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const W2G_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  grossWinnings: 'money',
  typeOfWager: 'text',
  federalTaxWithheld: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const SLI_FIELDS: Record<string, FieldKind> = {
  lenderName: 'text',
  studentLoanInterest: 'money',
  originationFeesExcluded: 'boolean',
};

const K1_FIELDS: Record<string, FieldKind> = {
  entityName: 'text',
  entityEin: 'text',
  entityType: 'text',
  ordinaryBusinessIncome: 'money',
  rentalIncome: 'money',
  guaranteedPayments: 'money',
  interestIncome: 'money',
  ordinaryDividends: 'money',
  qualifiedDividends: 'money',
  royalties: 'money',
  shortTermCapitalGain: 'money',
  longTermCapitalGain: 'money',
  netSection1231Gain: 'money',
  otherIncome: 'money',
  section179Deduction: 'money',
  selfEmploymentIncome: 'money',
};

const G_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  unemploymentCompensation: 'money',
  federalTaxWithheld: 'money',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const B_FIELDS: Record<string, FieldKind> = {
  brokerName: 'text',
  description: 'text',
  dateAcquired: 'text',
  dateSold: 'text',
  proceeds: 'money',
  costBasis: 'money',
  isLongTerm: 'boolean',
  federalTaxWithheld: 'money',
  washSaleLossDisallowed: 'money',
  basisReportedToIRS: 'boolean',
  isCollectible: 'boolean',
};

const K_FIELDS: Record<string, FieldKind> = {
  platformName: 'text',
  grossAmount: 'money',
  cardNotPresent: 'money',
  federalTaxWithheld: 'money',
};

const OID_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  originalIssueDiscount: 'money',
  otherPeriodicInterest: 'money',
  earlyWithdrawalPenalty: 'money',
  federalTaxWithheld: 'money',
  marketDiscount: 'money',
  acquisitionPremium: 'money',
  description: 'text',
  stateCode: 'text',
  stateTaxWithheld: 'money',
};

const C_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  dateOfCancellation: 'text',
  amountCancelled: 'money',
  interestIncluded: 'money',
  debtDescription: 'text',
  identifiableEventCode: 'text',
  personallyLiable: 'boolean',
};

const Q_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  grossDistribution: 'money',
  earnings: 'money',
  basisReturn: 'money',
  trusteeToTrusteeTransfer: 'boolean',
  qtpToRothIra: 'boolean',
  recipientNotDesignatedBeneficiary: 'boolean',
};

const SA_FIELDS: Record<string, FieldKind> = {
  payerName: 'text',
  grossDistribution: 'money',
  distributionCode: 'text',
  accountType: 'text',
};

const S_FIELDS: Record<string, FieldKind> = {
  filerName: 'text',
  closingDate: 'text',
  grossProceeds: 'money',
  propertyAddress: 'text',
  buyerRealEstateTax: 'money',
  transferorIsForeign: 'boolean',
};

const W2C_FIELDS: Record<string, FieldKind> = {
  employerName: 'text',
  employerEin: 'text',
  taxYearCorrected: 'integer',
  ...Object.fromEntries(W2C_CORRECTABLE.flatMap((f) => (['previous', 'correct'] as const).map((side) => [
    w2cField(side, f),
    (W2C_TEXT_FIELDS.has(f) ? 'text' : 'money') as FieldKind,
  ]))),
  correctsSsnOrName: 'boolean',
  isSpouse: 'boolean',
};

const FORM_FIELDS: Record<DocumentToolName, Record<string, FieldKind>> = {
  add_w2: W2_FIELDS,
  add_1099_int: INT_FIELDS,
  add_1099_div: DIV_FIELDS,
  add_1099_nec: NEC_FIELDS,
  add_1099_r: R_FIELDS,
  add_ssa_1099: SSA_FIELDS,
  add_mortgage_interest: MORTGAGE_FIELDS,
  add_education_expense: EDUCATION_FIELDS,
  add_1099_misc: MISC_FIELDS,
  add_1099_g: G_FIELDS,
  add_1099_b: B_FIELDS,
  add_1099_k: K_FIELDS,
  add_1099_oid: OID_FIELDS,
  add_1099_c: C_FIELDS,
  add_1099_q: Q_FIELDS,
  add_1099_sa: SA_FIELDS,
  add_1099_s: S_FIELDS,
  add_w2c: W2C_FIELDS,
  add_w2g: W2G_FIELDS,
  add_1098_e: SLI_FIELDS,
  add_k1: K1_FIELDS,
};

interface Normalized {
  status: StructuredFieldStatus;
  value?: unknown;
  rawText: string;
}

function rawOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finishNumber(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Parse a money token that is the entire string.
 * Accepts "$1,234.56", "1234", "(100.00)", and "-20.5".
 * Rejects leftover words, European grouping, and letter/digit mix-ups.
 */
export function parseMoneyToken(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let negative = false;
  let body = trimmed;
  if (body.startsWith('(') && body.endsWith(')') && body.length > 2) {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  if (body.startsWith('$')) body = body.slice(1).trim();
  if (body.startsWith('-')) {
    if (negative) return undefined;
    negative = true;
    body = body.slice(1).trim();
  }
  if (!body || body.startsWith('$') || body.includes('(') || body.includes(')')) return undefined;

  const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  const plain = /^\d+(?:\.\d+)?$/;
  if (!(body.includes(',') ? grouped.test(body) : plain.test(body))) return undefined;

  const n = Number(body.replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return finishNumber(negative ? -n : n);
}

function normalizeMoney(value: unknown): Normalized {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { status: 'extracted', value: finishNumber(value), rawText: '' };
  }
  if (typeof value === 'string') {
    const parsed = parseMoneyToken(value);
    if (parsed === undefined) return { status: 'unknown', rawText: value };
    return { status: 'extracted', value: parsed, rawText: value };
  }
  return { status: 'unknown', rawText: rawOf(value) };
}

function normalizeText(value: unknown): Normalized {
  if (typeof value !== 'string') return { status: 'unknown', rawText: rawOf(value) };
  const trimmed = value.trim();
  if (!trimmed) return { status: 'unknown', rawText: value };
  return { status: 'extracted', value: trimmed, rawText: value };
}

function normalizeBoolean(value: unknown): Normalized {
  if (typeof value === 'boolean') return { status: 'extracted', value, rawText: '' };
  if (typeof value !== 'string') return { status: 'unknown', rawText: rawOf(value) };
  const token = value.trim().toLowerCase();
  if (!token) return { status: 'unknown', rawText: value };
  if (token === 'true' || token === 'yes' || token === 'y' || token === 'x' || token === 'checked') {
    return { status: 'extracted', value: true, rawText: value };
  }
  if (token === 'false' || token === 'no' || token === 'n' || token === 'unchecked') {
    return { status: 'extracted', value: false, rawText: value };
  }
  return { status: 'unknown', rawText: value };
}

/** A whole-number count ("1", "2"). Anything else stays unknown. */
function normalizeInteger(value: unknown): Normalized {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { status: 'extracted', value, rawText: '' } : { status: 'unknown', rawText: '' };
  }
  if (typeof value !== 'string') return { status: 'unknown', rawText: rawOf(value) };
  const t = value.trim();
  if (!/^\d+$/.test(t)) return { status: 'unknown', rawText: value };
  return { status: 'extracted', value: Number(t), rawText: value };
}

function normalizeBox12(value: unknown): Normalized {
  if (typeof value === 'string') return { status: 'unknown', rawText: value };
  if (!Array.isArray(value)) return { status: 'unknown', rawText: '' };
  const entries: Array<{ code: string; amount: number }> = [];
  const rawParts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const code = typeof row.code === 'string' ? row.code.trim().toUpperCase() : '';
    if (typeof row.amount === 'string' && code) rawParts.push(`${code}:${row.amount}`);
    if (!code) continue;
    const amount = normalizeMoney(row.amount);
    if (amount.status !== 'extracted' || typeof amount.value !== 'number') continue;
    entries.push({ code, amount: amount.value });
  }
  if (entries.length === 0) {
    return { status: 'unknown', rawText: rawParts.join('; ') };
  }
  return { status: 'extracted', value: entries, rawText: rawParts.join('; ') };
}

function normalizeBox13(value: unknown): Normalized {
  if (typeof value === 'string') return { status: 'unknown', rawText: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unknown', rawText: '' };
  }
  const row = value as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  const rawParts: string[] = [];
  for (const key of ['statutoryEmployee', 'retirementPlan', 'thirdPartySickPay'] as const) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const flag = normalizeBoolean(row[key]);
    if (typeof row[key] === 'string') rawParts.push(`${key}=${row[key]}`);
    if (flag.status === 'extracted' && typeof flag.value === 'boolean') out[key] = flag.value;
  }
  if (Object.keys(out).length === 0) {
    return { status: 'unknown', rawText: rawParts.join('; ') };
  }
  return { status: 'extracted', value: out, rawText: rawParts.join('; ') };
}

function normalizeSimplifiedMethod(value: unknown): Normalized {
  if (typeof value === 'string') return { status: 'unknown', rawText: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unknown', rawText: '' };
  }
  const row = value as Record<string, unknown>;
  const total = normalizeMoney(row.totalContributions);
  const age = normalizeMoney(row.ageAtStartDate);
  const joint = normalizeBoolean(row.isJointAndSurvivor);
  const payments = normalizeMoney(row.paymentsThisYear);
  if (
    total.status !== 'extracted' ||
    age.status !== 'extracted' ||
    joint.status !== 'extracted' ||
    payments.status !== 'extracted'
  ) {
    return { status: 'unknown', rawText: '' };
  }
  const simplified: Record<string, unknown> = {
    totalContributions: total.value,
    ageAtStartDate: age.value,
    isJointAndSurvivor: joint.value,
    paymentsThisYear: payments.value,
  };
  if (Object.prototype.hasOwnProperty.call(row, 'combinedAge')) {
    const combined = normalizeMoney(row.combinedAge);
    // A supplied but unreadable combinedAge must not silently drop — the engine
    // would fall back to the single-life table under joint-and-survivor and
    // compute the wrong taxable pension. Keep the whole worksheet unknown.
    if (combined.status !== 'extracted') {
      return { status: 'unknown', rawText: rawOf(row.combinedAge) };
    }
    simplified.combinedAge = combined.value;
  }
  if (Object.prototype.hasOwnProperty.call(row, 'priorYearTaxFreeRecovery')) {
    const prior = normalizeMoney(row.priorYearTaxFreeRecovery);
    if (prior.status === 'extracted') simplified.priorYearTaxFreeRecovery = prior.value;
  }
  const rawParts: string[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (typeof raw === 'string') rawParts.push(`${key}=${raw}`);
  }
  return { status: 'extracted', value: simplified, rawText: rawParts.join('; ') };
}

function normalizeField(kind: FieldKind, value: unknown): Normalized {
  switch (kind) {
    case 'money':
      return normalizeMoney(value);
    case 'text':
      return normalizeText(value);
    case 'boolean':
      return normalizeBoolean(value);
    case 'integer':
      return normalizeInteger(value);
    case 'box12':
      return normalizeBox12(value);
    case 'box13':
      return normalizeBox13(value);
    case 'simplifiedMethod':
      return normalizeSimplifiedMethod(value);
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

/**
 * Normalize one classified form's extractor bag into tax-tool arguments.
 * `incomeTypeOrTool` is a document tool name ("add_ssa_1099") or a legacy
 * income-item key ("w2"). Unknown form types return no tool and no arguments.
 * `fieldRawTokens` carries the extractor's original OCR/PDF tokens when the
 * bag already holds parsed numbers (or undefined for an unreadable token).
 */
export function extractStructuredFields(
  incomeTypeOrTool: string | null | undefined,
  data: Record<string, unknown>,
  fieldRawTokens?: Record<string, string>,
): StructuredExtraction {
  const tool =
    incomeTypeOrTool && isDocumentTool(incomeTypeOrTool) ? incomeTypeOrTool : formToolForIncomeType(incomeTypeOrTool);
  if (!tool) return { tool: null, args: {}, rawText: {} };

  const schema = FORM_FIELDS[tool];
  const args: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};

  const keys = new Set([
    ...Object.keys(data),
    ...(fieldRawTokens ? Object.keys(fieldRawTokens) : []),
  ]);

  for (const key of keys) {
    const kind = schema[key];
    if (!kind) continue;
    const hasData = Object.prototype.hasOwnProperty.call(data, key);
    const externalRaw = fieldRawTokens?.[key];
    // A raw token alone (unreadable OCR, value already stripped) still yields an unknown fact.
    if (!hasData && externalRaw === undefined) continue;
    const normalized = hasData
      ? normalizeField(kind, data[key])
      : { status: 'unknown' as const, rawText: '' };
    const raw = externalRaw || normalized.rawText;
    if (raw) rawText[key] = raw;
    if (normalized.status === 'extracted') args[key] = normalized.value;
    else args[key] = undefined;
  }

  // 1099-B box 2 unread (a text layer cannot see squares): the term follows
  // from boxes 1b and 1c when both are calendar dates (IRC §1222).
  if (tool === 'add_1099_b' && args.isLongTerm === undefined) {
    const term = isLongTermHolding(args.dateAcquired as string | undefined, args.dateSold as string | undefined);
    if (term !== undefined) {
      args.isLongTerm = term;
      rawText.isLongTerm = `derived from box 1b ${String(args.dateAcquired)} and box 1c ${String(args.dateSold)}`;
    }
  }

  return { tool, args, rawText };
}

/** Currency punctuation or a decimal marks an amount-shaped token (not a bare integer). */
function isAmountShapedToken(value: string): boolean {
  return /[$(),]/.test(value) || value.includes('.');
}

/**
 * Generic bags (forms without a tax tool): money-shaped strings become numbers.
 * Other text stays text. Unreadable money stays unknown. Numbers are not reprinted.
 * `fieldRawTokens` preserves extractor OCR tokens when values are already numbers.
 */
export function normalizeGenericFields(
  data: Record<string, unknown>,
  fieldRawTokens?: Record<string, string>,
): {
  fields: Record<string, unknown>;
  rawText: Record<string, string>;
} {
  const fields: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};
  const keys = new Set([
    ...Object.keys(data),
    ...(fieldRawTokens ? Object.keys(fieldRawTokens) : []),
  ]);
  for (const key of keys) {
    const hasData = Object.prototype.hasOwnProperty.call(data, key);
    const externalRaw = fieldRawTokens?.[key];
    if (!hasData) {
      if (externalRaw !== undefined) {
        fields[key] = undefined;
        rawText[key] = externalRaw;
      }
      continue;
    }
    const value = data[key];
    if (value === undefined || value === null) {
      fields[key] = undefined;
      if (externalRaw) rawText[key] = externalRaw;
      continue;
    }
    if (typeof value === 'number') {
      fields[key] = Number.isFinite(value) ? finishNumber(value) : undefined;
      if (externalRaw) rawText[key] = externalRaw;
      continue;
    }
    if (typeof value === 'object') {
      fields[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        fields[key] = undefined;
        rawText[key] = value;
        continue;
      }
      const money = parseMoneyToken(value);
      // Currency punctuation or a decimal marks a money token.
      // A bare integer stays text so an account number is not turned into an amount.
      if (isAmountShapedToken(value)) {
        // Readable → number. Unreadable amount-shaped → unknown (not a string).
        fields[key] = money;
        rawText[key] = value;
        continue;
      }
      fields[key] = trimmed;
      rawText[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      fields[key] = value;
    }
  }
  return { fields, rawText };
}
