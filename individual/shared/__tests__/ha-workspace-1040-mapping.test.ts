import { describe, it, expect } from 'vitest';
import { FORM_1040_FIELDS } from '../src/constants/irsForm1040Map';
import { SCHEDULE_2_FIELDS } from '../src/constants/irsSchedule2Map';
import type { CalculationResult, TaxReturn } from '../src/types';

function value(label: string, calc: CalculationResult): number {
  const field = FORM_1040_FIELDS.find(f => f.formLabel?.startsWith(`Line ${label}:`));
  if (!field?.transform) throw new Error(`Missing mapped transform for line ${label}`);
  return Number(field.transform({} as TaxReturn, calc));
}
describe('2025 Form 1040 liability mapping', () => {
  it('maps the installed Schedule 2 PDF to its actual additional-tax fields', () => {
    expect(SCHEDULE_2_FIELDS.find(f => f.formLabel?.startsWith('Line 17c:'))?.pdfFieldName).toContain('f2_04[0]');
    expect(SCHEDULE_2_FIELDS.find(f => f.formLabel?.startsWith('Line 18:'))?.pdfFieldName).toContain('f2_21[0]');
    expect(SCHEDULE_2_FIELDS.find(f => f.formLabel?.startsWith('Line 21:'))?.pdfFieldName).toContain('f2_24[0]');
  });
  it('keeps other taxes and refundable credits out of line 22', () => {
    const calc = { form1040: { incomeTax: 5000, amtAmount: 100, excessAPTCRepayment: 50, totalTax: 6050, taxAfterCredits: 5550 }, credits: { totalNonRefundable: 600, totalRefundable: 500 } } as CalculationResult;
    expect(value('17', calc)).toBe(150);
    expect(value('18', calc)).toBe(5150);
    expect(value('22', calc)).toBe(4550);
    expect(value('23', calc)).toBe(1500);
    expect(value('22', calc) + value('23', calc)).toBe(calc.form1040.totalTax);
  });
  it('floors income tax after nonrefundable credits at zero while retaining other taxes', () => {
    const calc = { form1040: { incomeTax: 100, amtAmount: 0, excessAPTCRepayment: 0, totalTax: 750, taxAfterCredits: 250 }, credits: { totalNonRefundable: 300, totalRefundable: 500 } } as CalculationResult;
    expect(value('22', calc)).toBe(0);
    expect(value('23', calc)).toBe(750);
  });
});
