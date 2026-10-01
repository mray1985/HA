/**
 * California State Tax Constants — Tax Years 2025 and 2026
 * (2026: the amounts the FTB has published so far; see the end of this file)
 *
 * Sources:
 *   - CA Revenue & Taxation Code §17041 — California income tax rates
 *   - CA Revenue & Taxation Code §17043 — Mental Health Services Tax (Prop 63)
 *   - FTB Publication 1031 — Guidelines for Determining Resident Status
 *   - FTB Form 540 — California Resident Income Tax Return
 */

import { StateTaxBracket } from '../../types/index.js';
import { CA_EITC_TABLE_2025 } from './caEitc2025.js';

// ─── CA Income Tax Brackets (2025) ──────────────────────────────
// 9 progressive brackets per filing status

export const CA_BRACKETS: Record<string, StateTaxBracket[]> = {
  single: [
    { min: 0,       max: 11079,   rate: 0.01 },
    { min: 11079,   max: 26264,   rate: 0.02 },
    { min: 26264,   max: 41452,   rate: 0.04 },
    { min: 41452,   max: 57542,   rate: 0.06 },
    { min: 57542,   max: 72724,   rate: 0.08 },
    { min: 72724,   max: 371479,  rate: 0.093 },
    { min: 371479,  max: 445771,  rate: 0.103 },
    { min: 445771,  max: 742953,  rate: 0.113 },
    { min: 742953,  max: Infinity, rate: 0.123 },
  ],
  married_joint: [
    { min: 0,       max: 22158,   rate: 0.01 },
    { min: 22158,   max: 52528,   rate: 0.02 },
    { min: 52528,   max: 82904,   rate: 0.04 },
    { min: 82904,   max: 115084,  rate: 0.06 },
    { min: 115084,  max: 145448,  rate: 0.08 },
    { min: 145448,  max: 742958,  rate: 0.093 },
    { min: 742958,  max: 891542,  rate: 0.103 },
    { min: 891542,  max: 1485906, rate: 0.113 },
    { min: 1485906, max: Infinity, rate: 0.123 },
  ],
  married_separate: [
    { min: 0,       max: 11079,   rate: 0.01 },
    { min: 11079,   max: 26264,   rate: 0.02 },
    { min: 26264,   max: 41452,   rate: 0.04 },
    { min: 41452,   max: 57542,   rate: 0.06 },
    { min: 57542,   max: 72724,   rate: 0.08 },
    { min: 72724,   max: 371479,  rate: 0.093 },
    { min: 371479,  max: 445771,  rate: 0.103 },
    { min: 445771,  max: 742953,  rate: 0.113 },
    { min: 742953,  max: Infinity, rate: 0.123 },
  ],
  head_of_household: [
    { min: 0,       max: 22173,   rate: 0.01 },
    { min: 22173,   max: 52530,   rate: 0.02 },
    { min: 52530,   max: 67716,   rate: 0.04 },
    { min: 67716,   max: 83805,   rate: 0.06 },
    { min: 83805,   max: 98990,   rate: 0.08 },
    { min: 98990,   max: 505208,  rate: 0.093 },
    { min: 505208,  max: 606251,  rate: 0.103 },
    { min: 606251,  max: 1010417, rate: 0.113 },
    { min: 1010417, max: Infinity, rate: 0.123 },
  ],
};

// ─── CA Standard Deduction (2025) ───────────────────────────────
export const CA_STANDARD_DEDUCTION: Record<string, number> = {
  single: 5706,
  married_joint: 11412,
  married_separate: 5706,
  head_of_household: 11412,
};

// ─── CA Exemption Credits (2025) ────────────────────────────────
// California uses exemption *credits* (reduce tax, not income). Form 540
// lines 7–9: one amount for each personal, blind and senior exemption
// (R&TC §17054(a), (b), (c), (e): the same indexed base); line 10: each dependent.
export const CA_EXEMPTION_CREDIT = 153;
export const CA_DEPENDENT_EXEMPTION_CREDIT = 475;  // Per dependent

// ─── Mental Health Services Tax (MHST) — Proposition 63 ────────
// Additional 1% on taxable income over $1,000,000
export const CA_MHST_THRESHOLD = 1000000;
export const CA_MHST_RATE = 0.01;

// ─── CA Depreciation Conformity (Schedule CA) ───────────────────
// CA does not conform to IRC §168(k) bonus depreciation.
// CA Section 179 limit is $25,000 (R&TC §17255) vs federal $1.25M.
// CA §179 investment threshold (begins phaseout): $200,000.
export const CA_SECTION_179_LIMIT = 25000;
export const CA_SECTION_179_THRESHOLD = 200000;

// ─── CA Itemized Deduction Limits ────────────────────────────────
// CA mortgage interest deduction limit (pre-TCJA $1M, not the federal $750K TCJA limit)
// MFS limit is half: $500K. R&TC §17220.
export const CA_MORTGAGE_LIMIT: Record<string, number> = {
  single: 1000000,
  married_joint: 1000000,
  married_separate: 500000,
  head_of_household: 1000000,
};

// ─── CA Itemized Deduction Limitation (Pease-Style Phase-Out) ────
// CA retains its own high-income itemized deduction limitation.
// Source: FTB Form 540 Instructions, Schedule CA (540) instructions
export const CA_ITEMIZED_DEDUCTION_LIMITATION_THRESHOLD: Record<string, number> = {
  single: 252203,
  married_joint: 504411,
  married_separate: 252203,
  head_of_household: 378310,
};
export const CA_ITEMIZED_LIMITATION_RATE = 0.06;           // 6% of AGI excess over threshold
export const CA_ITEMIZED_LIMITATION_MAX_REDUCTION = 0.80;  // Never remove more than 80% of subject deductions

// ─── CA Exemption Credit Phase-Out (AGI Limitation Worksheet) ────
// Source: FTB Form 540 Instructions, Line 32 (page 14)
// Reduces exemption credits by $6 per $2,500 ($1,250 MFS) of AGI excess.
// Uses the same AGI thresholds as the itemized deduction limitation.
export const CA_EXEMPTION_PHASEOUT_REDUCTION_PER_STEP = 6;    // $6 reduction per step
export const CA_EXEMPTION_PHASEOUT_STEP: Record<string, number> = {
  single: 2500,
  married_joint: 2500,
  married_separate: 1250,
  head_of_household: 2500,
};

// ─── CalEITC — FTB 3514 (2025) ──────────────────────────────────
// Source: FTB 3514 instructions (2025). The credit is the EITC Table's amount
// for California earned income; when federal AGI differs and is at least the
// worksheet's Part II amount, the smaller of that and the table's amount for
// federal AGI. Earned income and federal AGI must be $32,900 or less;
// investment income $4,814 or less (Worksheet 1).
export interface CalEitcTables {
  /** Credit by $50 row (row k: $50k + 1 to $50(k + 1)), for 0, 1, 2, 3+ qualifying children. */
  table: ReadonlyArray<readonly [number, number, number, number]>;
  /** Earned income and federal AGI limit. */
  limit: number;
  /** Worksheet Part II: federal AGI from which its own table amount also applies, by qualifying children. */
  agiTestStart: readonly [number, number, number, number];
  investmentIncomeLimit: number;
}
export const CA_EITC_2025: CalEitcTables = {
  table: CA_EITC_TABLE_2025,
  limit: 32900,
  agiTestStart: [4661, 6998, 9823, 9823],
  investmentIncomeLimit: 4814,
};

// ─── Young Child Tax Credit (YCTC) — FTB 3514 Part VII (2025) ───
// One credit per return (line 24), reduced by $21.71 for each $100 of earned
// income over $27,425 (lines 25–28). With earned income of zero or less: no
// total net loss or total wages over $35,640 (line 23a, 23b).
export interface YctcTables {
  credit: number;
  phaseOutStart: number;
  reductionPer100: number;
  netLossLimit: number;
  wagesLimit: number;
}
export const CA_YCTC_2025: YctcTables = {
  credit: 1189,
  phaseOutStart: 27425,
  reductionPer100: 21.71,
  netLossLimit: 35640,
  wagesLimit: 35640,
};

// ─── CA Renter's Credit ──────────────────────────────────────────
// Source: FTB Form 540 Instructions, Line 46
// Nonrefundable credit for qualifying renters with CA AGI below threshold.
export const CA_RENTERS_CREDIT: Record<string, { credit: number; agiLimit: number }> = {
  single: { credit: 60, agiLimit: 53994 },
  married_joint: { credit: 120, agiLimit: 107988 },
  married_separate: { credit: 60, agiLimit: 53994 },
  head_of_household: { credit: 120, agiLimit: 107988 },
};

// ─── CA Dependent Care Credit (Form 3506) ────────────────────────
// Source: FTB Form 3506 Instructions
// CA has its own dependent care credit separate from federal.
// Rates keyed by CA AGI range.
export const CA_DEPENDENT_CARE_TABLE: { maxAGI: number; rate: number }[] = [
  { maxAGI: 40000,  rate: 0.50 },
  { maxAGI: 70000,  rate: 0.43 },
  { maxAGI: 100000, rate: 0.34 },
  // Over $100K → 0% (no credit)
];
export const CA_DEPENDENT_CARE_EXPENSE_LIMIT_1 = 3000;  // 1 qualifying person
export const CA_DEPENDENT_CARE_EXPENSE_LIMIT_2 = 6000;  // 2+ qualifying persons

// ─── CA Senior Head of Household Credit (code 163) ───────────────
// Source: 2025 Form 540 instructions, Special Credits: 65 or older by
// December 31; qualified as head of household in either of the two prior years
// by providing a household for a qualifying individual who died during one of
// them; AGI not over $98,652. 2% of taxable income (line 19), at most $1,860.
// This year's filing status does not matter.
export const CA_SENIOR_HOH_CREDIT = 1860;
export const CA_SENIOR_HOH_CREDIT_RATE = 0.02;
export const CA_SENIOR_HOH_AGI_LIMIT = 98652;
export const CA_SENIOR_HOH_MIN_AGE = 65;

// ─── CA Dependent Parent Credit (code 173) ───────────────────────
// Source: 2025 Form 540 instructions, Special Credits: married/RDP filing
// separately; the spouse/RDP not a member of the household for the last six
// months of the year; more than half the household expenses of a dependent
// mother's or father's home paid. One credit per return: 30% of Form 540
// line 35, at most $610.
export const CA_DEPENDENT_PARENT_CREDIT_RATE = 0.30;
export const CA_DEPENDENT_PARENT_CREDIT_MAX = 610;

// ─── CA SDI (State Disability Insurance) ────────────────────────
// Note: CA SDI is a payroll tax, not an income tax. It is withheld
// by employers and does not appear on the CA 540 return.
// Rate: 1.1% (2025) on all wages (no wage cap as of 2024+).
// Included here for reference/informational purposes only.
export const CA_SDI_RATE = 0.011;

// ═══ Tax Year 2026 ═══════════════════════════════════════════════
// Source: FTB Tax News, October 2026, "2026 Indexing": the CCPI change from
// June 2025 to June 2026 is 3.4%; standard deduction, personal, senior and
// dependent exemption credits, renter's credit AGI limits and the rate
// schedules X, Y and Z. (Schedule Y's fifth row prints "the amount over
// 118,966"; the row starts at $118,996, twice Schedule X's $59,498, and its
// base tax $4,109.92 is figured from $118,996.)
// The FTB publishes the other 2026 amounts in late December: the AGI threshold
// of the exemption credit phase-out and itemized deduction limitation,
// CalEITC, YCTC, and the senior head of household and dependent parent credits.
// Until then they are left out, and a return they can affect is held
// (engine/state/ca.ts `assessCalifornia`).

export const CA_CCPI_CHANGE_2026 = 0.034;

export const CA_BRACKETS_2026: Record<string, StateTaxBracket[]> = {
  single: [
    { min: 0,       max: 11456,   rate: 0.01 },
    { min: 11456,   max: 27157,   rate: 0.02 },
    { min: 27157,   max: 42861,   rate: 0.04 },
    { min: 42861,   max: 59498,   rate: 0.06 },
    { min: 59498,   max: 75197,   rate: 0.08 },
    { min: 75197,   max: 384109,  rate: 0.093 },
    { min: 384109,  max: 460927,  rate: 0.103 },
    { min: 460927,  max: 768213,  rate: 0.113 },
    { min: 768213,  max: Infinity, rate: 0.123 },
  ],
  married_joint: [
    { min: 0,       max: 22912,   rate: 0.01 },
    { min: 22912,   max: 54314,   rate: 0.02 },
    { min: 54314,   max: 85722,   rate: 0.04 },
    { min: 85722,   max: 118996,  rate: 0.06 },
    { min: 118996,  max: 150394,  rate: 0.08 },
    { min: 150394,  max: 768218,  rate: 0.093 },
    { min: 768218,  max: 921854,  rate: 0.103 },
    { min: 921854,  max: 1536426, rate: 0.113 },
    { min: 1536426, max: Infinity, rate: 0.123 },
  ],
  married_separate: [
    { min: 0,       max: 11456,   rate: 0.01 },
    { min: 11456,   max: 27157,   rate: 0.02 },
    { min: 27157,   max: 42861,   rate: 0.04 },
    { min: 42861,   max: 59498,   rate: 0.06 },
    { min: 59498,   max: 75197,   rate: 0.08 },
    { min: 75197,   max: 384109,  rate: 0.093 },
    { min: 384109,  max: 460927,  rate: 0.103 },
    { min: 460927,  max: 768213,  rate: 0.113 },
    { min: 768213,  max: Infinity, rate: 0.123 },
  ],
  head_of_household: [
    { min: 0,       max: 22927,   rate: 0.01 },
    { min: 22927,   max: 54316,   rate: 0.02 },
    { min: 54316,   max: 70018,   rate: 0.04 },
    { min: 70018,   max: 86654,   rate: 0.06 },
    { min: 86654,   max: 102356,  rate: 0.08 },
    { min: 102356,  max: 522385,  rate: 0.093 },
    { min: 522385,  max: 626864,  rate: 0.103 },
    { min: 626864,  max: 1044771, rate: 0.113 },
    { min: 1044771, max: Infinity, rate: 0.123 },
  ],
};

export const CA_STANDARD_DEDUCTION_2026: Record<string, number> = {
  single: 5900,
  married_joint: 11800,
  married_separate: 5900,
  head_of_household: 11800,
};

// Personal, blind and senior exemption credit, each ($158; $316 for the two
// personal or senior credits of a joint return).
export const CA_EXEMPTION_CREDIT_2026 = 158;

export const CA_DEPENDENT_EXEMPTION_CREDIT_2026 = 491;

// Renter's credit: $60 / $120 (R&TC §17053.5); the AGI limits are indexed.
export const CA_RENTERS_CREDIT_2026: Record<string, { credit: number; agiLimit: number }> = {
  single: { credit: 60, agiLimit: 55830 },
  married_joint: { credit: 120, agiLimit: 111660 },
  married_separate: { credit: 60, agiLimit: 55830 },
  head_of_household: { credit: 120, agiLimit: 111660 },
};

// ─── Per-year tables ─────────────────────────────────────────────

/** The amounts the calculator uses for a tax year. One the FTB has not published for the year is undefined. */
export interface CaliforniaYearTables {
  taxYear: number;
  brackets: Record<string, StateTaxBracket[]>;
  standardDeduction: Record<string, number>;
  /** Each personal, blind and senior exemption credit (Form 540 lines 7–9). */
  exemptionCredit: number;
  dependentExemptionCredit: number;
  rentersCredit: Record<string, { credit: number; agiLimit: number }>;
  /** The CCPI change the year's amounts were recomputed by (R&TC §17041(h)). */
  ccpiChange?: number;
  /** AGI threshold of the exemption credit phase-out and the itemized deduction limitation. */
  agiLimitationThreshold?: Record<string, number>;
  calEitc?: CalEitcTables;
  yctc?: YctcTables;
  seniorHoH?: { credit: number; agiLimit: number };
  /** The dependent parent credit's maximum. */
  dependentParentMax?: number;
}

const CA_TABLES_2025: CaliforniaYearTables = {
  taxYear: 2025,
  brackets: CA_BRACKETS,
  standardDeduction: CA_STANDARD_DEDUCTION,
  exemptionCredit: CA_EXEMPTION_CREDIT,
  dependentExemptionCredit: CA_DEPENDENT_EXEMPTION_CREDIT,
  rentersCredit: CA_RENTERS_CREDIT,
  agiLimitationThreshold: CA_ITEMIZED_DEDUCTION_LIMITATION_THRESHOLD,
  calEitc: CA_EITC_2025,
  yctc: CA_YCTC_2025,
  seniorHoH: { credit: CA_SENIOR_HOH_CREDIT, agiLimit: CA_SENIOR_HOH_AGI_LIMIT },
  dependentParentMax: CA_DEPENDENT_PARENT_CREDIT_MAX,
};

const CA_TABLES_2026: CaliforniaYearTables = {
  taxYear: 2026,
  brackets: CA_BRACKETS_2026,
  standardDeduction: CA_STANDARD_DEDUCTION_2026,
  exemptionCredit: CA_EXEMPTION_CREDIT_2026,
  dependentExemptionCredit: CA_DEPENDENT_EXEMPTION_CREDIT_2026,
  rentersCredit: CA_RENTERS_CREDIT_2026,
  ccpiChange: CA_CCPI_CHANGE_2026,
};

/** The year's tables, or undefined for a year HATax has no California amounts for. */
export function californiaTables(taxYear: number): CaliforniaYearTables | undefined {
  return taxYear === 2025 ? CA_TABLES_2025 : taxYear === 2026 ? CA_TABLES_2026 : undefined;
}
