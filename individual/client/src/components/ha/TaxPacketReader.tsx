import { useEffect, useRef, useState } from 'react';
import type { IncomeK1 } from '@hatax/engine';
import { useTaxReturnStore } from '../../store/taxReturnStore';
import { applyReviewedPacket, type TaxPacketReport, type PacketSource } from '../../services/taxPacketCorrelation';
import { readTaxPacket, type PacketDocument } from '../../services/taxPacketReader';
import PacketSourceViewer from './PacketSourceViewer';

type SavedReview = { report: TaxPacketReport; savedAt: string; targetId?: string; appliedIds: string[]; applications?: { targetId: string; appliedIds: string[]; appliedAt: string }[] };
export default function TaxPacketReader() {
  const tr = useTaxReturnStore(s => s.taxReturn);
  const updateField = useTaxReturnStore(s => s.updateField);
  const [report, setReport] = useState<TaxPacketReport | null>(null);
  const [documents, setDocuments] = useState<PacketDocument[]>([]);
  const [source, setSource] = useState<PacketSource>();
  const [selected, setSelected] = useState<string[]>([]);
  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState('');
  const [ein, setEin] = useState('');
  const [entityType, setEntityType] = useState<IncomeK1['entityType']>('partnership');
  const [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState('');
  const [ocr, setOCR] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (!tr) return <section className="ha-learning"><h2>K-1 / K-3 statements</h2><p>Open an unlocked return to read its supporting statements.</p></section>;
  const saved = (tr as typeof tr & { haStatementReviews?: SavedReview[] }).haStatementReviews ?? [];
  async function read(files: File[]) {
    abort.current?.abort(); const control = new AbortController(); abort.current = control;
    const returnId = tr!.id;
    setBusy(true); setMessage('Reading the uploaded text…'); setReport(null); setSelected([]); setConfirmed(false); setSource(undefined); setDocuments([]);
    try {
      const result = await readTaxPacket(files, progress => { if (!control.signal.aborted && abort.current === control && useTaxReturnStore.getState().taxReturn?.id === returnId) setMessage(progress); }, ocr, control.signal);
      if (control.signal.aborted || useTaxReturnStore.getState().taxReturn?.id !== returnId) return;
      setReport(result.report); setDocuments(result.documents); setSource(result.report.pages[0]?.lines[0]);
      const eins = [...new Set(result.report.pages.map(p => p.entityEin).filter(Boolean))];
      const matched = eins.length === 1 ? tr!.incomeK1.find(k => k.entityEin?.replace(/\D/g, '') === eins[0]!.replace(/\D/g, '')) : undefined;
      setTargetId(matched?.id ?? 'new'); setEin(eins.length === 1 ? eins[0]! : '');
      setMessage(`Read ${result.report.pages.length} pages across ${result.documents.length} files. Found ${result.report.candidates.length} labelled items. Review the source before applying.`);
    } catch (error) { if (!control.signal.aborted) setMessage(error instanceof Error ? error.message : 'Unable to read this packet.'); }
    finally { if (abort.current === control) setBusy(false); }
  }
  function saveReview(target?: string, appliedIds: string[] = []) {
    if (!report) return;
    const current = useTaxReturnStore.getState().taxReturn as typeof tr & { haStatementReviews?: SavedReview[] };
    if (!current || current.id !== tr!.id) throw new Error('Return changed. Reopen the packet for this return.');
    const previous = current.haStatementReviews ?? [];
    const prior = previous.find(r => r.report.id === report.id);
    const savedAt = new Date().toISOString();
    const applications = [...(prior?.applications ?? []), ...(target && appliedIds.length ? [{ targetId: target, appliedIds, appliedAt: savedAt }] : [])];
    updateField('haStatementReviews', [...previous.filter(r => r.report.id !== report.id), { report, savedAt, targetId: target ?? prior?.targetId, appliedIds: [...new Set([...(prior?.appliedIds ?? []), ...appliedIds])], applications }]);
  }
  function apply() {
    if (!report || !tr) return;
    try {
      const current = useTaxReturnStore.getState().taxReturn;
      if (!current || current.id !== tr.id) throw new Error('The return changed; reopen this packet.');
      const target = targetId === 'new' ? { id: crypto.randomUUID(), entityName: name.trim(), entityEin: ein.trim(), entityType } : current.incomeK1.find(k => k.id === targetId);
      if (!target || !target.entityName) throw new Error('Choose a K-1 entity, or enter the new entity name.');
      if (!target.entityEin || !/^\d{2}-?\d{7}$/.test(target.entityEin)) throw new Error('Enter the entity EIN in the interview or new-entity field before applying.');
      const next = applyReviewedPacket(current, target, report, selected, confirmed);
      updateField('incomeK1', [...current.incomeK1.filter(k => k.id !== target.id), next]);
      saveReview(target.id, selected); setTargetId(target.id); setSelected([]); setConfirmed(false);
      setMessage('Reviewed fields applied to the K-1 and saved with source references. Existing values were replaced, not added a second time. Foreign-tax and other review-only items were not applied.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not apply this packet.'); }
  }
  const lines = report?.pages.flatMap(p => p.lines).filter(l => !query.trim() || l.text.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <section className="ha-packet-reader"><h1>K-1 / K-3 statement reader</h1><p>Read the packet, correlate the areas, and follow each amount back to its page.</p>
    <label>Upload the K-1, K-3, and supporting statement PDFs together<input type="file" multiple accept="application/pdf,.pdf" disabled={busy} onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void read(files); }} /></label>
    <label className="ha-check"><input type="checkbox" checked={ocr} disabled={busy} onChange={e => setOCR(e.target.checked)} />Read scanned pages with local OCR when a text layer is missing</label>
    {busy && <button onClick={() => { abort.current?.abort(); setBusy(false); setMessage('Reading cancelled.'); }}>Cancel reading</button>}<p role="status">{message}</p>
    {saved.length > 0 && <p className="ha-small">{saved.length} saved packet review(s) in this encrypted return. {saved.map((s, i) => <button key={s.report.id} onClick={() => { setReport(s.report); setDocuments([]); setSource(s.report.pages[0]?.lines[0]); setSelected([]); setConfirmed(false); setTargetId(s.targetId ?? ''); setMessage('Saved correlation opened. Upload the original packet again to view its PDF pages.'); }}>Open review {i + 1}</button>)}</p>}
    {report && <>{report.warnings.map(w => <p className="ha-packet-warning" key={w}>{w}</p>)}<div className="ha-packet-grid"><section className="ha-packet-region"><h2>Source text and page</h2><label>Find a box, code, word, or amount<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Try code Z, foreign taxes, or an amount" /></label><label>Source page<select aria-label="Source page" value={source ? `${source.documentId}:${source.page}` : ''} onChange={e => { const page = report.pages.find(p => `${p.documentId}:${p.page}` === e.target.value); setSource(page?.lines[0]); }}>{report.pages.map(p => <option key={`${p.documentId}:${p.page}`} value={`${p.documentId}:${p.page}`}>{p.fileName} · page {p.page} · {p.kind}</option>)}</select></label><PacketSourceViewer document={documents.find(d => d.id === source?.documentId)} source={source} />
      <div className="ha-packet-text" aria-label="Extracted packet text">{lines.map((l, i) => <button key={`${l.documentId}:${l.page}:${i}`} onClick={() => setSource(l)}><small>{l.fileName} · p. {l.page}{l.ocr ? ' · OCR' : ''}</small>{l.text}</button>)}{!lines.length && <p>No matching text. A page with no readable text needs review.</p>}</div></section>
      <section className="ha-packet-region"><h2>Correlated areas</h2><p className="ha-small">K-1 destinations below use meaning and labels. K-3 amounts retain their source rows for foreign-tax review; complete K-3 calculation routing is not implemented.</p>
        <label>K-1 entity<select value={targetId} onChange={e => { setTargetId(e.target.value); setSelected([]); setConfirmed(false); }}><option value="">Choose an entity</option>{tr.incomeK1.map(k => <option key={k.id} value={k.id}>{k.entityName} · {k.entityEin || 'EIN needed'}</option>)}<option value="new">Add a new K-1 entity</option></select></label>
        {targetId === 'new' && <div className="ha-packet-new"><label>Entity name<input value={name} onChange={e => setName(e.target.value)} /></label><label>Entity EIN<input value={ein} onChange={e => setEin(e.target.value)} placeholder="12-3456789" /></label><label>Entity type<select value={entityType} onChange={e => setEntityType(e.target.value as IncomeK1['entityType'])}><option value="partnership">Partnership (1065)</option><option value="s_corp">S corporation (1120-S)</option><option value="estate">Estate (1041)</option><option value="trust">Trust (1041)</option></select></label></div>}
        <div className="ha-packet-candidates">{report.candidates.map(c => <article key={c.id}><label className="ha-check"><input type="checkbox" disabled={!c.supported || c.value === null || c.issues.some(i => i.startsWith('Conflicting'))} checked={selected.includes(c.id)} onChange={e => { setSelected(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id)); setConfirmed(false); }} />{c.label}</label><strong>{c.value === null ? 'Amount needs review' : c.value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong><p className="ha-small">{c.form} · {c.code || 'Code not established'} · {c.section || 'Section not established'}{c.activity ? ` · Activity: ${c.activity}` : ''} · {c.taxYear ?? 'Year unconfirmed'} · {c.entityEin || 'Entity unconfirmed'}</p><p className="ha-small">{c.supported ? `Destination: selected K-1 — ${c.label}. Replaces the existing value after review.` : 'Destination: statement / foreign-tax review. No automatic tax calculation applied.'}</p>{c.issues.map(issue => <p className="ha-packet-warning" key={issue}>{issue}</p>)}{c.sources.map((s, i) => <button key={i} onClick={() => setSource(s)}>Show {s.fileName} · page {s.page}</button>)}</article>)}</div>
        <label className="ha-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I verified the entity, recipient, tax year, activity, and selected values against the original. Repeated subtotals are not extra income.</label><button className="ha-primary" disabled={!selected.length || !confirmed} onClick={apply}>Apply selected reviewed K-1 fields</button><button onClick={() => { try { saveReview(); setMessage('Correlation notes saved with this encrypted return. Original PDFs remain in this tab; re-upload them to view pages after reopening.'); } catch (error) { setMessage(String(error)); } }}>Save correlation notes</button>
      </section></div></>}
  </section>;
}
