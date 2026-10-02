/**
 * Last year's totals and documents, from an HA Tax return and its calculation:
 * an imported HA Tax export, or last year's case in this app.
 */

import { FilingStatus, type CalculationResult, type PriorYearSummary, type TaxReturn } from '@hatax/engine';
import { documentsFromReturn } from '@hatax/local-ai';

export function priorYearSummaryFromReturn(tr: TaxReturn, result: CalculationResult, source: 'hatax-json' | 'hatax-case'): PriorYearSummary {
  const f = result.form1040;
  return {
    source,
    taxYear: tr.taxYear,
    filingStatus: tr.filingStatus !== undefined ? FilingStatus[tr.filingStatus] : undefined,
    totalIncome: f.totalIncome,
    agi: f.agi,
    taxableIncome: f.taxableIncome,
    deductionAmount: f.deductionAmount,
    totalTax: f.totalTax,
    totalCredits: f.totalCredits,
    totalPayments: f.totalPayments,
    refundAmount: f.refundAmount,
    amountOwed: f.amountOwed,
    effectiveTaxRate: f.effectiveTaxRate,
    // Detailed breakdown from JSON import
    totalWages: f.totalWages,
    totalInterest: f.totalInterest,
    totalDividends: f.totalDividends,
    scheduleCNetProfit: f.scheduleCNetProfit,
    capitalGainOrLoss: f.capitalGainOrLoss,
    seTax: f.seTax,
    // Enhanced breakdown
    estimatedTaxPayments: f.estimatedPayments > 0 ? f.estimatedPayments : undefined,
    iraDistributions: f.iraDistributionsTaxable > 0 ? f.iraDistributionsTaxable : undefined,
    pensionsAnnuities: f.pensionDistributionsTaxable > 0 ? f.pensionDistributionsTaxable : undefined,
    socialSecurityBenefits: f.taxableSocialSecurity > 0 ? f.taxableSocialSecurity : undefined,
    // Each payer's document, for the missing-document check (work order §23).
    documents: documentsFromReturn(tr),
  };
}
