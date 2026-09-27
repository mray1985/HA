/**
 * IRC §1(h)(4) — 28% maximum rate on long-term collectibles gain.
 *
 * Collectibles flagged on Form 1099-B must not stay in the 0%/15%/20% bucket.
 */
import { describe, it, expect } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculatePreferentialRateTax } from '../src/engine/capitalGains.js';
import { calculateScheduleD } from '../src/engine/scheduleD.js';
import { TaxReturn, FilingStatus } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'collectibles-test',
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

describe('28% collectibles rate', () => {
  it('taxes long-term collectibles at 28% instead of 15% when ordinary rates are higher', () => {
    // Ordinary income $200,000 is in the 32% single bracket (starts at $197,300).
    // $10,000 of LTCG stacked above that is under the 20% threshold ($533,400),
    // so a non-collectible gain is 15% ($1,500) and a collectible is 28% ($2,800).
    const ordinary = 200000;
    const gain = 10000;
    const taxable = ordinary + gain;

    const at15 = calculatePreferentialRateTax(
      taxable, 0, gain, FilingStatus.Single, 0, 2025, 0,
    );
    const at28 = calculatePreferentialRateTax(
      taxable, 0, gain, FilingStatus.Single, 0, 2025, gain,
    );

    expect(at15.collectiblesTax).toBe(0);
    expect(at15.preferentialTax).toBe(1500);
    expect(at28.collectiblesTax).toBe(2800);
    expect(at28.preferentialTax).toBe(0);
    expect(at28.totalTax - at15.totalTax).toBe(1300);
  });

  it('caps the 28% gain at net long-term gain', () => {
    const result = calculateScheduleD(
      [
        {
          id: 'art',
          brokerName: 'Gallery',
          description: 'Painting',
          dateSold: '2025-06-01',
          proceeds: 10000,
          costBasis: 0,
          isLongTerm: true,
          isCollectible: true,
        },
        {
          id: 'stock-loss',
          brokerName: 'Broker',
          description: 'Stock',
          dateSold: '2025-06-01',
          proceeds: 0,
          costBasis: 4000,
          isLongTerm: true,
        },
      ],
      0,
      FilingStatus.Single,
    );
    expect(result.netLongTerm).toBe(6000);
    expect(result.collectiblesGain).toBe(6000);
  });

  it('does not put a flagged collectible sale into the 15% bucket on Form 1040', () => {
    const sale = {
      id: 'b1',
      brokerName: 'Gallery',
      description: 'Sculpture',
      dateSold: '2025-08-01',
      proceeds: 10000,
      costBasis: 0,
      isLongTerm: true,
    };
    const wages = [{
      id: 'w1',
      employerName: 'Acme',
      wages: 220000,
      federalTaxWithheld: 0,
    }];

    const ordinaryGain = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [{ ...sale, isCollectible: false }],
    }));
    const collectibleGain = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [{ ...sale, isCollectible: true }],
    }));

    expect(ordinaryGain.scheduleD?.collectiblesGain).toBe(0);
    expect(collectibleGain.scheduleD?.collectiblesGain).toBe(10000);
    expect(collectibleGain.form1040.incomeTax - ordinaryGain.form1040.incomeTax).toBe(1300);
  });

  it('does not tax a short-term loss that already reduced collectibles at 15%', () => {
    const wages = [{
      id: 'w1',
      employerName: 'Acme',
      wages: 220000,
      federalTaxWithheld: 0,
    }];
    const collectibles = {
      id: 'art',
      brokerName: 'Gallery',
      description: 'Painting',
      dateSold: '2025-06-01',
      proceeds: 10000,
      costBasis: 0,
      isLongTerm: true,
      isCollectible: true,
    };
    const shortTermLoss = {
      id: 'stock',
      brokerName: 'Broker',
      description: 'Stock',
      dateSold: '2025-06-01',
      proceeds: 0,
      costBasis: 4000,
      isLongTerm: false,
    };
    const reducedOnly = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [{ ...collectibles, proceeds: 6000 }],
    }));
    const withShortTermLoss = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [collectibles, shortTermLoss],
    }));

    expect(withShortTermLoss.scheduleD?.collectiblesGain).toBe(6000);
    expect(withShortTermLoss.form1040.incomeTax).toBe(reducedOnly.form1040.incomeTax);
  });

  it('does not treat collectibles wiped out by a net capital loss as long-term gain', () => {
    const wages = [{
      id: 'w1',
      employerName: 'Acme',
      wages: 80000,
      federalTaxWithheld: 8000,
    }];
    const plainLoss = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [{
        id: 'stock',
        brokerName: 'Broker',
        description: 'Stock',
        dateSold: '2025-06-01',
        proceeds: 0,
        costBasis: 2000,
        isLongTerm: false,
      }],
    }));
    const wipedCollectibles = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: wages,
      income1099B: [
        {
          id: 'art',
          brokerName: 'Gallery',
          description: 'Painting',
          dateSold: '2025-06-01',
          proceeds: 3000,
          costBasis: 0,
          isLongTerm: true,
          isCollectible: true,
        },
        {
          id: 'stock',
          brokerName: 'Broker',
          description: 'Stock',
          dateSold: '2025-06-01',
          proceeds: 0,
          costBasis: 5000,
          isLongTerm: false,
        },
      ],
    }));

    expect(wipedCollectibles.scheduleD?.collectiblesGain).toBe(0);
    expect(wipedCollectibles.form1040.incomeTax).toBe(plainLoss.form1040.incomeTax);
  });
});
