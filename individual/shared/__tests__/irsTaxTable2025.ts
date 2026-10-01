/**
 * The IRS's own 2025 Tax Table (fixtures/irs-tax-table-2025.json, from
 * Publication 1040 (2025)), for tests: the tax on a taxable income below
 * $100,000 as the IRS prints it. Not imported from the engine.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TableStatus = 'Single' | 'MFJ' | 'MFS' | 'HOH' | 'QSS';

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'irs-tax-table-2025.json'), 'utf8')) as {
  rows: Array<[number, number, number, number, number, number]>;
};

export const TAX_TABLE_2025_ROWS = table.rows;

const COLUMN: Record<TableStatus, number> = { Single: 2, MFJ: 3, MFS: 4, HOH: 5, QSS: 3 };

/** The 2025 Tax Table's tax for a taxable income below $100,000. */
export function taxTable2025(taxableIncome: number, status: TableStatus): number {
  if (taxableIncome >= 100_000) throw new Error('The Tax Table stops at $100,000');
  const row = table.rows.find(([atLeast, lessThan]) => taxableIncome >= atLeast && taxableIncome < lessThan);
  if (!row) throw new Error(`No Tax Table row for ${taxableIncome}`);
  return row[COLUMN[status]]!;
}
