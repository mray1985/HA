/**
 * A figure printed in the words that name its own box.
 *
 * A 1099-DIV prints box 2b as "Unrecap. Sec. 1250 gain". The row reader took the
 * 1250 out of the label and wrote it as unrecaptured Section 1250 gain, on three
 * documents - income nobody sent. A printed amount is never a digit run out of
 * its own label.
 */
import { describe, it, expect } from 'vitest';
import { printedInsideLabel } from '../src/pageEvidence';

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
});