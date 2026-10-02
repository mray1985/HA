import { describe, expect, it } from 'vitest';
import { SUPPORTED_TAX_YEARS } from '@hatax/engine';
import { filingYear } from '../store/batchStore';

describe('filingYear', () => {
  it('is last calendar year: the returns being filed, extensions included', () => {
    expect(filingYear(new Date(2026, 9, 2))).toBe(2025);
    expect(filingYear(new Date(2026, 0, 15))).toBe(2025);
    expect(filingYear(new Date(2027, 0, 2))).toBe(2026);
  });

  it('stays within the years the engine supports', () => {
    const first = SUPPORTED_TAX_YEARS[0];
    const last = SUPPORTED_TAX_YEARS[SUPPORTED_TAX_YEARS.length - 1]!;
    expect(filingYear(new Date(last + 5, 3, 1))).toBe(last);
    expect(filingYear(new Date(first - 3, 3, 1))).toBe(first);
  });
});
