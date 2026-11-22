import type { ExpenseEntry } from '@hatax/engine';
export const CATEGORIES = [{ name: 'Supplies', line: 22 }, { name: 'Advertising', line: 8 }, { name: 'Office expense', line: 18 }, { name: 'Repairs and maintenance', line: 21 }, { name: 'Utilities', line: 25 }];
export interface KeeperEntry { id: string; date: string; description: string; amount: number; category: string; businessId: string; }
export function validateEntry(e: KeeperEntry, year: number): string | null {
  const date = new Date(`${e.date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== e.date || date.getUTCFullYear() !== year) return `Enter a valid date in tax year ${year}.`;
  if (!e.description.trim()) return 'Enter the business purpose.';
  if (!Number.isFinite(e.amount) || e.amount <= 0 || Math.round(e.amount * 100) !== e.amount * 100 && Math.abs(Math.round(e.amount * 100) - e.amount * 100) > 0.000001) return 'Enter a positive amount with at most two decimal places.';
  if (!CATEGORIES.some(c => c.name === e.category)) return 'Choose a supported expense category.';
  if (!e.businessId) return 'Choose the business this expense belongs to.';
  return null;
}
export function transferExpenses(existing: ExpenseEntry[], entries: KeeperEntry[]): ExpenseEntry[] {
  return [...existing.filter(e => !e.id.startsWith('hakeeper:')), ...entries.map(e => ({ id: `hakeeper:${e.id}`, scheduleCLine: CATEGORIES.find(c => c.name === e.category)!.line, category: e.category, description: e.description, amount: e.amount, businessId: e.businessId }))];
}
