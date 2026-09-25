/**
 * Flat-Tax State Constants — Tax Year 2024
 *
 * Pre-Act 11 Louisiana (graduated brackets), NC 4.5% rate, etc.
 * Source: State revenue department 2024 instructions.
 */

import type { FlatTaxStateConfig } from './flatTax.js';

export const FLAT_TAX_CONSTANTS_2024: Record<string, FlatTaxStateConfig> = {
  PA: {
    stateCode: 'PA',
    rate: 0.0307,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 0,
    dependentExemption: 0,
    skipSocialSecuritySubtraction: false,
    notes: 'PA taxes most income types at a flat 3.07% with virtually no deductions.',
  },

  IL: {
    stateCode: 'IL',
    rate: 0.0495,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 2775,
    dependentExemption: 2775,
    notes: 'IL uses a per-person exemption of $2,775 for taxpayer, spouse, and each dependent (TY2024).',
  },

  MA: {
    stateCode: 'MA',
    rate: 0.05,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 4400,
    dependentExemption: 1000,
    shortTermCapitalGainsRate: 0.085,
    longTermCapitalGainsRate: 0.05,
    collectiblesCapitalGainsRate: 0.12,
    surtax: { threshold: 1000000, rate: 0.04 },
    notes: 'MA Part A (5%), ST cap gains (8.5%), LT cap gains (5%), LT collectibles (12%). 4% surtax on income > $1M (TY2024).',
  },

  NC: {
    stateCode: 'NC',
    rate: 0.045,
    standardDeduction: {
      single: 12750,
      married_joint: 25500,
      married_separate: 12750,
      head_of_household: 19125,
    },
    personalExemption: 0,
    dependentExemption: 0,
    notes: 'NC flat 4.5% rate (TY2024). Standard deduction varies by filing status. No personal/dependent exemptions.',
  },

  MI: {
    stateCode: 'MI',
    rate: 0.0425,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 5600,
    dependentExemption: 5600,
    notes: 'MI uses a per-person exemption of $5,600 for taxpayer, spouse, and each dependent (TY2024).',
  },

  IN: {
    stateCode: 'IN',
    rate: 0.0305,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 1000,
    dependentExemption: 1500,
    notes: 'IN personal exemption $1,000 per person (taxpayer + spouse), plus $1,500 per dependent (TY2024 rate 3.05%).',
  },

  CO: {
    stateCode: 'CO',
    rate: 0.044,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 0,
    dependentExemption: 0,
    usesFederalTaxableIncome: true,
    notes: 'CO starts from federal taxable income. No additional state deductions or exemptions (TY2024).',
  },

  KY: {
    stateCode: 'KY',
    rate: 0.045,
    standardDeduction: { single: 3180, married_joint: 3180, married_separate: 3180, head_of_household: 3180 },
    personalExemption: 0,
    dependentExemption: 0,
    notes: 'KY standard deduction $3,180 regardless of filing status. Flat 4.5% rate (TY2024).',
  },

  UT: {
    stateCode: 'UT',
    rate: 0.0465,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 0,
    dependentExemption: 0,
    taxpayerCreditRate: 0.06,
    notes: 'UT flat 4.65% with taxpayer credit = 6% of (federal std deduction + personal exemptions) (TY2024).',
  },

  GA: {
    stateCode: 'GA',
    rate: 0.0539,
    standardDeduction: {
      single: 5400,
      married_joint: 7100,
      married_separate: 3550,
      head_of_household: 5400,
    },
    personalExemption: 2700,
    dependentExemption: 3000,
    notes: 'GA graduated brackets in TY2024 (5.39% top rate). Pre-HB 111. Standard deduction and personal exemption per status.',
  },

  AZ: {
    stateCode: 'AZ',
    rate: 0.025,
    standardDeduction: {
      single: 13850,
      married_joint: 27700,
      married_separate: 13850,
      head_of_household: 20800,
    },
    personalExemption: 0,
    dependentExemption: 0,
    agedExemption: 2100,
    dependentCredit: { under17: 100, age17plus: 25 },
    dependentCreditPhaseout: { single: 200000, married_joint: 400000 },
    notes: 'AZ flat 2.5% rate. Federal standard deduction conformity. Aged exemption ($2,100 for 65+). Dependent credit ($100 under-17 / $25 17+) with AGI phaseout.',
  },

  LA: {
    stateCode: 'LA',
    rate: 0,
    standardDeduction: {
      single: 4500,
      married_joint: 9000,
      married_separate: 4500,
      head_of_household: 4500,
    },
    personalExemption: 4500,
    dependentExemption: 1000,
    notes: 'LA pre-Act 11: graduated brackets 1.85%–4.25%. Standard deduction $4,500/$9,000. Personal exemption $4,500 per person, $1,000 per dependent. Use progressive calculator for 2024.',
  },

  IA: {
    stateCode: 'IA',
    rate: 0.044,
    standardDeduction: {
      single: 15750,
      married_joint: 31500,
      married_separate: 15750,
      head_of_household: 23625,
    },
    personalExemption: 40,
    dependentExemption: 40,
    notes: 'IA graduated rates phasing down. TY2024 top rate 4.4% (was 6.0% in 2022). Federal standard deduction conformity since 2023. $40 per exemption.',
  },
};

export const MA_PERSONAL_EXEMPTION_2024: Record<string, number> = {
  single: 4400,
  married_joint: 8800,
  married_separate: 4400,
  head_of_household: 6800,
};