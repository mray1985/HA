/**
 * Fail closed (TY2025 rule corpus, Bible §13): a situation the engine cannot
 * compute to the official rules is reported as unsupported instead of being
 * approximated. The return still calculates, so the preparer sees the rest,
 * but each finding blocks approval and export, and the state result it
 * concerns carries it.
 *
 * Each finding names the corpus rule it stands for. Remove a check only when
 * the engine implements that rule from its official source.
 */

import type { CalculationResult, StateQuestion, TaxReturn, UnsupportedPattern } from '../types/index.js';
import { specialDepreciationRate } from './form4562.js';
import { flatTaxConfigFor } from './state/flatTax.js';
import { getStateName } from './state/index.js';
import { NO_INCOME_TAX_STATES } from './state/stateRegistry.js';
import { assessWashingtonCapitalGains } from './state/wa.js';

export type { UnsupportedPattern };

const STATE_ONLY = 'Prepare this return outside HATax, or remove the state, until it is supported.';

export function findUnsupportedPatterns(taxReturn: TaxReturn, calculation?: CalculationResult | null): UnsupportedPattern[] {
  const out: UnsupportedPattern[] = [];
  const year = taxReturn.taxYear || 2025;
  const states = taxReturn.stateReturns ?? [];
  const add = (ruleId: string, jurisdiction: string, section: UnsupportedPattern['section'], message: string) =>
    out.push({ ruleId, jurisdiction, section, message });

  for (const s of states) {
    const code = s.stateCode.toUpperCase();
    const name = getStateName(code);
    const taxed = !(NO_INCOME_TAX_STATES as readonly string[]).includes(code);

    // TAX-008: part-year and nonresident returns would prorate all income by days
    // (allocation.ts); every state sources income by its own rules.
    if (taxed && (s.residencyType === 'part_year' || s.residencyType === 'nonresident')) {
      add('TAX-008', code, 'state', `${name} ${s.residencyType === 'part_year' ? 'part-year' : 'nonresident'} return: ${name} income sourcing is not built — HATax would prorate all income by days lived in the state, which ${name}'s rules do not allow. ${STATE_ONLY}`);
    }

    // A state the engine has no calculator for this year: no result, or a $0 result marked unavailable.
    const result = calculation?.stateResults?.find((r) => r.stateCode === code);
    if (taxed && calculation && (!result || result.additionalLines?.unavailable === 1)) {
      add('STATE.YEAR.NOT_SUPPORTED', code, 'state', `${name} tax for ${year} is not calculated by HATax. ${STATE_ONLY}`);
    }

    if (code === 'IN') {
      add('TAX-006', code, 'state', `Indiana county income tax (Schedule CT-40 / CT-40PNR) is not calculated yet. ${STATE_ONLY}`);
    }
    if (code === 'IA' && s.residencyType !== 'nonresident') {
      add('TAX-007', code, 'state', `Iowa school district and EMS surtax is not calculated yet. ${STATE_ONLY}`);
    }
    if (code === 'PA') {
      add('TAX-002', code, 'state', `Pennsylvania taxes eight classes of income separately, without netting a loss in one against another; HATax computes it from federal AGI. ${STATE_ONLY}`);
    }
    if (code === 'UT' && !flatTaxConfigFor('UT', year)?.utahTaxpayerCredit) {
      add('UT.TC40.TAXPAYER_CREDIT', code, 'state', `Utah's ${year} taxpayer tax credit amounts are not published in HATax yet, so its phase-out cannot be applied. ${STATE_ONLY}`);
    }
    if (code === 'DC' && calculation?.form1040.deductionUsed === 'itemized') {
      add('DC.ITEMIZED', code, 'state', `DC itemized deductions are not calculated (HATax applies DC's standard deduction). ${STATE_ONLY}`);
    }
  }

  // TAX-001: special depreciation whose rate the facts do not settle.
  for (const asset of taxReturn.depreciationAssets ?? []) {
    if (asset.disposed) continue;
    const placed = parseInt((asset.dateInService || '').slice(0, 4), 10);
    if (!Number.isFinite(placed) || placed > year) continue;
    const { unsettled } = specialDepreciationRate(asset, placed);
    if (!unsettled) continue;
    const name = asset.description?.trim() || 'An asset';
    out.push({
      ruleId: 'FED.BONUS_DEPRECIATION.168K', jurisdiction: 'US', section: 'depreciation', itemId: asset.id,
      message: `${name} (placed in service ${asset.dateInService}): special depreciation cannot be figured — ${unsettled}.${!asset.acquisitionDate ? ' Enter the date it was acquired (for a written binding contract, the date of the contract).' : ''}`,
    });
  }
  const vehicle = taxReturn.vehicle;
  const vehicleYear = parseInt((vehicle?.dateInService || '').slice(0, 4), 10);
  const vehicleUse = vehicle?.totalMiles ? (vehicle.businessMiles ?? 0) / vehicle.totalMiles : 0;
  if (vehicle?.method === 'actual' && vehicleYear === year && year >= 2025 && vehicleUse > 0.5
      && (!vehicle.acquisitionDate || vehicle.acquisitionDate <= '2025-01-19')) {
    out.push({
      ruleId: 'FED.BONUS_DEPRECIATION.168K', jurisdiction: 'US', section: 'depreciation', itemId: 'vehicle',
      message: vehicle.acquisitionDate
        ? `The vehicle was acquired before January 20, 2025: its special depreciation (40%) and first-year limit are not built.`
        : `The vehicle's special depreciation cannot be figured: enter the date it was acquired (a vehicle acquired before January 20, 2025 gets 40%, not 100%).`,
    });
  }

  // TAX-003: Washington's capital gains tax (state/wa.ts) — what the return does not settle.
  if (calculation) out.push(...assessWashingtonCapitalGains(taxReturn, calculation).findings);

  return out;
}

/**
 * Every question a state rule on this return asks, answered or not, so an
 * answer can be seen and changed. The findings hold only the open ones.
 */
export function stateQuestions(taxReturn: TaxReturn, calculation?: CalculationResult | null): StateQuestion[] {
  return calculation ? assessWashingtonCapitalGains(taxReturn, calculation).questions : [];
}

/** The findings about one state, for its result. */
export function unsupportedForState(patterns: readonly UnsupportedPattern[], stateCode: string): string[] {
  return patterns.filter((p) => p.section === 'state' && p.jurisdiction === stateCode.toUpperCase()).map((p) => p.message);
}
