import { useState, useMemo } from 'react';
import { useTaxReturnStore } from '../../store/taxReturnStore';
import { updateReturn } from '../../api/client';
import { deleteItemWithUndo } from '../../utils/deleteWithUndo';
import FormField from '../common/FormField';
import CurrencyInput from '../common/CurrencyInput';
import StepNavigation from '../layout/StepNavigation';
import SectionIntro from '../common/SectionIntro';
import StepWarningsBanner from '../common/StepWarningsBanner';
import AddButton from '../common/AddButton';
import CalloutCard from '../common/CalloutCard';
import { CalendarClock, Trash2, Pencil } from 'lucide-react';
import { calculateForm6252, type InstallmentSaleInfo, type InstallmentSaleResult } from '@hatax/engine';
import { validateAcquiredDate, validateTaxYearEventDate } from '../../utils/dateValidation';
import ItemWarningBadge from '../common/ItemWarningBadge';
import { useItemWarnings } from '../../hooks/useWarnings';

type PropertyKind = NonNullable<InstallmentSaleInfo['propertyKind']>;

const emptyForm = {
  description: '', dateAcquired: '', dateOfSale: '',
  propertyKind: undefined as PropertyKind | undefined,
  relatedParty: undefined as boolean | undefined,
  mainHome: false,
  sellingPrice: 0, mortgagesAssumedByBuyer: 0,
  costOrBasis: 0, depreciationAllowed: 0, sellingExpenses: 0,
  paymentsReceivedThisYear: 0,
  paymentsReceivedPriorYears: undefined as number | undefined,
};

const PROPERTY_KINDS: Array<{ value: PropertyKind; label: string }> = [
  { value: 'capital_asset', label: 'Capital asset (land or other investment property; not publicly traded stock)' },
  { value: 'business_personal', label: 'Business equipment or other depreciable personal property (section 1245)' },
  { value: 'business_real', label: 'Rental or business real estate you depreciated (section 1250)' },
];

const DISPOSITION_LABEL: Record<InstallmentSaleResult['disposition'], string> = {
  short_term_capital: 'Schedule D, short-term gain',
  long_term_capital: 'Schedule D, long-term gain',
  section1231: 'Form 4797, line 4 (section 1231 gain)',
  ordinary: 'Form 4797, line 10 (ordinary gain)',
  unknown: 'not settled yet',
};

export default function InstallmentSaleStep() {
  const { taxReturn, returnId, updateField } = useTaxReturnStore();
  if (!taxReturn || !returnId) return null;

  const items = taxReturn.installmentSales || [];
  const itemWarnings = useItemWarnings('installment_sale');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const startAdd = () => { setEditingId(null); setForm(emptyForm); setAdding(true); };
  const startEdit = (item: typeof items[0]) => {
    setAdding(false); setEditingId(item.id);
    setForm({
      description: item.description, dateAcquired: item.dateAcquired || '', dateOfSale: item.dateOfSale,
      propertyKind: item.propertyKind, relatedParty: item.relatedParty, mainHome: item.mainHome === true,
      sellingPrice: item.sellingPrice, mortgagesAssumedByBuyer: item.mortgagesAssumedByBuyer || 0,
      costOrBasis: item.costOrBasis,
      depreciationAllowed: item.depreciationAllowed || 0,
      sellingExpenses: item.sellingExpenses || 0,
      paymentsReceivedThisYear: item.paymentsReceivedThisYear,
      paymentsReceivedPriorYears: item.paymentsReceivedPriorYears,
    });
  };
  const cancelForm = () => { setAdding(false); setEditingId(null); setForm(emptyForm); };

  /** The form as a sale: blank dates stay absent; a main home is recorded only when it is one. */
  const toSale = (id: string): InstallmentSaleInfo => ({
    ...form,
    id,
    dateAcquired: form.dateAcquired || undefined,
    mainHome: form.mainHome || undefined,
  });

  const addItem = () => {
    updateField('installmentSales', [...items, toSale(crypto.randomUUID())]);
    cancelForm();
  };

  const saveEdit = () => {
    if (!editingId) return;
    updateField('installmentSales', items.map((i) => i.id === editingId ? toSale(i.id) : i));
    cancelForm();
  };

  const removeItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    deleteItemWithUndo({
      returnId,
      fieldName: 'installmentSales',
      item: item as any,
      label: `Installment sale${item.description ? `: ${item.description}` : ''}`,
      onCleanup: editingId === id ? cancelForm : undefined,
    });
  };

  const save = async () => {
    await updateReturn(returnId, { installmentSales: taxReturn.installmentSales });
  };

  const taxYear = taxReturn.taxYear || 2025;
  const saleYear = parseInt((form.dateOfSale || '').slice(0, 4), 10);
  const laterYear = Number.isFinite(saleYear) && saleYear < taxYear;

  // Preview computation for current form
  const preview = useMemo(() => {
    if (form.sellingPrice <= 0) return null;
    return calculateForm6252(toSale('preview'), taxYear);
  }, [form, taxYear]);

  const renderForm = (onSave: () => void, saveLabel: string) => (
    <div className="card mt-4">
      <FormField label="Property Description" irsRef="Form 6252, Line 1">
        <input className="input-field" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g., Vacant land on 123 Main St" />
      </FormField>
      <FormField label="What Was Sold" tooltip="Decides the recapture and where the gain goes. Stock or securities traded on an established market can't be reported on the installment method.">
        <select className="input-field" value={form.propertyKind ?? ''} onChange={(e) => setForm({ ...form, propertyKind: (e.target.value || undefined) as PropertyKind | undefined })}>
          <option value="">Select…</option>
          {PROPERTY_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </FormField>
      <FormField label="Date Acquired" irsRef="Form 6252, Line 2a" tooltip="Sets the holding period: more than 1 year is long-term." warning={validateAcquiredDate(form.dateAcquired, form.dateOfSale)}>
        <input type="date" className="input-field" value={form.dateAcquired} onChange={(e) => setForm({ ...form, dateAcquired: e.target.value })} />
      </FormField>
      <FormField label="Date Sold" irsRef="Form 6252, Line 2b" warning={laterYear ? undefined : validateTaxYearEventDate(form.dateOfSale)}>
        <input type="date" className="input-field" value={form.dateOfSale} onChange={(e) => setForm({ ...form, dateOfSale: e.target.value })} />
      </FormField>
      <FormField label="Sold to a Related Party?" irsRef="Form 6252, Line 3" tooltip="Your spouse, child, grandchild, parent or sibling, or a related corporation, partnership, estate or trust.">
        <select className="input-field" value={form.relatedParty === undefined ? '' : form.relatedParty ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, relatedParty: e.target.value === '' ? undefined : e.target.value === 'yes' })}>
          <option value="">Select…</option>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </FormField>
      <label className="flex items-center gap-2 text-sm text-slate-300 mt-1 mb-2">
        <input type="checkbox" checked={form.mainHome} onChange={(e) => setForm({ ...form, mainHome: e.target.checked })} />
        This was my main home
      </label>
      <FormField label="Selling Price" irsRef="Form 6252, Line 5" tooltip="Including mortgages and other debts. Don't include interest.">
        <CurrencyInput value={form.sellingPrice} onChange={(v) => setForm({ ...form, sellingPrice: v })} />
      </FormField>
      <FormField label="Debts the Buyer Assumed" optional irsRef="Form 6252, Line 6" tooltip="Mortgages, debts and other liabilities the buyer assumed or took the property subject to.">
        <CurrencyInput value={form.mortgagesAssumedByBuyer} onChange={(v) => setForm({ ...form, mortgagesAssumedByBuyer: v })} />
      </FormField>
      <FormField label="Cost or Other Basis" irsRef="Form 6252, Line 8">
        <CurrencyInput value={form.costOrBasis} onChange={(v) => setForm({ ...form, costOrBasis: v })} />
      </FormField>
      <FormField label="Depreciation Allowed or Allowable" optional irsRef="Form 6252, Line 9">
        <CurrencyInput value={form.depreciationAllowed} onChange={(v) => setForm({ ...form, depreciationAllowed: v })} />
      </FormField>
      <FormField label="Commissions and Other Expenses of Sale" optional irsRef="Form 6252, Line 11">
        <CurrencyInput value={form.sellingExpenses} onChange={(v) => setForm({ ...form, sellingExpenses: v })} />
      </FormField>
      <FormField label="Payments Received This Year" irsRef="Form 6252, Line 21" tooltip="Principal only. Interest you received is reported separately as interest income.">
        <CurrencyInput value={form.paymentsReceivedThisYear} onChange={(v) => setForm({ ...form, paymentsReceivedThisYear: v })} />
      </FormField>
      {laterYear && (
        <FormField label="Payments Received in Prior Years" irsRef="Form 6252, Line 23" tooltip="Principal received before this year, including any debt the buyer assumed over your basis in the year of sale. Don't include interest.">
          <CurrencyInput optional value={form.paymentsReceivedPriorYears} onChange={(v) => setForm({ ...form, paymentsReceivedPriorYears: v })} />
        </FormField>
      )}

      {preview && (
        <div className="mt-3 p-3 rounded-lg bg-HATaxService-blue-600/10 border border-HATaxService-blue-500/30 text-xs text-slate-300 space-y-1">
          <p>Gross profit percentage: {(preview.grossProfitRatio * 100).toFixed(2)}%</p>
          <p>Installment sale income this year: <span className="font-medium text-HATaxService-blue-300">${preview.installmentSaleIncome.toLocaleString()}</span> — {DISPOSITION_LABEL[preview.disposition]}</p>
          {preview.recaptureThisYear > 0 && <p>Depreciation recapture, ordinary income in the year of sale: ${preview.recaptureThisYear.toLocaleString()}</p>}
          {preview.unrecaptured1250ThisYear > 0 && <p>Of which unrecaptured section 1250 gain (taxed at up to 25%): ${preview.unrecaptured1250ThisYear.toLocaleString()}</p>}
          {preview.problems.map((p) => <p key={p} className="text-amber-300">{p}</p>)}
        </div>
      )}

      <div className="flex gap-3 mt-3">
        <button onClick={onSave} disabled={!form.description || !form.sellingPrice} className="btn-primary text-sm">{saveLabel}</button>
        <button onClick={cancelForm} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  );

  return (
    <div>
      <StepWarningsBanner stepId="installment_sale" />
      <SectionIntro icon={<CalendarClock className="w-8 h-8" />} title="Installment Sales (Form 6252)" description="Report income from property sales where you receive payments over multiple years." />

      <CalloutCard variant="info" title="How installment sales work" irsUrl="https://www.irs.gov/forms-pubs/about-form-6252">
        When you sell property at a gain and receive payments over time, you report the gain as you receive the payments: each year's gain is the principal received times the gross profit percentage. Depreciation recapture is taxed in full in the year of sale. The gain goes on Schedule D for a capital asset, or Form 4797 for business property.
      </CalloutCard>

      {items.length > 0 && (
        <div className="space-y-3 mt-6">
          {items.map((item, idx) => {
            const result = calculateForm6252(item, taxYear);
            return editingId === item.id ? (
              <div key={item.id}>{renderForm(saveEdit, 'Save Changes')}</div>
            ) : (
              <div key={item.id} className={`card mt-4 flex items-center justify-between gap-3 cursor-pointer hover:border-slate-500 transition-colors${itemWarnings.has(idx) ? " border-amber-500/40" : ""}`} onClick={() => startEdit(item)}>
                <div>
                  <div className="font-medium">{item.description}</div>
                  <div className="text-sm text-slate-400">${(result.installmentSaleIncome ?? 0).toLocaleString()} income ({((result.grossProfitRatio ?? 0) * 100).toFixed(2)}% gross profit) — {DISPOSITION_LABEL[result.disposition]}</div>
                  {result.problems.length > 0 && <div className="text-xs text-amber-300">{result.problems[0]}</div>}
                </div>
                <div className="flex items-center gap-1">
                  <ItemWarningBadge warnings={itemWarnings.get(idx)} />
                  <button onClick={(e) => { e.stopPropagation(); startEdit(item); }} className="p-2 text-slate-400 hover:text-HATaxService-blue-400" title="Edit"><Pencil className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); removeItem(item.id); }} className="p-2 text-slate-400 hover:text-red-400" title="Remove"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding ? renderForm(addItem, 'Add Installment Sale') : !editingId && <AddButton onClick={startAdd}>Add Installment Sale</AddButton>}

      <StepNavigation onContinue={save} />
    </div>
  );
}
