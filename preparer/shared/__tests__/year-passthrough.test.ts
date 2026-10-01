/**
 * Year-parameterized calculations must use the return's tax year.
 * Several callers previously omitted taxYear, so 2024 and 2026 fell through
 * to the 2025 default.
 */
import { describe, it, expect } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateQBIDeduction } from '../src/engine/qbi.js';
import { FilingStatus, TaxReturn, CalculationResult } from '../src/types/index.js';
import { getStandardDeduction } from '../src/constants/taxConstants.js';
import { SCHEDULE_D_FIELDS } from '../src/constants/irsScheduleDMap.js';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'year-passthrough',
    taxYear: 2025,
    status: 'in_progress',
    currentStep: 0,
    currentSection: 'review',
    filingStatus: FilingStatus.Single,
    dateOfBirth: '1990-01-15',
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
    incomeK1: [],
    income1099SA: [],
    incomeW2G: [],
    rentalProperties: [],
    expenses: [],
    educationCredits: [],
    deductionMethod: 'standard',
    otherIncome: 0,
    incomeDiscovery: {},
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

function mapField(label: string) {
  const field = SCHEDULE_D_FIELDS.find(f => f.formLabel === label);
  if (!field?.transform) throw new Error(`Missing Schedule D field: ${label}`);
  return field.transform;
}

describe('tax year is passed into year-parameterized calculations', () => {
  it('does not give a 2024 filer the 2025 senior deduction', () => {
    const senior = (taxYear: number) => calculateForm1040(makeReturn({
      taxYear,
      dateOfBirth: '1950-06-15',
      w2Income: [{ id: 'w2', employerName: 'Acme', wages: 50000, federalTaxWithheld: 4000 }],
    }));

    expect(senior(2024).form1040.schedule1ADeduction).toBe(0);
    expect(senior(2025).form1040.schedule1ADeduction).toBe(6000);
    expect(senior(2026).form1040.schedule1ADeduction).toBe(6000);
  });

  it('uses the year QBI threshold, not the 2025 default', () => {
    const qbiReturn = (taxYear: number) => {
      const standardDeduction = getStandardDeduction(taxYear)[FilingStatus.Single];
      return calculateForm1040(makeReturn({
        taxYear,
        w2Income: [{
          id: 'w2',
          employerName: 'Acme',
          wages: 195000 + standardDeduction,
          federalTaxWithheld: 20000,
        }],
        incomeK1: [{
          id: 'k1',
          entityName: 'SSTB LP',
          entityType: 'partnership',
          section199AQBI: 100000,
        }],
        qbiInfo: { isSSTB: true },
      }));
    };

    const at2024 = calculateQBIDeduction(100000, 195000, FilingStatus.Single, true, 0, 0, 0, 2024);
    expect(qbiReturn(2024).form1040.qbiDeduction).toBe(at2024);
    expect(at2024).toBeLessThan(20000);
    expect(qbiReturn(2025).form1040.qbiDeduction).toBe(20000);
    expect(qbiReturn(2026).form1040.qbiDeduction).toBe(20000);
  });

  it('caps HSA contributions at that year limit', () => {
    const hsa = (taxYear: number) => calculateForm1040(makeReturn({
      taxYear,
      w2Income: [{ id: 'w2', employerName: 'Acme', wages: 60000, federalTaxWithheld: 5000 }],
      hsaContribution: {
        coverageType: 'self_only',
        totalContributions: 4400,
        hdhpCoverageMonths: 12,
      },
    }));

    expect(hsa(2024).form1040.hsaDeduction).toBe(4150);
    expect(hsa(2025).form1040.hsaDeduction).toBe(4300);
    expect(hsa(2026).form1040.hsaDeduction).toBe(4400);
  });

  it('caps SEP-IRA contributions at that year maximum', () => {
    const sep = (taxYear: number) => calculateForm1040(makeReturn({
      taxYear,
      income1099NEC: [{ id: 'nec', payerName: 'Client', amount: 1_000_000 }],
      selfEmploymentDeductions: {
        healthInsurancePremiums: 0,
        sepIraContributions: 80000,
        solo401kContributions: 0,
        otherRetirementContributions: 0,
      },
    }));

    expect(sep(2024).form1040.retirementContributions).toBe(69000);
    expect(sep(2025).form1040.retirementContributions).toBe(70000);
    // 2026 compensation cap is $360,000, so 20% reaches the $72,000 annual addition.
    expect(sep(2026).form1040.retirementContributions).toBe(72000);
  });

  it('caps Solo 401(k) elective deferrals at that year limit', () => {
    const solo = (taxYear: number) => calculateForm1040(makeReturn({
      taxYear,
      income1099NEC: [{ id: 'nec', payerName: 'Client', amount: 100000 }],
      selfEmploymentDeductions: {
        healthInsurancePremiums: 0,
        sepIraContributions: 0,
        solo401kEmployeeDeferral: 24500,
        solo401kContributions: 24500,
        otherRetirementContributions: 0,
      },
    }));

    expect(solo(2024).form1040.retirementContributions).toBe(23000);
    expect(solo(2025).form1040.retirementContributions).toBe(23500);
    expect(solo(2026).form1040.retirementContributions).toBe(24500);
  });

  it('caps self-employed long-term care premiums at that year age limit', () => {
    const ltc = (taxYear: number) => calculateForm1040(makeReturn({
      taxYear,
      dateOfBirth: '1940-01-01',
      income1099NEC: [{ id: 'nec', payerName: 'Client', amount: 100000 }],
      selfEmploymentDeductions: {
        healthInsurancePremiums: 0,
        sepIraContributions: 0,
        solo401kContributions: 0,
        otherRetirementContributions: 0,
        form7206: {
          medicalDentalVisionPremiums: 0,
          longTermCarePremiums: 10000,
          taxpayerLTCPremium: 10000,
        },
      },
    }));

    expect(ltc(2024).form7206?.longTermCarePremiumsClaimed).toBe(5880);
    expect(ltc(2025).form7206?.longTermCarePremiumsClaimed).toBe(6020);
    expect(ltc(2026).form7206?.longTermCarePremiumsClaimed).toBe(6200);
  });

  it('uses that year federal poverty level for the premium tax credit', () => {
    const ptc = calculateForm1040(makeReturn({
      taxYear: 2024,
      w2Income: [{ id: 'w2', employerName: 'Acme', wages: 29160, federalTaxWithheld: 2000 }],
      premiumTaxCredit: {
        familySize: 1,
        forms1095A: [{
          id: 'f',
          marketplace: 'Healthcare.gov',
          enrollmentPremiums: Array(12).fill(500),
          slcspPremiums: Array(12).fill(600),
          advancePTC: Array(12).fill(0),
          coverageMonths: Array(12).fill(true),
        }],
      },
    }));

    // 2024 one-person FPL is $14,580. $29,160 is 200% of that level.
    // The 2025 level ($15,060) would put the same wages at about 194%.
    expect(ptc.premiumTaxCredit?.fplPercentage).toBeCloseTo(200, 0);
  });

  it('reduces the QBI limit by long-term gain left after a short-term loss and section 1231 gain', () => {
    const standardDeduction = getStandardDeduction(2025)[FilingStatus.Single];
    const capitalInIncome = 25000 + 10000;
    const taxableBeforeQbi = 100000;
    const wages = taxableBeforeQbi + standardDeduction - capitalInIncome;
    const result = calculateForm1040(makeReturn({
      w2Income: [{ id: 'w2', employerName: 'Acme', wages, federalTaxWithheld: 0 }],
      income1099B: [
        {
          id: 'lt',
          brokerName: 'Broker',
          description: 'Stock',
          dateSold: '2025-06-01',
          proceeds: 40000,
          costBasis: 0,
          isLongTerm: true,
        },
        {
          id: 'st',
          brokerName: 'Broker',
          description: 'Stock',
          dateSold: '2025-06-01',
          proceeds: 0,
          costBasis: 15000,
          isLongTerm: false,
        },
      ],
      incomeK1: [{
        id: 'k1',
        entityName: 'Biz LP',
        entityType: 'partnership',
        section199AQBI: 100000,
        netSection1231Gain: 10000,
      }],
      qbiInfo: { isSSTB: false },
    }));

    // Long-term base is min($40,000, $25,000) + $10,000 section 1231 = $35,000.
    // 20% of ($100,000 − $35,000) = $13,000. Unreduced long-term gain would cap at $12,000.
    expect(result.form1040.qbiDeduction).toBe(13000);
  });

  it('does not reduce the QBI limit by K-1 long-term gain that a short-term loss already offset', () => {
    const standardDeduction = getStandardDeduction(2025)[FilingStatus.Single];
    // The K-1's $10,000 long-term gain is Schedule D line 12: it nets with the
    // $15,000 short-term loss, leaving a $5,000 loss — $3,000 deducted, $2,000 carried.
    const wages = 100000 + standardDeduction + 3000;
    const result = calculateForm1040(makeReturn({
      w2Income: [{ id: 'w2', employerName: 'Acme', wages, federalTaxWithheld: 0 }],
      income1099B: [{
        id: 'st',
        brokerName: 'Broker',
        description: 'Stock',
        dateSold: '2025-06-01',
        proceeds: 0,
        costBasis: 15000,
        isLongTerm: false,
      }],
      incomeK1: [{
        id: 'k1',
        entityName: 'Biz LP',
        entityType: 'partnership',
        section199AQBI: 100000,
        longTermCapitalGain: 10000,
      }],
      qbiInfo: { isSSTB: false },
    }));

    // Net capital gain is zero ($10,000 long-term − $15,000 short-term, floored).
    // 20% of $100,000 = $20,000. Leaving the $10,000 unoffset would cap the deduction at $18,000.
    expect(result.form1040.qbiDeduction).toBe(20000);
  });
});

describe('Schedule D rate-gain lines', () => {
  it('reports collectibles on line 18 and direct unrecaptured 1250 on line 19', () => {
    const tr = makeReturn({ unrecapturedSection1250Gain: 2500 });
    const calc = {
      scheduleD: { collectiblesGain: 6000 },
      form4797: { unrecapturedSection1250Gain: 1000 },
    } as CalculationResult;

    expect(mapField('Line 18: 28% rate gain')(tr, calc)).toBe('6000');
    expect(mapField('Line 19: Unrecaptured section 1250 gain')(tr, calc)).toBe('3500');
    expect(mapField('Line 20: Are lines 18 and 19 both zero or blank: Yes')(tr, calc)).toBe(false);
    expect(mapField('Line 20: Are lines 18 and 19 both zero or blank: No')(tr, calc)).toBe(true);
  });
});
