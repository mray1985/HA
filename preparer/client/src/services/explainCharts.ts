/**
 * Chart data for the Explain tab, from the engine's result. Each item carries
 * the return section it comes from, so a click opens that part of the review.
 * Pure: only the return and its calculation go in.
 */

import type { CalculationResult, TaxReturn } from '@hatax/engine';
import { getExpenseCategories } from '../api/client';

export interface ChartItem {
  label: string;
  value: number;
  stepId: string;
}

export interface AmountItem {
  label: string;
  amount: number;
  stepId: string;
}

/** Income by source, as the engine counted it on Form 1040 (positive amounts only). */
export function incomeItems(calc: CalculationResult): ChartItem[] {
  const f = calc.form1040;
  return [
    { label: 'W-2 wages', value: f.totalWages, stepId: 'w2_income' },
    { label: 'Interest', value: f.totalInterest, stepId: '1099int_income' },
    { label: 'Dividends', value: f.totalDividends, stepId: '1099div_income' },
    { label: 'Business (Schedule C)', value: f.scheduleCNetProfit, stepId: 'se_summary' },
    { label: 'Capital gains', value: f.capitalGainOrLoss, stepId: '1099b_income' },
    { label: 'Retirement distributions', value: f.totalRetirementIncome, stepId: '1099r_income' },
    { label: 'Social Security (taxable)', value: f.taxableSocialSecurity, stepId: 'ssa1099_income' },
    { label: 'Unemployment', value: f.totalUnemployment, stepId: '1099g_income' },
    { label: 'Rental and royalty (Schedule E)', value: f.scheduleEIncome, stepId: 'rental_income' },
    { label: 'Other income (1099-MISC)', value: f.total1099MISCIncome, stepId: '1099misc_income' },
    { label: 'Partnership / S-corp (K-1)', value: f.k1OrdinaryIncome, stepId: 'k1_income' },
  ].filter((i) => (i.value ?? 0) > 0);
}

/** Adjustments to income (Schedule 1, part II), positive amounts only. */
export function adjustmentItems(calc: CalculationResult): AmountItem[] {
  const f = calc.form1040;
  return [
    { label: 'HSA deduction', amount: f.hsaDeduction || 0, stepId: 'hsa_contributions' },
    { label: 'Archer MSA deduction', amount: f.archerMSADeduction || 0, stepId: 'archer_msa' },
    { label: 'Student loan interest', amount: f.studentLoanInterest || 0, stepId: 'student_loan_ded' },
    { label: 'IRA deduction', amount: f.iraDeduction || 0, stepId: 'ira_contribution_ded' },
    { label: 'Educator expenses', amount: f.educatorExpenses || 0, stepId: 'educator_expenses_ded' },
    { label: 'Deductible part of SE tax', amount: f.seDeduction || 0, stepId: 'se_retirement' },
    { label: 'SE health insurance', amount: f.selfEmployedHealthInsurance || 0, stepId: 'se_health_insurance' },
    { label: 'SE retirement', amount: f.retirementContributions || 0, stepId: 'se_retirement' },
    { label: 'Alimony paid', amount: f.alimonyDeduction || 0, stepId: 'alimony_paid' },
    { label: 'Moving expenses', amount: f.movingExpenses || 0, stepId: 'other_income' },
    { label: 'Early withdrawal penalty', amount: f.earlyWithdrawalPenalty || 0, stepId: 'other_income' },
  ].filter((a) => a.amount > 0);
}

/** Props for the income → adjustments → deduction → taxable income flow. */
export function deductionsFlow(taxReturn: TaxReturn, calc: CalculationResult) {
  const f = calc.form1040;
  const a = calc.scheduleA;
  const isItemized = taxReturn.deductionMethod === 'itemized';
  const adjustments = adjustmentItems(calc);
  const deductions: AmountItem[] = a
    ? [
        { label: 'Medical and dental', amount: a.medicalDeduction || 0, stepId: 'medical_expenses' },
        { label: 'State and local taxes', amount: a.saltDeduction || 0, stepId: 'salt_deduction' },
        { label: 'Mortgage interest', amount: a.interestDeduction || 0, stepId: 'mortgage_interest_ded' },
        { label: 'Charitable', amount: a.charitableDeduction || 0, stepId: 'charitable_deduction' },
      ].filter((d) => d.amount > 0)
    : [];
  return {
    totalIncome: f.totalIncome || 0,
    adjustments,
    deductions,
    isItemized,
    totalAdjustments: adjustments.reduce((s, x) => s + x.amount, 0),
    agi: f.agi || 0,
    deductionAmount: f.deductionAmount,
    deductionLabel: isItemized ? 'Itemized deductions' : 'Standard deduction',
    qbiDeduction: f.qbiDeduction || 0,
    taxableIncome: f.taxableIncome || 0,
  };
}

/** Credits applied, nonrefundable and refundable, positive amounts only. */
export function creditItems(calc: CalculationResult): Array<ChartItem & { refundable: boolean }> {
  const c = calc.credits;
  return [
    { label: 'Child tax credit', value: c.childTaxCredit || 0, stepId: 'child_tax_credit', refundable: false },
    { label: 'Credit for other dependents', value: c.otherDependentCredit || 0, stepId: 'child_tax_credit', refundable: false },
    { label: 'Additional child tax credit', value: c.actcCredit || 0, stepId: 'child_tax_credit', refundable: true },
    { label: 'Education credit', value: c.educationCredit || 0, stepId: 'education_credits', refundable: false },
    { label: 'AOTC (refundable part)', value: c.aotcRefundableCredit || 0, stepId: 'education_credits', refundable: true },
    { label: 'Dependent care credit', value: c.dependentCareCredit || 0, stepId: 'dependent_care', refundable: false },
    { label: "Saver's credit", value: c.saversCredit || 0, stepId: 'savers_credit', refundable: false },
    { label: 'Clean energy credit', value: c.cleanEnergyCredit || 0, stepId: 'clean_energy', refundable: false },
    { label: 'Energy efficiency credit', value: c.energyEfficiencyCredit || 0, stepId: 'energy_efficiency', refundable: false },
    { label: 'Clean vehicle credit', value: c.evCredit || 0, stepId: 'ev_credit', refundable: false },
    { label: 'EV charging credit', value: c.evRefuelingCredit || 0, stepId: 'ev_refueling', refundable: false },
    { label: 'Scholarship credit', value: c.scholarshipCredit || 0, stepId: 'scholarship_credit', refundable: false },
    { label: 'Adoption credit', value: c.adoptionCredit || 0, stepId: 'adoption_credit', refundable: false },
    { label: 'Premium tax credit', value: c.premiumTaxCredit || 0, stepId: 'premium_tax_credit', refundable: true },
    { label: 'Elderly or disabled credit', value: c.elderlyDisabledCredit || 0, stepId: 'elderly_disabled', refundable: false },
    { label: 'Prior-year minimum tax credit', value: c.priorYearMinTaxCredit || 0, stepId: 'prior_year_amt_credit', refundable: false },
    { label: 'Foreign tax credit', value: c.foreignTaxCredit || 0, stepId: 'foreign_tax_credit', refundable: false },
    { label: 'Earned income credit', value: c.eitcCredit || 0, stepId: 'credits_overview', refundable: true },
    { label: 'Excess Social Security tax', value: c.excessSSTaxCredit || 0, stepId: 'credits_overview', refundable: true },
  ].filter((i) => i.value > 0);
}

const SPLIT_LINE_LABELS: Record<string, string> = { '24a': 'Travel', '24b': 'Business meals' };

/** Props for the Schedule C flow, or null when the return has no business. */
export function selfEmploymentFlow(calc: CalculationResult) {
  const c = calc.scheduleC;
  if (!c || (c.grossReceipts || 0) === 0 && (c.totalExpenses || 0) === 0) return null;
  const categories = getExpenseCategories();
  const byLine = new Map(categories.map((x) => [String(x.schedule_c_line), x.display_name]));
  const byKey = new Map(categories.map((x) => [x.category_key, x.display_name]));
  // Lines 9 (car and truck) and 13 (depreciation) are shown on their own.
  const expenses = Object.entries(c.lineItems || {})
    .filter(([line, amount]) => amount > 0 && line !== '9' && line !== '13')
    .map(([line, amount]) => ({ label: SPLIT_LINE_LABELS[line] || byLine.get(line) || byKey.get(line) || `Line ${line}`, amount, stepId: 'expense_categories' }))
    .sort((a, b) => b.amount - a.amount);
  const f = calc.form1040;
  return {
    grossReceipts: c.grossReceipts || 0,
    returnsAndAllowances: c.returnsAndAllowances || 0,
    otherBusinessIncome: c.otherBusinessIncome || 0,
    cogs: c.costOfGoodsSold || 0,
    totalExpenses: c.totalExpenses || 0,
    expenses,
    homeOffice: c.homeOfficeDeduction || 0,
    vehicle: c.vehicleDeduction || 0,
    depreciation: c.depreciationDeduction || 0,
    netProfit: c.netProfit || 0,
    seHealthInsurance: f.selfEmployedHealthInsurance || 0,
    seRetirement: f.retirementContributions || 0,
    seTaxDeductibleHalf: f.seDeduction || 0,
  };
}

/** Quarterly estimated payments and the required installments, or null when none were made or required. */
export function estimatedPayments(taxReturn: TaxReturn, calc: CalculationResult) {
  const quarters = (taxReturn.estimatedQuarterlyPayments ?? [0, 0, 0, 0]) as [number, number, number, number];
  const detail = calc.estimatedTaxPenalty?.quarterlyDetail;
  if (quarters.every((q) => !q) && !detail?.some((d) => d.requiredInstallment > 0)) return null;
  return { quarters, quarterlyDetail: detail };
}

/** Props for the AMT waterfall, or null when the engine computed no AMT figures. */
export function amtWaterfall(calc: CalculationResult) {
  const amt = calc.amt;
  if (!amt) return null;
  return {
    taxableIncome: amt.line1_taxableIncome,
    adjustmentsTotal: amt.amti - amt.line1_taxableIncome,
    exemption: amt.exemption,
    tentativeMinTax: amt.tentativeMinimumTax,
    regularTax: amt.regularTax,
    amtAmount: amt.amtAmount,
    applies: amt.applies,
  };
}
