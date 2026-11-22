import { useState } from 'react';
import Papa from 'papaparse';
import { useTaxReturnStore } from '../../store/taxReturnStore';
import { CATEGORIES, validateEntry, transferExpenses, type KeeperEntry } from './keeper';

// Entries live inside the existing encrypted return, not a second plaintext store.
type KeeperReturn = { haKeeperEntries?: KeeperEntry[] };
export default function HAKeeper({ onListen }: { onListen: () => void }) {
  const tr = useTaxReturnStore(s => s.taxReturn);
  const updateField = useTaxReturnStore(s => s.updateField);
  const entries = (tr as KeeperReturn | null)?.haKeeperEntries ?? [];
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0].name);
  const [businessId, setBusinessId] = useState('');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState(false);
  if (!tr) return <section className="ha-learning"><h2>HAKeeper</h2><p>Open an unlocked return to keep expenses with that return.</p></section>;
  const businesses = tr.businesses;
  const chosenBusiness = businessId || businesses[0]?.id || '';
  function save(next: KeeperEntry[]) { updateField('haKeeperEntries', next); setReview(false); }
  function add(e: React.FormEvent) {
    e.preventDefault();
    const entry = { id: crypto.randomUUID(), date, description: description.trim(), amount: Number(amount), category, businessId: chosenBusiness };
    const error = validateEntry(entry, tr!.taxYear);
    if (error) { setMessage(error); return; }
    save([...entries, entry]); setDescription(''); setAmount(''); setMessage('Expense saved with this encrypted return.');
  }
  async function importCSV(file?: File) {
    if (!file) return;
    if (file.size > 2_000_000) { setMessage('Choose a CSV smaller than 2 MB.'); return; }
    const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: 'greedy' });
    if (parsed.errors.length) { setMessage('CSV could not be read. Check its headers and quotation marks.'); return; }
    if (!['date', 'description', 'amount', 'category'].every(h => parsed.meta.fields?.includes(h))) { setMessage('CSV headers must be date,description,amount,category.'); return; }
    const batch = parsed.data.map(row => ({ id: crypto.randomUUID(), date: row.date, description: row.description, amount: Number(row.amount), category: row.category, businessId: chosenBusiness }));
    const bad = batch.findIndex(entry => validateEntry(entry, tr!.taxYear));
    if (bad >= 0) { setMessage(`Row ${bad + 2}: ${validateEntry(batch[bad], tr!.taxYear)} Nothing imported.`); return; }
    const seen = new Set<string>();
    for (const entry of batch) { const key = JSON.stringify([entry.date, entry.description, entry.amount, entry.businessId]); if (seen.has(key)) { setMessage('The CSV contains duplicate expenses. Review the duplicate rows before importing. Nothing imported.'); return; } seen.add(key); }
    if (batch.some(b => entries.some(e => e.date === b.date && e.description === b.description && e.amount === b.amount && e.businessId === b.businessId))) { setMessage('Import contains an entry already in HAKeeper. Review the CSV to avoid duplicates.'); return; }
    save([...entries, ...batch]); setMessage(`${batch.length} expenses imported for review.`);
  }
  return <section className="ha-learning"><div className="ha-section-heading"><div><h2>HAKeeper</h2><p>Keep records. Review expenses. Carry them into Schedule C.</p></div><button onClick={onListen}>Listen to the bookkeeping lesson</button></div>
    {!businesses.length && <p role="status">Add a business in the interview before recording expenses.</p>}
    <form onSubmit={add} className="ha-keeper-form"><label>Business<select value={chosenBusiness} onChange={e => { setBusinessId(e.target.value); setReview(false); }}><option value="">Choose a business</option>{businesses.map(b => <option key={b.id} value={b.id}>{b.businessName || b.businessDescription || 'Unnamed business'}</option>)}</select></label><label>Date<input type="text" inputMode="numeric" placeholder="YYYY-MM-DD" value={date} onChange={e => setDate(e.target.value)} required /></label><label>Business purpose<input value={description} onChange={e => setDescription(e.target.value)} maxLength={250} required /></label><label>Business portion ($)<input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required /></label><label>Category<select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c.name}>{c.name}</option>)}</select></label><button type="submit" disabled={!businesses.length}>Add expense</button></form>
    <label className="ha-import">Import expense CSV (date,description,amount,category)<input type="file" accept=".csv,text/csv" disabled={!businesses.length} onChange={e => { void importCSV(e.target.files?.[0]).catch(() => setMessage('Unable to import this file.')); e.target.value = ''; }} /></label>
    <p role="status">{message}</p><div className="ha-table-scroll"><table><caption>{tr.taxYear} expense records · ${entries.reduce((n, e) => n + e.amount, 0).toFixed(2)}</caption><thead><tr><th>Date</th><th>Business purpose</th><th>Category</th><th>Amount</th><th>Action</th></tr></thead><tbody>{entries.map(e => <tr key={e.id}><td>{e.date}</td><td>{e.description}</td><td>{e.category}</td><td>${e.amount.toFixed(2)}</td><td><button onClick={() => save(entries.filter(x => x.id !== e.id))} aria-label={`Remove ${e.description}`}>Remove</button></td></tr>)}</tbody></table></div>
    <button onClick={() => setReview(true)}>Review Schedule C transfer</button>{review && <div className="ha-transfer"><h3>Review before applying</h3><p>This replaces prior HAKeeper expense entries with the current ledger, including removals. Other return expenses remain. Check for expenses already entered elsewhere, business-use amounts, and proper categories. Income, assets, meals, and mileage need their own interview treatment.</p><ul>{CATEGORIES.map(c => <li key={c.name}>Schedule C line {c.line} · {c.name}: ${entries.filter(e => e.category === c.name).reduce((n, e) => n + e.amount, 0).toFixed(2)}</li>)}</ul><button onClick={() => { const error = entries.map(e => validateEntry(e, tr.taxYear) || (!businesses.some(b => b.id === e.businessId) ? 'An entry refers to a missing business.' : null)).find(Boolean); if (error) { setMessage(error); return; } updateField('expenses', transferExpenses(tr.expenses, entries)); setReview(false); setMessage('Applied to Schedule C. Review the recalculated return in Three screens.'); }}>Apply reviewed expenses</button><button onClick={() => setReview(false)}>Cancel</button></div>}
  </section>;
}
