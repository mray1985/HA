import { describe, expect, it } from 'vitest';
import {
  columnParts,
  getFormExtractionSchema,
  parseNameColumns,
  identityFromValues,
  isIdentityKey,
  parsePersonName,
  parseTin,
  parseUSAddress,
  verifyReadings,
} from '../src/index.js';

describe('identity parsing', () => {
  it('splits a name only when the words leave no choice', () => {
    expect(parsePersonName('MAYA LEE')).toEqual({ first: 'Maya', last: 'Lee' });
    expect(parsePersonName('MAYA R LEE')).toEqual({ first: 'Maya', middleInitial: 'R', last: 'Lee' });
    expect(parsePersonName('Maya R. Lee Jr.')).toEqual({ first: 'Maya', middleInitial: 'R', last: 'Lee', suffix: 'Jr.' });
    expect(parsePersonName("SEAN O'NEIL-PARK III")).toEqual({ first: 'Sean', last: "O'Neil-Park", suffix: 'III' });
    // A joint account, a compound surname or two middle names are not guessed.
    expect(parsePersonName('MAYA LEE & SAM LEE')).toBeNull();
    expect(parsePersonName('MAYA LEE AND SAM LEE')).toBeNull();
    expect(parsePersonName('MARIA DE LA CRUZ')).toBeNull();
    expect(parsePersonName('LEE, MAYA')).toBeNull();
    expect(parsePersonName('MAYA')).toBeNull();
    expect(parsePersonName('MAYA LEE\nSAM LEE')).toBeNull();
  });

  it('reads a US street and "City, ST ZIP" line, and nothing else', () => {
    expect(parseUSAddress(['815 MAGNOLIA AVE', 'BATON ROUGE, LA 70802'])).toEqual({ street: '815 MAGNOLIA AVE', city: 'BATON ROUGE', state: 'LA', zip: '70802' });
    expect(parseUSAddress(['815 Magnolia Ave\nApt 4B\nBaton Rouge LA 70802-1234'])).toEqual({ street: '815 Magnolia Ave Apt 4B', city: 'Baton Rouge', state: 'LA', zip: '70802-1234' });
    expect(parseUSAddress(['PO BOX 12', 'Austin, TX 78701'])).toMatchObject({ street: 'PO BOX 12', state: 'TX' });
    expect(parseUSAddress(['815 MAGNOLIA AVE', 'TORONTO ON M5V 2T6'])).toBeNull();
    expect(parseUSAddress(['MAGNOLIA AVE', 'BATON ROUGE, LA 70802'])).toBeNull();
    expect(parseUSAddress(['815 MAGNOLIA AVE', 'BATON ROUGE, XX 70802'])).toBeNull();
  });

  it('keeps only the last four digits of a masked TIN', () => {
    expect(parseTin('123-45-6789')).toEqual({ full: '123456789', lastFour: '6789' });
    expect(parseTin('XXX-XX-6789')).toEqual({ lastFour: '6789' });
    expect(parseTin('***-**-6789')).toEqual({ lastFour: '6789' });
    expect(parseTin('12-3456789')).toEqual({});
  });
});

describe('the person on a form', () => {
  it('reads the W-2 employee, and says what an independent reader confirmed', () => {
    const values = { a: '123-45-6789', e: 'MAYA R LEE', f: 'MAYA R LEE\n815 MAGNOLIA AVE\nBATON ROUGE LA 70802', '1': '52431.18' };
    const id = identityFromValues('W-2', values, (k) => k !== 'a');
    expect(id).toEqual({
      formType: 'W-2',
      tin: { raw: '123-45-6789', confirmed: false, value: '123456789' },
      name: { raw: 'MAYA R LEE', confirmed: true, value: { first: 'Maya', middleInitial: 'R', last: 'Lee' } },
      address: { raw: 'MAYA R LEE\n815 MAGNOLIA AVE\nBATON ROUGE LA 70802', confirmed: true, value: { street: '815 MAGNOLIA AVE', city: 'BATON ROUGE', state: 'LA', zip: '70802' } },
    });
    // An unconfirmed full SSN gives no last four either.
    expect(id!.tinLastFour).toBeUndefined();
  });

  it('reads a 1099-Q recipient and a 1098-T student to place the form only', () => {
    const q = identityFromValues('1099-Q', { 'recipient.tin': 'XXX-XX-3456', 'recipient.name': 'MAYA TESTPAYER' }, () => true);
    expect(q).toMatchObject({ formType: '1099-Q', placementOnly: true, tinLastFour: '3456', name: { value: { first: 'Maya', last: 'Testpayer' } } });
    const t = identityFromValues('1098-T', { 'student.tin': 'XXX-XX-1122', 'student.name': 'ALEX LEE' }, () => true);
    expect(t).toMatchObject({ placementOnly: true, tinLastFour: '1122', name: { value: { first: 'Alex', last: 'Lee' } } });
    // The recipient and student boxes are identity boxes: the page and the second reader confirm them.
    expect(isIdentityKey('1099-Q', 'recipient.name')).toBe(true);
    expect(isIdentityKey('1098-T', 'student.tin')).toBe(true);
    // Every other form's person is the return's own.
    expect(identityFromValues('1099-INT', { 'recipient.name': 'MAYA LEE' }, () => true)!.placementOnly).toBeUndefined();
  });

  it('joins a 2026 1099’s split address cells', () => {
    const id = identityFromValues('1099-NEC', {
      'recipient.tin': 'XXX-XX-6789', 'recipient.name': 'MAYA LEE', 'recipient.street': '815 MAGNOLIA AVE', 'recipient.apt': 'APT 2',
      'recipient.city': 'BATON ROUGE', 'recipient.state': 'LA', 'recipient.zip': '70802',
    }, () => true);
    expect(id).toMatchObject({ tinLastFour: '6789', name: { value: { first: 'Maya', last: 'Lee' } }, address: { value: { street: '815 MAGNOLIA AVE APT 2', city: 'BATON ROUGE', zip: '70802' } } });
    expect(id!.tin).toBeUndefined();
  });

  it('builds no address from split cells when one was not read (a scanned 1099-G)', () => {
    // Measured: the models read every cell but the city on a scanned 1099-G.
    const id = identityFromValues('1099-G', {
      'recipient.name': 'MAYA TESTPAYER', 'recipient.street': '815 MAGNOLIA AVE', 'recipient.state': 'LA', 'recipient.zip': '70802',
    }, () => true);
    expect(id?.address).toEqual({ raw: '815 MAGNOLIA AVE\n, LA 70802', confirmed: false, value: null });
    expect(parseUSAddress(['815 MAGNOLIA AVE', ', LA 70802'])).toBeNull();
  });

  it('never names the taxpayer from a 1098-T student or a 1099-Q recipient: they place the form only', () => {
    expect(identityFromValues('1098-T', { 'student.name': 'LEO LEE' }, () => true)).toMatchObject({ placementOnly: true });
    expect(identityFromValues('1099-Q', { 'recipient.name': 'LEO LEE' }, () => true)).toMatchObject({ placementOnly: true });
    expect(isIdentityKey('1098', 'borrower.tin')).toBe(true);
  });

  it('asks the independent readers to confirm identity boxes like amounts', () => {
    const schema = getFormExtractionSchema('W-2')!;
    const readings = verifyReadings(schema, {
      values: { a: '123-45-6789', e: 'MAYA LEE', f: '815 MAGNOLIA AVE\nBATON ROUGE LA 70802', '1': '100.00' },
      located: { '1': { box: [0, 0, 1, 1], source: 'pdf-text', pageText: '100.00' }, e: { box: [0, 2, 1, 3], source: 'pdf-text', pageText: 'MAYA LEE' } },
      box12FromPage: {},
    }, { a: '123-45-6789', f: '815 MAGNOLIA AVE\nBATON ROUGE LA 70803' });
    const status = Object.fromEntries(readings.map((r) => [r.key, r.status]));
    expect(status).toMatchObject({ '1': 'confirmed', e: 'confirmed', a: 'confirmed' });
    // Every line of an address must agree, not only the street.
    expect(status.f).toBe('conflict');
  });
});

describe("a W-2's name by its printed columns", () => {
  const word = (text: string, x: number, y = 100) => ({ text, box: [x, y, x + text.length * 9, y + 18] as [number, number, number, number], source: 'pdf-text' as const });

  it('splits where the page shows a column gap, never at a word space', () => {
    const page = [word('MARY', 80), word('ANN', 130), word('DE', 360), word('LA', 385), word('CRUZ', 410)];
    expect(columnParts('MARY ANN DE LA CRUZ', page)).toEqual(['MARY ANN', 'DE LA CRUZ']);
    // The reader's comma or line break does not decide it.
    expect(columnParts('MARY, ANN DE LA CRUZ', page)).toEqual(['MARY ANN', 'DE LA CRUZ']);
    expect(columnParts('MARY ANN\nDE LA CRUZ', page)).toEqual(['MARY ANN', 'DE LA CRUZ']);
    // Words that are not on one line of the page give nothing.
    expect(columnParts('MARY ANN SMITH', page)).toBeNull();
  });

  it('reads the columns as first name and initial, last name and suffix', () => {
    expect(parseNameColumns('MARY ANN', 'DE LA CRUZ')).toEqual({ first: 'Mary Ann', last: 'De La Cruz' });
    expect(parseNameColumns('MAYA R', 'TESTPAYER', 'JR')).toEqual({ first: 'Maya', middleInitial: 'R', last: 'Testpayer', suffix: 'Jr.' });
    expect(parseNameColumns('MAYA', 'TESTPAYER', 'ESQ')).toBeNull();
    const id = identityFromValues('W-2', { e: 'JORDAN\nTESTPAYER' }, () => true, { nameColumns: true });
    expect(id?.name?.value).toEqual({ first: 'Jordan', last: 'Testpayer' });
    // Without the page's columns, a two-line name is not split.
    expect(identityFromValues('W-2', { e: 'JORDAN\nTESTPAYER' }, () => true)?.name?.value).toBeNull();
  });
});
