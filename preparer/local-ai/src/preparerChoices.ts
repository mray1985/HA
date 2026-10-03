/**
 * Preparer decisions a form cannot make (work order §38, §40).
 *
 * A 1098-T, 1099-Q, 1099-SA or 1099-S is recorded but not applied: the engine
 * needs a fact the form does not print (the education credit, the qualified
 * expenses a distribution paid, whether an HSA distribution paid medical
 * expenses, the basis and ownership of a sold home). The preparer's answer is
 * schema-validated and kept as facts of the same form (source kind
 * "preparer_correction"), and the engine item is built from the form's facts
 * and the answer together — never from a default.
 *
 * Also: correcting a held form's field (a value the page could not read), which
 * is the same kind of recorded preparer fact.
 */

import { z } from 'zod';
import { factsFromFields, type TaxFact, type TaxFactValue } from './taxFact.js';
import { formKeyOf } from './factValidation.js';
import {
  FORM_EXTRACTION_SCHEMAS,
  TOOL_MAPPINGS,
} from './formSchemas.js';
import {
  factPrefixOf,
  fieldSchemaFor,
  FORM_TOOL_NAMES,
  TOOL_APPLICATION,
  type DocumentToolName,
  type TaxToolCallContext,
} from './taxTools.js';

export type ChoiceTool = 'add_education_expense' | 'add_1099_q' | 'add_1099_sa' | 'add_1099_s';

const money = z.number().finite().nonnegative();
const months = z.number().int().min(0).max(60);

/** The answers each form needs, validated before anything is recorded. */
export const CHOICE_SCHEMAS: Record<ChoiceTool, z.ZodTypeAny> = {
  add_education_expense: z
    .object({
      creditType: z.enum(['american_opportunity', 'lifetime_learning']),
      /** Form 8863 line 24, when box 8 did not settle it. */
      enrolledHalfTime: z.boolean().optional(),
      /** Form 8863 lines 23, 25 and 26 — required for the American Opportunity credit. */
      aotcClaimedPrior4Years: z.boolean().optional(),
      completedFirst4Years: z.boolean().optional(),
      felonyDrugConviction: z.boolean().optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.creditType !== 'american_opportunity') return;
      for (const f of ['aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction'] as const) {
        if (c[f] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'required for the American Opportunity credit (Form 8863 lines 23–26)' });
      }
    }),
  add_1099_q: z
    .object({
      qualifiedExpenses: money,
      taxFreeAssistance: money.optional(),
      expensesClaimedForCredit: money.optional(),
      /** Box 6, when the page did not settle it. */
      recipientNotDesignatedBeneficiary: z.boolean().optional(),
    })
    .strict(),
  add_1099_sa: z
    .object({
      /** The engine takes the whole distribution as used or not used; a partial use is entered by hand. */
      usedForQualifiedMedicalExpenses: z.boolean(),
    })
    .strict(),
  add_1099_s: z
    .object({
      /** The sale was of the taxpayer's main home (IRC §121). Other property is reported by hand. */
      mainHome: z.boolean(),
      costBasis: money.optional(),
      sellingExpenses: money.optional(),
      ownedMonths: months.optional(),
      usedAsResidenceMonths: months.optional(),
      priorExclusionUsedWithin2Years: z.boolean().optional(),
      reducedMaximumReason: z.enum(['change_of_employment', 'health', 'unforeseen_circumstances']).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (!c.mainHome) return;
      for (const f of ['costBasis', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years'] as const) {
        if (c[f] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'required for a main-home sale' });
      }
    }),
};

/** The answer fields of each choice form (a new answer replaces all of them). */
export const CHOICE_FIELDS: Record<ChoiceTool, readonly string[]> = {
  add_education_expense: ['creditType', 'enrolledHalfTime', 'aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction'],
  add_1099_q: ['qualifiedExpenses', 'taxFreeAssistance', 'expensesClaimedForCredit', 'recipientNotDesignatedBeneficiary'],
  add_1099_sa: ['usedForQualifiedMedicalExpenses'],
  add_1099_s: ['mainHome', 'costBasis', 'sellingExpenses', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years', 'reducedMaximumReason'],
};

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(answer)'}: ${i.message}`).join('; ');
}

export type RecordedFacts = { ok: true; facts: TaxFact[] } | { ok: false; error: string };

/** Validate a preparer's answer for one form and turn it into facts of that form. */
export function recordPreparerChoice(tool: ChoiceTool, answer: Record<string, unknown>, context: TaxToolCallContext): RecordedFacts {
  const parsed = CHOICE_SCHEMAS[tool].safeParse(answer);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const fields = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([, v]) => v !== undefined));
  return { ok: true, facts: preparerFacts(tool, fields, context) };
}

/**
 * Validate a preparer's value for one field of a form (a box the page could
 * not read, or a value validation holds) against the form tool's own schema.
 */
export function recordFieldCorrection(tool: DocumentToolName, field: string, value: unknown, context: TaxToolCallContext): RecordedFacts {
  const shape = fieldSchemaFor(tool).shape as Record<string, z.ZodTypeAny>;
  const schema = shape[field];
  if (!schema) return { ok: false, error: `${field} is not a field of this form` };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `${field}: ${formatIssues(parsed.error)}` };
  if (parsed.data === undefined) return { ok: false, error: `${field}: a value is required` };
  return { ok: true, facts: preparerFacts(tool, { [field]: parsed.data }, context) };
}

/**
 * A client's confirmed answer to one fact a form needs (§25: the qualified
 * expenses a 1099-Q paid), validated against that answer field's own schema
 * and kept as a verified client-response fact of the form. The rest of the
 * form's decision stays with the preparer; a later preparer decision replaces
 * it.
 */
export function recordClientChoiceAnswer(tool: ChoiceTool, field: string, value: unknown, context: TaxToolCallContext): RecordedFacts {
  const schema = CHOICE_SCHEMAS[tool];
  const object = (schema instanceof z.ZodEffects ? schema.innerType() : schema) as z.ZodObject<z.ZodRawShape>;
  const fieldSchema = object.shape[field] as z.ZodTypeAny | undefined;
  if (!fieldSchema || !CHOICE_FIELDS[tool].includes(field)) return { ok: false, error: `${field} is not a question of this form` };
  const parsed = fieldSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `${field}: ${formatIssues(parsed.error)}` };
  if (parsed.data === undefined) return { ok: false, error: `${field}: a value is required` };
  return { ok: true, facts: formFacts(tool, { [field]: parsed.data }, { ...context, sourceKind: 'client_response', verified: true }) };
}

function preparerFacts(tool: DocumentToolName, fields: Record<string, unknown>, context: TaxToolCallContext): TaxFact[] {
  return formFacts(tool, fields, { ...context, sourceKind: 'preparer_correction', verified: true });
}

function formFacts(tool: DocumentToolName, fields: Record<string, unknown>, context: TaxToolCallContext): TaxFact[] {
  const prefix = factPrefixOf(tool);
  return factsFromFields({
    returnId: context.returnId,
    taxYear: context.taxYear,
    documentId: context.sourceDocumentId,
    fileName: context.sourceFileName,
    extractor: context.extractor,
    formIndex: context.sourceFormIndex,
    sourceKind: context.sourceKind,
    ...(context.modelRunId ? { modelRunId: context.modelRunId } : {}),
    verified: context.verified,
    fields,
    factTypeFor: (field) => `${prefix}${field}`,
    rawText: context.rawText,
  });
}

/** The form tool whose facts these are (by fact-type prefix), when one is. */
export function formToolOfFacts(facts: readonly TaxFact[]): DocumentToolName | null {
  const factType = facts[0]?.factType ?? '';
  // Longest prefix first: "1099SA_" before "1099S_", "1098T_" before "1098_".
  const tools = [...FORM_TOOL_NAMES].sort((a, b) => factPrefixOf(b).length - factPrefixOf(a).length);
  return tools.find((t) => factType.startsWith(factPrefixOf(t))) ?? null;
}

/** One form's facts by field: the extracted value from the highest source, preparer corrections first. */
export function formFieldValues(facts: readonly TaxFact[]): Map<string, TaxFactValue> {
  const tool = formToolOfFacts(facts);
  const prefix = tool ? factPrefixOf(tool) : '';
  const out = new Map<string, TaxFactValue>();
  const ordered = [...facts].sort((a, b) => Number(a.sourceKind === 'preparer_correction') - Number(b.sourceKind === 'preparer_correction'));
  for (const f of ordered) {
    if (f.status !== 'extracted') continue;
    out.set(f.factType.slice(prefix.length), f.value);
  }
  return out;
}

/** A form's current tool fields, from its facts (preparer corrections included). */
export function toolFieldsFromFacts(tool: DocumentToolName, facts: readonly TaxFact[]): Record<string, unknown> {
  const shape = fieldSchemaFor(tool).shape as Record<string, unknown>;
  const values = formFieldValues(facts);
  return Object.fromEntries([...values].filter(([field]) => Object.prototype.hasOwnProperty.call(shape, field)));
}

export type ChoiceItem =
  | { state: 'ready'; target: 'educationCredits' | 'income1099Q' | 'income1099SA'; item: Record<string, unknown> }
  | { state: 'ready'; target: 'homeSale'; item: Record<string, unknown> }
  | { state: 'needs_answer'; missing: string[] }
  | { state: 'manual'; reason: string };

const str = (v: TaxFactValue | undefined) => (typeof v === 'string' ? v : undefined);
const num = (v: TaxFactValue | undefined) => (typeof v === 'number' ? v : undefined);
const bool = (v: TaxFactValue | undefined) => (typeof v === 'boolean' ? v : undefined);
const firstLine = (text: string | undefined) => text?.split(/\r?\n/)[0]!.trim();

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * The engine item for a choice form, from its facts and the preparer's
 * answers — or what is still needed, or why it must be entered by hand.
 */
export function buildChoiceItem(tool: ChoiceTool, facts: readonly TaxFact[]): ChoiceItem {
  const v = formFieldValues(facts);
  const needs = (fields: string[]): ChoiceItem | null => {
    const missing = fields.filter((f) => !v.has(f));
    return missing.length > 0 ? { state: 'needs_answer', missing } : null;
  };

  switch (tool) {
    case 'add_education_expense': {
      const wait = needs(['creditType', 'tuitionPaid']);
      if (wait) return wait;
      const aotc = v.get('creditType') === 'american_opportunity';
      const halfTime = bool(v.get('enrolledHalfTime')) ?? bool(v.get('halfTimeStudent'));
      if (aotc) {
        const more = needs(['aotcClaimedPrior4Years', 'completedFirst4Years', 'felonyDrugConviction']);
        if (more) return more;
        if (halfTime === undefined) return { state: 'needs_answer', missing: ['enrolledHalfTime'] };
      }
      return {
        state: 'ready',
        target: 'educationCredits',
        item: stripUndefined({
          type: v.get('creditType'),
          studentName: str(v.get('studentName')) ?? '',
          institution: firstLine(str(v.get('institutionName'))) ?? '',
          institutionEIN: str(v.get('institutionEin'))?.replace(/\D/g, ''),
          received1098T: true,
          tuitionPaid: num(v.get('tuitionPaid')),
          scholarships: num(v.get('scholarships')),
          enrolledHalfTime: halfTime,
          aotcClaimedPrior4Years: bool(v.get('aotcClaimedPrior4Years')),
          completedFirst4Years: bool(v.get('completedFirst4Years')),
          felonyDrugConviction: bool(v.get('felonyDrugConviction')),
        }),
      };
    }
    case 'add_1099_q': {
      const wait = needs(['grossDistribution', 'earnings', 'basisReturn', 'qualifiedExpenses', 'recipientNotDesignatedBeneficiary']);
      if (wait) return wait;
      const gross = num(v.get('grossDistribution'))!;
      const qualified = num(v.get('qualifiedExpenses'))!;
      const assistance = num(v.get('taxFreeAssistance'));
      const claimed = num(v.get('expensesClaimedForCredit'));
      const transfer = bool(v.get('trusteeToTrusteeTransfer')) === true || bool(v.get('qtpToRothIra')) === true;
      const adjusted = qualified - (assistance ?? 0) - (claimed ?? 0);
      return {
        state: 'ready',
        target: 'income1099Q',
        item: stripUndefined({
          payerName: firstLine(str(v.get('payerName'))) ?? '',
          grossDistribution: gross,
          earnings: num(v.get('earnings')),
          basisReturn: num(v.get('basisReturn')),
          qualifiedExpenses: qualified,
          taxFreeAssistance: assistance,
          expensesClaimedForCredit: claimed,
          distributionType: transfer ? 'rollover' : adjusted >= gross ? 'qualified' : 'non_qualified',
          // Box 6 checked: paid to the account owner, not the student (IRC §529(c)(3)(A)).
          recipientType: v.get('recipientNotDesignatedBeneficiary') === true ? 'accountOwner' : 'beneficiary',
        }),
      };
    }
    case 'add_1099_sa': {
      const account = str(v.get('accountType'));
      if (account && account !== 'HSA') {
        return { state: 'manual', reason: `${account} distributions are reported on Form 8853, which the engine does not compute from a 1099-SA; enter it by hand.` };
      }
      const wait = needs(['grossDistribution', 'distributionCode', 'usedForQualifiedMedicalExpenses']);
      if (wait) return wait;
      return {
        state: 'ready',
        target: 'income1099SA',
        item: stripUndefined({
          payerName: firstLine(str(v.get('payerName'))) ?? '',
          grossDistribution: num(v.get('grossDistribution')),
          distributionCode: str(v.get('distributionCode'))?.trim(),
          qualifiedMedicalExpenses: bool(v.get('usedForQualifiedMedicalExpenses')),
        }),
      };
    }
    case 'add_1099_s': {
      const wait = needs(['grossProceeds', 'mainHome']);
      if (wait) return wait;
      if (v.get('mainHome') !== true) {
        return { state: 'manual', reason: 'Not the main home: report the sale on Form 8949 / 4797 by hand (the home-sale exclusion does not apply).' };
      }
      const more = needs(['costBasis', 'ownedMonths', 'usedAsResidenceMonths', 'priorExclusionUsedWithin2Years']);
      if (more) return more;
      return {
        state: 'ready',
        target: 'homeSale',
        item: stripUndefined({
          salePrice: num(v.get('grossProceeds')),
          costBasis: num(v.get('costBasis')),
          sellingExpenses: num(v.get('sellingExpenses')),
          ownedMonths: num(v.get('ownedMonths')),
          usedAsResidenceMonths: num(v.get('usedAsResidenceMonths')),
          priorExclusionUsedWithin2Years: bool(v.get('priorExclusionUsedWithin2Years')),
          reducedMaximumReason: str(v.get('reducedMaximumReason')),
        }),
      };
    }
  }
}

/** Facts grouped by form key, for the forms of one choice tool. */
export function choiceForms(facts: readonly TaxFact[], tool: ChoiceTool): Map<string, TaxFact[]> {
  const prefix = factPrefixOf(tool);
  const out = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (!f.factType.startsWith(prefix)) continue;
    // "1099S_" must not take "1099SA_" facts.
    if (formToolOfFacts([f]) !== tool) continue;
    const key = formKeyOf(f);
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

/** True when the tool's forms wait for a preparer decision. */
export function needsChoice(tool: DocumentToolName): tool is ChoiceTool {
  return TOOL_APPLICATION[tool].kind === 'needs_preparer_choice';
}

export type FieldInput =
  | { kind: 'number'; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'text' }
  | { kind: 'enum'; options: string[] };

/**
 * What a field of a form is called to a person, in the words the form itself
 * uses. The tool field names (`federalIncomeTaxWithheld`) are the engine's
 * vocabulary and must never reach the screen; these are read from the printed
 * label and the IRS box number where there is one, so the preparer can match
 * what they see on the page to what the app asks for.
 *
 * A field with no entry here is spoken from its name rather than shown raw.
 */
const FIELD_LABELS: Partial<Record<DocumentToolName, Record<string, string>>> = {
  add_w2: {
    wages: 'Wages, tips and other compensation (box 1)',
    federalTaxWithheld: 'Federal income tax withheld (box 2)',
    socialSecurityWages: 'Social Security wages (box 3)',
    socialSecurityTax: 'Social Security tax withheld (box 4)',
    medicareWages: 'Medicare wages (box 5)',
    medicareTax: 'Medicare tax withheld (box 6)',
    state: 'State (box 15)',
    stateWages: 'State wages (box 16)',
    stateTaxWithheld: 'State income tax (box 17)',
    localWages: 'Local wages (box 18)',
    localTaxWithheld: 'Local income tax (box 19)',
    localityName: 'Locality name (box 20)',
    isSpouse: 'The employee is the taxpayer’s spouse (box 5 has a tick)',
  },
  add_w2c: {
    wages: 'Corrected wages (box 1)',
    federalTaxWithheld: 'Corrected federal income tax withheld (box 2)',
    socialSecurityWages: 'Corrected Social Security wages (box 3)',
    socialSecurityTax: 'Corrected Social Security tax withheld (box 4)',
    medicareWages: 'Corrected Medicare wages (box 5)',
    medicareTax: 'Corrected Medicare tax withheld (box 6)',
    state: 'Corrected state (box 15)',
    stateWages: 'Corrected state wages (box 16)',
    stateTaxWithheld: 'Corrected state income tax (box 17)',
    localWages: 'Corrected local wages (box 18)',
    localTaxWithheld: 'Corrected local income tax (box 19)',
  },
  add_1099_int: {
    amount: 'Interest income (box 1)',
    earlyWithdrawalPenalty: 'Early withdrawal penalty (box 2)',
    usBondInterest: 'Interest on a U.S. Treasury bond sold before maturity (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    taxExemptInterest: 'Tax-exempt interest (box 5)',
    stateTaxWithheld: 'State tax withheld (box 16)',
  },
  add_1099_div: {
    ordinaryDividends: 'Ordinary dividends (box 1a)',
    qualifiedDividends: 'Qualified dividends (box 1b)',
    capitalGainDistributions: 'Capital gain distributions (box 2a)',
    unrecapturedSection1250Gain: 'Unrecaptured §1250 gain (box 2b)',
    collectiblesGain: 'Collectibles gain (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    foreignTaxPaid: 'Foreign tax paid (box 6)',
    foreignSourceIncome: 'Foreign source income (box 7)',
    stateTaxWithheld: 'State tax withheld (box 17)',
  },
  add_1099_nec: {
    amount: 'Nonemployee compensation (box 1)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    stateTaxWithheld: 'State tax withheld (box 17)',
  },
  add_1099_r: {
    grossDistribution: 'Gross distribution (box 1a)',
    taxableAmount: 'Taxable amount (box 2a)',
    distributionCode: 'Distribution code (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    isIRA: 'This is an IRA distribution',
    isRothIRA: 'This is a Roth IRA distribution',
    rothContributionBasis: 'Roth IRA contributions made this year (box 5)',
    qcdAmount: 'Qualified charitable distribution (box 3a)',
    earlyDistributionExceptionCode: 'Early distribution exception code',
    earlyDistributionExceptionAmount: 'Amount in an early distribution exception',
    useSimplifiedMethod: 'The 10-year averaging method applies (box 6)',
    stateTaxWithheld: 'State tax withheld (box 17)',
  },
  add_ssa_1099: {
    benefitsPaid: 'Benefits paid (box 5)',
    benefitsRepaid: 'Benefits repaid (box 5r)',
    netBenefits: 'Net benefits (box 9)',
    federalTaxWithheld: 'Federal tax withheld (box 10)',
    isSpouse: 'The recipient is the taxpayer’s spouse',
  },
  add_mortgage_interest: {
    mortgageInterest: 'Mortgage interest received (box 1)',
    outstandingPrincipal: 'Outstanding principal on 1 January (box 2)',
    originationDate: 'Date the loan was originated (box 3)',
    refundOfOverpaidInterest: 'Refund of overpaid interest from a prior year (box 4)',
    mortgageInsurancePremiums: 'Mortgage insurance premiums (box 5)',
    points: 'Points paid on the mortgage (box 6)',
  },
  add_1099_misc: {
    rents: 'Rents (box 1)',
    royalties: 'Royalties (box 2)',
    otherIncome: 'Other income (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    stateTaxWithheld: 'State tax withheld (box 17)',
  },
  add_1099_g: {
    unemploymentCompensation: 'Unemployment compensation (box 1)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    stateTaxWithheld: 'State tax withheld (box 17)',
  },
  add_1099_b: {
    proceeds: 'Proceeds (box 1d)',
    costBasis: 'Cost or other basis (box 1e)',
    isLongTerm: 'Long-term — held more than one year (box 2)',
    washSaleLossDisallowed: 'Loss disallowed by the wash sale rule (box 4)',
    isCollectible: 'Collectibles (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
  },
  add_1099_k: {
    grossAmount: 'Gross amount (box 1a)',
    cardNotPresent: 'Amounts paid by card, online or by phone (box 1b)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
  },
  add_1099_oid: {
    originalIssueDiscount: 'Original issue discount (box 1)',
    otherPeriodicInterest: 'Other periodic interest (box 2)',
    earlyWithdrawalPenalty: 'Early withdrawal penalty (box 3)',
    federalTaxWithheld: 'Federal tax withheld (box 4)',
    marketDiscount: 'Market discount (box 5)',
    acquisitionPremium: 'Acquisition premium (box 6)',
    stateTaxWithheld: 'State tax withheld (box 12)',
  },
  add_1099_c: {
    dateOfCancellation: 'Date the debt was cancelled (box 1)',
    amountCancelled: 'Amount of debt cancelled (box 2)',
    interestIncluded: 'Interest included in the cancelled debt (box 3)',
    identifiableEventCode: 'Identifiable event code (box 6)',
    personallyLiable: 'You were personally liable for the debt (box 5)',
  },
  add_1099_q: {
    qualifiedExpenses: 'Qualified education expenses this distribution paid',
    taxFreeAssistance: 'Tax-free educational assistance — scholarships and grants (box 4)',
    expensesClaimedForCredit: 'Expenses used for an education credit',
    recipientNotDesignatedBeneficiary: 'Paid to someone other than the student (box 6)',
    trusteeToTrusteeTransfer: 'A trustee-to-trustee transfer (box 4a)',
    qtpToRothIra: 'Paid directly to a Roth IRA (box 4b)',
  },
  add_1099_sa: {
    usedForQualifiedMedicalExpenses: 'Did the whole distribution pay qualified medical expenses?',
    grossDistribution: 'Gross distribution (box 1)',
    distributionCode: 'Distribution code (box 3)',
    accountType: 'Which account paid it (box 5)',
  },
  add_1099_s: {
    closingDate: 'Date of sale (box 2)',
    grossProceeds: 'Gross proceeds (box 3)',
    transferorIsForeign: 'The seller was not a US person (box 7)',
  },
  add_education_expense: {
    creditType: 'Which education credit this student qualifies for',
    enrolledHalfTime: 'Enrolled at least half-time (Form 1098-T box 8)',
    aotcClaimedPrior4Years: 'American Opportunity credit claimed for this student in any of the 4 years before (Form 8863 line 23)',
    completedFirst4Years: 'Completed the first 4 years of college before this year (Form 8863 line 25)',
    felonyDrugConviction: 'Felony drug conviction this year (Form 8863 line 26)',
    tuitionPaid: 'Tuition paid (Form 1098-T box 1)',
    scholarships: 'Scholarships and grants (Form 1098-T box 13)',
  },
};

/** Spoken from the field name when the form has no printed label for it. */
function spokenField(field: string): string {
  const ACRONYMS: Record<string, string> = {
    ssn: 'SSN', ein: 'EIN', fedTaxWithheld: 'federal tax withheld', qbi: 'QBI',
    hsa: 'HSA', ctc: 'child tax credit', agi: 'AGI', ira: 'IRA', isbn: 'ISIN',
  };
  const key = field.split('.')[0]!;
  if (ACRONYMS[key]) return ACRONYMS[key]!;
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** What a field of a form is called to a person: the printed label and box, or the field's own words. */
export function toolFieldLabel(tool: DocumentToolName, field: string): string {
  const table = FIELD_LABELS[tool];
  const exact = table?.[field];
  const head = field.split('.')[0]!;
  const label = exact ?? table?.[head] ?? spokenField(field);
  // The box number is taken from the form schema rather than typed into the
  // label, so it cannot drift from the form. Hand-written box numbers sent
  // preparers to boxes the form does not have (1099-INT tax-exempt interest is
  // box 8, not box 5; 1099-R gross distribution is box 1, not box 1a).
  const printed = printedBoxFor(tool, field);
  if (!printed) return label;
  return /\(box [^)]*\)\s*$/.test(label)
    ? label.replace(/\(box [^)]*\)\s*$/, `(box ${printed})`)
    : `${label} (box ${printed})`;
}

/** The box identifier the form prints for a tool field, from the form schema. */
function printedBoxFor(tool: DocumentToolName, field: string): string | null {
  const mappings = TOOL_MAPPINGS as Record<
    string,
    { tool: string | null; direct?: Record<string, string>; checkboxes?: Record<string, string> } | undefined
  >;
  const schemas = FORM_EXTRACTION_SCHEMAS as Record<
    string,
    { boxes: ReadonlyArray<{ key: string; box: string }> } | undefined
  >;

  for (const [formType, mapping] of Object.entries(mappings)) {
    if (!mapping || mapping.tool !== tool) continue;
    const schema = schemas[formType];
    if (!schema) continue;
    const printed = new Map(schema.boxes.map((b) => [b.key, b.box]));
    for (const group of [mapping.direct, mapping.checkboxes]) {
      for (const [boxKey, fieldName] of Object.entries(group ?? {})) {
        if (fieldName === field) return printed.get(boxKey) || null;
      }
    }
    return null;
  }
  return null;
}

/** How a preparer enters one field of a form, read from the form tool's schema. */
export function fieldInput(tool: DocumentToolName, field: string): FieldInput | null {
  let schema = (fieldSchemaFor(tool).shape as Record<string, z.ZodTypeAny>)[field];
  while (schema) {
    const def = schema._def as { typeName: string } & Record<string, unknown>;
    if (def.typeName === 'ZodEffects') schema = def.schema as z.ZodTypeAny;
    else if (def.typeName === 'ZodOptional') schema = def.innerType as z.ZodTypeAny;
    else break;
  }
  if (!schema) return null;
  const def = schema._def as { typeName: string; checks?: Array<{ kind: string; value?: number }>; values?: string[] };
  switch (def.typeName) {
    case 'ZodNumber': {
      const checks = def.checks ?? [];
      return {
        kind: 'number',
        integer: checks.some((c) => c.kind === 'int'),
        ...(checks.find((c) => c.kind === 'min') ? { min: checks.find((c) => c.kind === 'min')!.value } : {}),
        ...(checks.find((c) => c.kind === 'max') ? { max: checks.find((c) => c.kind === 'max')!.value } : {}),
      };
    }
    case 'ZodBoolean': return { kind: 'boolean' };
    case 'ZodEnum': return { kind: 'enum', options: [...(def.values ?? [])] };
    case 'ZodString': return { kind: 'text' };
    default: return null;
  }
}
