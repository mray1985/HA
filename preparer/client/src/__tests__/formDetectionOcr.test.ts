/**
 * Which form a scan is taken to be.
 *
 * W-2C's secondary keywords are deliberately a superset of the W-2's, so that a
 * real correction is never read as an original. On a photo that made the
 * reverse mistake the common one: OCR scoring tolerates two edits, so a plain
 * W-2 satisfied "w-2c" against the printed "w-2" and the correction's generic
 * secondaries then outscored the W-2. Every W-2 photo was read as a W-2c and no
 * money came off it at all.
 */
import { describe, it, expect } from 'vitest';
import { detectFormType, type TextBlock } from '../services/pdfExtractHelpers';

/** One OCR-shaped block per phrase, laid out as the scanner returns them. */
function blocks(phrases: string[]): TextBlock[] {
  return phrases.map((text, i) => ({ text, x: 40, y: 40 + i * 18, width: 220, height: 12, page: 1 }));
}

const W2_WORDS = ['Wage and Tax Statement', 'Form W-2', "Employer's name", '1 Wages', 'Federal income tax withheld', 'Social security wages', '2 Social security tax', '17 State wages'];

describe('a scanned form is only a W-2c when it says so', () => {
  it('reads a photographed W-2 as a W-2, not a W-2c', () => {
    const res = detectFormType(blocks(W2_WORDS), true);
    expect(res.type).toBe('W-2');
  });

  it('still reads a correction as a W-2c', () => {
    const res = detectFormType(
      blocks(['Corrected Wage and Tax Statement', 'Form W-2c', 'Previously reported wages', 'c Previously reported wages', '1 Wages']),
      true,
    );
    expect(res.type).toBe('W-2C');
  });

  it('still reads a correction that only states "previously reported"', () => {
    const res = detectFormType(
      blocks(['Form W-2c', 'Previously reported', 'Correct information', "Employer's name", '1 Wages']),
      true,
    );
    expect(res.type).toBe('W-2C');
  });

  it('does not let a bare "w-2c" fuzzy match borrow the correction form', () => {
    // "w-2g" style noise: the page prints W-2 and nothing that only a
    // correction prints, so this must not be taken as a W-2c.
    const res = detectFormType(blocks(['Form W-2g', 'Wages, tips', 'Federal income tax withheld']), true);
    expect(res.type).not.toBe('W-2C');
  });

  it('leaves an unreadable page unclassified rather than guessing', () => {
    expect(detectFormType(blocks(['zzzz qqqq', '1234 5678']), true).type).toBeNull();
  });
});