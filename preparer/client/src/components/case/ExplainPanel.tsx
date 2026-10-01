/**
 * Explain tab: how the engine arrived at the result — effective and marginal
 * rates, the flow from income to refund, the line-by-line breakdown, and the
 * calculation trace (work order §71 "explain major results").
 */

import { useMemo, type ReactNode } from 'react';
import { FilingStatus } from '@hatax/engine';
import { amtWaterfall, creditItems, deductionsFlow, estimatedPayments, incomeItems, selfEmploymentFlow } from '../../services/explainCharts';
import { resolveFormFromLineId } from '../../services/traceFormLinker';
import { useCaseStore } from '../../store/caseStore';
import BracketChart from '../explain/BracketChart';
import EffectiveTaxRateCard from '../explain/EffectiveTaxRateCard';
import TaxFlowSwitcher from '../explain/TaxFlowSwitcher';
import TaxInsights from '../explain/TaxInsights';
import TraceTree from '../explain/TraceTree';
import ExplainTaxesPanel from '../layout/ExplainTaxesPanel';
import AMTWaterfall from '../charts/AMTWaterfall';
import CreditsChartSwitcher from '../charts/CreditsChartSwitcher';
import DeductionsFlowSwitcher from '../charts/DeductionsFlowSwitcher';
import EstimatedPaymentsChart from '../charts/EstimatedPaymentsChart';
import IncomeChartSwitcher from '../charts/IncomeChartSwitcher';
import SEFlowSwitcher from '../charts/SEFlowSwitcher';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-700 bg-surface-800 p-4">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      {children}
    </section>
  );
}

export default function ExplainPanel() {
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const navigateToFormLine = useCaseStore((s) => s.navigateToFormLine);
  const showSection = useCaseStore((s) => s.showReviewSection);
  const charts = useMemo(() => {
    if (!taxReturn || !calculation) return null;
    return {
      income: incomeItems(calculation),
      deductions: deductionsFlow(taxReturn, calculation),
      credits: creditItems(calculation),
      business: selfEmploymentFlow(calculation),
      estimates: estimatedPayments(taxReturn, calculation),
      amt: amtWaterfall(calculation),
    };
  }, [taxReturn, calculation]);
  if (!taxReturn || !calculation || !charts) return <p className="text-sm text-slate-500">No calculation yet.</p>;
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
      {charts.income.length > 0 && (
        <Card title="Income by source">
          <IncomeChartSwitcher items={charts.income} onSliceClick={showSection} />
        </Card>
      )}
      <Card title="From income to taxable income">
        <DeductionsFlowSwitcher {...charts.deductions} onBarClick={showSection} />
      </Card>
      {charts.credits.length > 0 && (
        <Card title="Credits">
          <CreditsChartSwitcher items={charts.credits} onSliceClick={showSection} />
        </Card>
      )}
      {charts.business && (
        <Card title="Business (Schedule C)">
          <SEFlowSwitcher {...charts.business} onBarClick={showSection} />
        </Card>
      )}
      {charts.estimates && (
        <Card title="Estimated tax payments">
          <EstimatedPaymentsChart quarters={charts.estimates.quarters} quarterlyDetail={charts.estimates.quarterlyDetail} />
        </Card>
      )}
      {charts.amt && (
        <Card title="Alternative minimum tax">
          <AMTWaterfall {...charts.amt} />
        </Card>
      )}
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
