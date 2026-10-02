import * as tax2024 from './tax2024.js';
import * as tax2025 from './tax2025.js';
import * as tax2026 from './tax2026.js';

export const SUPPORTED_TAX_YEARS = [2024, 2025, 2026] as const;

// Use a wide type to avoid literal-type incompatibilities between years
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaxModule = Record<string, any>;

/**
 * Get all tax constants for the specified year.
 * Throws if year is not supported.
 */
export function getTaxConstants(year: number): TaxModule {
  switch (year) {
    case 2024: return tax2024;
    case 2025: return tax2025;
    case 2026: return tax2026;
    default:
      throw new Error(`Unsupported tax year: ${year}. Supported years: ${SUPPORTED_TAX_YEARS.join(', ')}`);
  }
}

// ── Convenience resolvers (year-neutral names) ──────────────────────────
// The year-specific files export constants with year-suffixed names
// (e.g., TAX_BRACKETS_2025). These resolvers strip the year suffix
// and return the correct year's value.

export function getTaxBrackets(year: number) {
  const constants = getTaxConstants(year);
  return year === 2026 ? constants.TAX_BRACKETS_2026 : constants.TAX_BRACKETS_2025;
}

export function getStandardDeduction(year: number) {
  const constants = getTaxConstants(year);
  return year === 2026 ? constants.STANDARD_DEDUCTION_2026 : constants.STANDARD_DEDUCTION_2025;
}

export function getBonusDepreciationRate(year: number) {
  const constants = getTaxConstants(year);
  return year === 2026 ? constants.BONUS_DEPRECIATION_RATE_2026 : constants.BONUS_DEPRECIATION_RATE_2025;
}

export function getDepreciationTaxYear(year: number) {
  return getTaxConstants(year).DEPRECIATION_TAX_YEAR;
}

export function getLtcPremiumLimits(year: number) {
  const constants = getTaxConstants(year);
  return year === 2026 ? constants.LTC_PREMIUM_LIMITS_2026 : constants.LTC_PREMIUM_LIMITS_2025;
}

// ── Year-neutral re-exports (for constants that already have no year suffix) ──
// These are re-exported from the resolved year's module.

export function getAdditionalStandardDeduction(year: number) {
  return getTaxConstants(year).ADDITIONAL_STANDARD_DEDUCTION;
}

export function getDependentStandardDeduction(year: number) {
  return getTaxConstants(year).DEPENDENT_STANDARD_DEDUCTION;
}

export function getSeTax(year: number) {
  return getTaxConstants(year).SE_TAX;
}

export function getQbi(year: number) {
  return getTaxConstants(year).QBI;
}

export function getHomeOffice(year: number) {
  return getTaxConstants(year).HOME_OFFICE;
}

export function getHomeOfficeDepreciation(year: number) {
  return getTaxConstants(year).HOME_OFFICE_DEPRECIATION;
}

export function getVehicle(year: number) {
  return getTaxConstants(year).VEHICLE;
}

export function getVehicleDepreciation(year: number) {
  return getTaxConstants(year).VEHICLE_DEPRECIATION;
}

export function getSection179(year: number) {
  return getTaxConstants(year).SECTION_179;
}

export function getMacrsGdsRates(year: number) {
  return getTaxConstants(year).MACRS_GDS_RATES;
}

export function getMacrsGdsRatesMidQuarter(year: number) {
  return getTaxConstants(year).MACRS_GDS_RATES_MID_QUARTER;
}

export function getEducationCredits(year: number) {
  return getTaxConstants(year).EDUCATION_CREDITS;
}

export function getEstimatedTax(year: number) {
  return getTaxConstants(year).ESTIMATED_TAX;
}

export function getHsa(year: number) {
  return getTaxConstants(year).HSA;
}

export function getArcherMsa(year: number) {
  return getTaxConstants(year).ARCHER_MSA;
}

export function getCapitalGainsRates(year: number) {
  return getTaxConstants(year).CAPITAL_GAINS_RATES;
}

export function getNiit(year: number) {
  return getTaxConstants(year).NIIT;
}

export function getQcd(year: number) {
  return getTaxConstants(year).QCD;
}

export function getEarlyDistribution(year: number) {
  return getTaxConstants(year).EARLY_DISTRIBUTION;
}

export function getDependentCare(year: number) {
  return getTaxConstants(year).DEPENDENT_CARE;
}

export function getSaversCredit(year: number) {
  return getTaxConstants(year).SAVERS_CREDIT;
}

export function getCleanEnergy(year: number) {
  return getTaxConstants(year).CLEAN_ENERGY;
}

export function getHsaDistributions(year: number) {
  return getTaxConstants(year).HSA_DISTRIBUTIONS;
}

export function getSocialSecurity(year: number) {
  return getTaxConstants(year).SOCIAL_SECURITY;
}

export function getForm8582(year: number) {
  return getTaxConstants(year).FORM_8582;
}

export function getEvCredit(year: number) {
  return getTaxConstants(year).EV_CREDIT;
}

export function getEnergyEfficiency(year: number) {
  return getTaxConstants(year).ENERGY_EFFICIENCY;
}

export function getForeignTaxCredit(year: number) {
  return getTaxConstants(year).FOREIGN_TAX_CREDIT;
}

export function getSanctionedCountries(year: number) {
  return getTaxConstants(year).SANCTIONED_COUNTRIES;
}

export function getEstimatedTaxPenalty(year: number) {
  return getTaxConstants(year).ESTIMATED_TAX_PENALTY;
}

export function getKiddieTax(year: number) {
  return getTaxConstants(year).KIDDIE_TAX;
}

export function getFeie(year: number) {
  return getTaxConstants(year).FEIE;
}

export function getAdoptionCredit(year: number) {
  return getTaxConstants(year).ADOPTION_CREDIT;
}

export function getPremiumTaxCredit(year: number) {
  return getTaxConstants(year).PREMIUM_TAX_CREDIT;
}

export function getHomeSaleExclusion(year: number) {
  return getTaxConstants(year).HOME_SALE_EXCLUSION;
}

export function getCharitableAgiLimits(year: number) {
  return getTaxConstants(year).CHARITABLE_AGI_LIMITS;
}

export function getForm8283(year: number) {
  return getTaxConstants(year).FORM_8283;
}

export function getExcessContribution(year: number) {
  return getTaxConstants(year).EXCESS_CONTRIBUTION;
}

export function getScholarshipCredit(year: number) {
  return getTaxConstants(year).SCHOLARSHIP_CREDIT;
}

export function getEmergencyDistribution(year: number) {
  return getTaxConstants(year).EMERGENCY_DISTRIBUTION;
}

export function getForm4137(year: number) {
  return getTaxConstants(year).FORM_4137;
}

export function getDependentCareEmployer(year: number) {
  return getTaxConstants(year).DEPENDENT_CARE_EMPLOYER;
}

export function getEvRefueling(year: number) {
  return getTaxConstants(year).EV_REFUELING;
}

export function getSolo401k(year: number) {
  return getTaxConstants(year).SOLO_401K;
}

export function getSepIra(year: number) {
  return getTaxConstants(year).SEP_IRA;
}

export function getPlausibility(year: number) {
  return getTaxConstants(year).PLAUSIBILITY;
}

export function getEitcBrackets(year: number) {
  return getTaxConstants(year).EITC_BRACKETS;
}

export function getEitcInvestmentIncomeLimit(year: number) {
  return getTaxConstants(year).INVESTMENT_INCOME_LIMIT;
}
