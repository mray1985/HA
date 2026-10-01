/**
 * Schema-validated tax-engine tools for automation (work order §5, HA-AI-011).
 * Models call these instead of writing Form 1040 line fields.
 *
 * Fact tools (`invokeTaxTool`) return TaxFacts, the validated fields, and how
 * the result applies to the return (an income item, a total recomputed from
 * every source, a dependent, a preparer choice, or a candidate fact). They do
 * not calculate tax. Return tools (`returnTools.ts`) calculate the return and
 * run its diagnostics; they never change it.
 */

import { z } from 'zod';
import {
  factsFromFields,
  fieldsForToolCall,
  type FieldConfidenceSource,
  type FieldRawTextSource,
  type FieldSourceLocationSource,
  type TaxFact,
  type TaxFactSecondReading,
  type TaxFactSourceKind,
} from './taxFact.js';

// ─── Tool names ──────────────────────────────────────────────

/** Tools that take one tax form's boxes. */
export const FORM_TOOL_NAMES = [
  'add_w2',
  'add_1099_int',
  'add_1099_div',
  'add_1099_nec',
  'add_1099_r',
  'add_ssa_1099',
  'add_mortgage_interest',
  'add_education_expense',
  'add_1099_misc',
  'add_1099_g',
  'add_1099_b',
  'add_1099_k',
  'add_1099_oid',
  'add_1099_c',
  'add_1099_q',
  'add_1099_sa',
  'add_1099_s',
  'add_w2c',
] as const;

/**
 * Tools that record a fact about the case from any evidence: a prior-year
 * return, a client's answer, a payment confirmation, business income records.
 */
export const RECORD_TOOL_NAMES = [
  'add_dependent',
  'add_schedule_c_income',
  'add_estimated_payment',
  'set_state_residency',
  'set_document_expected',
] as const;

/** Every tool that produces TaxFacts. */
export const TAX_TOOL_NAMES = [...FORM_TOOL_NAMES, 'set_filing_status_candidate', ...RECORD_TOOL_NAMES] as const;

export type TaxToolName = (typeof TAX_TOOL_NAMES)[number];

/** Tools that take one tax form's boxes. */
export type DocumentToolName = (typeof FORM_TOOL_NAMES)[number];

export type RecordToolName = (typeof RECORD_TOOL_NAMES)[number];

/** Tools whose result is one engine item per source (addIncomeItem). */
export type TaxToolIncomeName =
  | 'add_w2' | 'add_1099_int' | 'add_1099_div' | 'add_1099_nec' | 'add_1099_r'
  | 'add_1099_misc' | 'add_1099_g' | 'add_1099_b' | 'add_1099_k' | 'add_1099_oid' | 'add_1099_c'
  | 'add_schedule_c_income';

export function isDocumentTool(name: string): name is DocumentToolName {
  return (FORM_TOOL_NAMES as readonly string[]).includes(name);
}

export function isRecordTool(name: string): name is RecordToolName {
  return (RECORD_TOOL_NAMES as readonly string[]).includes(name);
}

/** Totals the engine keeps once per return, recomputed from every source's facts. */
export type AggregateTarget = 'socialSecurityBenefits' | 'mortgageInterest' | 'estimatedPayments' | 'stateResidency';

/**
 * How a successful call applies to the return.
 * - income_item: one engine item per source (addIncomeItem).
 * - aggregate: the engine holds one value for the return (Social Security
 *   benefits; mortgage interest; estimated payments by quarter and state;
 *   each state's residency), so it is recomputed from every source's facts —
 *   recording the same evidence again can never double-count it.
 * - dependent: one engine dependent per person, merged across every source
 *   that names them (a prior-year return, the client's answers).
 * - needs_preparer_choice: the engine needs a decision the document cannot
 *   make (education: American Opportunity vs Lifetime Learning credit).
 * - candidate_fact: recorded as a fact only; never sets the return.
 */
export type TaxToolApplication =
  | { kind: 'income_item'; itemType: TaxToolIncomeType }
  | { kind: 'aggregate'; target: AggregateTarget }
  | { kind: 'dependent' }
  /** A W-2c: corrects the boxes of the W-2 it names (same employer EIN and year) on this case. */
  | { kind: 'w2_correction' }
  | { kind: 'needs_preparer_choice'; target: PreparerChoiceTarget; choice: PreparerChoice }
  | { kind: 'candidate_fact' };

/**
 * Decisions a form cannot make, which the engine needs before the form can be
 * on the return:
 * - educationCredit / creditType (1098-T): American Opportunity or Lifetime Learning;
 * - qualifiedTuitionProgram / qualifiedExpenses (1099-Q): the qualified education
 *   expenses the distribution paid;
 * - hsaDistribution / qualifiedMedicalExpenses (1099-SA): whether it paid
 *   qualified medical expenses (the engine otherwise taxes it and adds the penalty);
 * - homeSale / ownershipAndBasis (1099-S): basis, and the months owned and used
 *   as a main home (IRC §121).
 */
export type PreparerChoiceTarget = 'educationCredit' | 'qualifiedTuitionProgram' | 'hsaDistribution' | 'homeSale';
export type PreparerChoice = 'creditType' | 'qualifiedExpenses' | 'qualifiedMedicalExpenses' | 'ownershipAndBasis';

/** Income-item API keys used by addIncomeItem / intentExecutor. */
export type TaxToolIncomeType =
  | 'w2' | '1099int' | '1099div' | '1099nec' | '1099r'
  | '1099misc' | '1099g' | '1099b' | '1099k' | '1099oid' | '1099c'
  | 'business-receipts';

export const TAX_TOOL_INCOME_TYPE: Record<TaxToolIncomeName, TaxToolIncomeType> = {
  add_w2: 'w2',
  add_1099_int: '1099int',
  add_1099_div: '1099div',
  add_1099_nec: '1099nec',
  add_1099_r: '1099r',
  add_1099_misc: '1099misc',
  add_1099_g: '1099g',
  add_1099_b: '1099b',
  add_1099_k: '1099k',
  add_1099_oid: '1099oid',
  add_1099_c: '1099c',
  add_schedule_c_income: 'business-receipts',
};

/** Classified document income type → the form tool that reads it. */
const INCOME_TYPE_TO_TOOL: Record<string, FormIncomeToolName> = {
  w2: 'add_w2',
  '1099int': 'add_1099_int',
  '1099div': 'add_1099_div',
  '1099nec': 'add_1099_nec',
  '1099r': 'add_1099_r',
  '1099misc': 'add_1099_misc',
  '1099g': 'add_1099_g',
  '1099b': 'add_1099_b',
  '1099k': 'add_1099_k',
  '1099oid': 'add_1099_oid',
  '1099c': 'add_1099_c',
};

/** Classified document income type → the form tool that reads it (income items and preparer-choice forms). */
const INCOME_TYPE_TO_FORM_TOOL: Record<string, DocumentToolName> = {
  ...INCOME_TYPE_TO_TOOL,
  ssa1099: 'add_ssa_1099',
  '1098': 'add_mortgage_interest',
  '1098t': 'add_education_expense',
  '1099q': 'add_1099_q',
  '1099sa': 'add_1099_sa',
  '1099s': 'add_1099_s',
  w2c: 'add_w2c',
};

export function formToolForIncomeType(incomeType: string | null | undefined): DocumentToolName | null {
  if (!incomeType) return null;
  return INCOME_TYPE_TO_FORM_TOOL[incomeType] ?? null;
}

type FormIncomeToolName = Exclude<TaxToolIncomeName, 'add_schedule_c_income'>;

export function toolNameForIncomeType(incomeType: string | null | undefined): FormIncomeToolName | null {
  if (!incomeType) return null;
  return INCOME_TYPE_TO_TOOL[incomeType] ?? null;
}

// ─── Field schemas ───────────────────────────────────────────
// Optional amounts: missing stays omitted. Explicit 0 is kept.
// .strict() rejects unknown keys so the model cannot invent form lines.
// null / empty string from extractors are treated as missing, not zero.

function asMissing(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

const optionalAmount = z.preprocess(asMissing, z.number().finite().optional());
const optionalString = z.preprocess(asMissing, z.string().optional());
const optionalBoolean = z.preprocess(asMissing, z.boolean().optional());

/** W-2 Box 12a–d coded benefit entries (matches W2Box12Entry). */
const W2Box12EntrySchema = z
  .object({
    code: z.string().min(1),
    amount: z.number().finite(),
  })
  .strict();

/** W-2 Box 13 checkboxes (matches W2Box13). */
const W2Box13Schema = z
  .object({
    statutoryEmployee: optionalBoolean,
    retirementPlan: optionalBoolean,
    thirdPartySickPay: optionalBoolean,
  })
  .strict();

const optionalBox12 = z.preprocess(asMissing, z.array(W2Box12EntrySchema).optional());
const optionalInteger = z.preprocess(asMissing, z.number().int().optional());
const optionalBox13 = z.preprocess(asMissing, W2Box13Schema.optional());

/** 1099-R Simplified Method worksheet fields (matches Income1099R.simplifiedMethod). */
const SimplifiedMethodSchema = z
  .object({
    totalContributions: z.number().finite(),
    ageAtStartDate: z.number().finite(),
    isJointAndSurvivor: z.boolean(),
    combinedAge: optionalAmount,
    paymentsThisYear: z.number().finite(),
    priorYearTaxFreeRecovery: optionalAmount,
  })
  .strict();

const optionalSimplifiedMethod = z.preprocess(asMissing, SimplifiedMethodSchema.optional());

const AddW2FieldsSchema = z
  .object({
    employerName: optionalString,
    employerEin: optionalString,
    wages: optionalAmount,
    federalTaxWithheld: optionalAmount,
    socialSecurityWages: optionalAmount,
    socialSecurityTax: optionalAmount,
    medicareWages: optionalAmount,
    medicareTax: optionalAmount,
    stateTaxWithheld: optionalAmount,
    stateWages: optionalAmount,
    state: optionalString,
    /** Boxes 18-20, first line: local wages, local income tax, locality name. */
    localWages: optionalAmount,
    localTaxWithheld: optionalAmount,
    localityName: optionalString,
    box12: optionalBox12,
    box13: optionalBox13,
    isSpouse: optionalBoolean,
  })
  .strict();

const Add1099IntFieldsSchema = z
  .object({
    payerName: optionalString,
    amount: optionalAmount,
    earlyWithdrawalPenalty: optionalAmount,
    usBondInterest: optionalAmount,
    federalTaxWithheld: optionalAmount,
    taxExemptInterest: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099DivFieldsSchema = z
  .object({
    payerName: optionalString,
    ordinaryDividends: optionalAmount,
    qualifiedDividends: optionalAmount,
    capitalGainDistributions: optionalAmount,
    unrecapturedSection1250Gain: optionalAmount,
    collectiblesGain: optionalAmount,
    federalTaxWithheld: optionalAmount,
    foreignTaxPaid: optionalAmount,
    foreignSourceIncome: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099NecFieldsSchema = z
  .object({
    payerName: optionalString,
    payerEin: optionalString,
    amount: optionalAmount,
    federalTaxWithheld: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

const Add1099RFieldsSchema = z
  .object({
    payerName: optionalString,
    grossDistribution: optionalAmount,
    taxableAmount: optionalAmount,
    federalTaxWithheld: optionalAmount,
    distributionCode: optionalString,
    isIRA: optionalBoolean,
    isRothIRA: optionalBoolean,
    rothContributionBasis: optionalAmount,
    qcdAmount: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
    isSpouse: optionalBoolean,
    earlyDistributionExceptionCode: optionalString,
    earlyDistributionExceptionAmount: optionalAmount,
    useSimplifiedMethod: optionalBoolean,
    simplifiedMethod: optionalSimplifiedMethod,
  })
  .strict();

export const FILING_STATUS_CANDIDATES = [
  'single',
  'married_filing_jointly',
  'married_filing_separately',
  'head_of_household',
  'qualifying_surviving_spouse',
] as const;

/** SSA-1099 (issued by the Social Security Administration). Box 5 may be negative. */
const AddSsa1099FieldsSchema = z
  .object({
    beneficiaryName: optionalString,
    benefitsPaid: optionalAmount,
    benefitsRepaid: optionalAmount,
    netBenefits: optionalAmount,
    federalTaxWithheld: optionalAmount,
    isSpouse: optionalBoolean,
  })
  .strict();

/** Form 1098 (Rev. April 2025). */
const AddMortgageInterestFieldsSchema = z
  .object({
    lenderName: optionalString,
    lenderTin: optionalString,
    mortgageInterest: optionalAmount,
    outstandingPrincipal: optionalAmount,
    originationDate: optionalString,
    refundOfOverpaidInterest: optionalAmount,
    mortgageInsurancePremiums: optionalAmount,
    points: optionalAmount,
    propertyAddressSameAsBorrower: optionalBoolean,
    propertyAddress: optionalString,
    numberOfProperties: optionalInteger,
    acquisitionDate: optionalString,
  })
  .strict();

/** Form 1098-T. */
const AddEducationExpenseFieldsSchema = z
  .object({
    institutionName: optionalString,
    institutionEin: optionalString,
    studentName: optionalString,
    tuitionPaid: optionalAmount,
    priorYearAdjustments: optionalAmount,
    scholarships: optionalAmount,
    scholarshipAdjustments: optionalAmount,
    includesNextPeriod: optionalBoolean,
    halfTimeStudent: optionalBoolean,
    graduateStudent: optionalBoolean,
    insuranceReimbursement: optionalAmount,
  })
  .strict();

// ─── Remaining information returns (work order §16) ──────────
// Field names are the engine item's, so an applied item carries nothing the
// engine does not define. Printed boxes the engine cannot take are review
// boxes in formSchemas.ts, never tool fields.

/** Form 1099-MISC (Rev. December 2026). */
const Add1099MiscFieldsSchema = z
  .object({
    payerName: optionalString,
    rents: optionalAmount,
    royalties: optionalAmount,
    otherIncome: optionalAmount,
    federalTaxWithheld: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

/** Form 1099-G (Rev. December 2026). Box 2 refunds are reviewed, not income items. */
const Add1099GFieldsSchema = z
  .object({
    payerName: optionalString,
    unemploymentCompensation: optionalAmount,
    federalTaxWithheld: optionalAmount,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

/** Form 1099-B (2026): one sale. */
const Add1099BFieldsSchema = z
  .object({
    brokerName: optionalString,
    description: optionalString,
    /** Box 1b as printed ("03/02/2019" or "VARIOUS"). */
    dateAcquired: optionalString,
    /** Box 1c as printed. */
    dateSold: optionalString,
    proceeds: optionalAmount,
    costBasis: optionalAmount,
    /** Box 2: long-term (true) or short-term (false). "Ordinary" is reviewed. */
    isLongTerm: optionalBoolean,
    federalTaxWithheld: optionalAmount,
    washSaleLossDisallowed: optionalAmount,
    /** Box 12. */
    basisReportedToIRS: optionalBoolean,
    /** Box 3 "Collectibles". */
    isCollectible: optionalBoolean,
  })
  .strict();

/** Form 1099-K (Rev. December 2026). */
const Add1099KFieldsSchema = z
  .object({
    platformName: optionalString,
    grossAmount: optionalAmount,
    cardNotPresent: optionalAmount,
    federalTaxWithheld: optionalAmount,
  })
  .strict();

/** Form 1099-OID (Rev. January 2024). */
const Add1099OidFieldsSchema = z
  .object({
    payerName: optionalString,
    originalIssueDiscount: optionalAmount,
    otherPeriodicInterest: optionalAmount,
    earlyWithdrawalPenalty: optionalAmount,
    federalTaxWithheld: optionalAmount,
    marketDiscount: optionalAmount,
    acquisitionPremium: optionalAmount,
    description: optionalString,
    stateCode: optionalString,
    stateTaxWithheld: optionalAmount,
  })
  .strict();

/** 1099-C box 6 identifiable event codes (Instructions for Forms 1099-A and 1099-C). */
export const IDENTIFIABLE_EVENT_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/** Form 1099-C (Rev. April 2025). */
const Add1099CFieldsSchema = z
  .object({
    payerName: optionalString,
    /** Box 1 as printed. */
    dateOfCancellation: optionalString,
    amountCancelled: optionalAmount,
    interestIncluded: optionalAmount,
    debtDescription: optionalString,
    identifiableEventCode: optionalString,
    /** Box 5. Recorded for review (a nonrecourse debt may not be income); the engine has no field for it. */
    personallyLiable: optionalBoolean,
  })
  .strict();

/** Form 1099-Q (Rev. April 2025). The qualified expenses it paid are the preparer's to supply. */
const Add1099QFieldsSchema = z
  .object({
    payerName: optionalString,
    grossDistribution: optionalAmount,
    earnings: optionalAmount,
    basisReturn: optionalAmount,
    /** Box 4a / 4b. */
    trusteeToTrusteeTransfer: optionalBoolean,
    qtpToRothIra: optionalBoolean,
    /** Box 6: the recipient is not the designated beneficiary. */
    recipientNotDesignatedBeneficiary: optionalBoolean,
  })
  .strict();

/** 1099-SA box 3 distribution codes (Instructions for Forms 1099-SA and 5498-SA). */
export const HSA_DISTRIBUTION_CODES = ['1', '2', '3', '4', '5', '6'] as const;

/** Form 1099-SA (Rev. April 2025). Whether it paid qualified medical expenses is the preparer's to answer. */
const Add1099SaFieldsSchema = z
  .object({
    payerName: optionalString,
    grossDistribution: optionalAmount,
    distributionCode: optionalString,
    /** Box 5: which account paid it. */
    accountType: z.preprocess(asMissing, z.enum(['HSA', 'Archer MSA', 'MA MSA']).optional()),
  })
  .strict();

/** Form 1099-S (Rev. December 2026). The §121 facts (basis, ownership, use) are the preparer's to supply. */
const Add1099SFieldsSchema = z
  .object({
    filerName: optionalString,
    /** Box 1 as printed. */
    closingDate: optionalString,
    grossProceeds: optionalAmount,
    propertyAddress: optionalString,
    buyerRealEstateTax: optionalAmount,
    /** Box 7. */
    transferorIsForeign: optionalBoolean,
  })
  .strict();

/** W-2 boxes a W-2c corrects on the return (each printed as previously reported / correct). */
export const W2C_CORRECTABLE = [
  'wages',
  'federalTaxWithheld',
  'socialSecurityWages',
  'socialSecurityTax',
  'medicareWages',
  'medicareTax',
  'state',
  'stateWages',
  'stateTaxWithheld',
  'localWages',
  'localTaxWithheld',
  'localityName',
] as const;

export type W2cCorrectable = (typeof W2C_CORRECTABLE)[number];

/** W-2c boxes that hold text, not an amount. */
export const W2C_TEXT_FIELDS: ReadonlySet<W2cCorrectable> = new Set(['state', 'localityName']);

const cap = (f: string) => f[0]!.toUpperCase() + f.slice(1);
/** "wages" → "previousWages" / "correctWages". */
export const w2cField = (side: 'previous' | 'correct', field: W2cCorrectable) => `${side}${cap(field)}`;

/** Form W-2c (Rev. January 2026): only the corrected boxes are printed. */
const AddW2cFieldsSchema = z
  .object({
    employerName: optionalString,
    employerEin: optionalString,
    /** Box c: the year of the W-2 being corrected. */
    taxYearCorrected: z.preprocess(asMissing, z.number().int().min(2000).max(2100).optional()),
    ...Object.fromEntries(W2C_CORRECTABLE.flatMap((f) => (['previous', 'correct'] as const).map((side) => [
      w2cField(side, f),
      W2C_TEXT_FIELDS.has(f) ? optionalString : optionalAmount,
    ]))),
    /** Box e: the SSN or name was corrected (not an amount correction). */
    correctsSsnOrName: optionalBoolean,
    isSpouse: optionalBoolean,
  })
  .strict();

export const SetFilingStatusCandidateSchema = z
  .object({
    status: z.enum(FILING_STATUS_CANDIDATES),
  })
  .strict();

// ─── Record tools ────────────────────────────────────────────

export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

/** Relationship to the taxpayer, as the return records it (the engine and its diagnostics read these). */
export const DEPENDENT_RELATIONSHIPS = [
  'Son', 'Daughter', 'Stepson', 'Stepdaughter', 'Foster Child',
  'Brother', 'Sister', 'Half Brother', 'Half Sister', 'Stepbrother', 'Stepsister',
  'Parent', 'Mother', 'Father', 'Stepmother', 'Stepfather',
  'Grandchild', 'Grandparent',
  'Niece', 'Nephew', 'Aunt', 'Uncle',
  'Son-in-Law', 'Daughter-in-Law', 'Father-in-Law', 'Mother-in-Law', 'Brother-in-Law', 'Sister-in-Law',
  'None (not related)',
] as const;

export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

/** A relationship as printed ("DAUGHTER", "step son") → the return's term; undefined when it is none of them. */
export function canonicalRelationship(text: string | undefined): DependentRelationship | undefined {
  if (!text) return undefined;
  const key = text.toLowerCase().replace(/[^a-z]/g, '');
  return DEPENDENT_RELATIONSHIPS.find((r) => r.toLowerCase().replace(/[^a-z]/g, '') === key);
}

export const RESIDENCY_TYPES = ['resident', 'part_year', 'nonresident'] as const;

/**
 * Tax documents a client receives again year after year (work order §23).
 * One-time documents (W-2G, 1099-C, 1099-S) are not expected again.
 */
export const EXPECTED_DOCUMENT_TYPES = [
  'W-2', '1099-INT', '1099-DIV', '1099-R', '1099-NEC', '1099-MISC', '1099-G', '1099-K', '1099-B',
  '1099-OID', '1099-SA', '1099-Q', 'SSA-1099', '1098', '1098-T', '1098-E', '1095-A', 'K-1',
] as const;

export type ExpectedDocumentType = (typeof EXPECTED_DOCUMENT_TYPES)[number];

export const ESTIMATED_PAYMENT_JURISDICTIONS = ['federal', ...US_STATE_CODES] as const;

/** A calendar date, YYYY-MM-DD, that exists. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

const optionalDate = z.preprocess(asMissing, isoDate.optional());
const optionalNonNegative = z.preprocess(asMissing, z.number().finite().nonnegative().optional());

/** Form 1040 dependent: one person, from any evidence that names them. */
const AddDependentFieldsSchema = z
  .object({
    firstName: optionalString,
    lastName: optionalString,
    /** Full SSN, ITIN or ATIN (9 digits; dashes allowed). */
    ssn: z.preprocess(asMissing, z.string().regex(/^\d{3}-?\d{2}-?\d{4}$/).optional()),
    /** Only the last four digits, when that is all the evidence shows (a prior-year return copy). */
    ssnLastFour: z.preprocess(asMissing, z.string().regex(/^\d{4}$/).optional()),
    relationship: z.preprocess(asMissing, z.enum(DEPENDENT_RELATIONSHIPS).optional()),
    dateOfBirth: optionalDate,
    /** Months the person lived in the taxpayer's home during the tax year. */
    monthsLivedWithYou: z.preprocess(asMissing, z.number().int().min(0).max(12).optional()),
    isStudent: optionalBoolean,
    isDisabled: optionalBoolean,
  })
  .strict();

/** Schedule C line 1 receipts that no 1099-NEC or 1099-K reports. */
const AddScheduleCIncomeFieldsSchema = z
  .object({
    businessName: optionalString,
    /** What the receipts are, as the income records name them. */
    description: optionalString,
    amount: optionalNonNegative,
  })
  .strict();

/** One estimated tax payment (Form 1040-ES or a state's), or a prior-year overpayment applied. */
const AddEstimatedPaymentFieldsSchema = z
  .object({
    jurisdiction: z.preprocess(asMissing, z.enum(ESTIMATED_PAYMENT_JURISDICTIONS).optional()),
    amount: optionalNonNegative,
    datePaid: optionalDate,
    /** Installment number printed on the voucher or confirmation (1–4). */
    installment: z.preprocess(asMissing, z.number().int().min(1).max(4).optional()),
    /** Tax year the payment is for, as the confirmation states it. */
    taxYear: z.preprocess(asMissing, z.number().int().min(2000).max(2100).optional()),
    /** The prior year's overpayment applied to this year's estimated tax. */
    priorYearOverpaymentApplied: optionalBoolean,
    confirmationNumber: optionalString,
  })
  .strict();

/** The taxpayer's residency in one state for the tax year. */
const SetStateResidencyFieldsSchema = z
  .object({
    stateCode: z.preprocess(asMissing, z.enum(US_STATE_CODES).optional()),
    residencyType: z.preprocess(asMissing, z.enum(RESIDENCY_TYPES).optional()),
    daysLivedInState: z.preprocess(asMissing, z.number().int().min(1).max(366).optional()),
  })
  .strict();

/** Whether the client received a document the missing-document engine asked about (§23, §25). */
const SetDocumentExpectedFieldsSchema = z
  .object({
    formType: z.preprocess(asMissing, z.enum(EXPECTED_DOCUMENT_TYPES).optional()),
    /** The payer, employer or institution, as last year's document names it. */
    issuer: optionalString,
    /** Yes: the client has it (it is still to be uploaded). No: the client says there is none this year. */
    received: optionalBoolean,
  })
  .strict();

export const RECORD_FIELD_SCHEMAS: Record<RecordToolName, z.ZodObject<z.ZodRawShape>> = {
  add_dependent: AddDependentFieldsSchema,
  add_schedule_c_income: AddScheduleCIncomeFieldsSchema,
  add_estimated_payment: AddEstimatedPaymentFieldsSchema,
  set_state_residency: SetStateResidencyFieldsSchema,
  set_document_expected: SetDocumentExpectedFieldsSchema,
};

export const TOOL_FIELD_SCHEMAS: Record<DocumentToolName, z.ZodObject<z.ZodRawShape>> = {
  add_w2: AddW2FieldsSchema,
  add_1099_int: Add1099IntFieldsSchema,
  add_1099_div: Add1099DivFieldsSchema,
  add_1099_nec: Add1099NecFieldsSchema,
  add_1099_r: Add1099RFieldsSchema,
  add_ssa_1099: AddSsa1099FieldsSchema,
  add_mortgage_interest: AddMortgageInterestFieldsSchema,
  add_education_expense: AddEducationExpenseFieldsSchema,
  add_1099_misc: Add1099MiscFieldsSchema,
  add_1099_g: Add1099GFieldsSchema,
  add_1099_b: Add1099BFieldsSchema,
  add_1099_k: Add1099KFieldsSchema,
  add_1099_oid: Add1099OidFieldsSchema,
  add_1099_c: Add1099CFieldsSchema,
  add_1099_q: Add1099QFieldsSchema,
  add_1099_sa: Add1099SaFieldsSchema,
  add_1099_s: Add1099SFieldsSchema,
  add_w2c: AddW2cFieldsSchema,
};

/** Fields recorded as facts for review but not written to the engine's item. */
export const FACT_ONLY_FIELDS: Partial<Record<DocumentToolName, readonly string[]>> = {
  add_1099_c: ['personallyLiable'],
};

/** An income item's fields as the engine takes them: fact-only fields removed. */
export function engineItemFields(itemType: string, fields: Record<string, unknown>): Record<string, unknown> {
  const tool = (Object.keys(TAX_TOOL_INCOME_TYPE) as TaxToolIncomeName[]).find((t) => TAX_TOOL_INCOME_TYPE[t] === itemType);
  const factOnly = tool && isDocumentTool(tool) ? FACT_ONLY_FIELDS[tool] ?? [] : [];
  if (factOnly.length === 0) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !factOnly.includes(key)));
}

export const TOOL_APPLICATION: Record<TaxToolName, TaxToolApplication> = {
  add_w2: { kind: 'income_item', itemType: 'w2' },
  add_1099_int: { kind: 'income_item', itemType: '1099int' },
  add_1099_div: { kind: 'income_item', itemType: '1099div' },
  add_1099_nec: { kind: 'income_item', itemType: '1099nec' },
  add_1099_r: { kind: 'income_item', itemType: '1099r' },
  add_ssa_1099: { kind: 'aggregate', target: 'socialSecurityBenefits' },
  add_mortgage_interest: { kind: 'aggregate', target: 'mortgageInterest' },
  add_education_expense: { kind: 'needs_preparer_choice', target: 'educationCredit', choice: 'creditType' },
  add_1099_misc: { kind: 'income_item', itemType: '1099misc' },
  add_1099_g: { kind: 'income_item', itemType: '1099g' },
  add_1099_b: { kind: 'income_item', itemType: '1099b' },
  add_1099_k: { kind: 'income_item', itemType: '1099k' },
  add_1099_oid: { kind: 'income_item', itemType: '1099oid' },
  add_1099_c: { kind: 'income_item', itemType: '1099c' },
  add_1099_q: { kind: 'needs_preparer_choice', target: 'qualifiedTuitionProgram', choice: 'qualifiedExpenses' },
  add_1099_sa: { kind: 'needs_preparer_choice', target: 'hsaDistribution', choice: 'qualifiedMedicalExpenses' },
  add_1099_s: { kind: 'needs_preparer_choice', target: 'homeSale', choice: 'ownershipAndBasis' },
  add_w2c: { kind: 'w2_correction' },
  set_filing_status_candidate: { kind: 'candidate_fact' },
  add_dependent: { kind: 'dependent' },
  add_schedule_c_income: { kind: 'income_item', itemType: 'business-receipts' },
  add_estimated_payment: { kind: 'aggregate', target: 'estimatedPayments' },
  set_state_residency: { kind: 'aggregate', target: 'stateResidency' },
  set_document_expected: { kind: 'candidate_fact' },
};

/** The field schema of a fact tool that takes fields (every tool but the filing-status candidate). */
export function fieldSchemaFor(tool: DocumentToolName | RecordToolName): z.ZodObject<z.ZodRawShape> {
  return isRecordTool(tool) ? RECORD_FIELD_SCHEMAS[tool] : TOOL_FIELD_SCHEMAS[tool];
}

/** Keep only schema-known keys (for OCR bridges). Direct tool calls still reject unknowns. */
export function pickToolFieldArgs(
  tool: DocumentToolName | RecordToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const shape = fieldSchemaFor(tool).shape as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      picked[key] = args[key];
    }
  }
  return picked;
}

const FACT_TYPE_PREFIX: Record<TaxToolName, string> = {
  add_w2: 'W2',
  add_1099_int: '1099INT',
  add_1099_div: '1099DIV',
  add_1099_nec: '1099NEC',
  add_1099_r: '1099R',
  add_ssa_1099: 'SSA1099',
  add_mortgage_interest: '1098',
  add_education_expense: '1098T',
  add_1099_misc: '1099MISC',
  add_1099_g: '1099G',
  add_1099_b: '1099B',
  add_1099_k: '1099K',
  add_1099_oid: '1099OID',
  add_1099_c: '1099C',
  add_1099_q: '1099Q',
  add_1099_sa: '1099SA',
  add_1099_s: '1099S',
  add_w2c: 'W2C',
  set_filing_status_candidate: 'FILING_STATUS',
  add_dependent: 'DEPENDENT',
  add_schedule_c_income: 'SCHC_RECEIPTS',
  add_estimated_payment: 'ESTPAY',
  set_state_residency: 'STATE_RESIDENCY',
  set_document_expected: 'DOCEXPECT',
};

/** Fact-type prefix of every fact a tool writes (`<prefix>_<field>`). */
export function factPrefixOf(tool: TaxToolName): string {
  return `${FACT_TYPE_PREFIX[tool]}_`;
}

// ─── Call context / results ──────────────────────────────────

export interface TaxToolCallContext {
  returnId: string;
  taxYear: number;
  /** The evidence: an uploaded document, or a recorded answer / import with its own id. */
  sourceDocumentId: string;
  /**
   * 0-based position of the form within a file holding several (two W-2s in
   * one PDF), or of the entry within its source (the second dependent listed
   * on a prior-year return).
   */
  sourceFormIndex?: number;
  /** §60 source kind. Absent means an original tax document. */
  sourceKind?: TaxFactSourceKind;
  /** Extractor build: model file SHA-256 prefix and quantization, or code version. */
  extractorVersion?: string;
  /** The model run that read these values (§42). */
  modelRunId?: string;
  /**
   * The values were checked against their source: a client's answer that the
   * model and a reading of the client's own words agree on (§25, §60).
   */
  verified?: boolean;
  /** Independent second reading by field (§33). */
  secondReading?: Record<string, TaxFactSecondReading | undefined>;
  sourceFileName: string;
  extractor: string;
  /** Per-field score. A missing field stays null. */
  confidence?: FieldConfidenceSource;
  /** Original source text by field. A missing field stays empty. */
  rawText?: FieldRawTextSource;
  /**
   * Page + box when the extractor located the token.
   * Absent when no text block was found. Never invent coordinates.
   */
  sourceLocation?: FieldSourceLocationSource;
}

export interface TaxToolSuccess {
  ok: true;
  tool: TaxToolName;
  /** Present for income-item tools; safe for addIncomeItem / add_income. */
  incomeType?: TaxToolIncomeType;
  /** How this result applies to the return. */
  application: TaxToolApplication;
  /** Plain fields with missing amounts omitted (never zeroed). */
  fields: Record<string, unknown>;
  facts: TaxFact[];
  /**
   * Filing-status candidate only: records a fact. Does not set final filing status.
   * Final status remains a preparer/user choice.
   */
  appliesFilingStatus?: false;
}

export interface TaxToolFailure {
  ok: false;
  tool: TaxToolName;
  error: string;
}

export type TaxToolResult = TaxToolSuccess | TaxToolFailure;

export interface InvokeTaxToolInput {
  tool: TaxToolName;
  /** Raw tool arguments (document fields or { status }). */
  args: Record<string, unknown>;
  context: TaxToolCallContext;
}

function stripUndefined(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate and execute a tax-engine tool call.
 * Returns TaxFacts + fields for the add-income path. Does not calculate tax
 * and does not write Form 1040 lines.
 */
export function invokeTaxTool(input: InvokeTaxToolInput): TaxToolResult {
  const { tool, args, context } = input;

  if (tool === 'set_filing_status_candidate') {
    const parsed = SetFilingStatusCandidateSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, tool, error: formatZodError(parsed.error) };
    }
    const fields = fieldsForToolCall({ status: parsed.data.status });
    const facts = factsFromFields({
      returnId: context.returnId,
      taxYear: context.taxYear,
      documentId: context.sourceDocumentId,
      fileName: context.sourceFileName,
      extractor: context.extractor,
      formIndex: context.sourceFormIndex,
      sourceKind: context.sourceKind,
      extractorVersion: context.extractorVersion,
      modelRunId: context.modelRunId,
      verified: context.verified,
      fields,
      factTypeFor: () => 'FILING_STATUS_CANDIDATE',
      confidence: context.confidence,
      rawText: context.rawText,
      sourceLocation: context.sourceLocation,
    });
    return {
      ok: true,
      tool,
      fields,
      facts,
      application: TOOL_APPLICATION[tool],
      appliesFilingStatus: false,
    };
  }

  const schema = fieldSchemaFor(tool);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, tool, error: formatZodError(parsed.error) };
  }

  // Drop undefined keys so missing amounts never become zero defaults.
  const cleaned = stripUndefined(parsed.data as Record<string, unknown>);
  const fields = fieldsForToolCall(cleaned);

  // Facts cover every schema field the caller supplied. Missing/null values
  // become status "unknown" (no value). Tool fields omit those keys entirely.
  const shape = schema.shape as Record<string, unknown>;
  const factFields: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      factFields[key] = cleaned[key];
    }
  }

  const prefix = FACT_TYPE_PREFIX[tool];
  const facts = factsFromFields({
    returnId: context.returnId,
    taxYear: context.taxYear,
    documentId: context.sourceDocumentId,
    fileName: context.sourceFileName,
    extractor: context.extractor,
    formIndex: context.sourceFormIndex,
    sourceKind: context.sourceKind,
    extractorVersion: context.extractorVersion,
    modelRunId: context.modelRunId,
    verified: context.verified,
    secondReading: context.secondReading,
    fields: factFields,
    factTypeFor: (field) => `${prefix}_${field}`,
    confidence: context.confidence,
    rawText: context.rawText,
    sourceLocation: context.sourceLocation,
  });

  return {
    ok: true,
    tool,
    ...(TOOL_APPLICATION[tool].kind === 'income_item'
      ? { incomeType: TAX_TOOL_INCOME_TYPE[tool as TaxToolIncomeName] }
      : {}),
    application: TOOL_APPLICATION[tool],
    fields,
    facts,
  };
}

/** Convenience wrappers matching work-order tool names. */
export function addW2(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_w2', args, context });
}

export function add1099Int(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_int', args, context });
}

export function add1099Div(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_div', args, context });
}

export function add1099Nec(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_nec', args, context });
}

export function add1099R(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_1099_r', args, context });
}

/**
 * Records a filing-status candidate as a TaxFact only.
 * Does not set the return's final filing status (that remains a user choice).
 */
export function setFilingStatusCandidate(
  args: Record<string, unknown>,
  context: TaxToolCallContext,
): TaxToolResult {
  return invokeTaxTool({ tool: 'set_filing_status_candidate', args, context });
}

export function addDependent(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_dependent', args, context });
}

export function addScheduleCIncome(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_schedule_c_income', args, context });
}

export function addEstimatedPayment(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'add_estimated_payment', args, context });
}

/** Records the taxpayer's residency in one state; the applier sets that state's return from every source. */
export function setStateResidency(args: Record<string, unknown>, context: TaxToolCallContext): TaxToolResult {
  return invokeTaxTool({ tool: 'set_state_residency', args, context });
}
