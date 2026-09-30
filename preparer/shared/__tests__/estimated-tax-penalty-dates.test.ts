import { describe, expect, it } from 'vitest';
import { calculateEstimatedTaxPenalty, calculateScheduledPenalty, installmentDueDates } from '../src/engine/estimatedTaxPenalty.js';
import { FilingStatus } from '../src/types/index.js';

describe('Form 2210 with dated payments (IRC §6654, Part IV)', () => {
  it('uses the §7503 due dates', () => {
    expect(installmentDueDates(2025)).toEqual(['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15']);
    expect(installmentDueDates(2022)).toEqual(['2022-04-18', '2022-06-15', '2022-09-15', '2023-01-17']);
  });

  it('charges nothing when each installment is paid on time', () => {
    const due = installmentDueDates(2025);
    const r = calculateScheduledPenalty(8000, { withholding: 0, estimatedPayments: due.map((date) => ({ date, amount: 2000 })) }, 2025);
    expect(r.totalPenalty).toBe(0);
    expect(r.quarterlyDetail.map((q) => q.underpayment)).toEqual([0, 0, 0, 0]);
  });

  it('charges the missed installments when the whole year is paid in January', () => {
    const r = calculateScheduledPenalty(8000, { withholding: 0, estimatedPayments: [{ date: '2026-01-15', amount: 8000 }] }, 2025);
    // Q1: 2,000 unpaid Apr 15 2025 → Jan 15 2026 (275 days), Q2 from Jun 16 (213), Q3 from Sep 15 (122), Q4 on time.
    const expected = (days: number) => Math.round(2000 * 0.07 * days / 365 * 100) / 100;
    expect(r.quarterlyDetail.map((q) => q.penalty)).toEqual([expected(275), expected(213), expected(122), 0]);
    expect(r.quarterlyDetail.map((q) => q.underpayment)).toEqual([2000, 2000, 2000, 0]);
  });

  it('applies an early overpayment to the next installment', () => {
    const r = calculateScheduledPenalty(8000, { withholding: 0, estimatedPayments: [{ date: '2025-04-01', amount: 4000 }, { date: '2025-09-15', amount: 4000 }] }, 2025);
    expect(r.totalPenalty).toBe(0);
  });

  it('counts withholding as paid evenly, whatever its timing', () => {
    const r = calculateScheduledPenalty(8000, { withholding: 8000, estimatedPayments: [] }, 2025);
    expect(r.totalPenalty).toBe(0);
  });

  it('finds a penalty the even spread missed', () => {
    const args = [12000, 9000, undefined, 60000, FilingStatus.Single, undefined, 2025] as const;
    const even = calculateEstimatedTaxPenalty(...args);
    const late = calculateEstimatedTaxPenalty(...args, { withholding: 0, estimatedPayments: [{ date: '2026-01-15', amount: 9000 }] });
    expect(late.penalty).toBeGreaterThan(even.penalty);
  });
});
