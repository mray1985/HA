/**
 * State Calculator Registry — Maps state codes to calculation modules.
 *
 * All 50 states + DC are registered here. States fall into four categories:
 *   1. No-income-tax states (9) — return zero result
 *   2. Flat-tax states (13) — via createFlatTaxCalculator()
 *   3. Progressive-tax states (20) — via createProgressiveTaxCalculator()
 *   4. Custom calculators (9) — CA, NY, NJ, OH, WI, CT, MD, AL, HI
 */

import {
  TaxReturn, CalculationResult, StateCalculationResult, StateReturnConfig,
} from '../../types/index.js';

// Custom state calculators
import { calculateNewYork } from './ny.js';
import { calculateCalifornia } from './ca.js';
import { calculateNewJersey } from './nj.js';
import { calculateOhio } from './oh.js';
import { calculateWisconsin } from './wi.js';
import { calculateConnecticut } from './ct.js';
import { calculateMaryland } from './md.js';
import { calculateAlabama } from './al.js';
import { calculateHawaii } from './hi.js';
import { createNHCalculator } from './nh.js';

// Factories
import { createFlatTaxCalculator } from './flatTax.js';
import { createProgressiveTaxCalculator } from './progressiveTax.js';

// Progressive state configs
import {
  VA_CONFIG, MN_CONFIG, OR_CONFIG, MO_CONFIG, SC_CONFIG,
  MS_CONFIG, KS_CONFIG, OK_CONFIG, AR_CONFIG, ID_CONFIG,
  ND_CONFIG, RI_CONFIG, WV_CONFIG, ME_CONFIG, NM_CONFIG,
  MT_CONFIG, NE_CONFIG, VT_CONFIG, DE_CONFIG, DC_CONFIG,
} from '../../constants/states/progressiveTax.js';

/** Interface that all state calculators implement. */
export interface StateCalculator {
  calculate(
    taxReturn: TaxReturn,
    federalResult: CalculationResult,
    config: StateReturnConfig,
  ): StateCalculationResult;
}

/** States with no income tax — immediate zero result. */
export const NO_INCOME_TAX_STATES = [
  'AK', // Alaska
  'FL', // Florida
  'NV', // Nevada
  'SD', // South Dakota
  'TN', // Tennessee (Hall tax fully repealed 2021)
  'TX', // Texas
  'WA', // Washington (no income tax; capital gains excise tax is separate)
  'WY', // Wyoming
];

/** Flat-tax states — single rate with simple deductions. */
export const FLAT_TAX_STATES = [
  'AZ', // 2.5%
  'CO', // 4.4%
  'GA', // 5.19% (HB 111, retroactive TY2025)
  'IA', // 3.8%
  'IL', // 4.95%
  'IN', // 3.0%
  'KY', // 4.0%
  'LA', // 3.0% (Act 11 reform TY2025)
  'MA', // 5.0%
  'MI', // 4.25%
  'NC', // 4.25%
  'PA', // 3.07%
  'UT', // 4.5%
];

/** Progressive-tax states — graduated brackets via factory. */
export const PROGRESSIVE_TAX_STATES = [
  'AR', 'DC', 'DE', 'ID', 'KS', 'ME', 'MN', 'MO', 'MS', 'MT',
  'ND', 'NE', 'NM', 'OK', 'OR', 'RI', 'SC', 'VA', 'VT', 'WV',
];

/** Registry of implemented state calculators — factories that create calculators per tax year. */
const CALCULATOR_FACTORIES: Record<string, (taxYear: number) => StateCalculator> = {
  // Custom calculators (complex state-specific rules) - these need to be wrapped to accept taxYear
  CA: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateCalifornia(taxReturn, federalResult, config) }),
  NY: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateNewYork(taxReturn, federalResult, config) }),
  NJ: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateNewJersey(taxReturn, federalResult, config) }),
  OH: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateOhio(taxReturn, federalResult, config) }),
  WI: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateWisconsin(taxReturn, federalResult, config) }),
  CT: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateConnecticut(taxReturn, federalResult, config) }),
  MD: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateMaryland(taxReturn, federalResult, config) }),
  AL: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateAlabama(taxReturn, federalResult, config) }),
  HI: (taxYear: number) => ({ calculate: (taxReturn, federalResult, config) => calculateHawaii(taxReturn, federalResult, config) }),
  NH: (taxYear: number) => createNHCalculator(),

  // Flat-tax states
  PA: (taxYear: number) => createFlatTaxCalculator('PA', taxYear),
  IL: (taxYear: number) => createFlatTaxCalculator('IL', taxYear),
  MA: (taxYear: number) => createFlatTaxCalculator('MA', taxYear),
  NC: (taxYear: number) => createFlatTaxCalculator('NC', taxYear),
  MI: (taxYear: number) => createFlatTaxCalculator('MI', taxYear),
  IN: (taxYear: number) => createFlatTaxCalculator('IN', taxYear),
  CO: (taxYear: number) => createFlatTaxCalculator('CO', taxYear),
  KY: (taxYear: number) => createFlatTaxCalculator('KY', taxYear),
  UT: (taxYear: number) => createFlatTaxCalculator('UT', taxYear),
  GA: (taxYear: number) => createFlatTaxCalculator('GA', taxYear),
  AZ: (taxYear: number) => createFlatTaxCalculator('AZ', taxYear),
  LA: (taxYear: number) => createFlatTaxCalculator('LA', taxYear),
  IA: (taxYear: number) => createFlatTaxCalculator('IA', taxYear),

  // Progressive-tax states
  VA: (taxYear: number) => createProgressiveTaxCalculator(VA_CONFIG, taxYear),
  MN: (taxYear: number) => createProgressiveTaxCalculator(MN_CONFIG, taxYear),
  OR: (taxYear: number) => createProgressiveTaxCalculator(OR_CONFIG, taxYear),
  MO: (taxYear: number) => createProgressiveTaxCalculator(MO_CONFIG, taxYear),
  SC: (taxYear: number) => createProgressiveTaxCalculator(SC_CONFIG, taxYear),
  MS: (taxYear: number) => createProgressiveTaxCalculator(MS_CONFIG, taxYear),
  KS: (taxYear: number) => createProgressiveTaxCalculator(KS_CONFIG, taxYear),
  OK: (taxYear: number) => createProgressiveTaxCalculator(OK_CONFIG, taxYear),
  AR: (taxYear: number) => createProgressiveTaxCalculator(AR_CONFIG, taxYear),
  ID: (taxYear: number) => createProgressiveTaxCalculator(ID_CONFIG, taxYear),
  ND: (taxYear: number) => createProgressiveTaxCalculator(ND_CONFIG, taxYear),
  RI: (taxYear: number) => createProgressiveTaxCalculator(RI_CONFIG, taxYear),
  WV: (taxYear: number) => createProgressiveTaxCalculator(WV_CONFIG, taxYear),
  ME: (taxYear: number) => createProgressiveTaxCalculator(ME_CONFIG, taxYear),
  NM: (taxYear: number) => createProgressiveTaxCalculator(NM_CONFIG, taxYear),
  MT: (taxYear: number) => createProgressiveTaxCalculator(MT_CONFIG, taxYear),
  NE: (taxYear: number) => createProgressiveTaxCalculator(NE_CONFIG, taxYear),
  VT: (taxYear: number) => createProgressiveTaxCalculator(VT_CONFIG, taxYear),
  DE: (taxYear: number) => createProgressiveTaxCalculator(DE_CONFIG, taxYear),
  DC: (taxYear: number) => createProgressiveTaxCalculator(DC_CONFIG, taxYear),
};

/** Cache of calculators by state code and tax year. */
const CALCULATOR_CACHE = new Map<string, StateCalculator>();

/**
 * Get the calculator for a state and tax year. Returns null if the state isn't implemented yet.
 */
export function getStateCalculator(stateCode: string, taxYear: number = 2025): StateCalculator | null {
  const key = `${stateCode.toUpperCase()}:${taxYear}`;
  if (CALCULATOR_CACHE.has(key)) {
    return CALCULATOR_CACHE.get(key)!;
  }
  const factory = CALCULATOR_FACTORIES[stateCode.toUpperCase()];
  if (!factory) return null;
  const calc = factory(taxYear);
  CALCULATOR_CACHE.set(key, calc);
  return calc;
}

/**
 * Check if a state's tax calculation is supported.
 */
export function isStateSupported(stateCode: string): boolean {
  const code = stateCode.toUpperCase();
  return NO_INCOME_TAX_STATES.includes(code) || code in CALCULATOR_FACTORIES;
}

/**
 * Get all supported state codes.
 */
export function getSupportedStates(): string[] {
  return [...NO_INCOME_TAX_STATES, ...Object.keys(CALCULATOR_FACTORIES)];
}
