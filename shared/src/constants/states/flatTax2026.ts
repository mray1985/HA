/**
 * Flat-Tax State Constants — Tax Year 2026
 *
 * Projected 2026 values: LA flat 3%, NC 3.99% (scheduled), CO 4.4%, etc.
 * Source: State revenue department 2026 projections / enacted legislation.
 */

import type { FlatTaxStateConfig } from './flatTax.js';

export const FLAT_TAX_CONSTANTS_2026: Record<string, FlatTaxStateConfig> = {
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
    personalExemption: 2850,
    dependentExemption: 2850,
    notes: 'IL uses a per-person exemption of $2,850 for taxpayer, spouse, and each dependent (TY2026 projected).',
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
    surtax: { threshold: 1150000, rate: 0.04 },
    notes: 'MA Part A (5%), ST cap gains (8.5%), LT cap gains (5%), LT collectibles (12%). 4% surtax on income > $1.15M (TY2026 inflation-adjusted).',
  },

  NC: {
    stateCode: 'NC',
    rate: 0.0399,
    standardDeduction: {
      single: 12750,
      married_joint: 25500,
      married_separate: 12750,
      head_of_household: 19125,
    },
    personalExemption: 0,
    dependentExemption: 0,
    notes: 'NC scheduled reduction to 3.99% flat rate (TY2026 per SB 105). Standard deduction same as TY2025.',
  },

  MI: {
    stateCode: 'MI',
    rate: 0.0425,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 5800,
    dependentExemption: 5800,
    notes: 'MI uses a per-person exemption of $5,800 for taxpayer, spouse, and each dependent (TY2026 projected).',
  },

  IN: {
    stateCode: 'IN',
    rate: 0.03,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 1000,
    dependentExemption: 1500,
    notes: 'IN flat 3.0% rate. Personal exemption $1,000 per person (taxpayer + spouse), plus $1,500 per dependent (TY2026).',
  },

  CO: {
    stateCode: 'CO',
    rate: 0.044,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 0,
    dependentExemption: 0,
    usesFederalTaxableIncome: true,
    notes: 'CO starts from federal taxable income. No additional state deductions or exemptions (TY2026).',
  },

  KY: {
    stateCode: 'KY',
    rate: 0.04,
    standardDeduction: { single: 3360, married_joint: 3360, married_separate: 3360, head_of_household: 3360 },
    personalExemption: 0,
    dependentExemption: 0,
    notes: 'KY standard deduction $3,360 (inflation-adjusted). Flat 4.0% rate (TY2026).',
  },

  UT: {
    stateCode: 'UT',
    rate: 0.045,
    standardDeduction: { single: 0, married_joint: 0, married_separate: 0, head_of_household: 0 },
    personalExemption: 0,
    dependentExemption: 0,
    taxpayerCreditRate: 0.06,
    notes: 'UT flat 4.5% with taxpayer credit = 6% of (federal std deduction + personal exemptions) (TY2026).',
  },

  GA: {
    stateCode: 'GA',
    rate: 0.0519,
    standardDeduction: {
      single: 12000,
      married_joint: 24000,
      married_separate: 12000,
      head_of_household: 12000,
    },
    personalExemption: 0,
    dependentExemption: 4000,
    notes: 'GA HB 111 flat 5.19% rate. Personal exemption repealed. $4,000 per dependent (TY2026).',
  },

  AZ: {
    stateCode: 'AZ',
    rate: 0.025,
    standardDeduction: {
      single: 16100,
      married_joint: 32200,
      married_separate: 16100,
      head_of_household: 24150,
    },
    personalExemption: 0,
    dependentExemption: 0,
    agedExemption: 2100,
    dependentCredit: { under17: 100, age17plus: 25 },
    dependentCreditPhaseout: { single: 200000, married_joint: 400000 },
    notes: 'AZ flat 2.5% rate. Federal standard deduction conformity (inflation-adjusted). Aged exemption ($2,100 for 65+). Dependent credit ($100 under-17 / $25 17+) with AGI phaseout.',
  },

  LA: {
    stateCode: 'LA',
    rate: 0.03,
    standardDeduction: {
      single: 12500,
      married_joint: 25000,
      married_separate: 12500,
      head_of_household: 25000,
    },
    personalExemption: 0,
    dependentExemption: 0,
    notes: 'LA Act 11 flat 3.0% rate continues. New standard deduction structure. Exemptions repealed. (TY2026).',
  },

  IA: {
    stateCode: 'IA',
    rate: 0.038,
    standardDeduction: {
      single: 15750,
      married_joint: 31500,
      married_separate: 15750,
      head_of_household: 23625,
    },
    personalExemption: 40,
    dependentExemption: 40,
    notes: 'IA flat 3.8% for TY2025+. Federal standard deduction conformity. $40 per exemption (TY2026).',
  },
};

export const MA_PERSONAL_EXEMPTION_2026: Record<string, number> = {
  single: 4400,
  married_joint: 8800,
  married_separate: 4400,
  head_of_household: 6800,
};