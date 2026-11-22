import { describe, it, expect } from 'vitest';
import { transferExpenses, validateEntry, type KeeperEntry } from '../components/ha/keeper';
const entry: KeeperEntry = { id: 'one', date: '2025-04-01', description: 'Printer paper for client work', amount: 25.45, category: 'Supplies', businessId: 'business-1' };
describe('HAKeeper reviewed expense transfer', () => {
  it('preserves non-HAKeeper expenses and replaces managed entries without duplication', () => {
    const manual = { id: 'manual', scheduleCLine: 8, category: 'Advertising', amount: 80 };
    const once = transferExpenses([manual], [entry]);
    const twice = transferExpenses(once, [entry]);
    expect(twice).toEqual(once);
    expect(twice[1]).toMatchObject({ id: 'hakeeper:one', scheduleCLine: 22, amount: 25.45, businessId: 'business-1' });
    expect(transferExpenses(twice, [])).toEqual([manual]);
  });
  it('rejects the wrong year and impossible dates', () => {
    expect(validateEntry(entry, 2025)).toBeNull();
    expect(validateEntry(entry, 2026)).toContain('2026');
    expect(validateEntry({ ...entry, date: '2025-02-30' }, 2025)).not.toBeNull();
  });
  it('rejects negative, non-finite, sub-cent, personal, and unassigned expenses', () => {
    for (const amount of [-10, 0, NaN, Infinity, 25.455]) expect(validateEntry({ ...entry, amount }, 2025)).not.toBeNull();
    expect(validateEntry({ ...entry, category: 'Personal' }, 2025)).not.toBeNull();
    expect(validateEntry({ ...entry, businessId: '' }, 2025)).not.toBeNull();
    expect(validateEntry({ ...entry, description: ' ' }, 2025)).not.toBeNull();
  });
});
