import { FilingStatus, TaxBracket } from '../types/index.js';

// ──────────────────────────────────────────────────
// 2026 Federal Tax Brackets
// Authority: IRC §1(a)-(d), (j) — Tax imposed; TCJA §11001 — Rate structure
// Constants: Rev. Proc. 2025-32, Section 3.01, Table 1 — Taxable income brackets
// ──────────────────────────────────────────────────

export const TAX_BRACKETS_2025: Record<FilingStatus, TaxBracket[]> = {
  [FilingStatus.Single]: [
    { min: 0, max: 12400, rate: 0.10 },
    { min: 12400, max: 50400, rate: 0.12 },
    { min: 50400, max: 105700, rate: 0.22 },
    { min: 105700, max: 201775, rate: 0.24 },
    { min: 201775, max: 256225, rate: 0.32 },
    { min: 256225, max: 640600, rate: 0.35 },
    { min: 640600, max: Infinity, rate: 0.37 },
  ],
  [FilingStatus.MarriedFilingJointly]: [
    { min: 0, max: 24800, rate: 0.10 },
    { min: 24800, max: 100800, rate: 0.12 },
    { min: 100800, max: 211400, rate: 0.22 },
    { min: 211400, max: 403550, rate: 0.24 },
    { min: 403550, max: 512450, rate: 0.32 },
    { min: 512450, max: 768700, rate: 0.35 },
    { min: 768700, max: Infinity, rate: 0.37 },
  ],
  [FilingStatus.MarriedFilingSeparately]: [
    { min: 0, max: 12400, rate: 0.10 },
    { min: 12400, max: 50400, rate: 0.12 },
    { min: 50400, max: 105700, rate: 0.22 },
    { min: 105700, max: 201775, rate: 0.24 },
    { min: 201775, max: 256225, rate: 0.32 },
    { min: 256225, max: 384350, rate: 0.35 },
    { min: 384350, max: Infinity, rate: 0.37 },
  ],
  [FilingStatus.HeadOfHousehold]: [
    { min: 0, max: 17700, rate: 0.10 },
    { min: 17700, max: 67450, rate: 0.12 },
    { min: 67450, max: 105700, rate: 0.22 },
    { min: 105700, max: 201775, rate: 0.24 },
    { min: 201775, max: 256200, rate: 0.32 },
    { min: 256200, max: 640600, rate: 0.35 },
    { min: 640600, max: Infinity, rate: 0.37 },
  ],
  [FilingStatus.QualifyingSurvivingSpouse]: [
    { min: 0, max: 24800, rate: 0.10 },
    { min: 24800, max: 100800, rate: 0.12 },
    { min: 100800, max: 211400, rate: 0.22 },
    { min: 211400, max: 403550, rate: 0.24 },
    { min: 403550, max: 512450, rate: 0.32 },
    { min: 512450, max: 768700, rate: 0.35 },
    { min: 768700, max: Infinity, rate: 0.37 },
  ],
};

// ──────────────────────────────────────────────────
// Standard Deduction
// Authority: IRC §63(c) — Standard deduction defined; TCJA §11021 — Increased amounts
// Constants: Rev. Proc. 2025-32, Section 3.02, Table 5 — Standard deduction amounts
// ──────────────────────────────────────────────────

export const STANDARD_DEDUCTION_2025: Record<FilingStatus, number> = {
  [FilingStatus.Single]: 16100,
  [FilingStatus.MarriedFilingJointly]: 32200,
  [FilingStatus.MarriedFilingSeparately]: 16100,
  [FilingStatus.HeadOfHousehold]: 24150,
  [FilingStatus.QualifyingSurvivingSpouse]: 32200,
};

// Additional standard deduction for age 65+ and/or blind
// Authority: IRC §63(f) — Additional amounts for aged/blind
// Constants: Rev. Proc. 2025-32, Section 3.02
export const ADDITIONAL_STANDARD_DEDUCTION = {
  UNMARRIED: 2050,
  MARRIED: 1650,
};

// Dependent standard deduction (reduced amount for filers claimed as dependents)
// Authority: IRC §63(c)(5) — Limitation on standard deduction for dependents
// Constants: Rev. Proc. 2025-32, Section 3.02
export const DEPENDENT_STANDARD_DEDUCTION = {
  MIN_AMOUNT: 1400,
  EARNED_INCOME_PLUS: 450,
};

// ──────────────────────────────────────────────────
// Self-Employment Tax
// Authority: IRC §1401(a) — SS rate on SE income; IRC §1401(b) — Medicare rate
//           IRC §1402(a) — Definition of net earnings from SE
//           IRC §3101(b)(2) — Additional Medicare Tax (0.9%)
// Constants: SSA COLA announcement — SS wage base for 2026
// ──────────────────────────────────────────────────

export const SE_TAX = {
  RATE: 0.153,
  SS_RATE: 0.124,
  MEDICARE_RATE: 0.029,
  SS_WAGE_BASE: 184500,
  NET_EARNINGS_FACTOR: 0.9235,
  ADDITIONAL_MEDICARE_RATE: 0.009,
  ADDITIONAL_MEDICARE_THRESHOLD_SINGLE: 200000,
  ADDITIONAL_MEDICARE_THRESHOLD_MFJ: 250000,
  ADDITIONAL_MEDICARE_THRESHOLD_MFS: 125000,
  MINIMUM_EARNINGS_THRESHOLD: 400,
  FARM_OPTIONAL_METHOD_MAX: 7500,
};

// ──────────────────────────────────────────────────
// Qualified Business Income (QBI) Deduction
// Authority: IRC §199A — Qualified business income deduction (20%); TCJA §11011
// Constants: Rev. Proc. 2025-32, Section 3.29 — Threshold amounts
// ──────────────────────────────────────────────────

export const QBI = {
  RATE: 0.20,
  THRESHOLD_SINGLE: 201775,
  THRESHOLD_MFJ: 403500,
  PHASE_IN_RANGE_SINGLE: 75000,
  PHASE_IN_RANGE_MFJ: 150000,
};

// ──────────────────────────────────────────────────
// Home Office
// Authority: IRC §280A(c) — Home office deduction requirements
// Constants: Rev. Proc. 2013-13 — Simplified method ($5/sq ft, max 300 sq ft)
// ──────────────────────────────────────────────────

export const HOME_OFFICE = {
  SIMPLIFIED_RATE: 5,
  SIMPLIFIED_MAX_SQFT: 300,
  SIMPLIFIED_MAX_DEDUCTION: 1500,
};

// ──────────────────────────────────────────────────
// Home Office Depreciation (MACRS — Residential Property)
// Authority: IRC §168 — Accelerated cost recovery system
// Constants: IRS Pub 946, Table A-6 — Residential Rental Property (27.5-year)
// Mid-month convention per IRC §168(d)(2)
// ──────────────────────────────────────────────────

export const HOME_OFFICE_DEPRECIATION = {
  RECOVERY_YEARS: 27.5,

  FIRST_YEAR_RATE_BY_MONTH: {
    1:  0.03485,
    2:  0.03182,
    3:  0.02879,
    4:  0.02576,
    5:  0.02273,
    6:  0.01970,
    7:  0.01667,
    8:  0.01364,
    9:  0.01061,
    10: 0.00758,
    11: 0.00455,
    12: 0.00152,
  } as Record<number, number>,

  SUBSEQUENT_YEAR_RATE: 0.03636,
};

// ──────────────────────────────────────────────────
// Vehicle / Standard Mileage
// Authority: IRC §162 — Business expenses; IRC §274(d) — Substantiation requirements
// Constants: IRS Notice — Standard mileage rate for 2026
// ──────────────────────────────────────────────────

export const VEHICLE = {
  STANDARD_MILEAGE_RATE: 0.71,
};

// ──────────────────────────────────────────────────
// Vehicle Depreciation (MACRS 5-Year / Section 280F)
// Authority: IRC §168 — MACRS; IRC §280F — Luxury vehicle limits
//           IRC §168(k) — Bonus depreciation (100% restored by OBBBA)
// Constants: Rev. Proc. 2025-32 — Section 280F dollar amounts for 2026
// ──────────────────────────────────────────────────

export const VEHICLE_DEPRECIATION = {
  SECTION_280F_LIMITS_BONUS: {
    year1: 20400,
    year2: 19800,
    year3: 11900,
    year4Plus: 7200,
  } as Record<string, number>,

  SECTION_280F_LIMITS_NO_BONUS: {
    year1: 12400,
    year2: 19800,
    year3: 11900,
    year4Plus: 7200,
  } as Record<string, number>,

  MACRS_5_YEAR_RATES: [0.20, 0.32, 0.192, 0.1152, 0.1152, 0.0576] as readonly number[],

  STRAIGHT_LINE_5_YEAR_RATES: [0.10, 0.20, 0.20, 0.20, 0.20, 0.10] as readonly number[],

  SUV_SECTION_179_LIMIT: 32000,

  BONUS_DEPRECIATION_RATE: 1.0,

  TAX_YEAR: 2026,
};

// ──────────────────────────────────────────────────
// Form 4562 — Section 179 & MACRS General Depreciation
// Authority: IRC §179 — Election to expense certain depreciable business assets
//           IRC §168 — Accelerated cost recovery system (MACRS)
//           IRC §168(k) — Bonus depreciation (100% restored by OBBBA)
// Constants: Rev. Proc. 2025-32, Section 3 — Section 179 dollar limits for 2026
//           IRS Pub 946, Table A-1 — GDS 200% DB, half-year convention
// ──────────────────────────────────────────────────

export const SECTION_179 = {
  MAX_DEDUCTION: 2560000,
  PHASE_OUT_THRESHOLD: 4090000,
  SUV_LIMIT: 32000,
} as const;

/**
 * MACRS GDS depreciation rate tables (200% declining balance, half-year convention).
 * Source: IRS Publication 946, Table A-1.
 *
 * Key = recovery period in years. Value = array of annual rates (0-indexed).
 * Year 0 = first year placed in service (half-year convention).
 * Each array sums to 1.0 (100% of basis recovered over the recovery period + 1 years).
 */
export const MACRS_GDS_RATES: Record<number, readonly number[]> = {
  3:  [0.3333, 0.4445, 0.1481, 0.0741],
  5:  [0.2000, 0.3200, 0.1920, 0.1152, 0.1152, 0.0576],
  7:  [0.1429, 0.2449, 0.1749, 0.1249, 0.0893, 0.0892, 0.0893, 0.0446],
  10: [0.1000, 0.1800, 0.1440, 0.1152, 0.0922, 0.0737, 0.0655, 0.0655, 0.0656, 0.0655, 0.0328],
  15: [0.0500, 0.0950, 0.0855, 0.0770, 0.0693, 0.0623, 0.0590, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0295],
  20: [0.0375, 0.0722, 0.0668, 0.0618, 0.0571, 0.0528, 0.0489, 0.0452, 0.0447, 0.0447, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0223],
};

/**
 * MACRS GDS depreciation rate tables — mid-quarter convention.
 * Source: IRS Publication 946, Appendix A, Tables A-2 through A-5 (200% DB)
 *         and Tables A-2a through A-5a (150% DB, for 15/20-year property).
 *
 * Key = recovery period in years.
 * Value = array of 4 rate arrays, indexed by quarter placed in service (0 = Q1, 3 = Q4).
 * Each rate array has (recoveryPeriod + 1) entries and sums to 1.0.
 *
 * The mid-quarter convention is required under IRC §168(d)(3) when more than 40%
 * of the aggregate depreciable basis placed in service during the tax year is placed
 * in service during the last 3 months of the tax year.
 */
export const MACRS_GDS_RATES_MID_QUARTER: Record<number, readonly (readonly number[])[]> = {
  // ── 3-Year Property (200% DB, mid-quarter) ─────────────────
  3: [
    [0.5833, 0.2778, 0.0926, 0.0463],  // Q1
    [0.4167, 0.3889, 0.1414, 0.0530],  // Q2
    [0.2500, 0.5000, 0.1667, 0.0833],  // Q3
    [0.0833, 0.6111, 0.2037, 0.1019],  // Q4
  ],
  // ── 5-Year Property (200% DB, mid-quarter) ─────────────────
  5: [
    [0.3500, 0.2600, 0.1560, 0.1101, 0.1101, 0.0138],  // Q1
    [0.2500, 0.3000, 0.1800, 0.1137, 0.1137, 0.0426],  // Q2
    [0.1500, 0.3400, 0.2040, 0.1224, 0.1130, 0.0706],  // Q3
    [0.0500, 0.3800, 0.2280, 0.1368, 0.1094, 0.0958],  // Q4
  ],
  // ── 7-Year Property (200% DB, mid-quarter) ─────────────────
  7: [
    [0.2500, 0.2143, 0.1531, 0.1093, 0.0875, 0.0874, 0.0875, 0.0109],  // Q1
    [0.1785, 0.2347, 0.1676, 0.1197, 0.0887, 0.0887, 0.0887, 0.0334],  // Q2
    [0.1071, 0.2551, 0.1822, 0.1302, 0.0930, 0.0885, 0.0886, 0.0553],  // Q3
    [0.0357, 0.2755, 0.1968, 0.1406, 0.1004, 0.0873, 0.0873, 0.0764],  // Q4
  ],
  // ── 10-Year Property (200% DB, mid-quarter) ────────────────
  10: [
    [0.1750, 0.1650, 0.1320, 0.1056, 0.0845, 0.0676, 0.0655, 0.0655, 0.0656, 0.0655, 0.0082],  // Q1
    [0.1250, 0.1750, 0.1400, 0.1120, 0.0896, 0.0717, 0.0655, 0.0655, 0.0656, 0.0655, 0.0246],  // Q2
    [0.0750, 0.1850, 0.1480, 0.1184, 0.0947, 0.0758, 0.0655, 0.0655, 0.0656, 0.0655, 0.0410],  // Q3
    [0.0250, 0.1950, 0.1560, 0.1248, 0.0998, 0.0799, 0.0655, 0.0655, 0.0656, 0.0655, 0.0574],  // Q4
  ],
  // ── 15-Year Property (150% DB, mid-quarter) ────────────────
  15: [
    [0.0875, 0.0913, 0.0821, 0.0739, 0.0665, 0.0599, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0074],  // Q1
    [0.0625, 0.0938, 0.0844, 0.0759, 0.0683, 0.0615, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0221],  // Q2
    [0.0375, 0.0963, 0.0866, 0.0780, 0.0702, 0.0632, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0368],  // Q3
    [0.0125, 0.0988, 0.0889, 0.0800, 0.0720, 0.0648, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0591, 0.0590, 0.0516],  // Q4
  ],
  // ── 20-Year Property (150% DB, mid-quarter) ────────────────
  20: [
    [0.0656, 0.0701, 0.0648, 0.0600, 0.0555, 0.0513, 0.0475, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0054],  // Q1
    [0.0469, 0.0715, 0.0661, 0.0612, 0.0566, 0.0523, 0.0484, 0.0448, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0170],  // Q2
    [0.0281, 0.0729, 0.0674, 0.0624, 0.0577, 0.0534, 0.0494, 0.0457, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0278],  // Q3
    [0.0094, 0.0743, 0.0687, 0.0636, 0.0588, 0.0544, 0.0503, 0.0465, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0446, 0.0388],  // Q4
  ],
};

/** Bonus depreciation rate for 2026 (100% restored by OBBBA). IRC §168(k). */
export const BONUS_DEPRECIATION_RATE_2025 = 1.0;

/** Tax year for MACRS year-index computation. */
export const DEPRECIATION_TAX_YEAR = 2026;

// ──────────────────────────────────────────────────
// Schedule A / Itemized Deductions
// Authority: IRC §164(b)(6) — SALT cap; IRC §163(h)(3) — Mortgage interest
//           IRC §170 — Charitable contributions; IRC §213(a) — Medical expenses
//           TCJA §11042 / OBBBA — SALT limitation ($40k for 2025-2029); TCJA §11043 — Mortgage limit
// ──────────────────────────────────────────────────

export const SCHEDULE_A = {
  SALT_CAP: 40000,
  SALT_CAP_MFS: 20000,
  SALT_PHASE_DOWN_THRESHOLD: 500000,
  SALT_PHASE_DOWN_THRESHOLD_MFS: 250000,
  SALT_PHASE_DOWN_RATE: 0.30,
  SALT_CAP_FLOOR: 10000,
  SALT_CAP_FLOOR_MFS: 5000,
  MEDICAL_AGI_THRESHOLD: 0.075,
  MORTGAGE_LIMIT: 750000,
  MORTGAGE_LIMIT_MFS: 375000,
};

// ──────────────────────────────────────────────────
// Child Tax Credit
// Authority: IRC §24(a) — CTC per qualifying child; IRC §24(h) — TCJA modifications
//           IRC §24(d) — ACTC (refundable portion); TCJA §11022
// Constants: Rev. Proc. 2025-32, Section 3.23 — CTC amounts
// ──────────────────────────────────────────────────

export const CHILD_TAX_CREDIT = {
  PER_CHILD: 2200,
  PER_OTHER_DEPENDENT: 500,
  PHASE_OUT_THRESHOLD_SINGLE: 200000,
  PHASE_OUT_THRESHOLD_MFJ: 400000,
  PHASE_OUT_RATE: 50,
  REFUNDABLE_MAX: 1700,
};

// ──────────────────────────────────────────────────
// Education Credits
// Authority: IRC §25A(b) — AOTC; IRC §25A(c) — LLC; IRC §25A(i) — AOTC modifications
// Constants: Rev. Proc. 2025-32, Section 3.24-3.25 — Phase-out thresholds
// ──────────────────────────────────────────────────

export const EDUCATION_CREDITS = {
  AOTC_MAX: 2500,
  AOTC_FIRST_TIER: 2000,
  AOTC_SECOND_TIER: 2000,
  AOTC_REFUNDABLE_RATE: 0.40,
  AOTC_PHASE_OUT_SINGLE: 80000,
  AOTC_PHASE_OUT_RANGE_SINGLE: 10000,
  AOTC_PHASE_OUT_MFJ: 160000,
  AOTC_PHASE_OUT_RANGE_MFJ: 20000,

  LLC_MAX: 2000,
  LLC_RATE: 0.20,
  LLC_PHASE_OUT_SINGLE: 80000,
  LLC_PHASE_OUT_RANGE_SINGLE: 10000,
  LLC_PHASE_OUT_MFJ: 160000,
  LLC_PHASE_OUT_RANGE_MFJ: 20000,
};

// ──────────────────────────────────────────────────
// Estimated Tax
// Authority: IRC §6654 — Failure to pay estimated income tax; IRC §6654(d)(1) — Required annual payment
// ──────────────────────────────────────────────────

export const ESTIMATED_TAX = {
  QUARTERLY_DIVISOR: 4,
  SAFE_HARBOR_RATE: 1.0,
  HIGH_INCOME_SAFE_HARBOR: 1.10,
  HIGH_INCOME_THRESHOLD: 150000,
};

// ──────────────────────────────────────────────────
// HSA Contribution Limits (2026)
// Authority: IRC §223(b) — Contribution limits; IRC §223(b)(3) — Catch-up contributions
// Constants: Rev. Proc. 2025-32 — HSA contribution limits for 2026
// ──────────────────────────────────────────────────

export const HSA = {
  INDIVIDUAL_LIMIT: 4400,
  FAMILY_LIMIT: 8750,
  CATCH_UP_55_PLUS: 1000,
};

// ──────────────────────────────────────────────────
// Archer MSA Contribution Limits (2026)
// Authority: IRC §220(b) — Contribution limits; IRC §220(d) — HDHP definition
// Constants: Rev. Proc. 2025-32 — Archer MSA HDHP thresholds
// ──────────────────────────────────────────────────

export const ARCHER_MSA = {
  SELF_ONLY_RATE: 0.65,
  FAMILY_RATE: 0.75,
  SELF_ONLY_DEDUCTIBLE_MIN: 2900,
  SELF_ONLY_DEDUCTIBLE_MAX: 4400,
  SELF_ONLY_OOP_MAX: 5850,
  FAMILY_DEDUCTIBLE_MIN: 5850,
  FAMILY_DEDUCTIBLE_MAX: 8750,
  FAMILY_OOP_MAX: 10700,
  EXCESS_TAX_RATE: 0.06,
  DISTRIBUTION_PENALTY_RATE: 0.20,
};

// ──────────────────────────────────────────────────
// Student Loan Interest Deduction (2026)
// Authority: IRC §221 — Student loan interest deduction
// Constants: Rev. Proc. 2025-32, Section 3.20 — Phase-out thresholds
// ──────────────────────────────────────────────────

export const STUDENT_LOAN_INTEREST = {
  MAX_DEDUCTION: 2500,
  PHASE_OUT_SINGLE: 85000,
  PHASE_OUT_RANGE_SINGLE: 15000,
  PHASE_OUT_MFJ: 175000,
  PHASE_OUT_RANGE_MFJ: 30000,
};

// ──────────────────────────────────────────────────
// IRA Contribution Limits (2026)
// Authority: IRC §219(b)(5) — Contribution limits; IRC §219(g) — Deduction phase-outs
// Constants: Rev. Proc. 2025-32, Section 3.08-3.10 — IRA limits and phase-outs
// ──────────────────────────────────────────────────

export const IRA = {
  MAX_CONTRIBUTION: 7500,
  CATCH_UP_50_PLUS: 1000,
  DEDUCTION_PHASE_OUT_SINGLE: 81000,
  DEDUCTION_PHASE_OUT_RANGE_SINGLE: 10000,
  DEDUCTION_PHASE_OUT_MFJ: 129000,
  DEDUCTION_PHASE_OUT_RANGE_MFJ: 20000,
  DEDUCTION_PHASE_OUT_MFJ_SPOUSE_COVERED: 236000,
  DEDUCTION_PHASE_OUT_RANGE_MFJ_SPOUSE_COVERED: 10000,
  DEDUCTION_PHASE_OUT_MFS: 0,
  DEDUCTION_PHASE_OUT_RANGE_MFS: 10000,
};

// ──────────────────────────────────────────────────
// Capital Gains / Qualified Dividends (2026)
// Authority: IRC §1(h) — Preferential rates for net capital gain and qualified dividends
//           IRC §1(h)(1)(B)-(D) — 0%/15%/20% rate tiers
// Constants: Rev. Proc. 2025-32, Section 3.12 — Capital gain rate thresholds
// ──────────────────────────────────────────────────

export const CAPITAL_GAINS_RATES = {
  RATE_0: 0,
  RATE_15: 0.15,
  RATE_20: 0.20,
  RATE_25: 0.25,
  THRESHOLD_0: {
    [FilingStatus.Single]: 49450,
    [FilingStatus.MarriedFilingJointly]: 98900,
    [FilingStatus.MarriedFilingSeparately]: 49450,
    [FilingStatus.HeadOfHousehold]: 66200,
    [FilingStatus.QualifyingSurvivingSpouse]: 98900,
  } as Record<FilingStatus, number>,
  THRESHOLD_15: {
    [FilingStatus.Single]: 545500,
    [FilingStatus.MarriedFilingJointly]: 613700,
    [FilingStatus.MarriedFilingSeparately]: 306850,
    [FilingStatus.HeadOfHousehold]: 579600,
    [FilingStatus.QualifyingSurvivingSpouse]: 613700,
  } as Record<FilingStatus, number>,
};

// ──────────────────────────────────────────────────
// Net Investment Income Tax (NIIT)
// Authority: IRC §1411 — Net investment income tax; ACA §1402(a)
// Note: NIIT thresholds are NOT indexed for inflation (statutory amounts)
// ──────────────────────────────────────────────────

export const NIIT = {
  RATE: 0.038,
  THRESHOLD_SINGLE: 200000,
  THRESHOLD_MFJ: 250000,
  THRESHOLD_MFS: 125000,
  THRESHOLD_HOH: 200000,
  THRESHOLD_QSS: 250000,
};

// ──────────────────────────────────────────────────
// Qualified Charitable Distributions (QCD)
// Authority: IRC §408(d)(8) — Qualified charitable distributions
//           SECURE 2.0 Act §307 — Inflation indexing starting 2024
// ──────────────────────────────────────────────────

export const QCD = {
  MAX_AMOUNT: 110000,
  MIN_AGE_MONTHS: 846,
};

// ──────────────────────────────────────────────────
// Early Distribution Penalty (Form 5329)
// Authority: IRC §72(t) — 10% additional tax on early distributions
//           IRC §72(t)(2) — Exceptions to early distribution penalty
// ──────────────────────────────────────────────────

export const EARLY_DISTRIBUTION = {
  PENALTY_RATE: 0.10,
  PENALTY_CODES: ['1'],
  EXCEPTION_CODES: ['2'],
  EXEMPT_CODES: ['3', '4', '7', 'G', 'T'],

  EXCEPTION_REASON_CODES: {
    '01': 'Separation from service after age 55 (or age 50 for public safety)',
    '02': 'SEPP — substantially equal periodic payments',
    '03': 'Disability',
    '04': 'Death (beneficiary distribution)',
    '05': 'Unreimbursed medical expenses exceeding 7.5% of AGI',
    '06': 'Health insurance premiums while unemployed',
    '07': 'IRS levy',
    '08': 'Qualified higher education expenses',
    '09': 'First-time homebuyer ($10,000 lifetime max)',
    '10': 'Qualified reservist distribution',
    '11': 'Qualified birth or adoption ($5,000 max)',
    '12': 'Terminal illness',
    '13': 'Domestic abuse victim ($10,000 or 50% of account, lesser)',
    '14': 'Qualified disaster recovery ($22,000 max)',
  } as Record<string, string>,
  FIRST_TIME_HOMEBUYER_LIMIT: 10000,
  BIRTH_ADOPTION_LIMIT: 5000,
};

// ──────────────────────────────────────────────────
// ACTC (Additional Child Tax Credit)
// Authority: IRC §24(d) — Refundable portion of CTC (ACTC)
// ──────────────────────────────────────────────────

export const ACTC = {
  EARNED_INCOME_THRESHOLD: 2500,
  EARNED_INCOME_RATE: 0.15,
};

// ──────────────────────────────────────────────────
// Child and Dependent Care Credit (Form 2441)
// Authority: IRC §21 — Expenses for household and dependent care services
// Note: These amounts are NOT indexed for inflation (statutory)
// ──────────────────────────────────────────────────

export const DEPENDENT_CARE = {
  EXPENSE_LIMIT_ONE: 3000,
  EXPENSE_LIMIT_TWO_PLUS: 6000,
  MAX_RATE: 0.35,
  MIN_RATE: 0.20,
  RATE_PHASE_OUT_START: 15000,
  RATE_STEP_SIZE: 2000,
  RATE_STEP: 0.01,
};

// ──────────────────────────────────────────────────
// Retirement Savings Contributions Credit (Saver's Credit, Form 8880)
// Authority: IRC §25B — Elective deferrals and IRA contributions by certain individuals
// Constants: Rev. Proc. 2025-32, Section 3.06 — AGI thresholds
// ──────────────────────────────────────────────────

export const SAVERS_CREDIT = {
  CONTRIBUTION_LIMIT: 2000,
  CONTRIBUTION_LIMIT_MFJ: 4000,
  SINGLE_50: 24100,
  SINGLE_20: 25900,
  SINGLE_10: 40200,
  HOH_50: 36150,
  HOH_20: 38850,
  HOH_10: 60300,
  MFJ_50: 48200,
  MFJ_20: 51800,
  MFJ_10: 80400,
};

// ──────────────────────────────────────────────────
// Residential Clean Energy Credit (Form 5695, Part I)
// Authority: IRC §25D — Residential clean energy credit; IRA §13302 — Extended through 2034
// ──────────────────────────────────────────────────

export const CLEAN_ENERGY = {
  RATE: 0.30,
  FUEL_CELL_CAP_PER_HALF_KW: 500,
};

// ──────────────────────────────────────────────────
// HSA Distributions (1099-SA)
// Authority: IRC §223(f)(2) — Includable in gross income; IRC §223(f)(4) — Additional tax
// ──────────────────────────────────────────────────

export const HSA_DISTRIBUTIONS = {
  PENALTY_RATE: 0.20,
};

// ──────────────────────────────────────────────────
// Schedule D — Capital Gains & Losses
// Authority: IRC §1211(b) — Limitation on capital losses for individuals
//           IRC §1212(b) — Capital loss carryover
// ──────────────────────────────────────────────────

export const SCHEDULE_D = {
  CAPITAL_LOSS_LIMIT: 3000,
  CAPITAL_LOSS_LIMIT_MFS: 1500,
};

// ──────────────────────────────────────────────────
// Social Security Benefits (SSA-1099)
// Authority: IRC §86 — Taxation of Social Security benefits
//           IRC §86(c) — Base amount definitions by filing status
// Note: These thresholds are NOT indexed for inflation (statutory since 1984/1993)
// ──────────────────────────────────────────────────

export const SOCIAL_SECURITY = {
  SINGLE_BASE_AMOUNT: 25000,
  SINGLE_ADJUSTED_BASE: 34000,
  MFJ_BASE_AMOUNT: 32000,
  MFJ_ADJUSTED_BASE: 44000,
  MFS_BASE_AMOUNT: 0,
  RATE_50: 0.50,
  RATE_85: 0.85,
};

// ──────────────────────────────────────────────────
// Educator Expenses (Schedule 1, Line 11)
// Authority: IRC §62(a)(2)(D) — Eligible educator expenses
// Constants: Rev. Proc. 2025-32, Section 3.19 — Educator expense limit
// ──────────────────────────────────────────────────

export const EDUCATOR_EXPENSES = {
  MAX_DEDUCTION: 300,
};

// ──────────────────────────────────────────────────
// Schedule E — Rental Income
// Authority: IRC §469 — Passive activity losses and credits
//           IRC §469(i) — $25,000 special allowance for rental real estate
// Note: These amounts are NOT indexed for inflation (statutory)
// ──────────────────────────────────────────────────

export const SCHEDULE_E = {
  PASSIVE_LOSS_ALLOWANCE: 25000,
  PHASE_OUT_START: 100000,
  PHASE_OUT_RANGE: 50000,
};

// ──────────────────────────────────────────────────
// Form 8582 — Passive Activity Loss Limitations
// Authority: IRC §469 — Passive activity losses and credits
//           IRC §469(i) — $25,000 special allowance for rental real estate
//           IRC §469(i)(4) — Married filing separately special rules
// Note: These amounts are NOT indexed for inflation (statutory)
// ──────────────────────────────────────────────────

export const FORM_8582 = {
  SPECIAL_ALLOWANCE: 25000,
  SPECIAL_ALLOWANCE_MFS: 12500,
  PHASE_OUT_START: 100000,
  PHASE_OUT_START_MFS: 50000,
  PHASE_OUT_RANGE: 50000,
  PHASE_OUT_RANGE_MFS: 25000,
};

// ──────────────────────────────────────────────────
// Clean Vehicle Credit (Form 8936) — EV Credit
// Authority: IRC §30D — New clean vehicle credit; IRC §25E — Previously owned clean vehicle
//           IRA §13401 — Modified §30D; IRA §13402 — New §25E
// ──────────────────────────────────────────────────

export const EV_CREDIT = {
  NEW_VEHICLE_MAX: 7500,
  NEW_CRITICAL_MINERAL: 3750,
  NEW_BATTERY_COMPONENT: 3750,
  NEW_MSRP_CAP_VAN_SUV_TRUCK: 80000,
  NEW_MSRP_CAP_OTHER: 55000,
  NEW_INCOME_LIMIT_MFJ: 300000,
  NEW_INCOME_LIMIT_HOH: 225000,
  NEW_INCOME_LIMIT_SINGLE: 150000,
  USED_VEHICLE_MAX: 4000,
  USED_PRICE_CAP: 25000,
  USED_INCOME_LIMIT_MFJ: 150000,
  USED_INCOME_LIMIT_HOH: 112500,
  USED_INCOME_LIMIT_SINGLE: 75000,
};

// ──────────────────────────────────────────────────
// Energy Efficient Home Improvement Credit (Form 5695, Part II)
// Authority: IRC §25C — Energy efficient home improvement credit; IRA §13301 — Modified §25C
// ──────────────────────────────────────────────────

export const ENERGY_EFFICIENCY = {
  RATE: 0.30,
  AGGREGATE_ANNUAL_LIMIT: 3200,
  HEAT_PUMP_ANNUAL_LIMIT: 2000,
  NON_HP_ANNUAL_LIMIT: 1200,
  WINDOWS_LIMIT: 600,
  DOORS_LIMIT: 500,
  ELECTRICAL_PANEL_LIMIT: 600,
  HOME_ENERGY_AUDIT_LIMIT: 150,
};

// ──────────────────────────────────────────────────
// Foreign Tax Credit (Form 1116) — Simplified
// Authority: IRC §901 — Foreign tax credit; IRC §904 — Limitation on credit
//           IRC §904(j) — Certain individuals exempt from limitation ($300/$600 de minimis)
// ──────────────────────────────────────────────────

export const FOREIGN_TAX_CREDIT = {
  SIMPLIFIED_ELECTION_LIMIT: 300,
  SIMPLIFIED_ELECTION_LIMIT_MFJ: 600,
};

// ──────────────────────────────────────────────────
// IRC §901(j) Sanctioned Countries
// Authority: IRC §901(j) — Denial of FTC for income from sanctioned countries
// Source: OFAC SDN list / Treasury designation; IRS Rev. Rul. cross-references
// These countries are designated under IRC §901(j)(2)(A)-(C):
//   (A) Countries supporting international terrorism (IRC §6(j) EAA)
//   (B) Countries the US does not recognize / has severed diplomatic relations
//   (C) Countries where the US government has determined FTC would be contrary to US interests
// Last updated: 2026 (current OFAC designations)
// ──────────────────────────────────────────────────
export const SANCTIONED_COUNTRIES: string[] = [
  'Cuba',
  'Iran',
  'North Korea',
  'Syria',
];

// ──────────────────────────────────────────────────
// Excess Social Security Tax Credit
// Authority: IRC §31(b) — Credit for excess SS tax withheld (multiple employers)
// Constants: SSA COLA announcement — SS wage base for 2026
// ──────────────────────────────────────────────────

export const EXCESS_SS_TAX = {
  SS_TAX_RATE: 0.062,
  SS_WAGE_BASE: 184500,
  MAX_SS_TAX: 11439.00,
};

// ──────────────────────────────────────────────────
// Alimony Deduction
// Authority: IRC §215 (pre-TCJA) — Deduction for alimony payments
//           IRC §71 (pre-TCJA) — Alimony received as income
//           TCJA §11051 — Repealed §215 and §71 for post-2018 agreements
// ──────────────────────────────────────────────────

export const ALIMONY = {
  TCJA_CUTOFF_DATE: '2019-01-01',
};

// ──────────────────────────────────────────────────
// Estimated Tax Penalty (Form 2210) — 2026
// Authority: IRC §6654 — Failure to pay estimated income tax
//           IRC §6621(a)(2) — Underpayment rate
// Constants: IRS underpayment rate announcement for 2026
// ──────────────────────────────────────────────────

export const ESTIMATED_TAX_PENALTY = {
  RATE: 0.07,
  REQUIRED_ANNUAL_PAYMENT_RATE: 0.90,
  PRIOR_YEAR_SAFE_HARBOR: 1.00,
  PRIOR_YEAR_SAFE_HARBOR_HIGH_INCOME: 1.10,
  HIGH_INCOME_THRESHOLD: 150000,
  MINIMUM_PENALTY_THRESHOLD: 1000,
  ANNUALIZATION_FACTORS: [4, 2.4, 1.5, 1] as readonly number[],
  QUARTERLY_INSTALLMENT_PERCENTAGES: [0.25, 0.50, 0.75, 1.00] as readonly number[],

  DAYS_MATRIX: [
    [77, 92, 92, 104],
    [16, 92, 92, 104],
    [0,  16, 92, 104],
    [0,   0,  0,  90],
  ] as readonly (readonly number[])[],
  PERIOD_RATES: [0.07, 0.07, 0.07, 0.07] as readonly number[],
};

// ──────────────────────────────────────────────────
// Kiddie Tax (Form 8615) — 2026
// Authority: IRC §1(g) — Certain unearned income of children taxed at parent's rate
// Constants: Rev. Proc. 2025-32, Section 3.03 — Kiddie tax thresholds
// ──────────────────────────────────────────────────

export const KIDDIE_TAX = {
  UNEARNED_INCOME_THRESHOLD: 2700,
  STANDARD_DEDUCTION_UNEARNED: 1350,
  AGE_LIMIT: 19,
  STUDENT_AGE_LIMIT: 24,
};

// ──────────────────────────────────────────────────
// Foreign Earned Income Exclusion (Form 2555) — 2026
// Authority: IRC §911 — Citizens or residents living abroad
// Constants: Rev. Proc. 2025-32, Section 3.36 — FEIE exclusion amount
// ──────────────────────────────────────────────────

export const FEIE = {
  EXCLUSION_AMOUNT: 130000,
  HOUSING_BASE: 20280,
  HOUSING_MAX_EXCLUSION: 39000,
};

// ──────────────────────────────────────────────────
// Schedule H — Household Employee Tax (2026)
// Authority: IRC §3111 — Employer FICA; IRC §3301 — FUTA tax
//           IRC §3121(x) — Domestic service employment threshold
// Constants: SSA announcement — Household employee cash wage threshold
// ──────────────────────────────────────────────────

export const SCHEDULE_H = {
  CASH_WAGE_THRESHOLD: 2800,
  FUTA_WAGE_THRESHOLD: 1000,
  SS_RATE: 0.124,
  MEDICARE_RATE: 0.029,
  FUTA_RATE: 0.006,
  FUTA_WAGE_BASE: 7000,
  SS_WAGE_BASE: 184500,
};

// ──────────────────────────────────────────────────
// Net Operating Loss (NOL) Carryforward — TCJA Rules
// Authority: IRC §172(a) — NOL deduction; IRC §172(b)(2) — 80% limitation
//           TCJA §13302 — Modified NOL rules (no carryback, 80% limit)
// ──────────────────────────────────────────────────

export const NOL = {
  DEDUCTION_LIMIT_RATE: 0.80,
};

// ──────────────────────────────────────────────────
// Adoption Credit (Form 8839) — 2026
// Authority: IRC §23 — Adoption expenses credit
// Constants: Rev. Proc. 2025-32, Section 3.35 — Adoption credit limits
// ──────────────────────────────────────────────────

export const ADOPTION_CREDIT = {
  MAX_CREDIT: 17280,
  PHASE_OUT_START: 259190,
  PHASE_OUT_RANGE: 40000,
};

// ──────────────────────────────────────────────────
// Dependent Care FSA Coordination
// Authority: IRC §129 — Dependent care assistance programs
// ──────────────────────────────────────────────────

export const DEPENDENT_CARE_FSA = {
  MAX_EXCLUSION: 5000,
  MAX_EXCLUSION_MFS: 2500,
};

// ──────────────────────────────────────────────────
// Premium Tax Credit (Form 8962) — 2026
// Authority: IRC §36B — Refundable credit for coverage under qualified health plan
//           ACA §1401 — Original PTC; IRA §12001 — Extended enhanced subsidies
// Constants: HHS 2025 Federal Poverty Guidelines (used for TY2026)
// ──────────────────────────────────────────────────

export const PREMIUM_TAX_CREDIT = {
  FPL_BASE_48: 15650,
  FPL_INCREMENT_48: 5570,
  FPL_BASE_AK: 19550,
  FPL_INCREMENT_AK: 6950,
  FPL_BASE_HI: 17990,
  FPL_INCREMENT_HI: 6420,

  APPLICABLE_FIGURE_TABLE: [
    { floor: 0, ceiling: 150, initialPct: 0, finalPct: 0 },
    { floor: 150, ceiling: 200, initialPct: 0, finalPct: 0.02 },
    { floor: 200, ceiling: 250, initialPct: 0.02, finalPct: 0.04 },
    { floor: 250, ceiling: 300, initialPct: 0.04, finalPct: 0.06 },
    { floor: 300, ceiling: 400, initialPct: 0.06, finalPct: 0.085 },
    { floor: 400, ceiling: Infinity, initialPct: 0.085, finalPct: 0.085 },
  ] as const,

  MIN_FPL_PERCENTAGE: 100,

  REPAYMENT_CAPS: [
    { floor: 0, ceiling: 200, singleCap: 375, otherCap: 750 },
    { floor: 200, ceiling: 300, singleCap: 975, otherCap: 1950 },
    { floor: 300, ceiling: 400, singleCap: 1625, otherCap: 3250 },
  ] as const,
};

// ──────────────────────────────────────────────────
// Schedule 1-A — Additional Deductions (OBBBA 2025-2028)
// Authority: One Big Beautiful Bill Act (OBBBA), signed 2025
//           OBBBA §101 — No Tax on Tips; OBBBA §102 — No Tax on Overtime
//           OBBBA §103 — Car Loan Interest; OBBBA §104 — Enhanced Senior Deduction
// Note: Below-the-line deductions (reduce taxable income, not AGI). Effective 2025-2028.
// ──────────────────────────────────────────────────

export const SCHEDULE_1A = {
  // No Tax on Tips — OBBBA §101
  TIPS_CAP: 25000,
  TIPS_PHASE_OUT_SINGLE: 150000,
  TIPS_PHASE_OUT_MFJ: 300000,
  TIPS_PHASE_OUT_RATE: 100,
  TIPS_PHASE_OUT_STEP: 1000,

  // No Tax on Overtime — OBBBA §102
  OVERTIME_CAP_SINGLE: 12500,
  OVERTIME_CAP_MFJ: 25000,
  OVERTIME_PHASE_OUT_SINGLE: 150000,
  OVERTIME_PHASE_OUT_MFJ: 300000,
  OVERTIME_PHASE_OUT_RATE: 100,
  OVERTIME_PHASE_OUT_STEP: 1000,

  // No Tax on Car Loan Interest — OBBBA §103
  CAR_LOAN_CAP: 10000,
  CAR_LOAN_PHASE_OUT_SINGLE: 100000,
  CAR_LOAN_PHASE_OUT_MFJ: 200000,
  CAR_LOAN_PHASE_OUT_RATE: 200,
  CAR_LOAN_PHASE_OUT_STEP: 1000,

  // Enhanced Senior Deduction — OBBBA §104
  SENIOR_AMOUNT: 6000,
  SENIOR_PHASE_OUT_SINGLE: 75000,
  SENIOR_PHASE_OUT_MFJ: 150000,
  SENIOR_PHASE_OUT_RATE: 0.06,
};

// ──────────────────────────────────────────────────
// Sale of Home Exclusion (Section 121)
// Authority: IRC §121 — Exclusion of gain from sale of principal residence
// ──────────────────────────────────────────────────

export const HOME_SALE_EXCLUSION = {
  SINGLE_MAX: 250000,
  MFJ_MAX: 500000,
  OWNERSHIP_MONTHS_REQUIRED: 24,
  RESIDENCE_MONTHS_REQUIRED: 24,
};

// ──────────────────────────────────────────────────
// Charitable Contribution AGI Limits (Schedule A)
// Authority: IRC §170(b)(1) — Percentage limitations on charitable deductions
// ──────────────────────────────────────────────────

export const CHARITABLE_AGI_LIMITS = {
  CASH_PUBLIC_RATE: 0.60,
  NON_CASH_RATE: 0.30,
  NON_CASH_ORDINARY_RATE: 0.50,
  OVERALL_LIMIT_RATE: 0.60,
};

// ──────────────────────────────────────────────────
// Form 8283 — Non-Cash Charitable Contributions
// Authority: IRC §170(f)(11) — Substantiation requirements for noncash donations
//           Reg §1.170A-13 — Recordkeeping and return requirements
// ──────────────────────────────────────────────────

export const FORM_8283 = {
  SECTION_B_THRESHOLD: 5000,
  CARRYFORWARD_YEARS: 5,
};

// ──────────────────────────────────────────────────
// Cancellation of Debt (1099-C / Form 982)
// Authority: IRC §61(a)(11) — COD as gross income; IRC §108 — Exclusions
//           IRC §6050P — Information returns for cancelled debt
// ──────────────────────────────────────────────────

export const CANCELLATION_OF_DEBT = {
  MIN_REPORTING_AMOUNT: 600,
};

// ──────────────────────────────────────────────────
// Excess Contribution Penalties (Form 5329)
// Authority: IRC §4973(a) — 6% excise on excess IRA contributions
//           IRC §4973(g) — 6% excise on excess HSA contributions
// ──────────────────────────────────────────────────

export const EXCESS_CONTRIBUTION = {
  PENALTY_RATE: 0.06,
};

// Coverdell ESA Contribution Limit
// Authority: IRC §530(b)(1)(A)(iii) — $2,000 annual limit per beneficiary
export const ESA_CONTRIBUTION_LIMIT = 2000;

// ──────────────────────────────────────────────────
// Scholarship Granting Organization Credit (IRC §25F)
// Authority: OBBBA §70202 — Credit for contributions to qualified SGOs
// ──────────────────────────────────────────────────

export const SCHOLARSHIP_CREDIT = {
  MAX_CREDIT: 1700,
};

// ──────────────────────────────────────────────────
// SECURE 2.0 Emergency Personal Expense Distribution
// Authority: SECURE 2.0 Act §314 — IRC §72(t)(2)(I)
// Note: Distributions after 12/31/2023 for emergency personal expenses
//       are exempt from the 10% early withdrawal penalty, up to $1,000/year.
// ──────────────────────────────────────────────────

export const EMERGENCY_DISTRIBUTION = {
  ANNUAL_LIMIT: 1000,
  REPAYMENT_PERIOD_YEARS: 3,
};

// ──────────────────────────────────────────────────
// 1099-Q (529 Distributions)
// Authority: IRC §529(c)(3)(A) — Qualified distributions tax-free
//           IRC §529(c)(6) — 10% additional tax on non-qualified distributions
// ──────────────────────────────────────────────────

export const DISTRIBUTION_529 = {
  PENALTY_RATE: 0.10,
};

// ──────────────────────────────────────────────────
// Qualified Opportunity Zone (Form 8997)
// Authority: IRC §1400Z-2 — Special rules for capital gains invested in QOZ funds
//           TCJA §13823 — Opportunity Zone program
// ──────────────────────────────────────────────────

export const QOZ = {
  DEFERRAL_PERIOD_5_YEAR_STEP_UP: 0.10,
  DEFERRAL_PERIOD_7_YEAR_STEP_UP: 0.15,
};

// ──────────────────────────────────────────────────
// Form 4137 — Social Security and Medicare Tax on Unreported Tip Income
// Authority: IRC §3121(q) — Tips treated as wages; IRC §3101 — Employee FICA rates
// Constants: SSA announcement — SS wage base for 2026
// ──────────────────────────────────────────────────

export const FORM_4137 = {
  SS_RATE: 0.062,
  MEDICARE_RATE: 0.0145,
  SS_WAGE_BASE: 184500,
};

// ──────────────────────────────────────────────────
// Dependent Care Employer Benefits (Form 2441, Part III)
// Authority: IRC §129 — Dependent care assistance programs
// ──────────────────────────────────────────────────

export const DEPENDENT_CARE_EMPLOYER = {
  MAX_EXCLUSION: 5000,
  MAX_EXCLUSION_MFS: 2500,
  STUDENT_DISABLED_DEEMED_ONE: 250,
  STUDENT_DISABLED_DEEMED_TWO: 500,
};

// ──────────────────────────────────────────────────
// EV Refueling Property Credit (Form 8911)
// Authority: IRC §30C — Alternative fuel vehicle refueling property credit
//           IRA §13404 — Extension and modification (through 2032)
// Constants: Statutory amounts (not inflation-indexed)
// ──────────────────────────────────────────────────

// ──────────────────────────────────────────────────
// Schedule R — Credit for the Elderly or the Disabled (2026)
// Authority: IRC §22 — Credit for the elderly and the permanently and totally disabled
// Note: ALL amounts are statutory (IRC §22) and NOT indexed for inflation
// ──────────────────────────────────────────────────

export const SCHEDULE_R = {
  INITIAL_AMOUNT_SINGLE: 5000,
  INITIAL_AMOUNT_MFJ_BOTH: 7500,
  INITIAL_AMOUNT_MFJ_ONE: 5000,
  INITIAL_AMOUNT_MFS: 3750,
  AGI_THRESHOLD_SINGLE: 7500,
  AGI_THRESHOLD_MFJ: 10000,
  AGI_THRESHOLD_MFS: 5000,
  AGI_REDUCTION_RATE: 0.50,
  CREDIT_RATE: 0.15,
};

// ──────────────────────────────────────────────────
// Solo 401(k) — Defined Contribution Limits (2026)
// Authority: IRC §402(g) — Elective deferral limit
//           IRC §414(v) — Catch-up contributions for age 50+
//           IRC §414(v)(2)(E) — Super catch-up for ages 60-63 (SECURE 2.0 Act §109)
//           IRC §415(c) — Annual additions limit
//           IRC §401(a)(17) — Compensation cap
// Constants: IRS Notice 2025-80 — 2026 retirement plan limits
// ──────────────────────────────────────────────────

export const SOLO_401K = {
  EMPLOYEE_DEFERRAL_LIMIT: 24500,
  CATCH_UP_50_PLUS: 8000,
  SUPER_CATCH_UP_60_63: 11250,
  EMPLOYER_CONTRIBUTION_RATE: 0.25,
  SE_EFFECTIVE_RATE: 0.20,
  ANNUAL_ADDITION_LIMIT: 72000,
  COMPENSATION_CAP: 355000,
};

// ──────────────────────────────────────────────────
// SEP-IRA Contribution Limits (2026)
// Authority: IRC §408(k) — SEP requirements; IRC §402(h) — Contribution limits
//           IRC §404(h)(1)(C) — 25% of compensation
// Constants: IRS Notice 2025-80 — 2026 retirement plan limits
// ──────────────────────────────────────────────────

export const SEP_IRA = {
  CONTRIBUTION_RATE: 0.25,
  SE_EFFECTIVE_RATE: 0.20,
  MAX_CONTRIBUTION: 72000,
  COMPENSATION_CAP: 355000,
};

// ──────────────────────────────────────────────────
// SIMPLE IRA Contribution Limits (2026)
// Authority: IRC §408(p)(2)(A) — Elective deferral limit for SIMPLE plans
//           IRC §414(v)(2)(B)(ii) — SIMPLE catch-up
//           IRC §414(v)(2)(E) — SECURE 2.0 super catch-up
// Constants: IRS Notice 2025-80 — 2026 retirement plan limits
// ──────────────────────────────────────────────────

export const SIMPLE_IRA = {
  EMPLOYEE_DEFERRAL_LIMIT: 17000,
  CATCH_UP_50_PLUS: 4000,
  SUPER_CATCH_UP_60_63: 5250,
  EMPLOYER_MATCH_RATE: 0.03,
  EMPLOYER_NONELECTIVE_RATE: 0.02,
};

// ──────────────────────────────────────────────────
// Long-Term Care Premium Limits — IRC §213(d)(10)
// Authority: Rev. Proc. 2025-32 (2026 inflation-adjusted amounts)
// Per person. Used by Form 7206 to cap deductible LTC premiums by age.
// ──────────────────────────────────────────────────
export const LTC_PREMIUM_LIMITS_2025 = {
  AGE_40_OR_UNDER: 490,
  AGE_41_TO_50: 920,
  AGE_51_TO_60: 1840,
  AGE_61_TO_70: 4910,
  AGE_71_AND_OVER: 6130,
} as const;

export const EV_REFUELING = {
  CREDIT_RATE: 0.30,
  PERSONAL_CAP: 1000,
  BUSINESS_CAP: 100000,
};

// ──────────────────────────────────────────────────
// Plausibility Thresholds — WARN-level validations
// Inspired by IRS Direct File Fact Graph's distinction between
// ERROR (blocks submission) and WARN (flags implausibility).
//
// These are NOT legal limits. They flag values that seem unusual and
// should be double-checked by the filer. They never block calculation.
//
// Thresholds based on IRS audit trigger research and SOI statistical norms.
// ──────────────────────────────────────────────────

// ──────────────────────────────────────────────────
// Earned Income Tax Credit (EITC) — 2026
// Authority: IRC §32 — Earned income credit (extended permanently by OBBBA)
// Constants: Rev. Proc. 2025-32, Sections 3.04-3.07 — EITC thresholds and phase-outs
// ──────────────────────────────────────────────────

export const INVESTMENT_INCOME_LIMIT = 12_250;  // Rev. Proc. 2025-32 §3.04

export const EITC_BRACKETS: Record<number, {
  maxCredit: number;
  earnedIncomeThreshold: number;
  phaseOutStartSingle: number;
  phaseOutStartMFJ: number;
  completePhaseOutSingle: number;
  completePhaseOutMFJ: number;
}> = {
  0: { maxCredit: 660, earnedIncomeThreshold: 8_650, phaseOutStartSingle: 10_840, phaseOutStartMFJ: 18_100, completePhaseOutSingle: 19_528, completePhaseOutMFJ: 26_788 },
  1: { maxCredit: 4_430, earnedIncomeThreshold: 12_950, phaseOutStartSingle: 23_700, phaseOutStartMFJ: 30_940, completePhaseOutSingle: 51_198, completePhaseOutMFJ: 58_438 },
  2: { maxCredit: 7_320, earnedIncomeThreshold: 18_130, phaseOutStartSingle: 23_700, phaseOutStartMFJ: 30_940, completePhaseOutSingle: 58_230, completePhaseOutMFJ: 65_470 },
  3: { maxCredit: 8_160, earnedIncomeThreshold: 18_130, phaseOutStartSingle: 23_700, phaseOutStartMFJ: 30_940, completePhaseOutSingle: 62_530, completePhaseOutMFJ: 69_770 },
};

export const PLAUSIBILITY = {
  W2_WAGES_HIGH: 1_000_000,
  SELF_EMPLOYMENT_INCOME_HIGH: 500_000,
  INTEREST_INCOME_HIGH: 100_000,
  DIVIDEND_INCOME_HIGH: 200_000,
  RETIREMENT_DISTRIBUTION_HIGH: 500_000,

  CHARITABLE_CASH_AGI_RATE: 0.50,
  MEDICAL_AGI_RATE: 0.30,

  SALT_ENTERED_HIGH: 50_000,

  HOME_OFFICE_AREA_PCT: 0.50,

  VEHICLE_BUSINESS_MILES_HIGH: 40_000,
};
