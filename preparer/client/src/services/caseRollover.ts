/**
 * Start this year's case from last year's case for the same client (work
 * order §13, §14). What carries is classified the way §14 asks:
 *
 * - STATIC, carried: the taxpayer's and spouse's name, SSN, date of birth,
 *   occupation and address (a spouse who died is not carried).
 * - CARRY_FORWARD, carried only from an approved case — the return that was
 *   filed — and only where the engine gives the amount for next year: the
 *   capital loss carryover (Schedule D), the prior-year tax for Form 2210,
 *   the Form 8606 IRA basis, and the Form 5695 residential clean energy
 *   credit carryforward.
 * - REQUIRES_CURRENT_YEAR_CONFIRMATION: dependents (names, SSN, date of birth
 *   and relationship are recorded as evidence; nobody is on the return until
 *   the months at home this year are known), the filing status (a candidate
 *   the preparer puts on the return, and the client is asked), the refund
 *   account (on the return only when the preparer confirms it), full-year
 *   residency, and the address and name.
 * - DO_NOT_CARRY: amounts, documents, IP PINs, this year's elections.
 *
 * Carryovers the engine cannot carry by itself — they need this year's facts
 * on the item they belong to, or the engine does not give next year's amount
 * — are listed with last year's figures for the preparer to enter.
 */

import {
  calculateForm1040,
  FilingStatus,
  SUPPORTED_TAX_YEARS,
  type CalculationResult,
  type DirectDeposit,
  type TaxReturn,
} from '@hatax/engine';
import { canonicalRelationship } from '@hatax/local-ai';
import { createReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { appendAudit, loadReviewRecord, saveReviewRecord } from './caseAudit';
import { returnFingerprint } from './caseReview';
import { sameClient } from './missingDocuments';
import { priorYearSummaryFromReturn } from './priorYearSummary';
import { recordEvidence, type RecordSource } from './recordTools';

/** What a case started from last year's case carries, kept with its review record. */
export interface RolloverRecord {
  fromReturnId: string;
  fromYear: number;
  at: string;
  /** Last year's case was approved when this one started, so its carryovers were carried. */
  approved: boolean;
  /** Carried onto the return, for the record. */
  carried: string[];
  /** Carried, and to be confirmed with the client this year. */
  confirm: Array<{ id: string; text: string }>;
  /** Last year's carryovers the preparer enters where they apply this year. */
  manual: Array<{ id: string; text: string }>;
  /** Last year's refund account: on the return only when the preparer confirms it. */
  bank?: DirectDeposit;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const FILING_STATUS_CANDIDATE: Record<FilingStatus, string> = {
  [FilingStatus.Single]: 'single',
  [FilingStatus.MarriedFilingJointly]: 'married_filing_jointly',
  [FilingStatus.MarriedFilingSeparately]: 'married_filing_separately',
  [FilingStatus.HeadOfHousehold]: 'head_of_household',
  [FilingStatus.QualifyingSurvivingSpouse]: 'qualifying_surviving_spouse',
};

const TAXPAYER_FIELDS = ['firstName', 'middleInitial', 'lastName', 'suffix', 'ssn', 'ssnLastFour', 'dateOfBirth', 'occupation',
  'addressStreet', 'addressCity', 'addressState', 'addressZip'] as const;
const SPOUSE_FIELDS = ['spouseFirstName', 'spouseMiddleInitial', 'spouseLastName', 'spouseSuffix', 'spouseSsn', 'spouseSsnLastFour',
  'spouseDateOfBirth', 'spouseOccupation'] as const;

/** Last year's case was approved, and the return has not changed since. */
export function isApprovedCase(tr: TaxReturn): boolean {
  const approval = loadReviewRecord(tr.id).approval;
  return Boolean(approval && approval.returnFingerprint === returnFingerprint(tr));
}

/**
 * The year this case can start, when the app supports it and the client has no
 * case for it yet; otherwise null.
 */
export function nextYearToStart(tr: TaxReturn, all: readonly TaxReturn[] = listReturns()): number | null {
  const next = tr.taxYear + 1;
  if (!(SUPPORTED_TAX_YEARS as readonly number[]).includes(next)) return null;
  const hasIdentity = Boolean((tr.ssn ?? '').replace(/\D/g, '').length === 9 || (tr.firstName && tr.lastName && tr.dateOfBirth));
  if (!hasIdentity) return null;
  return all.some((r) => r.id !== tr.id && r.taxYear === next && sameClient(r, tr)) ? null : next;
}

function calculate(tr: TaxReturn): CalculationResult | null {
  try {
    return calculateForm1040({ ...tr, filingStatus: tr.filingStatus || FilingStatus.Single });
  } catch {
    return null;
  }
}

/** Identity and address, with the spouse unless the spouse died. */
function identityPatch(prior: TaxReturn): Partial<TaxReturn> {
  const patch: Partial<TaxReturn> = {};
  const set = (field: keyof TaxReturn) => {
    const value = prior[field];
    if (value !== undefined && value !== null && value !== '') (patch as Record<string, unknown>)[field] = value;
  };
  TAXPAYER_FIELDS.forEach(set);
  if (!prior.spouseDateOfDeath) SPOUSE_FIELDS.forEach(set);
  return patch;
}

/**
 * The carryovers an approved case gives next year, each where the engine
 * computes next year's amount: onto the return, or listed for the preparer.
 */
export function carryoversFrom(prior: TaxReturn, calc: CalculationResult): { patch: Partial<TaxReturn>; carried: string[]; manual: RolloverRecord['manual'] } {
  const patch: Partial<TaxReturn> = {};
  const carried: string[] = [];
  const manual: RolloverRecord['manual'] = [];
  const y = prior.taxYear;
  const f = calc.form1040;

  // Schedule D capital loss carryover. The Capital Loss Carryover Worksheet
  // adds back a negative taxable income, which the result does not keep (it
  // is floored at 0), and K-1 capital gains and losses are not netted in
  // Schedule D here: either way the carryover is the preparer's to figure.
  const st = calc.scheduleD?.capitalLossCarryforwardST ?? 0;
  const lt = calc.scheduleD?.capitalLossCarryforwardLT ?? 0;
  if (st > 0 || lt > 0) {
    const k1Capital = (prior.incomeK1 ?? []).some((k) => Boolean(k.shortTermCapitalGain || k.longTermCapitalGain));
    if (f.taxableIncome > 0 && !k1Capital) {
      if (st > 0) patch.capitalLossCarryforwardST = st;
      if (lt > 0) patch.capitalLossCarryforwardLT = lt;
      carried.push(`capital loss carryover ${[st > 0 ? `${money(st)} short-term` : '', lt > 0 ? `${money(lt)} long-term` : ''].filter(Boolean).join(', ')}`);
    } else {
      manual.push({ id: 'capital-loss', text: `Capital loss carryover: the ${y} Schedule D shows ${money(st)} short-term and ${money(lt)} long-term; ${f.taxableIncome > 0 ? 'the K-1 capital gains and losses' : 'a taxable income of zero or less'} can change it — figure it with the Capital Loss Carryover Worksheet.` });
    }
  }

  // Form 2210 line 8: the prior year's tax — tax after nonrefundable credits
  // plus other taxes, less refundable credits. Excess social security tax
  // withheld is a payment there (line 6), not a refundable credit.
  const excessSS = calc.credits?.excessSSTaxCredit ?? 0;
  if (f.taxAfterCredits > 0) {
    patch.priorYearTax = Math.round((f.taxAfterCredits + excessSS) * 100) / 100;
    carried.push(`${y} tax of ${money(patch.priorYearTax)} for the Form 2210 safe harbor`);
  }

  const basis = calc.form8606?.remainingBasis ?? 0;
  if (prior.form8606 && basis > 0) {
    patch.form8606 = { priorYearBasis: basis };
    carried.push(`nondeductible IRA basis ${money(basis)} (Form 8606 line 2)`);
  }

  const cleanEnergy = calc.cleanEnergy?.carryforwardToNextYear ?? 0;
  if (cleanEnergy > 0) {
    patch.cleanEnergy = { priorYearCarryforward: cleanEnergy };
    carried.push(`residential clean energy credit carryforward ${money(cleanEnergy)} (Form 5695)`);
  }

  // Carryovers that belong to something this year's return must hold first,
  // or whose next-year amount the engine does not give.
  const nol = Math.max(0, (prior.nolCarryforward ?? 0) - (f.nolDeduction ?? 0)) + (f.currentYearNOL ?? 0);
  if (nol > 0) manual.push({ id: 'nol', text: `Net operating loss: ${y} carried in ${money(prior.nolCarryforward ?? 0)}, deducted ${money(f.nolDeduction ?? 0)}, and had a new NOL of ${money(f.currentYearNOL ?? 0)}. Figure the carryover with the NOL worksheet and enter it.` });
  const priorCharitable = (prior.itemizedDeductions?.charitableCarryforward ?? []).reduce((s, c) => s + (c.amount || 0), 0);
  const newCharitable = calc.scheduleA?.charitableExcessCarryforward ?? 0;
  if (priorCharitable > 0 || newCharitable > 0) {
    const used = calc.scheduleA?.charitableCarryforwardUsed ?? 0;
    manual.push({ id: 'charitable', text: `Charitable contribution carryover: ${y}'s contributions over the AGI limits were ${money(newCharitable)}${priorCharitable > 0 ? `, and of ${money(priorCharitable)} carried in, ${money(used)} was used` : ''}${calc.scheduleA ? '' : ' (the standard deduction was taken)'}. Enter each year's remaining amount by category; carryovers expire after five years.` });
  }
  const home = calc.scheduleC?.homeOfficeResult;
  if ((home?.operatingExpenseCarryover ?? 0) > 0 || (home?.depreciationCarryover ?? 0) > 0) {
    manual.push({ id: 'home-office', text: `Form 8829 carryovers: operating expenses ${money(home?.operatingExpenseCarryover ?? 0)} (line 43) and depreciation ${money(home?.depreciationCarryover ?? 0)} (line 44). Enter them with this year's home office.` });
  }
  const s179 = calc.scheduleC?.form4562Result?.section179Carryforward ?? 0;
  if (s179 > 0) manual.push({ id: 'section-179', text: `Section 179 carryover of ${money(s179)} (Form 4562 line 13) — enter it on this year's Form 4562 line 10.` });
  const amtCredit = calc.form8801?.carryforwardToNextYear ?? 0;
  if (amtCredit > 0) manual.push({ id: 'form-8801', text: `Minimum tax credit carryforward of ${money(amtCredit)} (Form 8801) — enter it with this year's Form 8801.` });
  const adoption = calc.adoptionCredit?.carryforwardByYear ?? [];
  if (adoption.some((a) => a.amount > 0)) manual.push({ id: 'adoption', text: `Adoption credit carryforward: ${adoption.filter((a) => a.amount > 0).map((a) => `${money(a.amount)} from ${a.taxYear}`).join(', ')} (Form 8839).` });
  const investment = calc.investmentInterest?.carryforward ?? 0;
  if (investment > 0) manual.push({ id: 'investment-interest', text: `Investment interest carryforward of ${money(investment)} (Form 4952 line 7) — enter it on this year's Form 4952 line 2.` });
  for (const a of calc.form8582?.activities ?? []) {
    if (a.suspendedLoss > 0) manual.push({ id: `passive:${a.id}`, text: `Suspended passive loss of ${money(a.suspendedLoss)} for ${a.name || a.id} (Form 8582) — enter it on this year's matching rental or K-1.` });
  }
  const assets = (prior.depreciationAssets ?? []).filter((a) => !a.disposed);
  if (assets.length > 0) manual.push({ id: 'depreciation-assets', text: `${assets.length} depreciation asset${assets.length === 1 ? '' : 's'} on the ${y} Schedule C (${assets.map((a) => a.description || a.id).join(', ')}) — enter each with its depreciation through ${y}.` });
  if ((prior.section1231Lookback ?? []).length > 0 || calc.form4797) manual.push({ id: 'section-1231', text: `Section 1231 five-year lookback: add ${y}'s net section 1231 gain or loss to the lookback years.` });

  return { patch, carried, manual };
}

/** Record a prior-year case's dependents, filing status and full-year residency as evidence on the new case. */
function recordEvidenceFrom(returnId: string, prior: TaxReturn): string[] {
  const source: RecordSource = {
    documentId: `prior-year-case:${prior.taxYear}`,
    label: `${prior.taxYear} case`,
    kind: 'document',
    extractor: 'prior-year-case',
  };
  const recorded: string[] = [];
  prior.dependents.forEach((d, index) => {
    const r = recordEvidence(returnId, 'add_dependent', {
      firstName: d.firstName || undefined,
      lastName: d.lastName || undefined,
      ssn: d.ssn && /^\d{3}-?\d{2}-?\d{4}$/.test(d.ssn) ? d.ssn : undefined,
      ssnLastFour: !d.ssn && d.ssnLastFour ? d.ssnLastFour : undefined,
      dateOfBirth: d.dateOfBirth || undefined,
      relationship: canonicalRelationship(d.relationship),
      // A permanent disability carries; being a student is this year's fact.
      isDisabled: d.isDisabled === true ? true : undefined,
    }, { ...source, index, rawText: { firstName: d.firstName, lastName: d.lastName, relationship: d.relationship } });
    if (r.result.ok) recorded.push(`dependent ${[d.firstName, d.lastName].filter(Boolean).join(' ')}`);
  });
  if (prior.filingStatus) {
    const r = recordEvidence(returnId, 'set_filing_status_candidate', { status: FILING_STATUS_CANDIDATE[prior.filingStatus] }, { ...source, index: 100 });
    if (r.result.ok) recorded.push(`filing status ${FILING_STATUS_CANDIDATE[prior.filingStatus].replace(/_/g, ' ')}`);
  }
  (prior.stateReturns ?? []).filter((s) => s.residencyType === 'resident').forEach((s, i) => {
    const r = recordEvidence(returnId, 'set_state_residency', { stateCode: s.stateCode.toUpperCase(), residencyType: 'resident' }, { ...source, index: 200 + i });
    if (r.result.ok) recorded.push(`${s.stateCode.toUpperCase()} full-year residency`);
  });
  return recorded;
}

/**
 * Start next year's case from this one. Returns the new case; the review
 * record on it lists what was carried, what to confirm, and what to enter.
 */
export function startNextYear(priorId: string, now = new Date()): TaxReturn {
  const prior = getReturn(priorId);
  const year = nextYearToStart(prior);
  if (year === null) throw new Error(`A ${prior.taxYear + 1} case cannot be started from this case.`);
  const approved = isApprovedCase(prior);
  const calc = calculate(prior);

  const created = createReturn(year);
  const identity = identityPatch(prior);
  const carry = approved && calc ? carryoversFrom(prior, calc) : { patch: {}, carried: [], manual: [] };
  updateReturn(created.id, {
    ...identity,
    ...carry.patch,
    ...(calc && prior.filingStatus ? { priorYearSummary: priorYearSummaryFromReturn(prior, calc, 'hatax-case') } : {}),
  });

  const evidence = recordEvidenceFrom(created.id, prior);
  const spouse = Boolean(identity.spouseFirstName || identity.spouseSsn);
  const confirm: RolloverRecord['confirm'] = [{
    id: 'identity',
    text: `Name${spouse ? 's' : ''}, SSN${spouse ? 's' : ''} and address are carried from the ${prior.taxYear} case (${[prior.addressStreet, prior.addressCity, prior.addressState].filter(Boolean).join(', ') || 'no address'}). Confirm nothing changed.`,
  }];
  const record: RolloverRecord = {
    fromReturnId: prior.id,
    fromYear: prior.taxYear,
    at: now.toISOString(),
    approved,
    carried: [`name${spouse ? 's' : ''}, SSN${spouse ? 's' : ''} and address`, ...carry.carried, ...evidence],
    confirm,
    manual: carry.manual,
    ...(prior.directDeposit?.routingNumber && prior.directDeposit.accountNumber ? { bank: prior.directDeposit } : {}),
  };
  saveReviewRecord(created.id, { ...loadReviewRecord(created.id), rollover: record });
  appendAudit(created.id, { kind: 'decision', subject: `Started from the ${prior.taxYear} case`, detail: `carried ${record.carried.join('; ')}${approved ? '' : ' — carryovers not carried: that case is not approved'}` }, now);
  return getReturn(created.id);
}

/** Put last year's refund account on the return, once the preparer confirms it. */
export function applyLastYearsAccount(returnId: string): { ok: true } | { ok: false; error: string } {
  const record = loadReviewRecord(returnId);
  const bank = record.rollover?.bank;
  if (!bank) return { ok: false, error: "There is no account from last year's case." };
  updateReturn(returnId, { directDeposit: bank });
  appendAudit(returnId, { kind: 'decision', subject: 'Refund account', detail: `used the ${record.rollover!.fromYear} account (${bank.accountType} ending ${bank.accountNumber.slice(-4)})` });
  return { ok: true };
}
