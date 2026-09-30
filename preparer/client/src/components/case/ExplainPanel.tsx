/**
 * Explain tab: how the engine arrived at the result — effective and marginal
 * rates, the flow from income to refund, the line-by-line breakdown, and the
 * calculation trace (work order §71 "explain major results").
 */

import { FilingStatus } from '@hatax/engine';
import { resolveFormFromLineId } from '../../services/traceFormLinker';
import { useCaseStore } from '../../store/caseStore';
import BracketChart from '../explain/BracketChart';
import EffectiveTaxRateCard from '../explain/EffectiveTaxRateCard';
import TaxFlowSwitcher from '../explain/TaxFlowSwitcher';
import TaxInsights from '../explain/TaxInsights';
import TraceTree from '../explain/TraceTree';
import ExplainTaxesPanel from '../layout/ExplainTaxesPanel';

export default function ExplainPanel() {
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const navigateToFormLine = useCaseStore((s) => s.navigateToFormLine);
  if (!taxReturn || !calculation) return <p className="text-sm text-slate-500">No calculation yet.</p>;
  const f = calculation.form1040;

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-2 gap-4">
        <EffectiveTaxRateCard form1040={f} />
        <BracketChart taxableIncome={f.taxableIncome} filingStatus={taxReturn.filingStatus ?? FilingStatus.Single} incomeTax={f.incomeTax} />
      </div>
      <div className="rounded-xl border border-slate-700 bg-surface-800 p-4">
        <TaxFlowSwitcher form1040={f} calculation={calculation} />
      </div>
      <TaxInsights form1040={f} calculation={calculation} />
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <ExplainTaxesPanel open />
      </div>
      <section className="rounded-xl border border-slate-700 bg-surface-800 p-4">
        <h3 className="text-sm font-semibold text-white mb-3">Calculation trace</h3>
        <TraceTree
          traces={calculation.traces ?? []}
          onNavigateToForm={(lineId) => {
            const formId = resolveFormFromLineId(lineId);
            if (formId) navigateToFormLine(formId, lineId);
          }}
        />
      </section>
    </div>
  );
}
