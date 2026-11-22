import { useEffect, useRef, useState } from 'react';
import { useTaxReturnStore } from '../store/taxReturnStore';
import { calculateForm1040, FilingStatus } from '@hatax/engine';

/**
 * Recalculates the tax estimate whenever the tax return data changes.
 * Only runs if there's at least some income entered.
 *
 * Debounced at 150ms to avoid recalculating on every keystroke during
 * rapid data entry (e.g., typing a dollar amount in CurrencyInput).
 *
 * Tracing is always enabled — overhead is negligible (~9 trace objects)
 * and traces are consumed by ExplainTaxesPanel, ReviewForm1040Step,
 * and TaxSummaryStep via the Zustand store.
 */
export function useLiveCalculation() {
  const [calculationError, setCalculationError] = useState<string | null>(null);
  const taxReturn = useTaxReturnStore((s) => s.taxReturn);
  const setCalculation = useTaxReturnStore((s) => s.setCalculation);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!taxReturn) {
      setCalculationError(null);
      setCalculation(null);
      return;
    }

    // Only calculate if there's income data (check all income sources)
    const hasIncome =
      taxReturn.w2Income.length > 0 ||
      taxReturn.income1099NEC.length > 0 ||
      taxReturn.income1099K.length > 0 ||
      taxReturn.income1099INT.length > 0 ||
      taxReturn.income1099DIV.length > 0 ||
      taxReturn.income1099R.length > 0 ||
      taxReturn.income1099G.length > 0 ||
      taxReturn.income1099MISC.length > 0 ||
      taxReturn.income1099B.length > 0 ||
      taxReturn.income1099DA.length > 0 ||
      taxReturn.incomeK1.length > 0 ||
      taxReturn.income1099SA.length > 0 ||
      taxReturn.rentalProperties.length > 0 ||
      !!taxReturn.incomeSSA1099 ||
      (taxReturn.otherIncome || 0) > 0;

    if (!hasIncome) {
      setCalculationError(null);
      setCalculation(null);
      return;
    }

    // Ensure filing status has a default
    const returnWithDefaults = {
      ...taxReturn,
      filingStatus: taxReturn.filingStatus || FilingStatus.Single,
    };

    // Debounce recalculation to avoid thrashing during rapid data entry
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      try {
        const result = calculateForm1040(
          returnWithDefaults,
          { enabled: true },
        );
        setCalculation(result);
        setCalculationError(null);
      } catch {
        setCalculation(null);
        setCalculationError('This return could not be calculated. Review the last entry in the interview before relying on the results.');
      }
    }, 150);

    return () => clearTimeout(debounceRef.current);
  }, [taxReturn, setCalculation]);
  return { calculationError };
}
