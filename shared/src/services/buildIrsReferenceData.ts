/**
 * Dynamic IRS Reference Data Builder
 *
 * Generates a personalized block of IRS thresholds/limits for the AI chat
 * system prompt. Instead of hardcoding all constants, this pulls from the
 * engine's tax constants based on the user's filing status, current section,
 * and enabled income/deduction/credit types.
 *
 * Benefits:
 *   - Always in sync with the engine (single source of truth)
 *   - ~40-60% fewer tokens than embedding everything
 *   - Higher signal-to-noise → better model responses
 */

import { FilingStatus } from '../types/index.js';
import {
  getTaxBrackets,
  getStandardDeduction,
  getAdditionalStandardDeduction,
  getSeTax,
  getQbi,
  getScheduleA,
  getChildTaxCredit,
  getEducationCredits,
  getStudentLoanInterest,
  getHsa,
  getIra,
  getCapitalGainsRates,
  getNiit,
  getScheduleD,
  getDependentCare,
  getSaversCredit,
  getSocialSecurity,
  getActc,
  getEarlyDistribution,
  getCleanEnergy,
  getQcd,
  getHomeOffice,
  getEitcBrackets,
  getEitcInvestmentIncomeLimit,
} from '../constants/taxConstants.js';
import { getAMTConstants } from '../constants/amt.js';

// ─── Types ────────────────────────────────────────

export interface IrsReferenceDataOptions {
  filingStatus?: string;
  currentSection?: string;
  incomeDiscovery?: Record<string, string>;
  deductionMethod?: string;
  dependentCount?: number;
  taxYear?: number;
}

// ─── Filing Status Mapping ────────────────────────

const FS_MAP: Record<string, FilingStatus> = {
  single: FilingStatus.Single,
  married_filing_jointly: FilingStatus.MarriedFilingJointly,
  married_filing_separately: FilingStatus.MarriedFilingSeparately,
  head_of_household: FilingStatus.HeadOfHousehold,
  qualifying_surviving_spouse: FilingStatus.QualifyingSurvivingSpouse,
};

const FS_SHORT: Record<FilingStatus, string> = {
  [FilingStatus.Single]: 'Single',
  [FilingStatus.MarriedFilingJointly]: 'MFJ',
  [FilingStatus.MarriedFilingSeparately]: 'MFS',
  [FilingStatus.HeadOfHousehold]: 'HOH',
  [FilingStatus.QualifyingSurvivingSpouse]: 'QSS',
};

// ─── Helpers ──────────────────────────────────────

function $(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function formatBrackets(fs: FilingStatus, taxYear: number): string {
  const brackets = getTaxBrackets(taxYear)[fs];
  const label = FS_SHORT[fs];
  const parts = brackets.map((b: { rate: number; max: number }) => {
    const rate = `${(b.rate * 100).toFixed(0)}%`;
    return b.max === Infinity ? `${rate} above` : `${rate} to ${$(b.max)}`;
  });
  return `Tax Brackets (${label}): ${parts.join(' | ')}`;
}

function has(discovery: Record<string, string> | undefined, ...keys: string[]): boolean {
  if (!discovery) return false;
  return keys.some((k) => discovery[k] === 'yes');
}

// ─── Layer 1: Always-Include Baseline ─────────────

function buildBaseline(fs: FilingStatus, isMFS: boolean, taxYear: number): string[] {
  const lines: string[] = [];
  const STANDARD_DEDUCTION = getStandardDeduction(taxYear);
  const ADDL_STD = getAdditionalStandardDeduction(taxYear);
  const SA = getScheduleA(taxYear);

  // Standard deduction
  const stdDed = STANDARD_DEDUCTION[fs];
  const addlAmt = fs === FilingStatus.Single || fs === FilingStatus.HeadOfHousehold
    ? ADDL_STD.UNMARRIED
    : ADDL_STD.MARRIED;
  lines.push(`Standard Deduction (${FS_SHORT[fs]}): ${$(stdDed)} | Additional (65+ or blind): ${$(addlAmt)}`);

  // Brackets
  lines.push(formatBrackets(fs, taxYear));

  // SALT cap
  const saltCap = isMFS ? SA.SALT_CAP_MFS : SA.SALT_CAP;
  const saltFloor = isMFS ? SA.SALT_CAP_FLOOR_MFS : SA.SALT_CAP_FLOOR;
  const saltPhaseDown = isMFS ? SA.SALT_PHASE_DOWN_THRESHOLD_MFS : SA.SALT_PHASE_DOWN_THRESHOLD;
  lines.push(`SALT Cap: ${$(saltCap)} (OBBBA 2025-2029) | Phases down above ${$(saltPhaseDown)} MAGI | Floor ${$(saltFloor)}`);

  return lines;
}

// ─── Layer 2: Section-Emphasized Data ─────────────

function buildSectionData(fs: FilingStatus, isMFS: boolean, section: string, taxYear: number): string[] {
  const lines: string[] = [];
  const SE = getSeTax(taxYear);
  const Q = getQbi(taxYear);
  const CG = getCapitalGainsRates(taxYear);
  const SA = getScheduleA(taxYear);
  const H = getHsa(taxYear);
  const I = getIra(taxYear);
  const SL = getStudentLoanInterest(taxYear);
  const HO = getHomeOffice(taxYear);
  const CTC = getChildTaxCredit(taxYear);
  const EC = getEducationCredits(taxYear);
  const DC = getDependentCare(taxYear);
  const SC = getSaversCredit(taxYear);
  const CE = getCleanEnergy(taxYear);
  const SD = getScheduleD(taxYear);
  const SS = getSocialSecurity(taxYear);
  const NI = getNiit(taxYear);
  const ED = getEarlyDistribution(taxYear);
  const AMT = getAMTConstants(taxYear);

  switch (section) {
    case 'income':
    case 'self_employment':
    case 'selfEmployment': {
      lines.push(`SE Tax: ${(SE.RATE * 100).toFixed(1)}% (${(SE.SS_RATE * 100).toFixed(1)}% OASDI up to ${$(SE.SS_WAGE_BASE)} + ${(SE.MEDICARE_RATE * 100).toFixed(1)}% Medicare)`);
      const addlThreshold = fs === FilingStatus.MarriedFilingJointly || fs === FilingStatus.QualifyingSurvivingSpouse
        ? SE.ADDITIONAL_MEDICARE_THRESHOLD_MFJ
        : isMFS ? SE.ADDITIONAL_MEDICARE_THRESHOLD_MFS : SE.ADDITIONAL_MEDICARE_THRESHOLD_SINGLE;
      lines.push(`Additional Medicare Tax: 0.9% on SE income above ${$(addlThreshold)}`);
      lines.push(`QBI Deduction: ${(Q.RATE * 100).toFixed(0)}% of qualified business income. SSTB threshold: ${$(isMFS ? Q.THRESHOLD_SINGLE : (fs === FilingStatus.MarriedFilingJointly ? Q.THRESHOLD_MFJ : Q.THRESHOLD_SINGLE))}`);
      // Capital gains for investment income
      const cg0 = CG.THRESHOLD_0[fs];
      const cg15 = CG.THRESHOLD_15[fs];
      lines.push(`Capital Gains (${FS_SHORT[fs]}): 0% to ${$(cg0)} | 15% to ${$(cg15)} | 20% above`);
      break;
    }

    case 'deductions': {
      lines.push(`Medical Expense Floor: ${(SA.MEDICAL_AGI_THRESHOLD * 100).toFixed(1)}% of AGI`);
      const mortLimit = isMFS ? SA.MORTGAGE_LIMIT_MFS : SA.MORTGAGE_LIMIT;
      lines.push(`Mortgage Interest: Deductible on first ${$(mortLimit)} of acquisition debt`);
      lines.push(`HSA Limits: ${$(H.INDIVIDUAL_LIMIT)} (self) / ${$(H.FAMILY_LIMIT)} (family). Catch-up 55+: ${$(H.CATCH_UP_55_PLUS)}`);
      lines.push(`IRA Limit: ${$(I.MAX_CONTRIBUTION)} (${$(I.MAX_CONTRIBUTION + I.CATCH_UP_50_PLUS)} if 50+)`);
      const slPhaseOut = fs === FilingStatus.MarriedFilingJointly
        ? `${$(SL.PHASE_OUT_MFJ)}-${$(SL.PHASE_OUT_MFJ + SL.PHASE_OUT_RANGE_MFJ)}`
        : `${$(SL.PHASE_OUT_SINGLE)}-${$(SL.PHASE_OUT_SINGLE + SL.PHASE_OUT_RANGE_SINGLE)}`;
      lines.push(`Student Loan Interest: Up to ${$(SL.MAX_DEDUCTION)}. Phase-out ${slPhaseOut}`);
      lines.push(`Home Office (Simplified): ${$(HO.SIMPLIFIED_RATE)}/sq ft, max ${HO.SIMPLIFIED_MAX_SQFT} sq ft = ${$(HO.SIMPLIFIED_MAX_DEDUCTION)}`);
      break;
    }

    case 'credits': {
      lines.push(`Child Tax Credit: ${$(CTC.PER_CHILD)}/child under 17 | ${$(CTC.PER_OTHER_DEPENDENT)} per other dependent`);
      const ctcPhaseOut = fs === FilingStatus.MarriedFilingJointly
        ? $(CTC.PHASE_OUT_THRESHOLD_MFJ)
        : $(CTC.PHASE_OUT_THRESHOLD_SINGLE);
      lines.push(`  Phase-out at ${ctcPhaseOut} AGI | ACTC refundable max ${$(CTC.REFUNDABLE_MAX)}`);

      // EITC
      const EITC = getEitcBrackets(taxYear);
      const e0 = EITC[0], e1 = EITC[1], e2 = EITC[2], e3 = EITC[3];
      lines.push(`EITC Max Credit: ${$(e0.maxCredit)} (0 children) | ${$(e1.maxCredit)} (1) | ${$(e2.maxCredit)} (2) | ${$(e3.maxCredit)} (3+). Investment income limit: ${$(getEitcInvestmentIncomeLimit(taxYear))}`);

      // Education
      const aotcPO = fs === FilingStatus.MarriedFilingJointly
        ? `${$(EC.AOTC_PHASE_OUT_MFJ)}-${$(EC.AOTC_PHASE_OUT_MFJ + EC.AOTC_PHASE_OUT_RANGE_MFJ)}`
        : `${$(EC.AOTC_PHASE_OUT_SINGLE)}-${$(EC.AOTC_PHASE_OUT_SINGLE + EC.AOTC_PHASE_OUT_RANGE_SINGLE)}`;
      lines.push(`AOTC: Up to ${$(EC.AOTC_MAX)} (40% refundable). Phase-out ${aotcPO}`);
      lines.push(`LLC: Up to ${$(EC.LLC_MAX)}. Phase-out same ranges`);

      lines.push(`Dependent Care Credit: Up to ${$(DC.EXPENSE_LIMIT_ONE)} (1) / ${$(DC.EXPENSE_LIMIT_TWO_PLUS)} (2+). Rate ${(DC.MIN_RATE * 100).toFixed(0)}-${(DC.MAX_RATE * 100).toFixed(0)}%`);

      const saverMFJ = SC.MFJ_10;
      const saverSingle = SC.SINGLE_10;
      const saverLimit = fs === FilingStatus.MarriedFilingJointly ? saverMFJ : saverSingle;
      lines.push(`Saver's Credit: Up to ${$(SC.CONTRIBUTION_LIMIT)} eligible contributions. AGI limit ${$(saverLimit)} (${FS_SHORT[fs]})`);

      lines.push(`Clean Energy Credit: ${(CE.RATE * 100).toFixed(0)}% of qualified expenditures`);
      break;
    }

    case 'review':
    case 'state':
    case 'finish': {
      const amtExemption = isMFS ? AMT.EXEMPTION.MFS
        : fs === FilingStatus.MarriedFilingJointly || fs === FilingStatus.QualifyingSurvivingSpouse
          ? AMT.EXEMPTION.MFJ
          : AMT.EXEMPTION.SINGLE;
      const amtPhaseOut = isMFS ? AMT.PHASE_OUT.MFS
        : fs === FilingStatus.MarriedFilingJointly || fs === FilingStatus.QualifyingSurvivingSpouse
          ? AMT.PHASE_OUT.MFJ
          : AMT.PHASE_OUT.SINGLE;
      lines.push(`AMT Exemption: ${$(amtExemption)} (${FS_SHORT[fs]}). Phase-out starts at ${$(amtPhaseOut)}`);

      const capLossLimit = isMFS ? SD.CAPITAL_LOSS_LIMIT_MFS : SD.CAPITAL_LOSS_LIMIT;
      lines.push(`Capital Loss Limit: ${$(capLossLimit)}/year`);

      const ssBase = fs === FilingStatus.MarriedFilingJointly
        ? SS.MFJ_BASE_AMOUNT
        : SS.SINGLE_BASE_AMOUNT;
      lines.push(`Social Security Taxability: Provisional income threshold ${$(ssBase)} (${FS_SHORT[fs]})`);

      const niitThreshold = fs === FilingStatus.MarriedFilingJointly || fs === FilingStatus.QualifyingSurvivingSpouse
        ? NI.THRESHOLD_MFJ
        : isMFS ? NI.THRESHOLD_MFS : NI.THRESHOLD_SINGLE;
      lines.push(`NIIT: ${(NI.RATE * 100).toFixed(1)}% on net investment income if MAGI > ${$(niitThreshold)}`);
      break;
    }

    default: {
      // For myInfo, welcome, etc. — just include SE tax basics
      lines.push(`SE Tax: ${(SE.RATE * 100).toFixed(1)}% (12.4% OASDI up to ${$(SE.SS_WAGE_BASE)} + 2.9% Medicare)`);
      break;
    }
  }

  return lines;
}

// ─── Layer 3: Conditional Data ────────────────────

function buildConditionalData(
  fs: FilingStatus,
  isMFS: boolean,
  discovery: Record<string, string> | undefined,
  deductionMethod: string | undefined,
  dependentCount: number | undefined,
  taxYear: number,
): string[] {
  const lines: string[] = [];
  const added = new Set<string>();
  const SE = getSeTax(taxYear);
  const Q = getQbi(taxYear);
  const CG = getCapitalGainsRates(taxYear);
  const SA = getScheduleA(taxYear);
  const H = getHsa(taxYear);
  const I = getIra(taxYear);
  const SL = getStudentLoanInterest(taxYear);
  const HO = getHomeOffice(taxYear);
  const CTC = getChildTaxCredit(taxYear);
  const DC = getDependentCare(taxYear);
  const EC = getEducationCredits(taxYear);
  const SD = getScheduleD(taxYear);
  const SS = getSocialSecurity(taxYear);
  const NI = getNiit(taxYear);
  const ED = getEarlyDistribution(taxYear);
  const QCD = getQcd(taxYear);
  const AMT = getAMTConstants(taxYear);

  function addOnce(key: string, line: string) {
    if (!added.has(key)) {
      added.add(key);
      lines.push(line);
    }
  }

  // Self-employment
  if (has(discovery, '1099nec', '1099k')) {
    addOnce('se', `SE Tax: ${(SE.RATE * 100).toFixed(1)}% (OASDI up to ${$(SE.SS_WAGE_BASE)} + Medicare). Min threshold: ${$(SE.MINIMUM_EARNINGS_THRESHOLD)}`);
    addOnce('qbi', `QBI Deduction: ${(Q.RATE * 100).toFixed(0)}% of QBI. SSTB threshold: ${$(fs === FilingStatus.MarriedFilingJointly ? Q.THRESHOLD_MFJ : Q.THRESHOLD_SINGLE)}`);
    addOnce('homeoffice', `Home Office (Simplified): ${$(HO.SIMPLIFIED_RATE)}/sq ft, max ${$(HO.SIMPLIFIED_MAX_DEDUCTION)}`);
  }

  // Capital gains
  if (has(discovery, '1099b', '1099da')) {
    const cg0 = CG.THRESHOLD_0[fs];
    const cg15 = CG.THRESHOLD_15[fs];
    addOnce('capgains', `Capital Gains (${FS_SHORT[fs]}): 0% to ${$(cg0)} | 15% to ${$(cg15)} | 20% above`);
    const capLossLimit = isMFS ? SD.CAPITAL_LOSS_LIMIT_MFS : SD.CAPITAL_LOSS_LIMIT;
    addOnce('caploss', `Capital Loss Limit: ${$(capLossLimit)}/year`);
    const niitThreshold = fs === FilingStatus.MarriedFilingJointly ? NI.THRESHOLD_MFJ : (isMFS ? NI.THRESHOLD_MFS : NI.THRESHOLD_SINGLE);
    addOnce('niit', `NIIT: ${(NI.RATE * 100).toFixed(1)}% on net investment income if MAGI > ${$(niitThreshold)}`);
  }

  // Dividends
  if (has(discovery, '1099div')) {
    const cg0 = CG.THRESHOLD_0[fs];
    addOnce('qualdiv', `Qualified Dividends: Taxed at capital gains rates (0% up to ${$(cg0)} for ${FS_SHORT[fs]})`);
  }

  // HSA
  if (has(discovery, 'ded_hsa', '1099sa')) {
    addOnce('hsa', `HSA Limits: ${$(H.INDIVIDUAL_LIMIT)} (self) / ${$(H.FAMILY_LIMIT)} (family). Catch-up 55+: ${$(H.CATCH_UP_55_PLUS)}`);
  }

  // IRA / Retirement
  if (has(discovery, 'ded_ira', '1099r')) {
    addOnce('ira', `IRA Limit: ${$(I.MAX_CONTRIBUTION)} (${$(I.MAX_CONTRIBUTION + I.CATCH_UP_50_PLUS)} if 50+)`);
    if (has(discovery, '1099r')) {
      addOnce('earlydist', `Early Distribution Penalty: ${(ED.PENALTY_RATE * 100).toFixed(0)}% on non-exempt early withdrawals`);
      addOnce('qcd', `QCD: Up to ${$(QCD.MAX_AMOUNT)}/year from IRA to charity (age 70½+)`);
    }
  }

  // Student loan
  if (has(discovery, 'ded_student_loan')) {
    const slPO = fs === FilingStatus.MarriedFilingJointly
      ? `${$(SL.PHASE_OUT_MFJ)}-${$(SL.PHASE_OUT_MFJ + SL.PHASE_OUT_RANGE_MFJ)}`
      : `${$(SL.PHASE_OUT_SINGLE)}-${$(SL.PHASE_OUT_SINGLE + SL.PHASE_OUT_RANGE_SINGLE)}`;
    addOnce('studentloan', `Student Loan Interest: Up to ${$(SL.MAX_DEDUCTION)}. Phase-out ${slPO}`);
  }

  // Social Security
  if (has(discovery, 'ssa1099')) {
    const ssBase = fs === FilingStatus.MarriedFilingJointly ? SS.MFJ_BASE_AMOUNT : SS.SINGLE_BASE_AMOUNT;
    addOnce('ss', `Social Security Taxability: Up to 85% taxable. Provisional income threshold ${$(ssBase)} (${FS_SHORT[fs]})`);
  }

  // Child/dependent credits
  if ((dependentCount && dependentCount > 0) || has(discovery, 'child_credit')) {
    addOnce('ctc', `Child Tax Credit: ${$(CTC.PER_CHILD)}/child under 17 | ACTC refundable max ${$(CTC.REFUNDABLE_MAX)}`);
  }
  if (has(discovery, 'dependent_care')) {
    addOnce('depcare', `Dependent Care Credit: Up to ${$(DC.EXPENSE_LIMIT_ONE)} (1) / ${$(DC.EXPENSE_LIMIT_TWO_PLUS)} (2+). Rate ${(DC.MIN_RATE * 100).toFixed(0)}-${(DC.MAX_RATE * 100).toFixed(0)}%`);
  }

  // Education
  if (has(discovery, 'education_credit')) {
    addOnce('aotc', `AOTC: Up to ${$(EC.AOTC_MAX)} (40% refundable)`);
    addOnce('llc', `LLC: Up to ${$(EC.LLC_MAX)}`);
  }

  // Itemized deductions
  if (deductionMethod === 'itemized' || has(discovery, 'ded_mortgage', 'ded_property_tax', 'ded_charitable', 'ded_medical')) {
    const mortLimit = isMFS ? SA.MORTGAGE_LIMIT_MFS : SA.MORTGAGE_LIMIT;
    addOnce('mortgage', `Mortgage Interest: Deductible on first ${$(mortLimit)} of acquisition debt`);
    addOnce('medical', `Medical Expense Floor: ${(SA.MEDICAL_AGI_THRESHOLD * 100).toFixed(1)}% of AGI`);
  }

  // AMT
  if (has(discovery, 'amt_data')) {
    const amtEx = isMFS ? AMT.EXEMPTION.MFS
      : fs === FilingStatus.MarriedFilingJointly ? AMT.EXEMPTION.MFJ : AMT.EXEMPTION.SINGLE;
    addOnce('amt', `AMT Exemption: ${$(amtEx)} (${FS_SHORT[fs]})`);
  }

  return lines;
}

// ─── Main Export ──────────────────────────────────

/**
 * Build a personalized IRS reference data block for the AI system prompt.
 * Pulls directly from the engine's tax constants via year resolvers.
 */
export function buildIrsReferenceData(options: IrsReferenceDataOptions): string {
  const taxYear = options.taxYear ?? 2025;
  const fsString = options.filingStatus || 'single';
  const fs = FS_MAP[fsString] ?? FilingStatus.Single;
  const isMFS = fs === FilingStatus.MarriedFilingSeparately;

  const section = options.currentSection || '';

  const baseline = buildBaseline(fs, isMFS, taxYear);
  const sectionData = buildSectionData(fs, isMFS, section, taxYear);
  const conditional = buildConditionalData(
    fs, isMFS,
    options.incomeDiscovery,
    options.deductionMethod,
    options.dependentCount,
    taxYear,
  );

  // Deduplicate: if a conditional line is already covered by section data, skip it
  const sectionSet = new Set(sectionData);
  const filteredConditional = conditional.filter((line) => !sectionSet.has(line));

  const allLines = [
    `TAX YEAR ${taxYear} REFERENCE DATA (${FS_SHORT[fs]} filer):`,
    '',
    ...baseline,
    '',
    ...sectionData,
  ];

  if (filteredConditional.length > 0) {
    allLines.push('', ...filteredConditional);
  }

  return allLines.join('\n');
}
