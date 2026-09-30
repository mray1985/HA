/**
 * Record resolution: the facts the record tools wrote (dependents, estimated
 * payments, state residency), merged across every source into what the return
 * should hold — or into the reason it cannot hold it yet.
 *
 * Several sources can describe the same thing: a prior-year return names a
 * child, and the client's answer gives the months she lived at home. Records
 * are merged per person / per state; for each field the highest-authority
 * source wins (work order §60: structured import > document > preparer
 * correction > client response > AI inference). Two sources of equal
 * authority that disagree are a conflict, never a silent pick.
 *
 * Nothing here guesses: a field no source gives stays missing, and a record
 * missing what the engine requires is reported, not applied.
 */

import { formKeyOf, validateImportedFacts } from './factValidation.js';
import { compareSourceAuthority, type TaxFact, type TaxFactValue } from './taxFact.js';
import { factPrefixOf, RESIDENCY_TYPES } from './taxTools.js';

// ─── Source records and field merging ────────────────────────

/** One source's record: the facts one tool call wrote, by field. */
interface SourceRecord {
  formKey: string;
  fields: Map<string, TaxFact>;
}

function recordsOf(facts: readonly TaxFact[], prefix: string): SourceRecord[] {
  const byKey = new Map<string, SourceRecord>();
  for (const fact of facts) {
    if (!fact.factType.startsWith(prefix)) continue;
    const formKey = formKeyOf(fact);
    const record = byKey.get(formKey) ?? { formKey, fields: new Map<string, TaxFact>() };
    record.fields.set(fact.factType.slice(prefix.length), fact);
    byKey.set(formKey, record);
  }
  return [...byKey.values()];
}

function extracted(record: SourceRecord, field: string): TaxFactValue | undefined {
  const fact = record.fields.get(field);
  return fact?.status === 'extracted' ? fact.value : undefined;
}

export interface FieldConflict {
  field: string;
  /** The disagreeing values, each with the record it came from. */
  values: Array<{ value: TaxFactValue; formKey: string }>;
}

/**
 * Merge records field by field. The value from the highest-authority source
 * wins; equal-authority sources that disagree (after `sameValue`) conflict.
 */
function mergeFields(
  records: readonly SourceRecord[],
  sameValue: (field: string, a: TaxFactValue, b: TaxFactValue) => boolean = (_f, a, b) => JSON.stringify(a) === JSON.stringify(b),
): { values: Map<string, TaxFactValue>; conflicts: FieldConflict[] } {
  const values = new Map<string, TaxFactValue>();
  const conflicts: FieldConflict[] = [];
  const fieldNames = new Set(records.flatMap((r) => [...r.fields.keys()]));
  for (const field of fieldNames) {
    const candidates = records
      .map((r) => ({ fact: r.fields.get(field), formKey: r.formKey }))
      .filter((c): c is { fact: TaxFact & { status: 'extracted' }; formKey: string } => c.fact?.status === 'extracted');
    if (candidates.length === 0) continue;
    const best = candidates.reduce((top, c) => (compareSourceAuthority(c.fact, top.fact) < 0 ? c : top));
    const top = candidates.filter((c) => compareSourceAuthority(c.fact, best.fact) === 0);
    const distinct: Array<{ value: TaxFactValue; formKey: string }> = [];
    for (const c of top) {
      if (!distinct.some((d) => sameValue(field, d.value, c.fact.value))) distinct.push({ value: c.fact.value, formKey: c.formKey });
    }
    if (distinct.length > 1) conflicts.push({ field, values: distinct });
    else values.set(field, best.fact.value);
  }
  return { values, conflicts };
}

const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const digits = (text: string) => text.replace(/\D/g, '');

// ─── Dependents ──────────────────────────────────────────────

export interface DependentRecordFields {
  firstName?: string;
  lastName?: string;
  /** Full SSN / ITIN / ATIN, digits only. */
  ssn?: string;
  ssnLastFour?: string;
  relationship?: string;
  dateOfBirth?: string;
  monthsLivedWithYou?: number;
  isStudent?: boolean;
  isDisabled?: boolean;
}

/** Fields the engine requires before a dependent can be on the return. */
export const REQUIRED_DEPENDENT_FIELDS = ['firstName', 'lastName', 'relationship', 'monthsLivedWithYou'] as const;

export interface ResolvedDependent {
  /** Every record that describes this person, oldest first. The first is the person's key on the return. */
  formKeys: string[];
  fields: DependentRecordFields;
  /** Required fields no source gives yet. */
  missing: Array<(typeof REQUIRED_DEPENDENT_FIELDS)[number]>;
  conflicts: FieldConflict[];
  /** Other reasons the person cannot be on the return as recorded. */
  problems: string[];
  /** True when the person can be written to the return. */
  ready: boolean;
}

interface PersonIdentity {
  ssn?: string;
  lastFour?: string;
  name?: string;
  dateOfBirth?: string;
}

function identityOf(record: SourceRecord): PersonIdentity {
  const text = (field: string) => {
    const v = extracted(record, field);
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const ssn = text('ssn') ? digits(text('ssn')!) : undefined;
  const first = text('firstName');
  const last = text('lastName');
  return {
    ...(ssn ? { ssn } : {}),
    ...(ssn || text('ssnLastFour') ? { lastFour: ssn ? ssn.slice(-4) : text('ssnLastFour')! } : {}),
    ...(first && last ? { name: `${norm(first)}|${norm(last)}` } : {}),
    ...(text('dateOfBirth') ? { dateOfBirth: text('dateOfBirth')! } : {}),
  };
}

/** Same person: equal full SSNs; or, without two full SSNs, the same name with no contradicting SSN digits or birth date. */
function samePerson(a: PersonIdentity, b: PersonIdentity): boolean {
  if (a.ssn && b.ssn) return a.ssn === b.ssn;
  if (!a.name || a.name !== b.name) return false;
  if (a.lastFour && b.lastFour && a.lastFour !== b.lastFour) return false;
  if (a.dateOfBirth && b.dateOfBirth && a.dateOfBirth !== b.dateOfBirth) return false;
  return true;
}

function sameDependentValue(field: string, a: TaxFactValue, b: TaxFactValue): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    if (field === 'ssn') return digits(a) === digits(b);
    if (field === 'firstName' || field === 'lastName') return norm(a) === norm(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function resolveDependents(facts: readonly TaxFact[], taxYear: number): ResolvedDependent[] {
  const people: Array<{ identity: PersonIdentity; records: SourceRecord[] }> = [];
  for (const record of recordsOf(facts, factPrefixOf('add_dependent'))) {
    const identity = identityOf(record);
    const match = identity.ssn || identity.name ? people.find((p) => samePerson(p.identity, identity)) : undefined;
    if (match) {
      match.records.push(record);
      match.identity = {
        ...match.identity,
        ...Object.fromEntries(Object.entries(identity).filter(([k]) => !(k in match.identity))),
      };
    } else {
      people.push({ identity, records: [record] });
    }
  }

  return people.map(({ identity, records }) => {
    const { values, conflicts } = mergeFields(records, sameDependentValue);
    const str = (f: string) => (typeof values.get(f) === 'string' ? (values.get(f) as string).trim() : undefined);
    const bool = (f: string) => (typeof values.get(f) === 'boolean' ? (values.get(f) as boolean) : undefined);
    const ssn = str('ssn') ? digits(str('ssn')!) : undefined;
    const fields: DependentRecordFields = {
      ...(str('firstName') ? { firstName: str('firstName') } : {}),
      ...(str('lastName') ? { lastName: str('lastName') } : {}),
      ...(ssn ? { ssn } : {}),
      ...(ssn ? { ssnLastFour: ssn.slice(-4) } : str('ssnLastFour') ? { ssnLastFour: str('ssnLastFour') } : {}),
      ...(str('relationship') ? { relationship: str('relationship') } : {}),
      ...(str('dateOfBirth') ? { dateOfBirth: str('dateOfBirth') } : {}),
      ...(typeof values.get('monthsLivedWithYou') === 'number' ? { monthsLivedWithYou: values.get('monthsLivedWithYou') as number } : {}),
      ...(bool('isStudent') !== undefined ? { isStudent: bool('isStudent') } : {}),
      ...(bool('isDisabled') !== undefined ? { isDisabled: bool('isDisabled') } : {}),
    };

    const problems: string[] = [];
    if (!identity.ssn && !identity.name) problems.push('The evidence gives neither a full name nor an SSN, so the person cannot be identified.');
    if (ssn && str('ssnLastFour') && str('ssnLastFour') !== ssn.slice(-4)) {
      problems.push(`The SSN ends in ${ssn.slice(-4)} but another source gives the last four digits as ${str('ssnLastFour')}.`);
    }
    if (fields.dateOfBirth && fields.dateOfBirth > `${taxYear}-12-31`) {
      problems.push(`Born ${fields.dateOfBirth}, after the ${taxYear} tax year.`);
    }
    const missing = REQUIRED_DEPENDENT_FIELDS.filter((f) => fields[f] === undefined);
    return {
      formKeys: records.map((r) => r.formKey),
      fields,
      missing,
      conflicts,
      problems,
      ready: missing.length === 0 && conflicts.length === 0 && problems.length === 0,
    };
  });
}

/** "Maya Lee" / "the dependent ending 1234" — for messages. */
export function dependentLabel(d: Pick<ResolvedDependent, 'fields'>): string {
  const name = [d.fields.firstName, d.fields.lastName].filter(Boolean).join(' ');
  if (name) return name;
  return d.fields.ssnLastFour ? `the dependent with SSN ending ${d.fields.ssnLastFour}` : 'a dependent';
}

// ─── Estimated payments ──────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Third Monday of January (Martin Luther King Jr. Day). */
function mlkDay(year: number): string {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const firstMonday = 1 + ((8 - jan1) % 7);
  return iso(new Date(Date.UTC(year, 0, firstMonday + 14)));
}

/** DC Emancipation Day (April 16), as observed: Saturday → Friday, Sunday → Monday. */
function emancipationDay(year: number): string {
  const d = new Date(Date.UTC(year, 3, 16));
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(15);
  if (day === 0) d.setUTCDate(17);
  return iso(d);
}

/** IRC §7503: a due date on a Saturday, Sunday or legal holiday moves to the next business day. */
function nextBusinessDay(date: Date, holidays: ReadonlySet<string>): string {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(iso(d))) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

/** Form 1040-ES installment due dates for a tax year: April 15, June 15, September 15, January 15 (§6654(c)), moved per §7503. */
export function installmentDueDates(taxYear: number): [string, string, string, string] {
  const holidays = new Set([emancipationDay(taxYear), mlkDay(taxYear + 1)]);
  return [
    nextBusinessDay(new Date(Date.UTC(taxYear, 3, 15)), holidays),
    nextBusinessDay(new Date(Date.UTC(taxYear, 5, 15)), holidays),
    nextBusinessDay(new Date(Date.UTC(taxYear, 8, 15)), holidays),
    nextBusinessDay(new Date(Date.UTC(taxYear + 1, 0, 15)), holidays),
  ];
}

export interface EstimatedPaymentTotals {
  total: number;
  payments: number;
}

export interface ResolvedEstimatedPayments {
  /** Federal payments by installment, when every federal payment can be placed. */
  federal?: EstimatedPaymentTotals & { quarters: [number, number, number, number] };
  /** State payments by state code, for each state whose payments can all be counted. */
  states: Record<string, EstimatedPaymentTotals>;
  /** Payments that cannot be counted yet. Their jurisdiction's total is not written while any wait. */
  waiting: Array<{ formKey: string; jurisdiction?: string; reason: string }>;
  /** Payments for another tax year, left out. */
  excluded: Array<{ formKey: string; jurisdiction?: string; reason: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function resolveEstimatedPayments(facts: readonly TaxFact[], taxYear: number): ResolvedEstimatedPayments {
  const held = new Set(validateImportedFacts(facts.filter((f) => f.factType.startsWith(factPrefixOf('add_estimated_payment')))).heldForms);
  const due = installmentDueDates(taxYear);
  const waiting: ResolvedEstimatedPayments['waiting'] = [];
  const excluded: ResolvedEstimatedPayments['excluded'] = [];
  const placed: Array<{ jurisdiction: string; amount: number; quarter?: number }> = [];

  for (const record of recordsOf(facts, factPrefixOf('add_estimated_payment'))) {
    const jurisdiction = extracted(record, 'jurisdiction') as string | undefined;
    const amount = extracted(record, 'amount') as number | undefined;
    const statedYear = extracted(record, 'taxYear') as number | undefined;
    const datePaid = extracted(record, 'datePaid') as string | undefined;
    const installment = extracted(record, 'installment') as number | undefined;
    const overpayment = extracted(record, 'priorYearOverpaymentApplied') === true;
    const wait = (reason: string) => waiting.push({ formKey: record.formKey, ...(jurisdiction ? { jurisdiction } : {}), reason });

    if (held.has(record.formKey)) { wait('Validation holds this payment for review.'); continue; }
    if (jurisdiction === undefined || amount === undefined) { wait('The payment has no amount or no jurisdiction.'); continue; }

    if (statedYear !== undefined && statedYear !== taxYear) {
      excluded.push({ formKey: record.formKey, jurisdiction, reason: `The payment is for tax year ${statedYear}.` });
      continue;
    }
    if (statedYear === undefined && !overpayment) {
      if (!datePaid) { wait('The payment has no tax year and no date paid.'); continue; }
      if (datePaid < `${taxYear}-01-01`) {
        excluded.push({ formKey: record.formKey, jurisdiction, reason: `Paid ${datePaid}, before the ${taxYear} tax year.` });
        continue;
      }
      if (datePaid > due[3]) {
        wait(`Paid ${datePaid}, after the last ${taxYear} installment date (${due[3]}): record which tax year it was for.`);
        continue;
      }
    }

    let quarter: number | undefined;
    if (jurisdiction === 'federal') {
      if (installment !== undefined) quarter = installment;
      else if (overpayment) quarter = 1;
      else if (datePaid) quarter = datePaid <= due[0] ? 1 : datePaid <= due[1] ? 2 : datePaid <= due[2] ? 3 : 4;
      else { wait('The payment has no date paid or installment number, so its installment is unknown.'); continue; }
    }
    placed.push({ jurisdiction, amount, ...(quarter !== undefined ? { quarter } : {}) });
  }

  const waitingIn = new Set(waiting.map((w) => w.jurisdiction));
  const out: ResolvedEstimatedPayments = { states: {}, waiting, excluded };

  const federal = placed.filter((p) => p.jurisdiction === 'federal');
  if (federal.length > 0 && !waitingIn.has('federal') && !waitingIn.has(undefined)) {
    const quarters: [number, number, number, number] = [0, 0, 0, 0];
    for (const p of federal) quarters[p.quarter! - 1] = round2(quarters[p.quarter! - 1]! + p.amount);
    out.federal = { quarters, total: round2(quarters.reduce((a, b) => a + b, 0)), payments: federal.length };
  }
  for (const p of placed) {
    if (p.jurisdiction === 'federal' || waitingIn.has(p.jurisdiction) || waitingIn.has(undefined)) continue;
    const s = out.states[p.jurisdiction] ?? { total: 0, payments: 0 };
    out.states[p.jurisdiction] = { total: round2(s.total + p.amount), payments: s.payments + 1 };
  }
  return out;
}

// ─── State residency ─────────────────────────────────────────

export type ResidencyType = (typeof RESIDENCY_TYPES)[number];

export interface ResolvedStateResidency {
  stateCode: string;
  formKeys: string[];
  residencyType?: ResidencyType;
  daysLivedInState?: number;
  conflicts: FieldConflict[];
  problems: string[];
  ready: boolean;
}

export function resolveStateResidency(facts: readonly TaxFact[]): ResolvedStateResidency[] {
  const byState = new Map<string, SourceRecord[]>();
  for (const record of recordsOf(facts, factPrefixOf('set_state_residency'))) {
    const code = extracted(record, 'stateCode');
    if (typeof code !== 'string') continue;
    byState.set(code.toUpperCase(), [...(byState.get(code.toUpperCase()) ?? []), record]);
  }

  const states = [...byState].map(([stateCode, records]): ResolvedStateResidency => {
    const { values, conflicts } = mergeFields(records);
    const residencyType = values.get('residencyType') as ResidencyType | undefined;
    const days = values.get('daysLivedInState') as number | undefined;
    const problems: string[] = [];
    if (!residencyType && !conflicts.some((c) => c.field === 'residencyType')) problems.push('The evidence does not say whether the taxpayer was a resident, part-year resident or nonresident.');
    // The engine allocates part-year income by days in the state; unknown days would allocate nothing.
    if (residencyType === 'part_year' && days === undefined) problems.push('Part-year residency needs the number of days lived in the state.');
    return {
      stateCode,
      formKeys: records.map((r) => r.formKey),
      ...(residencyType ? { residencyType } : {}),
      ...(residencyType === 'part_year' && days !== undefined ? { daysLivedInState: days } : {}),
      conflicts,
      problems,
      ready: false,
    };
  });

  const fullYear = states.filter((s) => s.residencyType === 'resident');
  if (fullYear.length > 1) {
    const codes = fullYear.map((s) => s.stateCode).join(' and ');
    for (const s of fullYear) s.problems.push(`The evidence makes the taxpayer a full-year resident of both ${codes}.`);
  }
  for (const s of states) s.ready = s.problems.length === 0 && s.conflicts.length === 0;
  return states;
}
