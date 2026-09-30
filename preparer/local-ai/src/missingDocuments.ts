/**
 * Missing-document engine (work order §23).
 *
 * Last year's documents — from last year's case for the same client, from an
 * imported prior-year HATax return, or, when only a prior-year return's
 * totals are known, from those totals — are compared with the documents this
 * year's case holds. Each one not matched is reported as *possibly* missing
 * ("Possible missing 1099-INT from Chase"), never as certainly missing: an
 * account can close, a job can end. The client is asked (§24), and the
 * client's answer (set_document_expected) settles it.
 *
 * Deterministic: a document matches by form and by payer — the same EIN, or
 * the same name once legal suffixes are set aside ("Chase" is "JPMORGAN
 * CHASE BANK NA"). A payer name that is one generic word ("First") never
 * matches on its own: a wrong match would hide a missing document.
 */

import type { PriorYearSummary, TaxReturn } from '@hatax/engine';
import { formKeyOf } from './factValidation.js';
import { formFieldValues, formToolOfFacts } from './preparerChoices.js';
import type { TaxFact } from './taxFact.js';
import { EXPECTED_DOCUMENT_TYPES, factPrefixOf, type DocumentToolName, type ExpectedDocumentType } from './taxTools.js';

/** One document of a kind the client receives again each year. */
export interface ExpectedDocument {
  formType: ExpectedDocumentType;
  /** Payer, employer, institution, lender, broker or platform (first line). */
  issuer?: string;
  issuerEin?: string;
  /** The document's main amount last year, for the message. */
  amount?: number;
}

/** Where last year's documents come from. */
export interface PriorYearEvidence {
  taxYear: number;
  /** "the 2024 case", "the imported 2024 HATax return", "the 2024 return (TurboTax)" */
  label: string;
  documents: ExpectedDocument[];
  /** Only the prior return's totals are known: the documents name no payer. */
  fromTotals: boolean;
}

/** The client's answer to "did you receive it?" (set_document_expected). */
export interface DocumentAnswer {
  formType: ExpectedDocumentType;
  issuer?: string;
  received: boolean;
  /** The client's words, and the reply they came from. */
  words: string;
  source: string;
}

export type MissingDocumentStatus = 'possibly_missing' | 'client_says_none' | 'client_says_received';

export interface MissingDocument {
  /** Stable for the same form and payer. */
  id: string;
  formType: ExpectedDocumentType;
  issuer?: string;
  /** What last year had: "the 2024 case has one for $123.45". */
  lastYear: string;
  status: MissingDocumentStatus;
  answer?: DocumentAnswer;
}

// ─── Payers ──────────────────────────────────────────────────

/** Words that name a legal form or a kind of institution, not the payer. */
const SUFFIXES = new Set([
  'INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'LTD', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'NA', 'N', 'A', 'FSB', 'THE',
  'OF', 'AND', 'BANK', 'TRUST', 'GROUP', 'HOLDINGS', 'SERVICES', 'SVCS', 'FINANCIAL', 'USA', 'US', 'NATIONAL', 'ASSOCIATION',
  'ASSN', 'FEDERAL', 'SAVINGS', 'CREDIT', 'UNION', 'PLAN', 'FUND', 'FUNDS', 'INVESTMENTS', 'SECURITIES',
]);

/** One of these alone does not tell two payers apart. */
const GENERIC = new Set([
  'FIRST', 'AMERICAN', 'AMERICA', 'UNITED', 'CITIZENS', 'PEOPLES', 'COMMUNITY', 'STATE', 'CITY', 'HOME', 'SECURITY', 'CAPITAL',
  'WESTERN', 'EASTERN', 'NORTHERN', 'SOUTHERN', 'CENTRAL', 'MUTUAL', 'GENERAL', 'COUNTY', 'PACIFIC', 'ATLANTIC', 'REGIONAL',
]);

const firstLine = (v: unknown) => (typeof v === 'string' && v.trim() ? v.split(/\r?\n/)[0]!.trim() : undefined);

function issuerTokens(name: string | undefined): string[] {
  if (!name) return [];
  return firstLine(name)!
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/['’.]/g, '')
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

const einDigits = (v: string | undefined) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 9 ? d : undefined;
};

/** The same payer: the same EIN, or one name's words all within the other's. */
export function sameIssuer(a: Pick<ExpectedDocument, 'issuer' | 'issuerEin'>, b: Pick<ExpectedDocument, 'issuer' | 'issuerEin'>): boolean {
  const ea = einDigits(a.issuerEin);
  const eb = einDigits(b.issuerEin);
  if (ea && eb && ea === eb) return true;
  const ta = issuerTokens(a.issuer);
  const tb = issuerTokens(b.issuer);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length === 1 && (small[0]!.length < 4 || GENERIC.has(small[0]!))) return false;
  return small.every((t) => big.includes(t));
}

const issuerKey = (d: Pick<ExpectedDocument, 'issuer'>) => issuerTokens(d.issuer).join(' ') || 'any';

/** The words a client would use for a payer ("chase", "jpmorgan"): no legal suffixes or generic words. */
export function issuerWords(name: string | undefined): string[] {
  return issuerTokens(name).filter((t) => t.length >= 3 && !GENERIC.has(t)).map((t) => t.toLowerCase());
}

// ─── Documents on a return and on a case ─────────────────────

const TYPE_OF_TOOL: Partial<Record<DocumentToolName, ExpectedDocumentType>> = {
  add_w2: 'W-2', add_1099_int: '1099-INT', add_1099_div: '1099-DIV', add_1099_r: '1099-R', add_1099_nec: '1099-NEC',
  add_1099_misc: '1099-MISC', add_1099_g: '1099-G', add_1099_k: '1099-K', add_1099_b: '1099-B', add_1099_oid: '1099-OID',
  add_1099_sa: '1099-SA', add_1099_q: '1099-Q', add_ssa_1099: 'SSA-1099', add_mortgage_interest: '1098',
  add_education_expense: '1098-T',
};

const ISSUER_FIELDS = ['employerName', 'payerName', 'filerName', 'institutionName', 'lenderName', 'platformName', 'brokerName'];
const EIN_FIELDS = ['employerEin', 'payerEin', 'institutionEin', 'lenderTin'];
const AMOUNT_FIELDS = ['wages', 'amount', 'ordinaryDividends', 'grossDistribution', 'nonemployeeCompensation', 'unemploymentCompensation', 'grossAmount', 'proceeds', 'originalIssueDiscount', 'totalBenefits', 'netBenefits', 'mortgageInterest', 'tuitionPaid', 'otherIncome', 'rents'];

const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

/** The tax documents a case's facts hold, one per form (held or not). */
export function documentsFromFacts(facts: readonly TaxFact[]): ExpectedDocument[] {
  const forms = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (f.sourceKind && f.sourceKind !== 'document' && f.sourceKind !== 'structured_import') continue;
    forms.set(formKeyOf(f), [...(forms.get(formKeyOf(f)) ?? []), f]);
  }
  const out: ExpectedDocument[] = [];
  for (const formFacts of forms.values()) {
    const tool = formToolOfFacts(formFacts);
    const formType = tool ? TYPE_OF_TOOL[tool] : undefined;
    if (!formType) continue;
    const v = formFieldValues(formFacts);
    const issuer = ISSUER_FIELDS.map((k) => firstLine(v.get(k))).find(Boolean);
    const ein = EIN_FIELDS.map((k) => v.get(k)).find((x): x is string => typeof x === 'string' && Boolean(einDigits(x)));
    const amount = AMOUNT_FIELDS.map((k) => positive(v.get(k))).find((x) => x !== undefined);
    out.push({ formType, ...(issuer ? { issuer } : {}), ...(ein ? { issuerEin: ein } : {}), ...(amount !== undefined ? { amount } : {}) });
  }
  return out;
}

/** The tax documents a return shows (each income item, and the forms behind its totals). */
export function documentsFromReturn(tr: TaxReturn): ExpectedDocument[] {
  const out: ExpectedDocument[] = [];
  const add = (formType: ExpectedDocumentType, issuer: unknown, issuerEin: unknown, amount: unknown) => {
    const name = firstLine(issuer);
    const ein = typeof issuerEin === 'string' ? issuerEin : undefined;
    out.push({ formType, ...(name ? { issuer: name } : {}), ...(ein ? { issuerEin: ein } : {}), ...(positive(amount) !== undefined ? { amount: positive(amount) } : {}) });
  };
  for (const w of tr.w2Income ?? []) add('W-2', w.employerName, w.employerEin, w.wages);
  for (const i of tr.income1099NEC ?? []) add('1099-NEC', i.payerName, i.payerEin, i.amount);
  for (const i of tr.income1099K ?? []) add('1099-K', i.platformName, undefined, i.grossAmount);
  for (const i of tr.income1099INT ?? []) add('1099-INT', i.payerName, undefined, i.amount);
  for (const i of tr.income1099OID ?? []) add('1099-OID', i.payerName, undefined, i.originalIssueDiscount);
  for (const i of tr.income1099DIV ?? []) add('1099-DIV', i.payerName, undefined, i.ordinaryDividends);
  for (const i of tr.income1099R ?? []) add('1099-R', i.payerName, undefined, i.grossDistribution);
  for (const i of tr.income1099G ?? []) add('1099-G', i.payerName, undefined, i.unemploymentCompensation);
  for (const i of tr.income1099MISC ?? []) add('1099-MISC', i.payerName, undefined, i.otherIncome || i.rents || i.royalties);
  for (const i of tr.income1099B ?? []) add('1099-B', i.brokerName, undefined, i.proceeds);
  for (const i of tr.incomeK1 ?? []) add('K-1', i.entityName, i.entityEin, undefined);
  for (const i of tr.income1099SA ?? []) add('1099-SA', i.payerName, undefined, i.grossDistribution);
  for (const i of tr.income1099Q ?? []) add('1099-Q', i.payerName, undefined, i.grossDistribution);
  if (tr.incomeSSA1099 && positive(tr.incomeSSA1099.totalBenefits) !== undefined) add('SSA-1099', undefined, undefined, tr.incomeSSA1099.totalBenefits);
  for (const e of tr.educationCredits ?? []) add('1098-T', e.institution, e.institutionEIN, undefined);
  if (positive(tr.itemizedDeductions?.mortgageInterest) !== undefined) add('1098', undefined, undefined, tr.itemizedDeductions!.mortgageInterest);
  if (positive(tr.studentLoanInterest) !== undefined) add('1098-E', undefined, undefined, tr.studentLoanInterest);
  for (const f of tr.premiumTaxCredit?.forms1095A ?? []) add('1095-A', f.marketplace, undefined, undefined);
  return out;
}

/** One entry per form and payer; a payer-less entry is dropped when a named one of its form exists. */
export function distinctDocuments(docs: readonly ExpectedDocument[]): ExpectedDocument[] {
  const out: ExpectedDocument[] = [];
  for (const d of docs) {
    const same = out.find((o) => o.formType === d.formType && (d.issuer || d.issuerEin ? (o.issuer || o.issuerEin) && sameIssuer(o, d) : !o.issuer && !o.issuerEin));
    if (same) {
      if (same.amount === undefined && d.amount !== undefined) same.amount = d.amount;
      continue;
    }
    out.push({ ...d });
  }
  return out.filter((d) => d.issuer || d.issuerEin || !out.some((o) => o.formType === d.formType && (o.issuer || o.issuerEin)));
}

/** Last year's documents from last year's case: its forms, and what its return holds besides. */
export function priorYearFromCase(priorReturn: TaxReturn, priorFacts: readonly TaxFact[]): PriorYearEvidence {
  return {
    taxYear: priorReturn.taxYear,
    label: `the ${priorReturn.taxYear} case`,
    documents: distinctDocuments([...documentsFromFacts(priorFacts), ...documentsFromReturn(priorReturn)]),
    fromTotals: false,
  };
}

/** The IRS threshold below which a payer need not send a 1099-INT or 1099-DIV. */
const INFORMATION_RETURN_MINIMUM = 10;

/**
 * Last year's documents from an imported prior-year return: its documents when
 * the import kept them (a HATax return), otherwise what its totals imply.
 */
export function priorYearFromSummary(summary: PriorYearSummary): PriorYearEvidence | null {
  const source = summary.source === 'hatax-json' ? 'imported HATax return' : summary.source === 'hatax-case' ? 'case' : summary.providerName ? `return (${summary.providerName})` : 'return';
  const label = `the ${summary.taxYear} ${source}`;
  if (summary.documents && summary.documents.length > 0) {
    const documents = summary.documents
      .filter((d): d is typeof d & { formType: ExpectedDocumentType } => (EXPECTED_DOCUMENT_TYPES as readonly string[]).includes(d.formType))
      .map((d) => ({ formType: d.formType, ...(d.issuer ? { issuer: d.issuer } : {}), ...(d.issuerEin ? { issuerEin: d.issuerEin } : {}), ...(d.amount !== undefined ? { amount: d.amount } : {}) }));
    return { taxYear: summary.taxYear, label, documents: distinctDocuments(documents), fromTotals: false };
  }
  const documents: ExpectedDocument[] = [];
  if (positive(summary.totalWages) !== undefined) documents.push({ formType: 'W-2', amount: summary.totalWages! });
  if ((summary.totalInterest ?? 0) >= INFORMATION_RETURN_MINIMUM) documents.push({ formType: '1099-INT', amount: summary.totalInterest! });
  if ((summary.totalDividends ?? 0) >= INFORMATION_RETURN_MINIMUM) documents.push({ formType: '1099-DIV', amount: summary.totalDividends! });
  const retirement = (summary.iraDistributions ?? 0) + (summary.pensionsAnnuities ?? 0);
  if (retirement > 0) documents.push({ formType: '1099-R', amount: retirement });
  if (positive(summary.socialSecurityBenefits) !== undefined) documents.push({ formType: 'SSA-1099', amount: summary.socialSecurityBenefits! });
  return documents.length > 0 ? { taxYear: summary.taxYear, label, documents, fromTotals: true } : null;
}

/** The documents this year's case has: its forms, forms classified on its uploads, and items entered on its return. */
export function receivedDocuments(facts: readonly TaxFact[], taxReturn: TaxReturn, classifiedFormTypes: readonly string[] = []): ExpectedDocument[] {
  const known = [...documentsFromFacts(facts), ...documentsFromReturn(taxReturn)];
  // A classified upload of a form with no tool facts (1098-E, 1095-A) still arrived.
  for (const t of classifiedFormTypes) {
    if ((EXPECTED_DOCUMENT_TYPES as readonly string[]).includes(t) && !known.some((k) => k.formType === t)) known.push({ formType: t as ExpectedDocumentType });
  }
  return known;
}

/** The client's answers about documents, the latest for each form and payer. */
export function documentAnswers(facts: readonly TaxFact[]): DocumentAnswer[] {
  const prefix = factPrefixOf('set_document_expected');
  const byRecord = new Map<string, TaxFact[]>();
  for (const f of facts) if (f.factType.startsWith(prefix)) byRecord.set(formKeyOf(f), [...(byRecord.get(formKeyOf(f)) ?? []), f]);
  const out: DocumentAnswer[] = [];
  for (const fs of byRecord.values()) {
    const get = (field: string) => fs.find((f) => f.sourceField === field && f.status === 'extracted');
    const formType = get('formType')?.value;
    const received = get('received');
    if (typeof formType !== 'string' || !(EXPECTED_DOCUMENT_TYPES as readonly string[]).includes(formType) || typeof received?.value !== 'boolean') continue;
    const issuer = get('issuer')?.value;
    const answer: DocumentAnswer = {
      formType: formType as ExpectedDocumentType,
      ...(typeof issuer === 'string' && issuer ? { issuer } : {}),
      received: received.value,
      words: received.rawText,
      source: received.sourceFileName,
    };
    const earlier = out.findIndex((a) => a.formType === answer.formType && (answer.issuer ? a.issuer !== undefined && sameIssuer(a, answer) : !a.issuer));
    if (earlier >= 0) out.splice(earlier, 1);
    out.push(answer);
  }
  return out;
}

// ─── Comparing ───────────────────────────────────────────────

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const TOTAL_OF: Partial<Record<ExpectedDocumentType, string>> = {
  'W-2': 'wages', '1099-INT': 'taxable interest', '1099-DIV': 'ordinary dividends',
  '1099-R': 'taxable IRA and pension distributions', 'SSA-1099': 'taxable Social Security benefits',
};

/**
 * Last year's documents this year's case does not have. A document matches a
 * received one of its form from the same payer; a received one that names no
 * payer stands in for one document of its form; a document known only from
 * last year's totals is matched by any received document of its form.
 */
export function findMissingDocuments(prior: PriorYearEvidence | null, received: readonly ExpectedDocument[], answers: readonly DocumentAnswer[] = []): MissingDocument[] {
  if (!prior) return [];
  const unused = received.map((r) => ({ doc: r, used: false }));
  const pending: ExpectedDocument[] = [];
  for (const e of prior.documents) {
    const named = Boolean(e.issuer || e.issuerEin);
    if (!named) {
      if (!received.some((r) => r.formType === e.formType)) pending.push(e);
      continue;
    }
    const match = unused.find((u) => !u.used && u.doc.formType === e.formType && sameIssuer(u.doc, e));
    if (match) match.used = true;
    else pending.push(e);
  }
  // A received document that names no payer can be only one of them.
  const missing: ExpectedDocument[] = [];
  for (const e of pending) {
    const stand = (e.issuer || e.issuerEin) ? unused.find((u) => !u.used && u.doc.formType === e.formType && !u.doc.issuer && !u.doc.issuerEin) : undefined;
    if (stand) stand.used = true;
    else missing.push(e);
  }

  return missing.map((e): MissingDocument => {
    const lastYear = prior.fromTotals && TOTAL_OF[e.formType]
      ? `${prior.label} reported ${money(e.amount ?? 0)} of ${TOTAL_OF[e.formType]}, and no ${e.formType} is on the case`
      : `${prior.label} has one${e.amount !== undefined ? ` for ${money(e.amount)}` : ''}`;
    const answer = answers.find((a) => a.formType === e.formType && (e.issuer ? a.issuer !== undefined && sameIssuer(a, e) : !a.issuer));
    return {
      id: `missing:${e.formType}:${issuerKey(e)}`,
      formType: e.formType,
      ...(e.issuer ? { issuer: e.issuer } : {}),
      lastYear,
      status: !answer ? 'possibly_missing' : answer.received ? 'client_says_received' : 'client_says_none',
      ...(answer ? { answer } : {}),
    };
  });
}

/** "Possible missing 1099-INT from Chase" — never "missing". */
export function missingDocumentTitle(m: Pick<MissingDocument, 'formType' | 'issuer'>): string {
  return `Possible missing ${m.formType}${m.issuer ? ` from ${m.issuer}` : ''}`;
}
