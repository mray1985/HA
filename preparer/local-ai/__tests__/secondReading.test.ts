import { describe, expect, it } from 'vitest';
import { getFormExtractionSchema } from '../src/formSchemas.js';
import {
  keysNeedingSecondReader,
  readingsAgree,
  secondReaderSchema,
  valuesAfterVerification,
  verifyReadings,
} from '../src/secondReading.js';

const MORTGAGE = getFormExtractionSchema('1098')!;
const at = (pageText: string) => ({ box: [0, 0, 10, 10] as const, source: 'ocr' as const, pageText });

describe('verifyReadings', () => {
  // Measured on the office-scan variant: the model read the lender TIN with an
  // extra digit; OCR could not find that string on the page.
  const evidence = {
    values: { 'lender.tin': '72-33344445', '1': '9,412.37', '2': '214,880.15' },
    located: { 'lender.tin': null, '1': at('9,412.37'), '2': null },
    box12FromPage: {},
  };

  it('confirms values the page itself shows, and marks the rest unconfirmed', () => {
    expect(verifyReadings(MORTGAGE, evidence)).toEqual([
      { key: 'lender.tin', status: 'unconfirmed', primary: '72-33344445' },
      { key: '1', status: 'confirmed', primary: '9,412.37', second: '9,412.37', confirmedBy: 'page' },
      { key: '2', status: 'unconfirmed', primary: '214,880.15' },
    ]);
    expect(keysNeedingSecondReader(MORTGAGE, evidence)).toEqual(['lender.tin', '2']);
  });

  it('uses a second model: agreement confirms, disagreement is a conflict — never a pick', () => {
    const readings = verifyReadings(MORTGAGE, evidence, { 'lender.tin': '72-3334445', '2': '$214,880.15' });
    expect(readings.find((r) => r.key === 'lender.tin')).toEqual({ key: 'lender.tin', status: 'conflict', primary: '72-33344445', second: '72-3334445' });
    expect(readings.find((r) => r.key === '2')).toMatchObject({ status: 'confirmed', confirmedBy: 'model' });
  });

  it('treats box 12 entries read from the page as confirmed by the page', () => {
    const w2 = getFormExtractionSchema('W-2')!;
    const r = verifyReadings(w2, { values: { '12a.code': 'D', '12a.amount': '2500.00' }, located: {}, box12FromPage: { '12a': { code: 'D', amount: '2500.00' } } });
    expect(r.every((x) => x.status === 'confirmed' && x.confirmedBy === 'page')).toBe(true);
  });
});

describe('missed boxes', () => {
  // Measured on a faded W-2: the model left box 5 blank; OCR shows the amount under its label.
  const W2 = getFormExtractionSchema('W-2')!;
  const evidence = {
    values: { '1': '52431.18' },
    located: { '1': at('52431.18') },
    box12FromPage: {},
    missed: [{ key: '5', pageText: '54,931.18', box: [0, 0, 10, 10] as const }],
  };

  it('goes to review with the page reading, and asks the second model for it', () => {
    expect(verifyReadings(W2, evidence).find((r) => r.key === '5')).toEqual({ key: '5', status: 'missed', page: '54,931.18' });
    expect(keysNeedingSecondReader(W2, evidence)).toEqual(['5']);
    expect(secondReaderSchema(W2, ['5']).boxes.map((b) => b.key)).toEqual(['5']);
  });

  it('is recovered only when the second model reads the same amount', () => {
    const agreed = verifyReadings(W2, evidence, { '5': '54931.18' });
    expect(agreed.find((r) => r.key === '5')).toEqual({ key: '5', status: 'recovered', second: '54931.18', page: '54,931.18', confirmedBy: 'model' });
    expect(valuesAfterVerification(evidence.values, agreed)).toEqual({ '1': '52431.18', '5': '54931.18' });

    const disagreed = verifyReadings(W2, evidence, { '5': '54913.18' });
    expect(disagreed.find((r) => r.key === '5')).toMatchObject({ status: 'missed', second: '54913.18' });
    expect(valuesAfterVerification(evidence.values, disagreed)).toEqual({ '1': '52431.18' });
  });

  it('never applies an unconfirmed or conflicting value change', () => {
    const readings = verifyReadings(MORTGAGE, { values: { '2': '214,880.15' }, located: {}, box12FromPage: {} }, { '2': '214,880.16' });
    expect(readings).toEqual([{ key: '2', status: 'conflict', primary: '214,880.15', second: '214,880.16' }]);
    expect(valuesAfterVerification({ '2': '214,880.15' }, readings)).toEqual({ '2': '214,880.15' });
  });
});

describe('readingsAgree', () => {
  it.each([
    ['$1,284.66', '1284.66', 'money', true],
    ['1284.66', '1284.68', 'money', false],
    ['72-1234567', '721234567', 'tin', true],
    ['RIVERBEND LOGISTICS LLC\n4100 CANAL', 'Riverbend Logistics, LLC', 'text', true],
    ['', '', 'text', false],
  ] as const)('%j vs %j (%s) → %j', (a, b, kind, expected) => {
    expect(readingsAgree(a, b, kind)).toBe(expected);
  });
});
