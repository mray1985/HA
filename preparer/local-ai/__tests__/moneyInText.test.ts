/**
 * The money printed inside a text run.
 *
 * The text layer merges a value with whatever sits beside it, so a whole-token
 * test rejects real figures. This also has to keep rejecting the numbers that
 * are printed all over a form and are not money — a ZIP, a year, an OMB number,
 * a box number — because a money reader that accepts those invents amounts on
 * blank forms.
 */
import { describe, it, expect } from 'vitest';
import { moneyIn } from '../src/pageEvidence';

describe('money printed inside a text run', () => {
  it('reads a figure merged with the word beside it', () => {
    // Measured: a real 1099-G prints "3,600.00 Form" in the text layer, and a
    // 1099-MISC prints "1,200.00 $". Both are the box's own amount.
    expect(moneyIn('3,600.00 Form')).toEqual({ value: 3600, raw: '3,600.00' });
    expect(moneyIn('1,200.00 $')).toEqual({ value: 1200, raw: '1,200.00' });
  });

  it('reads a bare figure with cents or comma grouping', () => {
    expect(moneyIn('4,200.00')).toEqual({ value: 4200, raw: '4,200.00' });
    expect(moneyIn('$9,412.37')).toEqual({ value: 9412.37, raw: '$9,412.37' });
    expect(moneyIn('11240.66')).toEqual({ value: 11240.66, raw: '11240.66' });
    expect(moneyIn('289,400')).toEqual({ value: 289400, raw: '289,400' });
  });

  it('does not read the numbers a form prints that are not money', () => {
    // Each of these sits on a real form inside a money box's row.
    expect(moneyIn('78704')).toBeUndefined();          // ZIP code
    expect(moneyIn('2020')).toBeUndefined();           // tax year
    expect(moneyIn('1545-0120')).toBeUndefined();      // OMB number
    expect(moneyIn('OMB No. 1545-0120')).toBeUndefined();
    expect(moneyIn('12')).toBeUndefined();             // box number
    expect(moneyIn('13a')).toBeUndefined();
    expect(moneyIn('$')).toBeUndefined();              // a sign with no figure
    expect(moneyIn('Unemployment compensation')).toBeUndefined();
    expect(moneyIn('')).toBeUndefined();
  });

  it('keeps a negative figure negative', () => {
    expect(moneyIn('-1,250.00')).toEqual({ value: -1250, raw: '-1,250.00' });
    expect(moneyIn('(1,250.00)')).toEqual({ value: -1250, raw: '(1,250.00)' });
    expect(moneyIn('(100.00)')).toEqual({ value: -100, raw: '(100.00)' });
  });

  it('reads a whole-dollar amount, with or without a currency sign', () => {
    expect(moneyIn('500')).toEqual({ value: 500, raw: '500' });
    expect(moneyIn('$500')).toEqual({ value: 500, raw: '$500' });
    expect(moneyIn('$ 500')).toEqual({ value: 500, raw: '$500' });
  });
});