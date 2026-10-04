/**
 * Money figures inside one text run, and where each sits across it.
 *
 * OCR of a photographed form returns whole strips of the page, so one run can
 * carry several boxes' amounts on one line — a measured W-2 photo yields
 * "94-3216540 68,250.00 7,120.00" in a single block, one figure for box 1 and
 * one for box 2. Separating them, and placing them, is the groundwork for
 * telling those boxes apart.
 */
import { describe, it, expect } from 'vitest';
import { moneyItemsIn } from '../src/pageEvidence';

/** A run 200px wide starting at x=100. */
const RUN: readonly [number, number, number, number] = [100, 0, 200, 12];

describe('money figures in one text run', () => {
  it('separates every figure in a strip and places them left to right', () => {
    // The W-2 strip as measured: an EIN, then box 1 wages, then box 2 withholding.
    const items = moneyItemsIn('94-3216540 68,250.00 7,120.00', RUN);
    expect(items.map((i) => i.value)).toEqual([68250, 7120]);
    expect(items[0]!.cx).toBeLessThan(items[1]!.cx);
  });

  it('does not report a figure twice where two patterns both cover it', () => {
    const items = moneyItemsIn('1,200.00', RUN);
    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe(1200);
  });

  it('leaves the non-money numbers in the run out', () => {
    // A ZIP and a year sit inside real strips and are not amounts.
    expect(moneyItemsIn('78704', RUN).map((i) => i.value)).toEqual([]);
    expect(moneyItemsIn('2020', RUN).map((i) => i.value)).toEqual([]);
    expect(moneyItemsIn('OMB No. 1545-0129', RUN).map((i) => i.value)).toEqual([]);
    expect(moneyItemsIn('Unemployment compensation', RUN)).toEqual([]);
  });

  it('keeps an accounting negative negative', () => {
    expect(moneyItemsIn('(1,250.00)', RUN)[0]!.value).toBe(-1250);
  });

  it('places figures in proportion to where they are printed', () => {
    const left = moneyItemsIn('11,111.00', RUN)[0]!;
    const right = moneyItemsIn('                    22,222.00', RUN)[0]!;
    expect(right.cx).toBeGreaterThan(left.cx);
  });

  it('reports position 0 without a box, so callers cannot mistake it for x=0', () => {
    expect(moneyItemsIn('5,000.00')[0]!.cx).toBe(0);
  });
});