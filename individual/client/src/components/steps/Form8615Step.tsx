import { useTaxReturnStore } from '../../store/taxReturnStore';
import { updateReturn } from '../../api/client';
import FormField from '../common/FormField';
import CurrencyInput from '../common/CurrencyInput';
import SSNInput from '../common/SSNInput';
import StepNavigation from '../layout/StepNavigation';
import SectionIntro from '../common/SectionIntro';
import CalloutCard from '../common/CalloutCard';
import StepWarningsBanner from '../common/StepWarningsBanner';
import { Baby, ExternalLink } from 'lucide-react';
import { FilingStatus, type Form8615Info, type Form8615Result } from '@hatax/engine';

const PARENT_STATUS: Array<{ value: FilingStatus; label: string }> = [
  { value: FilingStatus.Single, label: 'Single' },
  { value: FilingStatus.MarriedFilingJointly, label: 'Married filing jointly' },
  { value: FilingStatus.MarriedFilingSeparately, label: 'Married filing separately' },
  { value: FilingStatus.HeadOfHousehold, label: 'Head of household' },
  { value: FilingStatus.QualifyingSurvivingSpouse, label: 'Qualifying surviving spouse' },
];

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** The form's lines, as the IRS prints them. */
function Lines({ r }: { r: Form8615Result }) {
  const rows: Array<[string, string, number | undefined]> = [
    ['1', 'Your unearned income', r.line1],
    ['2', '$2,700, or your itemized amount', r.line2],
    ['3', 'Line 1 minus line 2', r.line3],
  ];
  if (r.line3 > 0) rows.push(['4', 'Your taxable income', r.line4], ['5', 'The smaller of line 3 or line 4 (your net unearned income)', r.line5]);
  if (r.applies) {
    rows.push(
      ['6', "Your parent's taxable income", r.line6],
      ...(r.line7 > 0 ? [['7', "The parent's other children's line 5", r.line7] as [string, string, number]] : []),
      ['8', 'Lines 5, 6 and 7', r.line8],
      ['9', "Tax on line 8 at your parent's filing status", r.line9],
      ['10', "Your parent's tax", r.line10],
      ['11', 'Line 9 minus line 10', r.line11],
      ...(r.line12b !== undefined ? [['12b', 'Your share (line 5 ÷ line 12a)', undefined] as [string, string, undefined]] : []),
      ['13', "Tax on your net unearned income at your parent's rate", r.line13],
      ['14', 'Line 4 minus line 5', r.line14],
      ['15', 'Tax on line 14 at your rate', r.line15],
      ['16', 'Lines 13 and 15', r.line16],
      ['17', 'Tax on all your taxable income at your rate', r.line17],
      ['18', 'Your tax (the larger of 16 and 17) — Form 1040 line 16', r.line18],
    );
  }
  return (
    <table className="w-full text-sm mt-3">
      <tbody>
        {rows.map(([line, label, value]) => (
          <tr key={line} className="border-t border-slate-700/50">
            <td className="py-1.5 pr-3 text-slate-500 w-10">{line}</td>
            <td className="py-1.5 text-slate-300">{label}</td>
            <td className="py-1.5 text-right text-slate-100 tabular-nums">{line === '12b' ? r.line12b!.toFixed(3) : money(value ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Form 8615: a child's unearned income over $2,700 taxed at the parent's
 * rate. Whether it applies is the filer's answer; the parent's figures come
 * from the parent's own return. The engine figures the form line by line
 * (engine/form8615.ts) once every figure is in, and holds the return until
 * then.
 */
export default function Form8615Step() {
  const { taxReturn, returnId, updateDeepField, calculation } = useTaxReturnStore();
  if (!taxReturn || !returnId) return null;

  const info: Form8615Info = taxReturn.form8615 ?? {};
  const set = (field: keyof Form8615Info, value: unknown) => updateDeepField(`form8615.${field}`, value);
  const outcome = calculation?.form8615;
  const itemizes = calculation?.form1040.deductionUsed === 'itemized';
  const result = outcome?.status === 'figured' ? outcome.result : undefined;

  const save = async () => {
    await updateReturn(returnId, { form8615: taxReturn.form8615 });
  };

  const yesNo = (value: boolean | undefined, onChange: (v: boolean) => void, label: string) => (
    <div className="flex gap-2" role="radiogroup" aria-label={label}>
      {[true, false].map((v) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`px-4 py-1.5 rounded-lg border text-sm ${value === v ? 'border-HATaxService-orange-400 bg-HATaxService-orange-500/10 text-white' : 'border-slate-600 text-slate-300 hover:border-slate-500'}`}
        >
          {v ? 'Yes' : 'No'}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <StepWarningsBanner stepId="form_8615" />

      <SectionIntro
        icon={<Baby className="w-8 h-8" />}
        title="Form 8615 (kiddie tax)"
        description="A child's interest, dividends and other unearned income over $2,700 is taxed at the parent's rate."
      />

      <CalloutCard variant="info" title="Who files Form 8615" irsUrl="https://www.irs.gov/forms-pubs/about-form-8615">
        You file it with your return if you must file a return, your unearned income was more than $2,700 and, at the end of {taxReturn.taxYear}, you were under 18, or 18 or a full-time student under 24 whose earned income was not more than half of your support — and at least one of your parents was alive and you don't file a joint return.
      </CalloutCard>

      {outcome === undefined && info.applies !== true && (
        <div className="card mt-6 text-sm text-slate-300">
          {info.applies === false
            ? 'You said Form 8615 does not apply to you.'
            : `Form 8615 is not needed: your unearned income is not more than $2,700, or you are 24 or older or file jointly${calculation ? '' : ' (enter your income first)'}.`}
          {info.applies === false && (
            <button type="button" onClick={() => set('applies', undefined)} className="ml-2 text-HATaxService-blue-400 hover:text-HATaxService-blue-300">Change</button>
          )}
        </div>
      )}

      {(outcome !== undefined || info.applies === true) && (
        <div className="card mt-6">
          {outcome?.status === 'ask' && (
            <p className="text-sm text-slate-300 mb-3">
              Your unearned income is {money(outcome.unearnedIncome)}{outcome.age !== undefined ? ` and you are ${outcome.age} at the end of ${taxReturn.taxYear}` : ''}.
            </p>
          )}
          <FormField label="Does Form 8615 apply to you?">
            {yesNo(info.applies, (v) => set('applies', v), 'Does Form 8615 apply to you?')}
          </FormField>
        </div>
      )}

      {info.applies === true && (
        <div className="card mt-6 space-y-1">
          <h3 className="font-medium text-slate-200 mb-2">From your parent's {taxReturn.taxYear} return</h3>
          <p className="text-xs text-slate-400 mb-3">Use the parent whose return the instructions name (the one with the higher taxable income when your parents file separately). Every figure is needed; enter 0 where the parent has none.</p>
          <FormField label="Parent's name (line A)">
            <input className="input-field" value={info.parentName ?? ''} onChange={(e) => set('parentName', e.target.value || undefined)} placeholder="First, initial, last" />
          </FormField>
          <FormField label="Parent's SSN (line B)">
            <SSNInput label="Parent's SSN" value={info.parentSsn ?? ''} onChange={(v) => set('parentSsn', v || undefined)} />
          </FormField>
          <FormField label="Parent's filing status (line C)">
            <select className="input-field" value={info.parentFilingStatus ?? ''} onChange={(e) => set('parentFilingStatus', e.target.value === '' ? undefined : Number(e.target.value))}>
              <option value="">Choose…</option>
              {PARENT_STATUS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </FormField>
          <FormField label="Parent's taxable income" irsRef="Parent's Form 1040, line 15 (0 if zero or less)">
            <CurrencyInput optional value={info.parentTaxableIncome} onChange={(v) => set('parentTaxableIncome', v)} />
          </FormField>
          <FormField label="Parent's tax" irsRef="Parent's Form 1040, line 16" helpText="Without any tax from Form 4972 or 8814 or education credit recapture.">
            <CurrencyInput optional value={info.parentTax} onChange={(v) => set('parentTax', v)} />
          </FormField>
          <FormField label="Parent's qualified dividends" irsRef="Parent's Form 1040, line 3a">
            <CurrencyInput optional value={info.parentQualifiedDividends} onChange={(v) => set('parentQualifiedDividends', v)} />
          </FormField>
          <FormField label="Parent's net capital gain" helpText="The smaller of Schedule D lines 15 and 16 (or Form 1040 line 7a when there is no Schedule D); 0 if none.">
            <CurrencyInput optional value={info.parentNetCapitalGain} onChange={(v) => set('parentNetCapitalGain', v)} />
          </FormField>
          <FormField label="The parent's other children's Forms 8615, line 5, in total (line 7)" helpText="0 when no other child of this parent files Form 8615.">
            <CurrencyInput optional value={info.otherChildrenNetUnearnedIncome} onChange={(v) => set('otherChildrenNetUnearnedIncome', v)} />
          </FormField>
          {(info.otherChildrenNetUnearnedIncome ?? 0) > 0 && (
            <>
              <FormField label="Qualified dividends included on line 7">
                <CurrencyInput optional value={info.otherChildrenQualifiedDividends} onChange={(v) => set('otherChildrenQualifiedDividends', v)} />
              </FormField>
              <FormField label="Net capital gain included on line 7">
                <CurrencyInput optional value={info.otherChildrenNetCapitalGain} onChange={(v) => set('otherChildrenNetCapitalGain', v)} />
              </FormField>
            </>
          )}
          {itemizes && (
            <FormField label="Your itemized deductions directly connected with your unearned income (line 2)" helpText="Custodian and investment fees and the like; 0 if none.">
              <CurrencyInput optional value={info.childDirectlyConnectedDeductions} onChange={(v) => set('childDirectlyConnectedDeductions', v)} />
            </FormField>
          )}
          <FormField label="Did your parent's tax use the Schedule D Tax Worksheet, Schedule J or the Foreign Earned Income Tax Worksheet?" helpText="Also yes if another child of this parent has 28% rate gain or unrecaptured section 1250 gain. HATax cannot figure Form 8615 then.">
            {yesNo(info.parentSpecialComputation, (v) => set('parentSpecialComputation', v), "Parent's special tax computation")}
          </FormField>
        </div>
      )}

      {outcome?.status === 'missing' && (
        <p className="mt-4 text-sm text-amber-300">
          {outcome.missing.length} figure{outcome.missing.length === 1 ? '' : 's'} still needed before Form 8615 can be figured. Your return cannot be filed until then.
        </p>
      )}

      {result && result.unsupported.length > 0 && (
        <div className="mt-4 space-y-2">
          {result.unsupported.map((u) => (
            <CalloutCard key={u.ruleId} variant="warning" title="Form 8615 cannot be figured here">{u.message}</CalloutCard>
          ))}
        </div>
      )}

      {result && result.unsupported.length === 0 && (
        <div className="card mt-6">
          <h3 className="font-medium text-slate-200">Your Form 8615</h3>
          <p className="text-xs text-slate-400 mt-1">
            {result.applies
              ? `Your tax is ${money(result.line18)} (line 18), on Form 1040 line 16.`
              : result.line3 <= 0
                ? 'Line 3 is zero or less, so the form stops there: your tax is figured as usual. The form is still attached to your return.'
                : 'Line 5 is zero, so the form stops there: your tax is figured as usual. The form is still attached to your return.'}
          </p>
          <Lines r={result} />
          <a href="https://www.irs.gov/forms-pubs/about-form-8615" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-3 text-xs text-HATaxService-blue-400 hover:text-HATaxService-blue-300 transition-colors"><ExternalLink className="w-3 h-3" />Form 8615 instructions on IRS.gov</a>
        </div>
      )}

      <StepNavigation onContinue={save} />
    </div>
  );
}
