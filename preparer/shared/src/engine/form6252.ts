import { InstallmentSaleInfo, InstallmentSaleResult } from '../types/index.js';
import { parseDateString, round2 } from './utils.js';

/**
 * Form 6252 — Installment Sale Income (2025 form and instructions; Schedule D
 * instructions, Unrecaptured Section 1250 Gain Worksheet line 4).
 *
 * Part I (every year): contract price and gross profit. Ordinary income
 * recapture (line 12, Form 4797 Part III) is part of the basis figure every
 * year and is taxed in full in the year of sale. Part II: this year's
 * installment sale income is line 22 (line 17 in the year of sale, plus the
 * year's payments without interest) times the gross profit percentage (line
 * 19, 4 decimal places).
 *
 * Line 26 goes to Schedule D for a capital asset (short or long term), or to
 * Form 4797 for trade or business property: line 4 (section 1231) when held
 * more than 1 year, line 10 (ordinary) otherwise. For section 1250 property
 * held more than 1 year, the gain is unrecaptured section 1250 gain first,
 * until the sale's total (the smaller of depreciation or gain, less section
 * 1250 recapture) is used up across the years.
 *
 * Recapture: section 1245 property recaptures the smaller of the depreciation
 * or the gain. Real property placed in service after 1986 is depreciated
 * straight line, so an individual has no section 1250 recapture; earlier real
 * property is not figured. What the facts do not settle is listed in
 * `problems` (engine/unsupported.ts reports it).
 *
 * @authority IRC §453, §453A, §1245, §1250; Form 6252 and instructions (2025)
 */
export function calculateForm6252(info: InstallmentSaleInfo, taxYear?: number): InstallmentSaleResult {
  const problems: string[] = [];
  const line5 = Math.max(0, info.sellingPrice);
  const line6 = Math.max(0, info.mortgagesAssumedByBuyer || 0);
  const line7 = round2(line5 - line6);
  const line8 = Math.max(0, info.costOrBasis);
  const line9 = Math.max(0, info.depreciationAllowed || 0);
  const line10 = round2(line8 - line9);
  const line11 = Math.max(0, info.sellingExpenses || 0);
  // Form 4797 line 24: the total gain on the sale.
  const totalGain = round2(line5 - line10 - line11);

  const kind = info.propertyKind;
  let line12 = 0;
  if (kind === 'business_personal') {
    // Form 4797 line 25b: the smaller of the depreciation or the gain.
    line12 = round2(Math.max(0, Math.min(line9, totalGain)));
  } else if (kind === 'business_real') {
    const acquired = info.dateAcquired ? parseDateString(info.dateAcquired) : null;
    if (line9 > 0 && acquired && acquired.year < 1987) {
      problems.push('Real property acquired before 1987 may have section 1250 recapture of accelerated depreciation, which HATax does not figure.');
    }
  } else if (kind === 'capital_asset' && line9 > 0) {
    problems.push('A capital asset has no depreciation; property you depreciated is trade or business property.');
  }

  const line13 = round2(line10 + line11 + line12);
  const line14 = round2(line5 - line13);
  if (line14 <= 0) problems.push('The sale has no gain, so it is not an installment sale: report it in full on Form 8949 or Form 4797.');
  if (info.mainHome) problems.push("The sale of a main home uses Form 6252 line 15's excluded gain, which HATax does not figure.");
  const line16 = Math.max(0, line14);
  const line17 = round2(Math.max(0, line6 - line13));
  const line18 = round2(line7 + line17);
  const line19 = line18 > 0 ? Math.round((line16 / line18) * 10000) / 10000 : 0;

  const saleYear = parseDateString(info.dateOfSale ?? '')?.year;
  const yearOfSale = taxYear !== undefined && saleYear === taxYear;
  if (saleYear === undefined) problems.push('Enter the date of sale.');
  else if (taxYear !== undefined && saleYear > taxYear) problems.push(`The sale is dated ${saleYear}, after ${taxYear}.`);
  else if (saleYear < 1984 || (saleYear === 1984 && info.dateOfSale < '1984-06-07')) {
    problems.push('A sale before June 7, 1984 can carry recapture into later years (line 25), which HATax does not figure.');
  }

  const line20 = yearOfSale ? line17 : 0;
  const line21 = Math.max(0, info.paymentsReceivedThisYear);
  const line22 = round2(line20 + line21);
  const line23 = yearOfSale ? 0 : Math.max(0, info.paymentsReceivedPriorYears || 0);
  if (!yearOfSale && info.paymentsReceivedPriorYears === undefined) {
    problems.push('Enter the payments received in prior years (line 23).');
  }
  // Gain already reported in prior years; this year's cannot take the total past the gross profit.
  const priorGain = round2(line19 * line23);
  const line24 = round2(Math.max(0, Math.min(line22 * line19, line16 - priorGain)));
  const line26 = line24;

  if (info.relatedParty === true) {
    problems.push('A sale to a related party has its own rules (Part III, and no installment method for depreciable property), which HATax does not figure.');
  } else if (info.relatedParty === undefined) {
    problems.push('Answer whether the property was sold to a related party (line 3).');
  }

  const held = heldMoreThanOneYear(info.dateAcquired, info.dateOfSale);
  let disposition: InstallmentSaleResult['disposition'] = 'unknown';
  if (kind === undefined) problems.push('Enter what was sold: a capital asset, or trade or business property (personal or real).');
  if (held === undefined) problems.push('Enter the date acquired (line 2a), which sets the holding period.');
  if (kind !== undefined && held !== undefined) {
    disposition = kind === 'capital_asset'
      ? (held ? 'long_term_capital' : 'short_term_capital')
      : (held ? 'section1231' : 'ordinary');
  }

  let unrecaptured1250ThisYear = 0;
  if (kind === 'business_real' && held === true) {
    // Worksheet line 4, steps 1-3: no section 1250 recapture for straight-line property.
    const total = round2(Math.max(0, Math.min(line9, totalGain)));
    const remaining = round2(Math.max(0, total - priorGain));
    unrecaptured1250ThisYear = round2(Math.min(line26, remaining));
  }

  return {
    contractPrice: line18,
    grossProfit: line16,
    grossProfitRatio: line19,
    ordinaryIncomeRecapture: line12,
    installmentSaleIncome: line24,
    totalReportableIncome: line26,
    yearOfSale,
    recaptureThisYear: yearOfSale ? line12 : 0,
    disposition,
    unrecaptured1250ThisYear,
    outstandingAtYearEnd: round2(Math.max(0, line18 - line22 - line23)),
    problems,
  };
}

/**
 * Held more than one year (IRC §1222): the sale falls after the anniversary of
 * the acquisition (February 28 for February 29). Undefined without both dates.
 */
function heldMoreThanOneYear(acquired: string | undefined, sold: string | undefined): boolean | undefined {
  const a = acquired ? parseDateString(acquired) : null;
  const s = sold ? parseDateString(sold) : null;
  if (!a || !s) return undefined;
  const acquiredAt = Date.UTC(a.year, a.month, a.day);
  const soldAt = Date.UTC(s.year, s.month, s.day);
  if (soldAt < acquiredAt) return undefined;
  const leapDay = a.month === 1 && a.day === 29;
  return soldAt > Date.UTC(a.year + 1, a.month, leapDay ? 28 : a.day);
}
