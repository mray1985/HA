import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateForm4562 } from '../src/engine/form4562.js';
import { calculateHomeSaleExclusion } from '../src/engine/homeSale.js';
import { limitAdoptionCredit } from '../src/engine/adoptionCredit.js';
import { figureCurrentYearNOL } from '../src/engine/nol.js';
import { applySection1231Lookback } from '../src/engine/section1231Lookback.js';
import { FilingStatus, TaxReturn } from '../src/types/index.js';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'six-rules',
    taxYear: 2025,
    status: 'in_progress',
    currentStep: 0,
    currentSection: 'review',
    filingStatus: FilingStatus.Single,
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
    rentalProperties: [],
    otherIncome: 0,
    expenses: [],
    deductionMethod: 'standard',
    educationCredits: [],
    incomeDiscovery: {},
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const wages = (amount: number) => [{
  id: 'w1',
  employerName: 'Acme',
  wages: amount,
  federalTaxWithheld: 0,
}];

describe('section 1231 five-year lookback', () => {
  it('uses the oldest unrecaptured losses first and drops years outside the window', () => {
    const result = applySection1231Lookback(12000, [
      { taxYear: 2019, netGainOrLoss: -10000 },
      { taxYear: 2020, netGainOrLoss: -10000 },
      { taxYear: 2021, netGainOrLoss: 3000 },
      { taxYear: 2022, netGainOrLoss: -2000 },
    ], 2025);
    expect(result.ordinaryFromGain).toBe(9000);
    expect(result.longTermGain).toBe(3000);
    expect(result.unrecapturedLoss).toBe(0);
  });

  it('taxes only the post-lookback gain as long-term on Form 1040', () => {
    const ordinary = calculateForm1040(makeReturn({
      w2Income: wages(80000),
      otherIncome: 9000,
    }));
    const lookedBack = calculateForm1040(makeReturn({
      w2Income: wages(80000),
      section1231Lookback: [
        { taxYear: 2020, netGainOrLoss: -10000 },
        { taxYear: 2021, netGainOrLoss: 3000 },
        { taxYear: 2022, netGainOrLoss: -2000 },
      ],
      form4797Properties: [{
        id: 'land',
        description: 'Land',
        dateAcquired: '2018-01-01',
        dateSold: '2025-06-01',
        salesPrice: 12000,
        costBasis: 0,
        depreciationAllowed: 0,
      }],
    }));
    expect(lookedBack.section1231LookbackOrdinary).toBe(9000);
    expect(lookedBack.section1231LongTermGain).toBe(3000);
    expect(lookedBack.form1040.totalIncome).toBe(ordinary.form1040.totalIncome + 3000);
  });
});

describe('section 1202', () => {
  it('excludes a 100% QSBS gain and taxes a 50% gain at 28%', () => {
    const none = calculateForm1040(makeReturn({ w2Income: wages(220000) }));
    const excluded = calculateForm1040(makeReturn({
      w2Income: wages(220000),
      income1099B: [{
        id: 'qsbs',
        brokerName: 'Transfer',
        description: 'QSBS Co',
        dateAcquired: '2015-01-01',
        dateSold: '2025-06-01',
        proceeds: 10000,
        costBasis: 0,
        isLongTerm: true,
        isQSBS: true,
        qsbsIssuer: 'QSBS Co',
      }],
    }));
    const half = calculateForm1040(makeReturn({
      w2Income: wages(220000),
      income1099B: [{
        id: 'qsbs',
        brokerName: 'Transfer',
        description: 'Old Co',
        dateAcquired: '2005-01-01',
        dateSold: '2025-06-01',
        proceeds: 10000,
        costBasis: 0,
        isLongTerm: true,
        isQSBS: true,
        qsbsIssuer: 'Old Co',
      }],
    }));
    const ordinaryLtcg = calculateForm1040(makeReturn({
      w2Income: wages(220000),
      income1099B: [{
        id: 'stock',
        brokerName: 'Broker',
        description: 'Stock',
        dateAcquired: '2020-01-01',
        dateSold: '2025-06-01',
        proceeds: 5000,
        costBasis: 0,
        isLongTerm: true,
      }],
    }));

    expect(excluded.scheduleD?.section1202ExcludedGain).toBe(10000);
    expect(excluded.scheduleD?.netLongTerm).toBe(0);
    expect(excluded.form1040.incomeTax).toBe(none.form1040.incomeTax);
    expect(half.scheduleD?.section1202ExcludedGain).toBe(5000);
    expect(half.scheduleD?.section1202RateGain).toBe(5000);
    expect(half.scheduleD?.collectiblesGain).toBe(5000);
    expect(half.scheduleD?.section1202AmtPreference).toBe(350);
    expect(half.form1040.incomeTax - ordinaryLtcg.form1040.incomeTax).toBe(650);
  });
});

describe('current-year NOL', () => {
  it('does not let the standard deduction or a capital loss create an NOL', () => {
    expect(figureCurrentYearNOL({
      agi: -50000,
      deductionAmount: 15000,
      schedule1ADeduction: 0,
      capitalLossDeduction: 0,
      nonbusinessIncome: 0,
      otherNonbusinessDeductions: 0,
    })).toBe(50000);
    expect(figureCurrentYearNOL({
      agi: -3000,
      deductionAmount: 15000,
      schedule1ADeduction: 0,
      capitalLossDeduction: 3000,
      nonbusinessIncome: 0,
      otherNonbusinessDeductions: 0,
    })).toBe(0);
  });

  it('reports a Schedule C loss as an NOL and does not deduct it this year', () => {
    const loss = calculateForm1040(makeReturn({
      income1099NEC: [{ id: 'nec', payerName: 'Client', amount: 0 }],
      expenses: [{ id: 'e1', scheduleCLine: 27, category: 'other', amount: 50000 }],
    }));
    expect(loss.currentYearNOL).toBeGreaterThan(0);
    expect(loss.form1040.nolDeduction).toBe(0);
    expect(loss.form1040.currentYearNOL).toBe(loss.currentYearNOL);
  });
});

describe('partial home-sale exclusion', () => {
  it('halves the exclusion after 12 months when the sale has a qualifying reason', () => {
    const reduced = calculateHomeSaleExclusion({
      salePrice: 200000,
      costBasis: 0,
      ownedMonths: 12,
      usedAsResidenceMonths: 12,
      reducedMaximumReason: 'health',
    }, FilingStatus.Single, 2025);
    const denied = calculateHomeSaleExclusion({
      salePrice: 200000,
      costBasis: 0,
      ownedMonths: 12,
      usedAsResidenceMonths: 12,
    }, FilingStatus.Single, 2025);

    expect(reduced.exclusionAmount).toBe(125000);
    expect(reduced.taxableGain).toBe(75000);
    expect(denied.exclusionAmount).toBe(0);
    expect(denied.taxableGain).toBe(200000);
  });
});

describe('ADS depreciation', () => {
  it('uses straight-line ADS when business use is 50% or less', () => {
    const result = calculateForm4562([{
      id: 'laptop',
      description: 'Laptop',
      cost: 10000,
      dateInService: '2025-06-01',
      propertyClass: 5,
      businessUsePercent: 40,
      depreciationSystem: 'ads',
    }], 0, 2025);
    expect(result.bonusDepreciationTotal).toBe(0);
    expect(result.assetDetails[0].macrsDepreciation).toBe(400);
  });
});

describe('adoption credit carryforward', () => {
  it('uses the oldest credit first and carries the unused current-year credit', () => {
    const limited = limitAdoptionCredit({
      qualifiedExpenses: 20000,
      priorCarryforwards: [
        { taxYear: 2019, amount: 1000 },
        { taxYear: 2021, amount: 4000 },
      ],
    }, 20000, 2025, 5000);
    expect(limited.expired).toBe(1000);
    expect(limited.credit).toBe(5000);
    expect(limited.carryforwardByYear).toEqual([
      { taxYear: 2021, amount: 0 },
      { taxYear: 2025, amount: 19000 },
    ].filter(year => year.amount > 0));
    expect(limited.carryforward).toBe(19000);
  });

  it('limits the Form 1040 credit to tax and reports the carryforward', () => {
    const result = calculateForm1040(makeReturn({
      w2Income: wages(30000),
      adoptionCredit: {
        qualifiedExpenses: 17280,
        numberOfChildren: 1,
      },
    }));
    expect(result.credits.adoptionCredit).toBeLessThan(17280);
    expect(result.adoptionCredit?.carryforward).toBeGreaterThan(0);
    expect((result.credits.adoptionCredit || 0) + (result.adoptionCredit?.carryforward || 0)).toBe(17280);
  });
});
