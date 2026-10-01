/**
 * Return fields a preparer can fill straight from the review list: the
 * taxpayer's and spouse's name, SSN, address and filing status, and a
 * dependent's SSN — what the readiness check reports missing — and the one
 * fact an engine finding needs (the business miles from July 1 in a year whose
 * mileage rate changes, the date a home was first used for business). Each
 * value is validated before it is written; the case store audits the change.
 */

import { FilingStatus, type TaxReturn } from '@hatax/engine';

export type ReturnFieldKind = 'text' | 'tin' | 'zip' | 'state' | 'filing_status' | 'count' | 'date';

export interface ReturnFieldSpec {
  label: string;
  kind: ReturnFieldKind;
}

const FIELDS: Record<string, ReturnFieldSpec> = {
  firstName: { label: "Taxpayer's first name", kind: 'text' },
  lastName: { label: "Taxpayer's last name", kind: 'text' },
  ssn: { label: "Taxpayer's SSN or ITIN", kind: 'tin' },
  spouseFirstName: { label: "Spouse's first name", kind: 'text' },
  spouseLastName: { label: "Spouse's last name", kind: 'text' },
  spouseSsn: { label: "Spouse's SSN or ITIN", kind: 'tin' },
  addressStreet: { label: 'Street address', kind: 'text' },
  addressCity: { label: 'City', kind: 'text' },
  addressState: { label: 'State', kind: 'state' },
  addressZip: { label: 'ZIP code', kind: 'zip' },
  filingStatus: { label: 'Filing status', kind: 'filing_status' },
  'vehicle.businessMilesFromJuly1': { label: 'Business miles driven on or after July 1', kind: 'count' },
  'homeOffice.dateFirstUsedForBusiness': { label: 'Date the home was first used for business', kind: 'date' },
};

export const FILING_STATUS_OPTIONS: ReadonlyArray<{ value: FilingStatus; label: string }> = [
  { value: FilingStatus.Single, label: 'Single' },
  { value: FilingStatus.MarriedFilingJointly, label: 'Married filing jointly' },
  { value: FilingStatus.MarriedFilingSeparately, label: 'Married filing separately' },
  { value: FilingStatus.HeadOfHousehold, label: 'Head of household' },
  { value: FilingStatus.QualifyingSurvivingSpouse, label: 'Qualifying surviving spouse' },
];

const DEPENDENT_TIN = /^dependents\.(\d+)\.ssn$/;

/** How a field is asked for, or null when it is not one the review list fills. */
export function returnFieldSpec(path: string, taxReturn?: TaxReturn | null): ReturnFieldSpec | null {
  if (FIELDS[path]) return FIELDS[path]!;
  const dependent = DEPENDENT_TIN.exec(path);
  if (dependent) {
    const d = taxReturn?.dependents?.[Number(dependent[1])];
    const name = d ? [d.firstName, d.lastName].filter(Boolean).join(' ') : '';
    return { label: `${name || `Dependent ${Number(dependent[1]) + 1}`}'s SSN, ITIN or ATIN`, kind: 'tin' };
  }
  return null;
}

/**
 * The value to write for what the preparer typed, or an error. Blank is an
 * error, never an empty value written over the field.
 */
export function parseReturnField(kind: ReturnFieldKind, input: string): { ok: true; value: string | number | FilingStatus } | { ok: false; error: string } {
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
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime()) ? { ok: true, value: text } : { ok: false, error: 'Enter the date.' };
    case 'text':
      return { ok: true, value: text };
  }
}
