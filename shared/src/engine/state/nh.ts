/**
 * New Hampshire State Calculator — Interest & Dividends Tax
 *
 * NH has no income tax on wages/salary. Prior to 2025, NH taxed interest
 * and dividend income at 4% (with $2,400 exemption per person). The I&D tax
 * was fully repealed effective 1/1/2025.
 *
 * TY2024: 4% on interest + dividends, $2,400/$4,800 exemption
 * TY2025+: Fully repealed — no tax
 */

import {
  TaxReturn, CalculationResult, StateCalculationResult, StateReturnConfig,
  FilingStatus, CalculationTrace,
} from '../../types/index.js';
import { getTaxConstants } from '../../constants/taxConstants.js';
import { TraceBuilder } from '../traceBuilder.js';
import { getStateWithholding, getStateFilingKey, getStateName } from './index.js';
import type { StateCalculator } from './stateRegistry.js';

function countPersons(filingStatus: FilingStatus | undefined): number {
  if (
    filingStatus === FilingStatus.MarriedFilingJointly ||
    filingStatus === FilingStatus.QualifyingSurvivingSpouse
  ) {
    return 2;
  }
  return 1;
}

export function createNHCalculator(): StateCalculator {
  return {
    calculate(
      taxReturn: TaxReturn,
      federalResult: CalculationResult,
      stateConfig: StateReturnConfig,
    ): StateCalculationResult {
      const taxYear = taxReturn.taxYear || 2025;
      const filingKey = getStateFilingKey(taxReturn.filingStatus);
      const filingStatus = taxReturn.filingStatus;
      const numDependents = taxReturn.dependents?.length || 0;
      const numPersons = countPersons(filingStatus);
      const tb = new TraceBuilder();
      const sName = getStateName('NH');
      const refs = { totalTaxLine: 'NH DP-10 Line 14' }; // NH DP-10 form

      // NH I&D tax fully repealed effective 1/1/2025
      if (taxYear >= 2025) {
        const zeroResult: StateCalculationResult = {
          stateCode: 'NH',
          stateName: 'New Hampshire',
          residencyType: stateConfig.residencyType,
          federalAGI: federalResult.form1040.agi,
          stateAdditions: 0,
          stateSubtractions: 0,
          stateAGI: 0,
          stateDeduction: 0,
          stateTaxableIncome: 0,
          stateExemptions: 0,
          stateIncomeTax: 0,
          stateCredits: 0,
          stateTaxAfterCredits: 0,
          localTax: 0,
          totalStateTax: 0,
          stateWithholding: getStateWithholding(taxReturn, 'NH'),
          stateEstimatedPayments: 0,
          stateRefundOrOwed: getStateWithholding(taxReturn, 'NH'),
          effectiveStateRate: 0,
          bracketDetails: [],
          additionalLines: { iAndDRepealed: 1 },
          traces: tb.build(),
        };
        return zeroResult;
      }

      // TY2024: 4% I&D tax with $2,400 per person exemption
      const idTaxRate = 0.04;
      const exemptionPerPerson = 2400;
      const totalExemption = exemptionPerPerson * numPersons;

      // Calculate interest and dividend income from federal result
      const interestIncome = federalResult.form1040.totalInterest || 0;
      // Ordinary dividends = total dividends - qualified dividends
      const ordinaryDividends = Math.max(0, (federalResult.form1040.totalDividends || 0) - (federalResult.form1040.qualifiedDividends || 0));
      const idIncome = interestIncome + ordinaryDividends;

      const taxableIdIncome = Math.max(0, idIncome - totalExemption);
      const grossTax = Math.round(taxableIdIncome * idTaxRate * 100) / 100;

      tb.trace('state.stateAGI', 'NH Interest & Dividends Income', idIncome, {
        authority: 'NH RSA 77:4; DP-10 Line 1',
        formula: 'Taxable Interest + Ordinary Dividends',
        inputs: [
          { lineId: 'form1040.line2b', label: 'Taxable Interest', value: interestIncome },
          { lineId: 'form1040.line3b', label: 'Ordinary Dividends', value: ordinaryDividends },
        ],
      });

      tb.trace('state.deduction', 'NH I&D Exemption', totalExemption, {
        authority: 'NH RSA 77:5; DP-10 Line 5',
        formula: `$2,400 × ${numPersons} person(s)`,
        inputs: [{ lineId: 'state.exemption', label: 'Exemption', value: totalExemption }],
      });

      tb.trace('state.taxableIncome', 'NH Taxable I&D Income', taxableIdIncome, {
        authority: 'NH RSA 77:4; DP-10 Line 6',
        formula: 'I&D Income − Exemption',
        inputs: [
          { lineId: 'state.stateAGI', label: 'I&D Income', value: idIncome },
          { lineId: 'state.deduction', label: 'Exemption', value: totalExemption },
        ],
      });

      tb.trace('state.incomeTax', 'NH I&D Tax', grossTax, {
        authority: 'NH RSA 77:4; DP-10 Line 7',
        formula: `${taxableIdIncome.toLocaleString()} × 4%`,
        inputs: [{ lineId: 'state.taxableIncome', label: 'Taxable I&D Income', value: taxableIdIncome }],
        children: taxableIdIncome > 0
          ? [{ lineId: 'state.bracket.flat', label: '4.00% flat rate', value: grossTax, formula: `${taxableIdIncome.toLocaleString()} × 4.00%`, inputs: [] }]
          : [],
      });

      const stateWithholding = getStateWithholding(taxReturn, 'NH');
      const totalStateTax = grossTax;
      const refundOrOwedRaw = stateWithholding - totalStateTax;
      const refundOrOwed = tb.trace(
        'state.refundOrOwed',
        refundOrOwedRaw >= 0 ? 'NH Refund' : 'NH Amount Owed',
        refundOrOwedRaw, {
          authority: 'DP-10 Line 14',
          formula: 'Withholding − Total Tax',
          inputs: [
            { lineId: 'state.totalTax', label: 'Total State Tax', value: totalStateTax },
            ...(stateWithholding > 0 ? [{ lineId: 'state.withholding', label: 'Withholding', value: stateWithholding }] : []),
          ],
        },
      );

      const effectiveRate = federalResult.form1040.agi > 0
        ? Math.round((totalStateTax / federalResult.form1040.agi) * 10000) / 10000
        : 0;

      return {
        stateCode: 'NH',
        stateName: 'New Hampshire',
        residencyType: stateConfig.residencyType,
        federalAGI: federalResult.form1040.agi,
        stateAdditions: 0,
        stateSubtractions: 0,
        stateAGI: idIncome,
        stateDeduction: totalExemption,
        stateTaxableIncome: taxableIdIncome,
        stateExemptions: totalExemption,
        stateIncomeTax: grossTax,
        stateCredits: 0,
        stateTaxAfterCredits: grossTax,
        localTax: 0,
        totalStateTax,
        stateWithholding,
        stateEstimatedPayments: 0,
        stateRefundOrOwed: refundOrOwed,
        effectiveStateRate: effectiveRate,
        bracketDetails: taxableIdIncome > 0
          ? [{
              rate: idTaxRate,
              taxableAtRate: taxableIdIncome,
              taxAtRate: grossTax,
            }]
          : [],
        additionalLines: { iAndDIncome: idIncome, iAndDExemption: totalExemption },
        traces: tb.build(),
      };
    },
  };
}