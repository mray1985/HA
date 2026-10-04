/**
 * A figure printed in the words that name its own box.
 *
 * A 1099-DIV prints box 2b as "Unrecap. Sec. 1250 gain". The row reader took the
 * 1250 out of the label and wrote it as unrecaptured Section 1250 gain, on three
 * documents - income nobody sent. A printed amount is never a digit run out of
 * its own label.
 */
import { describe, it, expect } from 'vitest';
import { figureIsItsOwnLabel, printedInsideLabel } from '../src/pageEvidence';

describe('a figure printed in its own label is the label', () => {
  it('rejects the digits a label carries', () => {
    expect(printedInsideLabel('1250', 'Unrecap. Sec. 1250 gain')).toBe(true);
    // The label's own figure, as the text layer prints it on these forms.
    expect(printedInsideLabel('1250', '2b Unrecap. Sec. 1250 gain')).toBe(true);
    // An amount with cents is not a digit run out of the label, so it is kept.
    expect(printedInsideLabel('1,250.00', 'Unrecap. Sec. 1250 gain')).toBe(false);
    expect(printedInsideLabel('8863', '6 Scholarship adjustments')).toBe(false);
  });

  it('keeps an amount the label does not carry', () => {
    expect(printedInsideLabel('68,250.00', "1 Wages, tips, other compensation")).toBe(false);
    expect(printedInsideLabel('9412.37', '1 Mortgage interest received from payer(s)/borrower(s)')).toBe(false);
    expect(printedInsideLabel('1200', '3 Other income')).toBe(false);
  });

  it('leaves short runs alone, because a label carries its own box number', () => {
    // Box numbers and small counts are legitimately printed in the label.
    expect(printedInsideLabel('13', '13a Other')).toBe(false);
    expect(printedInsideLabel('5', '5 Scholarships or grants')).toBe(false);
    expect(printedInsideLabel('1', '1 Wages, tips, other compensation')).toBe(false);
  });

  it('matches whole digit runs, not a fragment of a longer number', () => {
    // 250 appears inside 1250 but is not the figure printed in the label.
    expect(printedInsideLabel('250', 'Unrecap. Sec. 1250 gain')).toBe(false);
  });

  it('keeps a real amount that shares the label\'s digits when it sits beside the label', () => {
    const label = [0, 0, 120, 12] as const;
    const inLabel = [8, 0, 48, 12] as const;
    const valueColumn = [200, 0, 260, 12] as const;
    // The label's own "1250" sits in the label's box.
    expect(figureIsItsOwnLabel('1250', 'Unrecap. Sec. 1250 gain', inLabel, label)).toBe(true);
    // A whole-dollar 1,250 and 12.50 both normalize to 1250, and both are the
    // amount when they are printed in the value column.
    expect(figureIsItsOwnLabel('1,250', 'Unrecap. Sec. 1250 gain', valueColumn, label)).toBe(false);
    expect(figureIsItsOwnLabel('12.50', 'Unrecap. Sec. 1250 gain', valueColumn, label)).toBe(false);
  });
});