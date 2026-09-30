/**
 * Review actions (work order §38, §40): what the preparer answers from the
 * review list — a decision a form cannot make, the value of a field that holds
 * a form, or what a waiting dependent still needs. Every answer is validated,
 * recorded as a preparer fact, applied, and kept in the audit trail.
 */

import { useState, type ReactNode } from 'react';
import { CHOICE_FIELDS, DEPENDENT_RELATIONSHIPS, fieldInput, type ChoiceTool } from '@hatax/local-ai';
import type { ReviewAction } from '../../services/caseReview';
import { completeDependent, correctFormField, recordAcquisition, recordChoice, applyStatedFilingStatus, type DecisionResult } from '../../services/preparerDecisions';
import { useCaseStore } from '../../store/caseStore';

const inputClass = 'bg-surface-700 border border-slate-600 text-white text-sm rounded px-2 py-1.5 w-full';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-300">
      <span>{label}</span>
      {children}
      {hint && <span className="text-slate-500">{hint}</span>}
    </label>
  );
}

function YesNo({ value, onChange, label }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void; label: string }) {
  return (
    <select
      aria-label={label}
      className={inputClass}
      value={value === undefined ? '' : value ? 'yes' : 'no'}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'yes')}
    >
      <option value="">Choose…</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}

function Amount({ value, onChange, label, integer, min, max }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string; integer?: boolean; min?: number; max?: number }) {
  return (
    <input
      aria-label={label}
      className={inputClass}
      type="number"
      inputMode="decimal"
      step={integer ? 1 : 0.01}
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

type Answer = Record<string, unknown>;

function ChoiceFields({ tool, missing, answer, set }: { tool: ChoiceTool; missing: string[]; answer: Answer; set: (field: string, value: unknown) => void }) {
  const b = (f: string) => answer[f] as boolean | undefined;
  const n = (f: string) => answer[f] as number | undefined;
  switch (tool) {
    case 'add_education_expense': {
      const aotc = answer.creditType === 'american_opportunity';
      return (
        <>
          <Field label="Education credit">
            <select aria-label="Education credit" className={inputClass} value={(answer.creditType as string) ?? ''} onChange={(e) => set('creditType', e.target.value || undefined)}>
              <option value="">Choose…</option>
              <option value="american_opportunity">American Opportunity credit</option>
              <option value="lifetime_learning">Lifetime Learning credit</option>
            </select>
          </Field>
          {aotc && (
            <>
              <Field label="AOTC claimed for this student for 4 earlier years? (Form 8863 line 23)"><YesNo label="Line 23" value={b('aotcClaimedPrior4Years')} onChange={(v) => set('aotcClaimedPrior4Years', v)} /></Field>
              <Field label="Completed the first 4 years of college before this year? (line 25)"><YesNo label="Line 25" value={b('completedFirst4Years')} onChange={(v) => set('completedFirst4Years', v)} /></Field>
              <Field label="Felony drug conviction? (line 26)"><YesNo label="Line 26" value={b('felonyDrugConviction')} onChange={(v) => set('felonyDrugConviction', v)} /></Field>
            </>
          )}
          {(aotc || missing.includes('enrolledHalfTime')) && (
            <Field label="Enrolled at least half-time? (line 24)" hint="Box 8 of the 1098-T, when it was read, answers this.">
              <YesNo label="Line 24" value={b('enrolledHalfTime')} onChange={(v) => set('enrolledHalfTime', v)} />
            </Field>
          )}
        </>
      );
    }
    case 'add_1099_q':
      return (
        <>
          <Field label="Qualified education expenses paid with this distribution"><Amount label="Qualified expenses" value={n('qualifiedExpenses')} min={0} onChange={(v) => set('qualifiedExpenses', v)} /></Field>
          <Field label="Tax-free educational assistance (scholarships, grants)" hint="Optional"><Amount label="Tax-free assistance" value={n('taxFreeAssistance')} min={0} onChange={(v) => set('taxFreeAssistance', v)} /></Field>
          <Field label="Expenses used for an education credit" hint="Optional — not counted twice"><Amount label="Expenses used for a credit" value={n('expensesClaimedForCredit')} min={0} onChange={(v) => set('expensesClaimedForCredit', v)} /></Field>
          {missing.includes('recipientNotDesignatedBeneficiary') && (
            <Field label="Paid to someone other than the student (box 6 checked)?"><YesNo label="Box 6" value={b('recipientNotDesignatedBeneficiary')} onChange={(v) => set('recipientNotDesignatedBeneficiary', v)} /></Field>
          )}
        </>
      );
    case 'add_1099_sa':
      return (
        <Field label="Did the whole distribution pay qualified medical expenses?" hint="If only part did, enter the distribution by hand on Form 8889.">
          <YesNo label="Qualified medical expenses" value={b('usedForQualifiedMedicalExpenses')} onChange={(v) => set('usedForQualifiedMedicalExpenses', v)} />
        </Field>
      );
    case 'add_1099_s':
      return (
        <>
          <Field label="Was this the taxpayer's main home?"><YesNo label="Main home" value={b('mainHome')} onChange={(v) => set('mainHome', v)} /></Field>
          {b('mainHome') && (
            <>
              <Field label="Cost basis (purchase price plus improvements)"><Amount label="Cost basis" value={n('costBasis')} min={0} onChange={(v) => set('costBasis', v)} /></Field>
              <Field label="Selling expenses" hint="Optional — commissions, transfer taxes"><Amount label="Selling expenses" value={n('sellingExpenses')} min={0} onChange={(v) => set('sellingExpenses', v)} /></Field>
              <Field label="Months owned in the 5 years before the sale"><Amount label="Months owned" integer min={0} max={60} value={n('ownedMonths')} onChange={(v) => set('ownedMonths', v)} /></Field>
              <Field label="Months used as the main home in those 5 years"><Amount label="Months used" integer min={0} max={60} value={n('usedAsResidenceMonths')} onChange={(v) => set('usedAsResidenceMonths', v)} /></Field>
              <Field label="Home-sale exclusion used in the 2 years before?"><YesNo label="Prior exclusion" value={b('priorExclusionUsedWithin2Years')} onChange={(v) => set('priorExclusionUsedWithin2Years', v)} /></Field>
              <Field label="Sold because of work, health or unforeseen circumstances?" hint="Optional — allows a reduced exclusion (§121(c))">
                <select aria-label="Reduced exclusion reason" className={inputClass} value={(answer.reducedMaximumReason as string) ?? ''} onChange={(e) => set('reducedMaximumReason', e.target.value || undefined)}>
                  <option value="">No</option>
                  <option value="change_of_employment">Change of employment</option>
                  <option value="health">Health</option>
                  <option value="unforeseen_circumstances">Unforeseen circumstances</option>
                </select>
              </Field>
            </>
          )}
        </>
      );
  }
}

const FIELD_LABELS: Record<string, string> = {
  qualifiedExpenses: 'Qualified expenses',
  recipientNotDesignatedBeneficiary: 'Paid to someone other than the student (box 6)',
  creditType: 'Education credit',
  usedForQualifiedMedicalExpenses: 'Qualified medical expenses',
  mainHome: 'Main home',
  monthsLivedWithYou: 'Months lived with the taxpayer',
  relationship: 'Relationship',
  enrolledHalfTime: 'Enrolled at least half-time',
  isLongTerm: 'Long-term — held more than one year (box 2)',
  costBasis: 'Cost or other basis (box 1e)',
  proceeds: 'Proceeds (box 1d)',
  wages: 'Wages (box 1)',
  federalTaxWithheld: 'Federal income tax withheld',
  distributionCode: 'Distribution code',
};

function label(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function FixFields({ action, answer, set }: { action: Extract<ReviewAction, { kind: 'fix' }>; answer: Answer; set: (field: string, value: unknown) => void }) {
  return (
    <>
      {action.fields.map((field) => {
        const input = fieldInput(action.tool, field);
        const value = answer[field];
        return (
          <Field key={field} label={label(field)}>
            {input?.kind === 'number' && <Amount label={label(field)} integer={input.integer} min={input.min} max={input.max} value={value as number | undefined} onChange={(v) => set(field, v)} />}
            {input?.kind === 'boolean' && <YesNo label={label(field)} value={value as boolean | undefined} onChange={(v) => set(field, v)} />}
            {input?.kind === 'enum' && (
              <select aria-label={label(field)} className={inputClass} value={(value as string) ?? ''} onChange={(e) => set(field, e.target.value || undefined)}>
                <option value="">Choose…</option>
                {input.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {(input?.kind === 'text' || !input) && <input aria-label={label(field)} className={inputClass} value={(value as string) ?? ''} onChange={(e) => set(field, e.target.value || undefined)} />}
          </Field>
        );
      })}
    </>
  );
}

function DependentFields({ action, answer, set }: { action: Extract<ReviewAction, { kind: 'dependent' }>; answer: Answer; set: (field: string, value: unknown) => void }) {
  return (
    <>
      {action.missing.includes('relationship') && (
        <Field label="Relationship to the taxpayer">
          <select aria-label="Relationship" className={inputClass} value={(answer.relationship as string) ?? ''} onChange={(e) => set('relationship', e.target.value || undefined)}>
            <option value="">Choose…</option>
            {DEPENDENT_RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
      )}
      {action.missing.includes('monthsLivedWithYou') && (
        <Field label="Months lived in the taxpayer's home this year">
          <Amount label="Months lived with the taxpayer" integer min={0} max={12} value={answer.monthsLivedWithYou as number | undefined} onChange={(v) => set('monthsLivedWithYou', v)} />
        </Field>
      )}
    </>
  );
}

const TITLE: Record<ReviewAction['kind'], string> = {
  choice: 'Record the decision',
  fix: 'Enter the value',
  dependent: 'Complete the dependent',
  filing_status: "Use the client's filing status",
  acquisition_date: 'Enter the date acquired',
};

export function actionLabel(action: ReviewAction): string {
  return action.kind === 'choice' ? 'Decide' : action.kind === 'fix' ? 'Enter the missing value' : action.kind === 'filing_status' ? 'Use it'
    : action.kind === 'acquisition_date' ? 'Enter the date acquired' : 'Complete';
}

export default function ReviewActionForm({ action, onDone }: { action: ReviewAction; onDone: () => void }) {
  const act = useCaseStore((s) => s.act);
  const [answer, setAnswer] = useState<Answer>({});
  const [error, setError] = useState<string | null>(null);
  const set = (field: string, value: unknown) => setAnswer((a) => ({ ...a, [field]: value }));

  const submit = () => {
    // Every question the form needs is answered before anything is recorded.
    const unanswered = action.kind === 'choice'
      ? action.missing.filter((f) => CHOICE_FIELDS[action.tool].includes(f) && answer[f] === undefined)
      : action.kind === 'dependent' ? action.missing.filter((f) => answer[f] === undefined) : [];
    if (unanswered.length > 0) {
      setError(`Answer every question (${unanswered.map(label).join(', ')}).`);
      return;
    }
    const result: DecisionResult = act((returnId) => {
      switch (action.kind) {
        case 'choice':
          return recordChoice(returnId, action.formKey, action.tool, answer);
        case 'fix': {
          for (const field of action.fields) {
            if (answer[field] === undefined) continue;
            const r = correctFormField(returnId, action.formKey, field, answer[field]);
            if (!r.ok) return r;
          }
          return action.fields.some((f) => answer[f] !== undefined) ? { ok: true, outcome: { kind: 'recorded' } } : { ok: false, error: 'Enter at least one value.' };
        }
        case 'dependent':
          return completeDependent(returnId, { firstName: action.firstName, lastName: action.lastName }, answer);
        case 'filing_status':
          return applyStatedFilingStatus(returnId, action.status, action.label);
        case 'acquisition_date':
          return typeof answer.acquisitionDate === 'string'
            ? recordAcquisition(returnId, action.assetId, {
              acquisitionDate: answer.acquisitionDate,
              longProductionPeriod: answer.longProductionPeriod === true,
              electOutOfBonus: answer.electOutOfBonus === true,
            })
            : { ok: false, error: 'Enter the date acquired.' };
      }
    });
    if (result.ok) onDone();
    else setError(result.error);
  };

  return (
    <form
      className="mt-2 flex flex-col gap-3 rounded-lg border border-slate-700 bg-surface-900 p-3"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <p className="text-xs font-semibold text-white">{TITLE[action.kind]}</p>
      {action.kind === 'choice' && <ChoiceFields tool={action.tool} missing={action.missing} answer={answer} set={set} />}
      {action.kind === 'fix' && <FixFields action={action} answer={answer} set={set} />}
      {action.kind === 'dependent' && <DependentFields action={action} answer={answer} set={set} />}
      {action.kind === 'acquisition_date' && (
        <div className="flex flex-col gap-2 text-sm text-slate-300">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Date acquired (for a written binding contract, the date of the contract)</span>
            <input type="date" aria-label="Date acquired" className={inputClass} value={(answer.acquisitionDate as string) ?? ''} onChange={(e) => set('acquisitionDate', e.target.value || undefined)} />
          </label>
          {action.assetId !== 'vehicle' && (
            <>
              <label className="flex items-center gap-2"><input type="checkbox" checked={answer.longProductionPeriod === true} onChange={(e) => set('longProductionPeriod', e.target.checked)} /> Long production period property or certain aircraft</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={answer.electOutOfBonus === true} onChange={(e) => set('electOutOfBonus', e.target.checked)} /> Elected out of special depreciation for this class of property</label>
            </>
          )}
        </div>
      )}
      {action.kind === 'filing_status' && <p className="text-sm text-slate-300">Set the return's filing status to {action.label}. The engine still checks that the client qualifies for it.</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <p className="text-xs text-slate-500">Recorded as a preparer entry and kept in the audit trail.</p>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onDone} className="text-sm text-slate-400 hover:text-white px-3 py-1.5">Cancel</button>
        <button type="submit" className="text-sm font-medium bg-HATaxService-orange-500 hover:bg-HATaxService-orange-600 text-white rounded px-3 py-1.5">Save</button>
      </div>
    </form>
  );
}
