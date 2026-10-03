/**
 * Return fields a preparer can fill straight from the review list: the
 * taxpayer's and spouse's name, SSN, address and filing status, and a
 * dependent's SSN — what the readiness check reports missing — and the one
 * fact an engine finding needs (the business miles from July 1 in a year whose
 * mileage rate changes, the date a home was first used for business, the cash
 * a client who does not itemize gave to public charities from 2026, the kind of
 * a K-1 that reports unrecaptured section 1250 gain, whether Form 8615 applies
 * to a child and the parent's figures it takes). Each value is validated
 * before it is written; the case store audits the change.
 */

import { FilingStatus, type TaxReturn } from '@hatax/engine';

export type ReturnFieldKind = 'text' | 'tin' | 'zip' | 'state' | 'filing_status' | 'count' | 'date' | 'amount' | 'k1_entity' | 'yes_no';

export interface ReturnFieldSpec {
  label: string;
  kind: ReturnFieldKind;
}

const FIELDS: Record<string, ReturnFieldSpec> = {
  firstName: { label: "Taxpayer's first name", kind: 'text' },
  lastName: { label: "Taxpayer's last name", kind: 'text' },
  ssn: { label: "Taxpayer's SSN or ITIN", kind: 'tin' },
  dateOfBirth: { label: "Taxpayer's date of birth", kind: 'date' },
  spouseFirstName: { label: "Spouse's first name", kind: 'text' },
  spouseLastName: { label: "Spouse's last name", kind: 'text' },
  spouseSsn: { label: "Spouse's SSN or ITIN", kind: 'tin' },
  spouseDateOfBirth: { label: "Spouse's date of birth", kind: 'date' },
  addressStreet: { label: 'Street address', kind: 'text' },
  addressCity: { label: 'City', kind: 'text' },
  addressState: { label: 'State', kind: 'state' },
  addressZip: { label: 'ZIP code', kind: 'zip' },
  filingStatus: { label: 'Filing status', kind: 'filing_status' },
  'vehicle.businessMilesFromJuly1': { label: 'Business miles driven on or after July 1', kind: 'count' },
  'homeOffice.dateFirstUsedForBusiness': { label: 'Date the home was first used for business', kind: 'date' },
  nonItemizerCharitableCash: { label: 'Cash given to public charities', kind: 'amount' },
  'form8615.applies': { label: 'Does Form 8615 apply to this child?', kind: 'yes_no' },
  'form8615.parentName': { label: "Form 8615 line A: parent's name", kind: 'text' },
  'form8615.parentSsn': { label: "Form 8615 line B: parent's SSN", kind: 'tin' },
  'form8615.parentFilingStatus': { label: "Form 8615 line C: parent's filing status", kind: 'filing_status' },
  'form8615.parentTaxableIncome': { label: "Parent's taxable income (parent's Form 1040 line 15; 0 if zero or less)", kind: 'amount' },
  'form8615.parentTax': { label: "Parent's tax (parent's Form 1040 line 16, without Form 4972 or 8814 tax or education credit recapture)", kind: 'amount' },
  'form8615.parentQualifiedDividends': { label: "Parent's qualified dividends (parent's Form 1040 line 3a; 0 if none)", kind: 'amount' },
  'form8615.parentNetCapitalGain': { label: "Parent's net capital gain (0 if none)", kind: 'amount' },
  'form8615.otherChildrenNetUnearnedIncome': { label: "Line 5 of the parent's other children's Forms 8615, in total (0 if none)", kind: 'amount' },
  'form8615.otherChildrenQualifiedDividends': { label: "Qualified dividends included on the other children's line 5", kind: 'amount' },
  'form8615.otherChildrenNetCapitalGain': { label: "Net capital gain included on the other children's line 5", kind: 'amount' },
  'form8615.childDirectlyConnectedDeductions': { label: "The child's itemized deductions directly connected with the unearned income (0 if none)", kind: 'amount' },
  'form8615.parentSpecialComputation': { label: "Did the parent's tax use the Schedule D Tax Worksheet, Schedule J or the Foreign Earned Income Tax Worksheet (or does another child have 28% rate or unrecaptured section 1250 gain)?", kind: 'yes_no' },
};

export const YES_NO_OPTIONS: ReadonlyArray<{ value: 'yes' | 'no'; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export const FILING_STATUS_OPTIONS: ReadonlyArray<{ value: FilingStatus; label: string }> = [
  { value: FilingStatus.Single, label: 'Single' },
  { value: FilingStatus.MarriedFilingJointly, label: 'Married filing jointly' },
  { value: FilingStatus.MarriedFilingSeparately, label: 'Married filing separately' },
  { value: FilingStatus.HeadOfHousehold, label: 'Head of household' },
  { value: FilingStatus.QualifyingSurvivingSpouse, label: 'Qualifying surviving spouse' },
];

export const K1_ENTITY_OPTIONS: ReadonlyArray<{ value: 'partnership' | 's_corp' | 'estate' | 'trust'; label: string }> = [
  { value: 'partnership', label: 'Partnership (Form 1065)' },
  { value: 's_corp', label: 'S corporation (Form 1120-S)' },
  { value: 'estate', label: 'Estate (Form 1041)' },
  { value: 'trust', label: 'Trust (Form 1041)' },
];

const DEPENDENT_TIN = /^dependents\.(\d+)\.ssn$/;
const K1_ENTITY = /^incomeK1\.(\d+)\.entityType$/;

/** How a field is asked for, or null when it is not one the review list fills. */
export function returnFieldSpec(path: string, taxReturn?: TaxReturn | null): ReturnFieldSpec | null {
  if (FIELDS[path]) return FIELDS[path]!;
  const dependent = DEPENDENT_TIN.exec(path);
  if (dependent) {
    const d = taxReturn?.dependents?.[Number(dependent[1])];
    const name = d ? [d.firstName, d.lastName].filter(Boolean).join(' ') : '';
    return { label: `${name || `Dependent ${Number(dependent[1]) + 1}`}'s SSN, ITIN or ATIN`, kind: 'tin' };
  }
  const k1 = K1_ENTITY.exec(path);
  if (k1) {
    const name = taxReturn?.incomeK1?.[Number(k1[1])]?.entityName?.trim();
    return { label: `Kind of K-1${name ? ` (${name})` : ''}`, kind: 'k1_entity' };
  }
  return null;
}

/** Month/day/year as typed, or an ISO date, as YYYY-MM-DD. */
function isoDate(text: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const year = iso?.[1] ?? slash?.[3];
  const month = (iso?.[2] ?? slash?.[1])?.padStart(2, '0');
  const day = (iso?.[3] ?? slash?.[2])?.padStart(2, '0');
  if (!year || !month || !day) return undefined;
  const value = `${year}-${month}-${day}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) return undefined;
  return value;
}

/**
 * The value to write for what the preparer typed, or an error. Blank is an
 * error, never an empty value written over the field.
 */
export function parseReturnField(kind: ReturnFieldKind, input: string): { ok: true; value: string | number | boolean | FilingStatus } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Enter a value.' };
  switch (kind) {
    case 'tin': {
      const digits = text.replace(/[\s-]/g, '');
      return /^\d{9}$/.test(digits) ? { ok: true, value: digits } : { ok: false, error: 'An SSN, ITIN or ATIN is 9 digits.' };
    }
    case 'zip':
      return /^\d{5}(-?\d{4})?$/.test(text) ? { ok: true, value: text.replace(/^(\d{5})(\d{4})$/, '$1-$2') } : { ok: false, error: 'A ZIP code is 5 or 9 digits.' };
    case 'state':
      return /^[A-Z]{2}$/.test(text.toUpperCase()) ? { ok: true, value: text.toUpperCase() } : { ok: false, error: 'Choose the state.' };
    case 'filing_status': {
      const status = Number(text) as FilingStatus;
      return FILING_STATUS_OPTIONS.some((o) => o.value === status) ? { ok: true, value: status } : { ok: false, error: 'Choose the filing status.' };
    }
    case 'count':
      return /^\d{1,7}$/.test(text.replace(/,/g, '')) ? { ok: true, value: Number(text.replace(/,/g, '')) } : { ok: false, error: 'Enter a whole number.' };
    case 'yes_no':
      return text === 'yes' || text === 'no' ? { ok: true, value: text === 'yes' } : { ok: false, error: 'Choose yes or no.' };
    case 'k1_entity':
      return K1_ENTITY_OPTIONS.some((o) => o.value === text) ? { ok: true, value: text } : { ok: false, error: 'Choose the kind of K-1.' };
    case 'amount': {
      const amount = text.replace(/^\$/, '').replace(/,/g, '');
      return /^\d{1,9}(\.\d{1,2})?$/.test(amount) ? { ok: true, value: Number(amount) } : { ok: false, error: 'Enter a dollar amount.' };
    }
    case 'date': {
      const iso = isoDate(text);
      return iso ? { ok: true, value: iso } : { ok: false, error: 'Enter the date.' };
    }
    case 'text':
      return { ok: true, value: text };
  }
}
