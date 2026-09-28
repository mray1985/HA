/**
 * Structured extraction (development-order step 6).
 * Turns raw extractor tokens into the fields the tax tools already accept.
 * A printed "$0.00" stays numeric 0. A missing or unreadable token stays unknown.
 * rawText is the original token, never a string rebuilt from the normalized number.
 * This step does not store coordinates, validate tax rules, or calculate tax.
 */

import { toolNameForIncomeType, type TaxToolIncomeName } from './taxTools.js';

export type StructuredFieldStatus = 'extracted' | 'unknown';

export interface StructuredExtraction {
  tool: TaxToolIncomeName | null;
  /**
   * Arguments for the tax tool. Unreadable supplied fields are present as
   * undefined so they become unknown facts. Keys the extractor never sent
   * are absent. Missing amounts are not zero.
   */
  args: Record<string, unknown>;
  /** Original source text by field. Absent when the extractor already passed a number. */
  rawText: Record<string, string>;
}

type FieldKind = 'money' | 'text' | 'boolean' | 'box12' | 'box13' | 'simplifiedMethod';

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

const FORM_FIELDS: Record<TaxToolIncomeName, Record<string, FieldKind>> = {
  add_w2: W2_FIELDS,
  add_1099_int: INT_FIELDS,
  add_1099_div: DIV_FIELDS,
  add_1099_nec: NEC_FIELDS,
  add_1099_r: R_FIELDS,
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

function normalizeBox12(value: unknown): Normalized {
  if (typeof value === 'string') return { status: 'unknown', rawText: value };
  if (!Array.isArray(value)) return { status: 'unknown', rawText: '' };
  const entries: Array<{ code: string; amount: number }> = [];
  const rawParts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const code = typeof row.code === 'string' ? row.code.trim() : '';
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
    if (combined.status === 'extracted') simplified.combinedAge = combined.value;
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
 * Unknown form types return no tool and an empty argument list.
 */
export function extractStructuredFields(
  incomeType: string | null | undefined,
  data: Record<string, unknown>,
): StructuredExtraction {
  const tool = toolNameForIncomeType(incomeType);
  if (!tool) return { tool: null, args: {}, rawText: {} };

  const schema = FORM_FIELDS[tool];
  const args: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};

  for (const [key, kind] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const normalized = normalizeField(kind, data[key]);
    if (normalized.rawText) rawText[key] = normalized.rawText;
    if (normalized.status === 'extracted') args[key] = normalized.value;
    else args[key] = undefined;
  }

  return { tool, args, rawText };
}

/**
 * Generic bags (forms without a tax tool): money-shaped strings become numbers.
 * Other text stays text. Unreadable money is not coerced. Numbers are not reprinted.
 */
export function normalizeGenericFields(data: Record<string, unknown>): {
  fields: Record<string, unknown>;
  rawText: Record<string, string>;
} {
  const fields: Record<string, unknown> = {};
  const rawText: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      fields[key] = undefined;
      continue;
    }
    if (typeof value === 'number') {
      fields[key] = Number.isFinite(value) ? finishNumber(value) : undefined;
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
      if (money !== undefined && (/[$(),]/.test(value) || value.includes('.'))) {
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
