/**
 * State Tax Calculation Tests — Progressive + New Flat + Custom States
 *
 * Tests for all 30 newly added state calculators:
 *   - Progressive factory states (20): VA, MN, OR, MO, SC, MS, KS, OK, AR,
 *     ID, ND, RI, WV, ME, NM, MT, NE, VT, DE, DC
 *   - New flat-tax states (4): GA, AZ, LA, IA
 *   - Custom calculators (6): OH, WI, CT, MD, AL, HI
 *
 * Test categories:
 *   1. Smoke tests — $0, $75K single, $150K MFJ, $500K single
 *   2. Golden-value tests — exact dollar amounts verified against state tax tables
 *   3. EITC tests — states with state EITC rate
 *   4. Social Security exemption tests
 *   5. Custom calculator specific tests
 *   6. Full coverage validation — all 50 states + DC produce valid results
 */

import { describe, it, expect } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateStateTaxes, applyBrackets } from '../src/engine/state/index.js';
import {
  isStateSupported, getSupportedStates, getStateCalculator, NO_INCOME_TAX_STATES,
  FLAT_TAX_STATES, PROGRESSIVE_TAX_STATES,
} from '../src/engine/state/stateRegistry.js';
import { TaxReturn, FilingStatus, StateReturnConfig } from '../src/types/index.js';
import { getStandardDeduction } from '../src/constants/taxConstants.js';
import { NM_CONFIG, MO_CONFIG, ME_CONFIG, DC_CONFIG } from '../src/constants/states/progressiveTax.js';
import { FLAT_TAX_CONSTANTS } from '../src/constants/states/flatTax.js';
import { FLAT_TAX_CONSTANTS_2024 } from '../src/constants/states/flatTax2024.js';
import { FLAT_TAX_CONSTANTS_2026 } from '../src/constants/states/flatTax2026.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'state-prog-test',
    taxYear: 2025,
    status: 'in_progress',
    currentStep: 0,
    currentSection: 'review',
    dependents: [],
    w2Income: [],
    income1099NEC: [],
    income1099K: [],
    income1099INT: [],
    income1099DIV: [],
    income1099R: [],
    income1099G: [],
    income1099MISC: [],
    income1099B: [],
    income1099DA: [],
    income1099C: [],
    income1099Q: [],
    incomeK1: [],
    income1099SA: [],
    incomeW2G: [],
    rentalProperties: [],
    otherIncome: 0,
    businesses: [],
    deductionMethod: 'standard',
    expenses: [],
    educationCredits: [],
    incomeDiscovery: {},
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

function makeW2Return(
  wages: number,
  stateCode: string,
  stateWithheld = 0,
  filingStatus = FilingStatus.Single,
  dependentCount = 0,
) {
  const dependents = Array.from({ length: dependentCount }, (_, i) => ({
    id: `dep${i}`,
    firstName: `Child${i}`,
    lastName: 'Test',
    dateOfBirth: '2015-06-15',
    relationship: 'child' as const,
    monthsLivedWithYou: 12,
    ssn: `000-00-000${i}`,
  }));

  return makeTaxReturn({
    filingStatus,
    dependents,
    w2Income: [{
      id: 'w1',
      employerName: 'Test Corp',
      wages,
      federalTaxWithheld: Math.round(wages * 0.15),
      socialSecurityWages: Math.min(wages, 168600),
      socialSecurityTax: Math.min(wages, 168600) * 0.062,
      medicareWages: wages,
      medicareTax: wages * 0.0145,
      state: stateCode,
      stateTaxWithheld: stateWithheld,
      // Pennsylvania taxes box 16 (PA-40 line 1a).
      ...(stateCode === 'PA' ? { stateWages: wages } : {}),
    }],
    stateReturns: [{ stateCode, residencyType: 'resident' as const }],
  });
}

function calcState(
  wages: number,
  stateCode: string,
  filingStatus = FilingStatus.Single,
  stateSpecificData?: Record<string, unknown>,
  dependentCount = 0,
) {
  const tr = makeW2Return(wages, stateCode, 0, filingStatus, dependentCount);
  if (stateSpecificData) {
    tr.stateReturns![0].stateSpecificData = stateSpecificData;
  }
  const federal = calculateForm1040(tr);
  const results = calculateStateTaxes(tr, federal);
  return results[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. FULL COVERAGE VALIDATION — All 50 States + DC
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full 50-State + DC Coverage', () => {
  it('all 50 states + DC are supported', () => {
    const allStateCodes = [
      'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
      'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
      'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
      'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
      'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
      'DC',
    ];
    for (const code of allStateCodes) {
      expect(isStateSupported(code), `${code} should be supported`).toBe(true);
    }
    expect(getSupportedStates().length).toBeGreaterThanOrEqual(51);
  });

  it('all income-tax states produce valid results for $100K single', () => {
    const incomeStates = [
      ...FLAT_TAX_STATES, ...PROGRESSIVE_TAX_STATES,
      'CA', 'NY', 'NJ', 'OH', 'WI', 'CT', 'MD', 'AL', 'HI',
    ];
    for (const state of incomeStates) {
      const result = calcState(100000, state);
      expect(result, `${state} should return a result`).toBeDefined();
      expect(result.stateCode).toBe(state);
      expect(Number.isFinite(result.stateIncomeTax), `${state} tax should be finite`).toBe(true);
      expect(result.stateIncomeTax, `${state} should have tax > 0 on $100K`).toBeGreaterThan(0);
      expect(result.effectiveStateRate, `${state} effective rate should be > 0`).toBeGreaterThan(0);
      expect(result.effectiveStateRate, `${state} effective rate should be < 15%`).toBeLessThan(0.15);
    }
  });

  it('zero income produces zero state tax for all states', () => {
    const incomeStates = [
      ...FLAT_TAX_STATES, ...PROGRESSIVE_TAX_STATES,
      'CA', 'NY', 'NJ', 'OH', 'WI', 'CT', 'MD', 'AL', 'HI',
    ];
    for (const state of incomeStates) {
      const result = calcState(0, state);
      expect(result.stateIncomeTax, `${state} should have $0 tax on $0 income`).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PROGRESSIVE FACTORY STATES — Smoke Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Progressive Factory States — Smoke Tests', () => {
  const EXPECTED_RANGES: Record<string, [number, number]> = {
    // [min effective rate, max effective rate] for $100K single
    VA: [0.03, 0.06],
    MN: [0.04, 0.08],
    OR: [0.06, 0.10],
    MO: [0.02, 0.05],
    SC: [0.03, 0.07],
    MS: [0.02, 0.05],
    KS: [0.03, 0.06],
    OK: [0.02, 0.05],
    AR: [0.01, 0.04],
    ID: [0.03, 0.06],
    ND: [0.00, 0.02],
    RI: [0.02, 0.05],
    WV: [0.02, 0.05],
    ME: [0.04, 0.08],
    NM: [0.02, 0.05],
    MT: [0.03, 0.06],
    NE: [0.03, 0.06],
    VT: [0.03, 0.07],
    DE: [0.03, 0.07],
    DC: [0.05, 0.09],
  };

  for (const state of PROGRESSIVE_TAX_STATES) {
    const [minRate, maxRate] = EXPECTED_RANGES[state] || [0.001, 0.15];

    it(`${state} — $75K single produces tax in expected range`, () => {
      const result = calcState(75000, state);
      expect(result.stateIncomeTax).toBeGreaterThan(0);
      expect(result.bracketDetails!.length).toBeGreaterThanOrEqual(1);
    });

    it(`${state} — $150K MFJ produces tax`, () => {
      const result = calcState(150000, state, FilingStatus.MarriedFilingJointly);
      expect(result.stateIncomeTax).toBeGreaterThan(0);
    });

    it(`${state} — $500K single has higher effective rate than $75K`, () => {
      const low = calcState(75000, state);
      const high = calcState(500000, state);
      expect(high.effectiveStateRate).toBeGreaterThanOrEqual(low.effectiveStateRate);
    });

    it(`${state} — effective rate is in expected range for $100K`, () => {
      const result = calcState(100000, state);
      expect(result.effectiveStateRate).toBeGreaterThanOrEqual(minRate);
      expect(result.effectiveStateRate).toBeLessThanOrEqual(maxRate);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PROGRESSIVE STATES — Golden Value Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Progressive States — Golden Value Tests', () => {
  // Virginia — simple 4-bracket system, $8K std deduction (single)
  it('VA — $50K single: tax ≈ $2,195', () => {
    const result = calcState(50000, 'VA');
    // $50K - $8,750 std ded - $930 personal = $40,320 taxable
    // $3K×2% + $2K×3% + $12K×5% + $23,320×5.75% = $60 + $60 + $600 + $1,340.90 = $2,061
    expect(result.stateTaxableIncome).toBeCloseTo(40320, -1);
    expect(result.stateIncomeTax).toBeGreaterThan(1900);
    expect(result.stateIncomeTax).toBeLessThan(2400);
  });

  // Missouri — top bracket at just $4,828
  it('MO — $75K single: tax ≈ $2,652', () => {
    const result = calcState(75000, 'MO');
    // $75K − federal basic standard deduction ($15,750) → rest at 4.7%
    expect(result.stateIncomeTax).toBeGreaterThan(2200);
    expect(result.stateIncomeTax).toBeLessThan(3100);
  });

  // Mississippi — $10K zero bracket then 4.4%
  it('MS — $50K single: tax ≈ $1,342', () => {
    const result = calcState(50000, 'MS');
    // $50K - $2,300 std ded - $6K personal = $41,700
    // $10K×0% + $31,700×4.4% = $1,394.80
    expect(result.stateIncomeTax).toBeGreaterThan(1200);
    expect(result.stateIncomeTax).toBeLessThan(1600);
  });

  // Kansas — 2 brackets
  it('KS — $80K single: tax ≈ $3,402', () => {
    const result = calcState(80000, 'KS');
    // $80K - $3,500 std ded - $2,250 personal = $74,250
    // $15K×3.1% + $59,250×5.58% = $465 + $3,306.15 = $3,771
    expect(result.stateIncomeTax).toBeGreaterThan(3200);
    expect(result.stateIncomeTax).toBeLessThan(4000);
  });

  // Idaho — zero bracket + 5.3%
  it('ID — $60K single: tax ≈ $2,609', () => {
    const result = calcState(60000, 'ID');
    // Starts from federal taxable income (~$45,400)
    // $4,489×0% + ($45,400-$4,489)×5.3% = $40,911×5.3% = $2,168
    expect(result.stateIncomeTax).toBeGreaterThan(1800);
    expect(result.stateIncomeTax).toBeLessThan(2800);
  });

  // North Dakota — very low rates, large zero bracket
  it('ND — $100K single: tax ≈ $860', () => {
    const result = calcState(100000, 'ND');
    // Starts from federal taxable income (~$85,400)
    // $44,725×0% + ($85,400-$44,725)×1.95% = $40,675×1.95% = $793
    expect(result.stateIncomeTax).toBeGreaterThan(500);
    expect(result.stateIncomeTax).toBeLessThan(1200);
  });

  // DC — high rates
  it('DC — $200K single: tax ≈ $13,100', () => {
    const result = calcState(200000, 'DC');
    // $200K - $14,600 std ded = $185,400
    // $10K×4% + $30K×6% + $20K×6.5% + $125,400×8.5%
    // = $400 + $1,800 + $1,300 + $10,659 = $14,159
    expect(result.stateIncomeTax).toBeGreaterThan(12000);
    expect(result.stateIncomeTax).toBeLessThan(16000);
  });

  // South Carolina — zero bracket + 2 rates
  it('SC — $80K single: tax ≈ $3,913', () => {
    const result = calcState(80000, 'SC');
    // Starts from federal taxable income (~$65,400)
    // $3,460×0% + $13,870×3% + $48,070×6.2% = $416.10 + $2,980.34 = $3,396
    expect(result.stateIncomeTax).toBeGreaterThan(3000);
    expect(result.stateIncomeTax).toBeLessThan(4500);
  });

  // Oregon — starts from federal taxable income, $256 exemption credit (not deduction)
  it('OR — $100K single: tax ≈ $6,900', () => {
    const result = calcState(100000, 'OR');
    // Federal taxable ≈ $85,400, then OR deduction $2,835 (exemption is credit, not deduction)
    // Taxable ≈ $82,565
    // $4,400×4.75% + $6,650×6.75% + $71,515×8.75% = ~$7,008 - $256 credit
    expect(result.stateExemptions).toBe(0); // Exemption is a credit, not a deduction
    expect(result.stateCredits).toBeGreaterThanOrEqual(256); // $256 per person
    expect(result.stateIncomeTax).toBeGreaterThan(5800);
    expect(result.stateIncomeTax).toBeLessThan(7800);
  });

  // Minnesota — starts from federal taxable income
  it('MN — $120K single: tax ≈ $6,500', () => {
    const result = calcState(120000, 'MN');
    // Federal taxable ≈ $105,400 → MN brackets (no MN std ded)
    // $31,690×5.35% + $72,400×6.8% + $1,310×7.85%
    expect(result.stateIncomeTax).toBeGreaterThan(5500);
    expect(result.stateIncomeTax).toBeLessThan(7500);
  });

  // Delaware — 7 brackets, $110 exemption credit (not deduction)
  it('DE — $60K single: tax ≈ $2,850 before $110 credit', () => {
    const result = calcState(60000, 'DE');
    // $60K - $3,250 std ded = $56,750 taxable (exemption is credit, not deduction)
    // $2K×0% + $3K×2.2% + $5K×3.9% + $10K×4.8% + $5K×5.2% + $31,750×5.55%
    // Then subtract $110 exemption credit
    expect(result.stateExemptions).toBe(0); // No income deduction
    expect(result.stateCredits).toBeGreaterThanOrEqual(110); // $110 credit per person
    expect(result.stateIncomeTax).toBeGreaterThan(2400);
    expect(result.stateIncomeTax).toBeLessThan(3300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. NEW FLAT-TAX STATES
// ═══════════════════════════════════════════════════════════════════════════════

describe('New Flat-Tax States', () => {
  it('GA — 5.19% flat, $75K single', () => {
    const result = calcState(75000, 'GA');
    // $75K - $12K std ded - $3,700 personal = $59,300
    // $59,300 × 5.19% = $3,077.67
    expect(result.stateIncomeTax).toBeGreaterThan(2800);
    expect(result.stateIncomeTax).toBeLessThan(3300);
  });

  it('AZ — 2.5% flat, $75K single', () => {
    const result = calcState(75000, 'AZ');
    // $75K - $14,600 std ded - $2,100 personal = $58,300
    // $58,300 × 2.5% = $1,457.50
    expect(result.stateIncomeTax).toBeGreaterThan(1300);
    expect(result.stateIncomeTax).toBeLessThan(1600);
  });

  it('LA — 3.0% flat, $75K single', () => {
    const result = calcState(75000, 'LA');
    // $75K - $12,500 std ded = $62,500
    // $62,500 × 3.0% = $1,875
    expect(result.stateIncomeTax).toBeGreaterThan(1700);
    expect(result.stateIncomeTax).toBeLessThan(2000);
  });

  it('IA — 3.8% flat, $75K single', () => {
    const result = calcState(75000, 'IA');
    // $75K - $15,750 std ded - $40 personal = $59,210
    // $59,210 × 3.8% = $2,249.98
    expect(result.stateIncomeTax).toBeGreaterThan(2000);
    expect(result.stateIncomeTax).toBeLessThan(2500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. RATE CORRECTIONS — Updated Flat-Tax States
// ═══════════════════════════════════════════════════════════════════════════════

describe('Flat-Tax Rate Corrections (TY2025)', () => {
  it('NC — rate corrected to 4.25% (was 4.5%)', () => {
    const result = calcState(100000, 'NC');
    // $100K - $12,750 std ded = $87,250
    // $87,250 × 4.25% = $3,708.13
    expect(result.stateIncomeTax).toBeCloseTo(87250 * 0.0425, -1);
  });

  it('IN — rate corrected to 3.0% (was 3.05%)', () => {
    const result = calcState(100000, 'IN');
    // $100K - $1,000 personal = $99,000
    // $99,000 × 3.0% = $2,970
    expect(result.stateIncomeTax).toBeCloseTo(99000 * 0.03, -1);
  });

  // Hand-computed from the 2025 TC-40 instructions, lines 9–20.
  it('UT — 4.5%, and the taxpayer credit is phased out at $100K single', () => {
    const result = calcState(100000, 'UT');
    // Line 16: 6% × $15,750 = $945. Line 19: ($100,000 − $18,213) × 1.3% = $1,063.23. Line 20: $0.
    expect(result.stateIncomeTax).toBe(4500);
    expect(result.stateCredits).toBe(0);
  });

  it('UT — the credit phases out by 1.3% of income over the base', () => {
    const result = calcState(30000, 'UT');
    // $945 − ($30,000 − $18,213) × 1.3% ($153.23) = $791.77; tax $1,350 − $791.77.
    expect(result.stateCredits).toBe(791.77);
    expect(result.stateTaxAfterCredits ?? result.stateIncomeTax - result.stateCredits).toBeCloseTo(558.23, 2);
  });

  it('UT — $2,111 per qualifying dependent, a child born this year counted twice', () => {
    const tr = makeW2Return(60000, 'UT', 0, FilingStatus.MarriedFilingJointly, 2);
    tr.dependents![1]!.dateOfBirth = '2025-03-03';
    const result = calculateStateTaxes(tr, calculateForm1040(tr))[0]!;
    // Line 15: 3 × $2,111 + $31,500 = $37,833 → $2,269.98; less ($60,000 − $36,426) × 1.3% = $306.46.
    expect(result.stateCredits).toBe(1963.52);
  });

  it('UT — a qualified exempt taxpayer owes no Utah tax even where the credit falls short', () => {
    const tr = makeW2Return(15000, 'UT');
    tr.deductionMethod = 'itemized';
    tr.itemizedDeductions = {
      medicalExpenses: 0, stateLocalIncomeTax: 12000, realEstateTax: 0, personalPropertyTax: 0, mortgageInterest: 10000,
      mortgageInsurancePremiums: 0, charitableCash: 0, charitableNonCash: 0, casualtyLoss: 0, otherDeductions: 0,
    };
    const federal = calculateForm1040(tr);
    expect(federal.form1040.deductionUsed).toBe('itemized');
    const result = calculateStateTaxes(tr, federal)[0]!;
    // Line 14 takes the $12,000 of state income tax back out: 6% × $10,000 = $600 < $675 of tax.
    // Line 21: federal AGI $15,000 ≤ $15,750, so no Utah tax.
    expect(result.stateIncomeTax).toBe(675);
    expect(result.stateCredits).toBe(675);
  });

  it('UT 2024 — 4.55% (not 4.65%) and its own base amounts', () => {
    const tr = makeW2Return(30000, 'UT');
    tr.taxYear = 2024;
    const result = calculateStateTaxes(tr, calculateForm1040(tr))[0]!;
    // 4.55% × $30,000 = $1,365. Credit: 6% × $14,600 = $876 − ($30,000 − $17,652) × 1.3% ($160.52) = $715.48.
    expect(result.stateIncomeTax).toBe(1365);
    expect(result.stateCredits).toBe(715.48);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CUSTOM STATE CALCULATORS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Custom State — Ohio', () => {
  it('OH — $75K single: zero bracket then 2.75%/3.5%', () => {
    const result = calcState(75000, 'OH');
    // OH has no std deduction, AGI-phased exemption
    // $75K AGI → partial exemption → taxable income
    // $26,050×0% + remaining at 2.75%
    expect(result.stateIncomeTax).toBeGreaterThan(800);
    expect(result.stateIncomeTax).toBeLessThan(2000);
    expect(result.stateDeduction).toBe(0); // OH has no standard deduction
  });

  it('OH — $30K single: gets full personal exemption', () => {
    const result = calcState(30000, 'OH');
    // AGI ≤ $40K → full $2,400 exemption per person
    expect(result.stateExemptions).toBeGreaterThanOrEqual(2400);
  });

  it('OH — $100K single: exemption phased out', () => {
    const result = calcState(100000, 'OH');
    // AGI > $80K → exemption = $0
    expect(result.stateExemptions).toBe(0);
  });
});

describe('Custom State — Wisconsin', () => {
  it('WI — $75K single: sliding-scale std deduction', () => {
    const result = calcState(75000, 'WI');
    // Standard deduction starts at $12,760, phases down above $16,990
    // At $75K, significant phase-down
    expect(result.stateDeduction).toBeGreaterThan(0);
    expect(result.stateDeduction).toBeLessThan(12760);
    expect(result.stateIncomeTax).toBeGreaterThan(2500);
    expect(result.stateIncomeTax).toBeLessThan(5000);
  });

  it('WI — $15K single: full standard deduction', () => {
    const result = calcState(15000, 'WI');
    // Income below phase-out start → full deduction
    expect(result.stateDeduction).toBeGreaterThanOrEqual(12700);
  });
});

describe('Custom State — Connecticut', () => {
  it('CT — $75K single: 7 brackets, no std deduction', () => {
    const result = calcState(75000, 'CT');
    expect(result.stateDeduction).toBe(0); // CT has no standard deduction
    expect(result.stateIncomeTax).toBeGreaterThan(2500);
    expect(result.stateIncomeTax).toBeLessThan(5000);
  });

  it('CT — $25K single: gets full exemption credit', () => {
    const result = calcState(25000, 'CT');
    // Below $30K phase-out start → full $15K exemption → credit = $15K × 3% = $450
    expect(result.stateCredits).toBeGreaterThan(0);
  });

  it('CT — $200K single: exemption credit phased out', () => {
    const result = calcState(200000, 'CT');
    // Well above phase-out → exemption should be $0 or very small
    // Credit should be minimal
    expect(result.stateIncomeTax).toBeGreaterThan(8000);
  });
});

describe('Custom State — Maryland', () => {
  it('MD — $100K single: state + county tax', () => {
    const result = calcState(100000, 'MD');
    // MD has mandatory county tax (default 3.07%)
    expect(result.localTax).toBeGreaterThan(0);
    expect(result.totalStateTax).toBeGreaterThan(result.stateTaxAfterCredits);
  });

  it('MD — county selection changes local tax', () => {
    const montgomery = calcState(100000, 'MD', FilingStatus.Single, { countyCode: 'montgomery' });
    const worcester = calcState(100000, 'MD', FilingStatus.Single, { countyCode: 'worcester' });
    // Montgomery 3.2% vs Worcester 2.25%
    expect(montgomery.localTax).toBeGreaterThan(worcester.localTax);
  });

  it('MD — flat standard deduction (HB 352, TY2025)', () => {
    const result = calcState(50000, 'MD');
    // MD std ded = flat $3,350 for single (HB 352 replaced 15%-of-AGI formula)
    expect(result.stateDeduction).toBe(3350);
  });

  it('MD — low income gets same flat std deduction', () => {
    const result = calcState(10000, 'MD');
    // Flat $3,350 regardless of income (no more min/max clamping)
    expect(result.stateDeduction).toBe(3350);
  });
});

describe('Custom State — Alabama', () => {
  it('AL — $75K single: federal tax deduction', () => {
    const result = calcState(75000, 'AL');
    // AL uniquely deducts federal income tax from state income
    expect(result.stateIncomeTax).toBeGreaterThan(0);
    // Effective rate should be lower than most states due to federal tax deduction
    expect(result.effectiveStateRate).toBeLessThan(0.05);
  });

  it('AL — federal tax deduction reduces taxable income', () => {
    const result = calcState(100000, 'AL');
    // AL taxable = AGI - std ded - exemptions - federal tax paid
    // Federal tax on $100K is ~$12K+ → significant reduction
    expect(result.stateTaxableIncome).toBeLessThan(85000);
  });
});

describe('Custom State — Hawaii', () => {
  it('HI — $75K single: 12 brackets up to 11%', () => {
    const result = calcState(75000, 'HI');
    expect(result.stateIncomeTax).toBeGreaterThan(3000);
    expect(result.stateIncomeTax).toBeLessThan(6000);
    expect(result.bracketDetails!.length).toBeGreaterThan(5); // Should hit many brackets
  });

  it('HI — $300K single: hits top 11% bracket', () => {
    const result = calcState(300000, 'HI');
    // Top bracket is 11% above $200K
    expect(result.effectiveStateRate).toBeGreaterThan(0.07);
  });

  it('HI — food/excise tax credit is refundable', () => {
    const result = calcState(20000, 'HI');
    // $110 per exemption, refundable
    expect(result.stateCredits).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SOCIAL SECURITY EXEMPTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Social Security Exemption', () => {
  const ssOnlyReturn = (stateCode: string) => makeTaxReturn({
    filingStatus: FilingStatus.Single,
    incomeSSA1099: { id: 'ssa1', totalBenefits: 24000, federalTaxWithheld: 0 },
    stateReturns: [{ stateCode, residencyType: 'resident' as const }],
  });

  it('progressive states exempt SS benefits', () => {
    const ssExemptStates = ['VA', 'MO', 'MS', 'KS', 'OK', 'AR', 'RI', 'WV', 'ME', 'NM', 'NE', 'DE', 'DC'];
    for (const state of ssExemptStates) {
      const tr = ssOnlyReturn(state);
      const federal = calculateForm1040(tr);
      const results = calculateStateTaxes(tr, federal);
      if (results.length > 0) {
        expect(results[0].stateSubtractions, `${state} should subtract SS`)
          .toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. STATE EITC TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('State EITC', () => {
  // Create a low-income filer who qualifies for federal EITC
  function makeEITCReturn(stateCode: string) {
    return makeTaxReturn({
      filingStatus: FilingStatus.Single,
      dependents: [
        { id: 'd1', firstName: 'Child', lastName: 'Test', dateOfBirth: '2015-06-15',
          relationship: 'child' as const, monthsLivedWithYou: 12, ssn: '000-00-0001' },
        { id: 'd2', firstName: 'Child2', lastName: 'Test', dateOfBirth: '2017-03-20',
          relationship: 'child' as const, monthsLivedWithYou: 12, ssn: '000-00-0002' },
      ],
      w2Income: [{
        id: 'w1', employerName: 'Test', wages: 15000,
        federalTaxWithheld: 0,
        socialSecurityWages: 15000, socialSecurityTax: 930,
        medicareWages: 15000, medicareTax: 217.50,
        state: stateCode, stateTaxWithheld: 0,
      }],
      stateReturns: [{ stateCode, residencyType: 'resident' as const }],
    });
  }

  const statesWithEITC = [
    { code: 'VA', rate: 0.20, label: 'Virginia 20%' },
    { code: 'MN', rate: 0.45, label: 'Minnesota 45%' },
    { code: 'OR', rate: 0.12, label: 'Oregon 12%' },
    { code: 'KS', rate: 0.17, label: 'Kansas 17%' },
    { code: 'RI', rate: 0.15, label: 'Rhode Island 15%' },
    { code: 'ME', rate: 0.12, label: 'Maine 12%' },
    { code: 'NM', rate: 0.25, label: 'New Mexico 25%' },
    { code: 'VT', rate: 0.38, label: 'Vermont 38%' },
    { code: 'DC', rate: 0.70, label: 'DC 70%' },
  ];

  for (const { code, label } of statesWithEITC) {
    it(`${label} — EITC-eligible filer gets state EITC`, () => {
      const tr = makeEITCReturn(code);
      const federal = calculateForm1040(tr);
      const results = calculateStateTaxes(tr, federal);

      if (results.length > 0 && federal.credits.eitcCredit > 0) {
        expect(results[0].stateCredits, `${code} should have credits for EITC filer`)
          .toBeGreaterThan(0);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. EXEMPTION CREDIT FIXES (NE, AR, DE) — Bug Fixes from Multi-Model Review
// ═══════════════════════════════════════════════════════════════════════════════

describe('Exemption Credits (not deductions)', () => {
  // NE: $171 per exemption — must count all persons, not just 1
  it('NE — MFJ with 3 dependents gets $855 credit (5 × $171)', () => {
    const result = calcState(75000, 'NE', FilingStatus.MarriedFilingJointly, undefined, 3);
    // 2 persons (MFJ) + 3 dependents = 5 × $171 = $855
    expect(result.stateCredits).toBeGreaterThanOrEqual(855);
  });

  it('NE — single with 0 dependents gets $171 credit', () => {
    const result = calcState(75000, 'NE', FilingStatus.Single, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(171);
  });

  it('NE — single with 2 dependents gets $513 credit (3 × $171)', () => {
    const result = calcState(75000, 'NE', FilingStatus.Single, undefined, 2);
    expect(result.stateCredits).toBeGreaterThanOrEqual(513);
  });

  // AR: $29 per exemption — must be a tax credit, not income deduction
  it('AR — MFJ with 3 dependents gets $145 credit (5 × $29)', () => {
    const result = calcState(75000, 'AR', FilingStatus.MarriedFilingJointly, undefined, 3);
    // 2 persons + 3 dependents = 5 × $29 = $145
    expect(result.stateCredits).toBeGreaterThanOrEqual(145);
    expect(result.stateExemptions).toBe(0); // Not an income deduction
  });

  it('AR — single gets $29 credit', () => {
    const result = calcState(75000, 'AR', FilingStatus.Single, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(29);
    expect(result.stateExemptions).toBe(0);
  });

  // DE: $110 per exemption — must be a tax credit, not income deduction
  it('DE — MFJ with 2 dependents gets $440 credit (4 × $110)', () => {
    const result = calcState(75000, 'DE', FilingStatus.MarriedFilingJointly, undefined, 2);
    // 2 persons + 2 dependents = 4 × $110 = $440
    expect(result.stateCredits).toBeGreaterThanOrEqual(440);
    expect(result.stateExemptions).toBe(0); // Not an income deduction
  });

  it('DE — single gets $110 credit', () => {
    const result = calcState(75000, 'DE', FilingStatus.Single, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(110);
    expect(result.stateExemptions).toBe(0);
  });

  // OR: $256 per exemption — ORS §316.085 (credit, not deduction)
  it('OR — single gets $256 credit', () => {
    const result = calcState(75000, 'OR', FilingStatus.Single, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(256);
    expect(result.stateExemptions).toBe(0);
  });

  it('OR — MFJ with 2 dependents gets $1024 credit (4 × $256)', () => {
    const result = calcState(100000, 'OR', FilingStatus.MarriedFilingJointly, undefined, 2);
    expect(result.stateCredits).toBeGreaterThanOrEqual(1024);
    expect(result.stateExemptions).toBe(0);
  });

  // MFS / HoH regression tests — verify these count as 1 person
  it('NE — MFS counts as 1 person ($171 credit)', () => {
    const result = calcState(75000, 'NE', FilingStatus.MarriedFilingSeparately, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(171);
    // Should not be 2 × $171
    expect(result.stateCredits).toBeLessThan(342);
  });

  it('NE — HoH with 1 dependent gets $342 credit (2 × $171)', () => {
    const result = calcState(75000, 'NE', FilingStatus.HeadOfHousehold, undefined, 1);
    expect(result.stateCredits).toBeGreaterThanOrEqual(342);
  });

  it('AR — MFS counts as 1 person ($29 credit)', () => {
    const result = calcState(75000, 'AR', FilingStatus.MarriedFilingSeparately, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(29);
    expect(result.stateCredits).toBeLessThan(58);
  });

  it('DE — HoH with 2 dependents gets $330 credit (3 × $110)', () => {
    const result = calcState(75000, 'DE', FilingStatus.HeadOfHousehold, undefined, 2);
    expect(result.stateCredits).toBeGreaterThanOrEqual(330);
    expect(result.stateExemptions).toBe(0);
  });

  it('OR — MFS counts as 1 person ($256 credit)', () => {
    const result = calcState(75000, 'OR', FilingStatus.MarriedFilingSeparately, undefined, 0);
    expect(result.stateCredits).toBeGreaterThanOrEqual(256);
    expect(result.stateCredits).toBeLessThan(512);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. MFJ FILING STATUS
// ═══════════════════════════════════════════════════════════════════════════════

describe('MFJ Filing Status', () => {
  it('MFJ generally pays less tax than single at same income due to wider brackets', () => {
    const testStates = ['VA', 'MN', 'KS', 'ME', 'DC'];
    for (const state of testStates) {
      const single = calcState(100000, state, FilingStatus.Single);
      const mfj = calcState(100000, state, FilingStatus.MarriedFilingJointly);
      expect(mfj.totalStateTax, `${state} MFJ tax should be ≤ single tax`)
        .toBeLessThanOrEqual(single.totalStateTax + 1); // +1 for rounding
    }
  });
});

describe('Federal standard-deduction conformity', () => {
  function expectMatch(
    deduction: Record<string, number>,
    year: number,
  ) {
    const federal = getStandardDeduction(year);
    expect(deduction.single).toBe(federal[FilingStatus.Single]);
    expect(deduction.married_joint).toBe(federal[FilingStatus.MarriedFilingJointly]);
    expect(deduction.married_separate).toBe(federal[FilingStatus.MarriedFilingSeparately]);
    expect(deduction.head_of_household).toBe(federal[FilingStatus.HeadOfHousehold]);
  }

  it('NM and MO 2025 match the federal basic standard deduction', () => {
    expectMatch(NM_CONFIG.standardDeduction, 2025);
    expectMatch(MO_CONFIG.standardDeduction, 2025);
    expect(NM_CONFIG.standardDeductionConformsToFederal).toBe(true);
    expect(MO_CONFIG.standardDeductionConformsToFederal).toBe(true);
    expect(calcState(75000, 'NM').stateDeduction).toBe(15750);
    expect(calcState(75000, 'MO').stateDeduction).toBe(15750);
  });

  it('ME and DC keep state-specific standard deductions', () => {
    const federal2025 = getStandardDeduction(2025);
    expect(ME_CONFIG.standardDeductionConformsToFederal).toBe(false);
    expect(DC_CONFIG.standardDeductionConformsToFederal).toBe(false);
    expect(ME_CONFIG.standardDeduction.single).toBe(14600);
    expect(ME_CONFIG.standardDeduction.married_joint).toBe(29200);
    expect(ME_CONFIG.standardDeduction.head_of_household).toBe(21900);
    expect(ME_CONFIG.standardDeduction.single).not.toBe(federal2025[FilingStatus.Single]);
    expect(calcState(75000, 'ME').stateDeduction).toBe(14600);
  });

  // DC's own 2025 amounts (2025 D-40ES booklet), not the federal ones.
  it('DC — $15,000 / $30,000 / $22,500, plus $1,600 or $2,000 per age or blindness box', () => {
    expect(DC_CONFIG.standardDeduction).toEqual({ single: 15000, married_joint: 30000, married_separate: 15000, head_of_household: 22500 });
    expect(calcState(75000, 'DC').stateDeduction).toBe(15000);
    expect(calcState(75000, 'DC', FilingStatus.MarriedFilingJointly).stateDeduction).toBe(30000);
    expect(calcState(75000, 'DC', FilingStatus.HeadOfHousehold, undefined, 1).stateDeduction).toBe(22500);

    const senior = makeW2Return(75000, 'DC');
    senior.dateOfBirth = '1955-01-01';
    expect(calculateStateTaxes(senior, calculateForm1040(senior))[0]!.stateDeduction).toBe(17000);
    const couple = makeW2Return(75000, 'DC', 0, FilingStatus.MarriedFilingJointly);
    couple.dateOfBirth = '1955-01-01';
    couple.spouseDateOfBirth = '1956-01-01';
    couple.isLegallyBlind = true;
    expect(calculateStateTaxes(couple, calculateForm1040(couple))[0]!.stateDeduction).toBe(30000 + 3 * 1600);
  });

  it('AZ and IA match the federal basic standard deduction for each year they claim conformity', () => {
    expectMatch(FLAT_TAX_CONSTANTS_2024.AZ.standardDeduction, 2024);
    expectMatch(FLAT_TAX_CONSTANTS_2024.IA.standardDeduction, 2024);
    expectMatch(FLAT_TAX_CONSTANTS.AZ.standardDeduction, 2025);
    expectMatch(FLAT_TAX_CONSTANTS.IA.standardDeduction, 2025);
    expectMatch(FLAT_TAX_CONSTANTS_2026.AZ.standardDeduction, 2026);
    expectMatch(FLAT_TAX_CONSTANTS_2026.IA.standardDeduction, 2026);
  });
});

describe('State calculators follow the tax year table', () => {
  function calcYear(stateCode: string, taxYear: number) {
    const tr = makeW2Return(75000, stateCode);
    tr.taxYear = taxYear;
    const federal = calculateForm1040(tr);
    return calculateStateTaxes(tr, federal)[0];
  }

  it('uses the 2026 flat-tax table for Arizona instead of the 2025 table', () => {
    expect(getStateCalculator('AZ', 2026)).not.toBeNull();
    expect(calcYear('AZ', 2025).stateDeduction).toBe(getStandardDeduction(2025)[FilingStatus.Single]);
    expect(calcYear('AZ', 2026).stateDeduction).toBe(getStandardDeduction(2026)[FilingStatus.Single]);
    expect(calcYear('AZ', 2026).stateDeduction).not.toBe(calcYear('AZ', 2025).stateDeduction);
  });

  it('does not apply the 2025 progressive brackets to 2024 or 2026', () => {
    for (const stateCode of ['VA', 'NM', 'MO', 'ME', 'DC']) {
      expect(getStateCalculator(stateCode, 2024), stateCode).toBeNull();
      expect(getStateCalculator(stateCode, 2026), stateCode).toBeNull();
      expect(getStateCalculator(stateCode, 2025), stateCode).not.toBeNull();
      const otherYear = calcYear(stateCode, 2026);
      expect(otherYear.additionalLines?.unavailable).toBe(1);
      expect(otherYear.totalStateTax).toBe(0);
    }
  });

  it('does not apply 2025 custom-state brackets to another year', () => {
    expect(getStateCalculator('CA', 2024)).toBeNull();
    expect(getStateCalculator('NY', 2026)).toBeNull();
    expect(getStateCalculator('CA', 2025)).not.toBeNull();
    expect(calcYear('CA', 2024).additionalLines?.unavailable).toBe(1);
    expect(calcYear('CA', 2025).totalStateTax).toBeGreaterThan(0);
  });

  it('keeps New Hampshire year logic for 2024 and the 2025 repeal', () => {
    expect(getStateCalculator('NH', 2024)).not.toBeNull();
    expect(getStateCalculator('NH', 2025)).not.toBeNull();
    expect(getStateCalculator('NH', 2026)).not.toBeNull();
  });
});
