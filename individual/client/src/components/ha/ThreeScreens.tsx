import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FORM_1040_TEMPLATE } from '@hatax/engine';
import { useTaxReturnStore } from '../../store/taxReturnStore';
import { ALL_TEMPLATES } from '../../services/irsFormFiller';
import DocumentInventoryPanel from '../common/DocumentInventoryPanel';
import IRSWorkspaceViewer from './IRSWorkspaceViewer';
import { formatCurrency } from '../../utils/format';

export default function ThreeScreens() {
  const tr = useTaxReturnStore(s => s.taxReturn);
  const calc = useTaxReturnStore(s => s.calculation);
  const navigate = useNavigate();
  const [selected, setSelected] = useState('totalWages');
  const [form, setForm] = useState('f1040');
  const [instance, setInstance] = useState(0);
  const [visual, setVisual] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const f = calc?.form1040;
  const templates = useMemo(() => tr && calc ? ALL_TEMPLATES.filter(t => t.condition(tr, calc)) : [FORM_1040_TEMPLATE], [tr, calc]);
  const template = templates.find(t => t.formId === form) || FORM_1040_TEMPLATE;
  const instanceCount = tr && calc ? (template.instanceCount?.(tr, calc) ?? 1) : 1;
  const effectiveTemplate = useMemo(() => tr && calc && template.fieldsForInstance ? { ...template, fields: template.fieldsForInstance(Math.min(instance, instanceCount - 1), tr, calc) } : template, [template, instance, instanceCount, tr, calc]);
  const rows = [
    { key: 'totalWages', label: 'W-2 wages', line: '1a', value: f?.totalWages ?? 0, text: 'Your W-2 box 1 wages flow into Form 1040 line 1a. Other income is reported on its own lines.' },
    { key: 'agi', label: 'Adjusted gross income', line: '11a', value: f?.agi ?? 0, text: 'Your income after allowed adjustments. This number is used in many eligibility calculations.' },
    { key: 'deductionAmount', label: 'Deduction', line: '12e', value: f?.deductionAmount ?? 0, text: `The ${f?.deductionUsed || 'selected'} deduction reduces income subject to income tax. It does not eliminate self-employment tax.` },
    { key: 'taxableIncome', label: 'Taxable income', line: '15', value: f?.taxableIncome ?? 0, text: 'Income remaining after applicable deductions. Different kinds of income can have different tax treatment.' },
    { key: 'totalTax', label: 'Total tax', line: '24', value: f?.totalTax ?? 0, text: 'Total tax after the applicable credits and additional taxes, including self-employment tax when it applies.' },
    { key: 'totalPayments', label: 'Payments', line: '33', value: f?.totalPayments ?? 0, text: 'Withholding, estimated payments, and applicable refundable credits are reconciled against tax.' },
  ];
  const current = rows.find(r => r.key === selected)!;
  function select(key: string) { setSelected(key); setForm('f1040'); }
  if (!tr) return <section className="ha-learning"><h2>Your three-screen workspace</h2><p>Open a return from the dashboard to see your source information, populated IRS forms, and explanations together.</p><button onClick={() => navigate('/')}>Open a return</button></section>;
  return <><div className="ha-title"><h1>See the whole picture.</h1><p>Source → Form → Explanation · Tax year {tr.taxYear}</p></div>
    <div className="ha-three"><section className="ha-panel"><h2>Your information</h2><div className="ha-panel-body"><h3>Return information</h3><p>Hover, focus, or select a number to follow it across the three screens.</p>
      {tr.w2Income.map(w => <div className={`ha-source ${selected === 'totalWages' ? 'ha-highlight' : ''}`} key={w.id} onMouseEnter={() => select('totalWages')}><h3>W-2 · {w.employerName || 'Employer'}</h3><p>Box 1 wages: {formatCurrency(w.wages)}</p><p>Box 2 federal withholding: {formatCurrency(w.federalTaxWithheld)}</p></div>)}
      {!tr.w2Income.length && <p>No W-2 entered yet. Use the interview to enter or import your documents.</p>}
      <div className="ha-source-links">{rows.map(r => <button key={r.key} className={selected === r.key ? 'selected' : ''} onMouseEnter={() => select(r.key)} onFocus={() => select(r.key)} onClick={() => select(r.key)}>{r.label}<strong>{calc ? formatCurrency(r.value) : "Pending"}</strong></button>)}</div>
      <button className="ha-primary" onClick={() => navigate(`/return/${tr.id}`)}>Continue interview / upload documents</button>
      <button aria-expanded={showInventory} onClick={() => setShowInventory(v => !v)}>Document inventory</button>{showInventory && <DocumentInventoryPanel />}
    </div></section>
    <section className="ha-panel"><h2>IRS forms</h2><div className="ha-panel-body ha-form-body"><label className="ha-form-select">Choose a form<select value={template.formId} onChange={e => { setForm(e.target.value); setInstance(0); }}>{templates.map(t => <option key={t.formId} value={t.formId}>{t.displayName}</option>)}</select></label><p className="ha-linked-line">{template.formId === 'f1040' ? `Form 1040 · line ${current.line} · ${current.label}` : template.displayName}</p><>{instanceCount > 1 && <label>Form instance<select aria-label="Form instance" value={instance} onChange={e => setInstance(Number(e.target.value))}>{Array.from({ length: instanceCount }, (_, i) => <option key={i} value={i}>Instance {i + 1}</option>)}</select></label>}</><IRSWorkspaceViewer template={effectiveTemplate} sourcePath={`form1040.${selected}`} /></div></section>
    <section className="ha-panel"><div className="ha-panel-heading"><h2>Plain language</h2><div className="ha-toggle"><button aria-pressed={!visual} onClick={() => setVisual(false)}>Written</button><button aria-pressed={visual} onClick={() => setVisual(true)}>Visual</button></div></div><div className="ha-panel-body"><div className="ha-explanation-rows">{rows.map(r => <button key={r.key} className={selected === r.key ? 'selected' : ''} onMouseEnter={() => select(r.key)} onFocus={() => select(r.key)} onClick={() => select(r.key)}><span>{r.label}</span><strong>{calc ? formatCurrency(r.value) : "Pending"}</strong></button>)}</div>
      <h3>Here’s what it means.</h3>{!calc ? <p>Enter income in the interview to calculate this return. Missing information is not treated as confirmed zero.</p> : visual ? <div className="ha-bars">{rows.map(r => <div key={r.key}><span>{r.label}: {calc ? formatCurrency(r.value) : "Pending"}</span><meter min={0} max={Math.max(1, ...rows.map(x => Math.abs(x.value)))} value={Math.abs(r.value)} /></div>)}</div> : <p className="ha-narrative">{current.text}</p>}
      {calc && <p className="ha-result">{f!.amountOwed > 0 ? 'Estimated balance due' : 'Estimated refund'} <strong>{formatCurrency(f!.amountOwed > 0 ? f!.amountOwed : f!.refundAmount)}</strong></p>}
      <p className="ha-small">Calculation and form review. Filing availability and form coverage require verification before production use.</p>
    </div></section></div></>;
}
