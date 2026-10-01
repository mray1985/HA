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

import type { CalculationResult, Form8615Field, StateQuestion, TaxReturn, UnsupportedPattern } from '../types/index.js';
import { getTaxConstants } from '../constants/taxConstants.js';
import { calculateForm6252 } from './form6252.js';
import { specialDepreciationRate } from './form4562.js';
import { flatTaxConfigFor } from './state/flatTax.js';
import { getStateName } from './state/index.js';
import { NO_INCOME_TAX_STATES } from './state/stateRegistry.js';
import { assessIowa } from './state/ia.js';
import { assessIndiana } from './state/in.js';
import { assessPennsylvania } from './state/pa.js';
import { assessCalifornia } from './state/ca.js';
import { assessWashingtonCapitalGains } from './state/wa.js';

export type { UnsupportedPattern };

const STATE_ONLY = 'Prepare this return outside HATax, or remove the state, until it is supported.';

/** What each figure Form 8615 needs is, for the finding that asks for it. */
const FORM_8615_FIELDS: Record<Form8615Field, string> = {
  parentName: "the parent's name (line A)",
  parentSsn: "the parent's SSN (line B)",
  parentFilingStatus: "the parent's filing status (line C)",
  parentTaxableIncome: "the parent's taxable income, Form 1040 line 15 (line 6)",
  parentTax: "the parent's tax, Form 1040 line 16 without Form 4972 or 8814 tax or education credit recapture (line 10)",
  parentQualifiedDividends: "the parent's qualified dividends, Form 1040 line 3a (0 if none)",
  parentNetCapitalGain: "the parent's net capital gain (0 if none)",
  otherChildrenNetUnearnedIncome: "the total of line 5 of the parent's other children's Forms 8615 (line 7; 0 if none)",
  otherChildrenQualifiedDividends: "the qualified dividends included on line 7",
  otherChildrenNetCapitalGain: "the net capital gain included on line 7",
  childDirectlyConnectedDeductions: "the child's itemized deductions directly connected with the unearned income (line 2; 0 if none)",
  parentSpecialComputation: "whether the parent's tax used the Schedule D Tax Worksheet, Schedule J or the Foreign Earned Income Tax Worksheet",
};

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

    if (code === 'UT' && !flatTaxConfigFor('UT', year)?.utahTaxpayerCredit) {
      add('UT.TC40.TAXPAYER_CREDIT', code, 'state', `Utah's ${year} taxpayer tax credit amounts are not published in HATax yet, so its phase-out cannot be applied. ${STATE_ONLY}`);
    }
    if (code === 'DC' && calculation?.form1040.deductionUsed === 'itemized') {
      add('DC.ITEMIZED', code, 'state', `DC itemized deductions are not calculated (HATax applies DC's standard deduction). ${STATE_ONLY}`);
    }
    if (code === 'CA') {
      // California credits: what the return does not say, and amounts the FTB has not published for the year.
      out.push(...assessCalifornia(taxReturn, calculation).findings);
      // FTB 3885A: California's depreciation is figured from this year's
      // Form 4562 with no special depreciation and California's §179 limits.
      // An earlier year's §179 is California's only within its limits that year
      // ($25,000, reduced over $200,000 of §179 property placed in service).
      const byYear = new Map<number, { section179: number; cost: number }>();
      for (const a of taxReturn.depreciationAssets ?? []) {
        const placed = parseInt((a.dateInService || '').slice(0, 4), 10);
        if (!Number.isFinite(placed) || placed >= year) continue;
        const v = byYear.get(placed) ?? { section179: 0, cost: 0 };
        v.section179 += Math.max(0, a.priorSection179 ?? 0);
        if ((a.businessUsePercent ?? 100) > 50) v.cost += Math.max(0, a.cost) * Math.min(100, Math.max(0, a.businessUsePercent ?? 100)) / 100;
        byYear.set(placed, v);
      }
      for (const [placed, v] of byYear) {
        if (v.section179 > 0 && (v.section179 > 25000 || v.cost > 200000)) {
          add('CA.DEPRECIATION', code, 'state', `California depreciation: the ${placed} federal §179 expense on assets still depreciated ($${Math.round(v.section179).toLocaleString('en-US')}) is beyond what California allowed that year (FTB 3885A: $25,000, reduced over $200,000 of §179 property), so their California basis is not figured. ${STATE_ONLY}`);
        }
      }
      if ((calculation?.form4562?.section179Carryforward ?? 0) > 0) {
        add('CA.DEPRECIATION', code, 'state', `California depreciation: the federal §179 deduction is limited by business income this year; California's limit uses California business income, which is not figured. ${STATE_ONLY}`);
      }
      const software = (taxReturn.depreciationAssets ?? []).filter((a) => a.isSoftware && !a.disposed && parseInt((a.dateInService || '').slice(0, 4), 10) < year);
      if (software.length > 0) {
        add('CA.DEPRECIATION', code, 'state', `California amortization of software placed in service in an earlier year (${software.map((a) => a.description || a.id).join(', ')}) is not figured. ${STATE_ONLY}`);
      }
      if (taxReturn.vehicle?.method === 'actual' && (taxReturn.vehicle.vehicleCost ?? 0) > 0) {
        add('CA.DEPRECIATION', code, 'state', `California depreciation of the vehicle (no §168(k) special depreciation, so a different basis and §280F limits) is not figured. ${STATE_ONLY}`);
      }
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

  // Form 8829 line 41: the depreciation percentage depends on when the home was
  // first used for business; before May 13, 1993 other rules apply (Pub 946).
  const home = taxReturn.homeOffice;
  if (home?.method === 'actual' && (home.homeCostOrValue ?? 0) > 0) {
    const first = home.dateFirstUsedForBusiness;
    if (!first) {
      out.push({ ruleId: 'FED.FORM8829.LINE41', jurisdiction: 'US', section: 'federal', itemId: 'homeOffice',
        message: 'Home office depreciation: enter the date the home was first used for business (Form 8829 line 41 depends on it).' });
    } else if (first < '1993-05-13') {
      out.push({ ruleId: 'FED.FORM8829.LINE41', jurisdiction: 'US', section: 'federal', itemId: 'homeOffice',
        message: `Home office first used for business ${first}, before May 13, 1993: its depreciation percentage (Pub 946) is not figured by HATax.` });
    }
  }

  // A standard mileage rate that changes on July 1 (2026: Notice 2026-10 and
  // Announcement 2026-11) needs the business miles driven from July 1.
  const mileage = calculation?.scheduleC?.vehicleResult;
  if (vehicle?.method === 'standard_mileage' && mileage?.mileageSplitNeeded) {
    const over = vehicle.businessMilesFromJuly1 !== undefined && vehicle.businessMilesFromJuly1 > (vehicle.businessMiles ?? 0);
    out.push({
      ruleId: 'FED.VEHICLE.STANDARD_MILEAGE_SPLIT', jurisdiction: 'US', section: 'federal', itemId: 'vehicle',
      message: over
        ? `The business miles from July 1 (${vehicle.businessMilesFromJuly1}) are more than the year's business miles (${vehicle.businessMiles ?? 0}).`
        : `The ${year} standard mileage rate is 72.5 cents a mile before July 1 and 76 cents from July 1 (Notice 2026-10, Announcement 2026-11): enter the business miles driven on or after July 1. Until then every mile is at 72.5 cents.`,
    });
  }

  // IRC §170(p), from 2026: a return that does not itemize deducts cash given to
  // public charities, up to $1,000 ($2,000 joint). Donations on file do not say
  // which were to public charities (not a donor advised fund, supporting
  // organization or private foundation), so the preparer enters the amount.
  if (getTaxConstants(year).NON_ITEMIZER_CHARITABLE && calculation?.form1040.deductionUsed === 'standard'
      && taxReturn.nonItemizerCharitableCash === undefined && taxReturn.incomeDiscovery?.ded_charitable !== 'no'
      && ((taxReturn.itemizedDeductions?.charitableCash ?? 0) > 0 || taxReturn.incomeDiscovery?.ded_charitable === 'yes')) {
    const cash = taxReturn.itemizedDeductions?.charitableCash ?? 0;
    out.push({
      ruleId: 'FED.170P.NON_ITEMIZER', jurisdiction: 'US', section: 'federal', itemId: 'charitable',
      message: `${year}: the return takes the standard deduction${cash > 0 ? ` and has $${cash.toLocaleString('en-US')} of cash donations` : ' and the client gave to charity'}. Enter the cash given to public charities (not a donor advised fund, supporting organization or private foundation): up to $1,000 ($2,000 joint) is deducted (IRC §170(p)). Enter 0 if none qualifies.`,
    });
  }

  // K-1 box 9c: the Unrecaptured Section 1250 Gain Worksheet takes a partnership's
  // or S corporation's amount with its section 1231 gain (line 5) and an estate's
  // or trust's directly (line 11), so the kind of K-1 decides where it goes.
  for (const k1 of taxReturn.incomeK1 ?? []) {
    if ((k1.unrecapturedSection1250Gain ?? 0) > 0 && !(['partnership', 's_corp', 'estate', 'trust'] as const).includes(k1.entityType)) {
      out.push({
        ruleId: 'FED.K1.ENTITY_TYPE', jurisdiction: 'US', section: 'federal', itemId: k1.id,
        message: `K-1${k1.entityName ? ` from ${k1.entityName}` : ''}: it reports unrecaptured section 1250 gain, but not whether it is from a partnership, S corporation, estate or trust, which decides how Schedule D takes the gain. Enter the kind of K-1.`,
      });
    }
  }

  // Form 6252: an installment sale whose facts do not settle where its gain goes.
  const installment = (taxReturn.installmentSales ?? []).map((sale) => ({ sale, result: calculateForm6252(sale, year) }));
  for (const { sale, result } of installment) {
    if (result.problems.length === 0) continue;
    out.push({
      ruleId: 'FED.FORM6252', jurisdiction: 'US', section: 'federal', itemId: sale.id,
      message: `Installment sale${sale.description ? ` (${sale.description})` : ''}: ${result.problems.join(' ')}`,
    });
  }
  // IRC §453A: interest on the deferred tax once obligations from sales over $150,000
  // outstanding at the end of the year are more than $5,000,000.
  const outstanding = installment.filter(({ sale }) => sale.sellingPrice > 150000).reduce((s, { result }) => s + result.outstandingAtYearEnd, 0);
  if (outstanding > 5000000) {
    add('FED.453A', 'US', 'federal', `Installment sales: $${outstanding.toLocaleString('en-US')} is still owed on sales over $150,000, more than $5,000,000, so interest is due on the deferred tax (IRC §453A). HATax does not figure it.`);
  }

  // Form 8615 (engine/form8615.ts): whether it applies, the parent's figures it takes, what it cannot figure.
  const form8615 = calculation?.form8615;
  if (form8615?.status === 'ask') {
    const kiddie = getTaxConstants(year).KIDDIE_TAX;
    out.push({
      ruleId: 'FED.8615.APPLIES', jurisdiction: 'US', section: 'federal', itemId: 'applies',
      message: `${form8615.age !== undefined ? `The taxpayer is ${form8615.age} at the end of ${year}` : 'The taxpayer can be claimed as a dependent'} and has $${form8615.unearnedIncome.toLocaleString('en-US')} of unearned income, more than $${kiddie.UNEARNED_INCOME_THRESHOLD.toLocaleString('en-US')}. Form 8615 taxes it at the parent's rate when the child must file a return and was under 18, or was 18 or a full-time student under 24 whose earned income was not more than half of their support, at least one parent was alive at the end of the year, and the child does not file a joint return. Say whether Form 8615 applies.`,
    });
  } else if (form8615?.status === 'missing') {
    for (const field of form8615.missing) {
      out.push({ ruleId: 'FED.8615.PARENT', jurisdiction: 'US', section: 'federal', itemId: field, message: `Form 8615: ${FORM_8615_FIELDS[field]} is not entered.` });
    }
  } else if (form8615?.status === 'figured') {
    for (const u of form8615.result.unsupported) out.push({ ruleId: u.ruleId, jurisdiction: 'US', section: 'federal', message: u.message });
  }
  // A child's unearned income listed on this return was once estimated at a guessed
  // parent rate; that is Form 8814's job, which HATax does not do.
  const kiddieEntries = taxReturn.kiddieTaxEntries?.length ? taxReturn.kiddieTaxEntries : taxReturn.kiddieTax ? [taxReturn.kiddieTax] : [];
  if (kiddieEntries.some((e) => (e.childUnearnedIncome ?? 0) > 0)) {
    add('FED.8814', 'US', 'federal', 'This return lists a child\'s unearned income for the kiddie tax. A child\'s Form 8615 is figured on the child\'s own return, and reporting the child\'s interest and dividends on the parent\'s return (Form 8814) is not supported, so nothing is added here. Prepare Form 8814 outside HATax, or remove the entry and figure Form 8615 on the child\'s return.');
  }

  // TAX-002: Pennsylvania's eight income classes (state/pa.ts) — what the return does not settle.
  out.push(...assessPennsylvania(taxReturn, calculation).findings);

  // TAX-007: Iowa's IA 1040 and school district / EMS surtax (state/ia.ts) — what the return does not settle.
  out.push(...assessIowa(taxReturn, calculation).findings);

  // TAX-006: Indiana county tax and exemptions (state/in.ts) — what the return does not settle.
  out.push(...assessIndiana(taxReturn, calculation?.form1040.agi).findings);

  // TAX-003: Washington's capital gains tax (state/wa.ts) — what the return does not settle.
  if (calculation) out.push(...assessWashingtonCapitalGains(taxReturn, calculation).findings);

  return out;
}

/**
 * Every question a state rule on this return asks, answered or not, so an
 * answer can be seen and changed. The findings hold only the open ones.
 */
export function stateQuestions(taxReturn: TaxReturn, calculation?: CalculationResult | null): StateQuestion[] {
  return [
    ...assessPennsylvania(taxReturn, calculation).questions,
    ...assessIowa(taxReturn, calculation).questions,
    ...assessIndiana(taxReturn, calculation?.form1040.agi).questions,
    ...(calculation ? assessWashingtonCapitalGains(taxReturn, calculation).questions : []),
    ...assessCalifornia(taxReturn, calculation).questions,
  ];
}

/** The findings about one state, for its result. */
export function unsupportedForState(patterns: readonly UnsupportedPattern[], stateCode: string): string[] {
  return patterns.filter((p) => p.section === 'state' && p.jurisdiction === stateCode.toUpperCase()).map((p) => p.message);
}
