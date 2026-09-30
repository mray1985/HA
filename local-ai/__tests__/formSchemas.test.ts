import { describe, expect, it } from 'vitest';
import {
  FORM_EXTRACTION_SCHEMAS,
  boxValuesFromTemplate,
  buildExtractionTemplate,
  checkboxState,
  getFormExtractionSchema,
  isBlankTranscription,
  mapBoxesToTool,
  stateCodeFromCell,
  type FormExtractionSchema,
} from '../src/formSchemas.js';
import { extractStructuredFields } from '../src/structuredExtraction.js';

const W2 = getFormExtractionSchema('W-2')!;

/** Real GLM-OCR (Q4_K_M, CPU) output for the gauntlet case w2-basic-single. */
const GLM_W2_OUTPUT: Record<string, string> = {
  'a Employee\'s social security number': '000-12-3456',
  'b Employer identification number (EIN)': '72-1234567',
  "c Employer's name, address, and ZIP code": 'RIVERBEND LOGISTICS LLC\n4100 CANAL ST\nNEW ORLEANS LA 70119',
  'd Control number': '00419',
  "f Employee's address and ZIP code": '815 MAGNOLIA AVE BATON ROUGE LA 70802',
  '1 Wages, tips, other compensation': '52431.18',
  '2 Federal income tax withheld': '5873.40',
  '3 Social security wages': '54931.18',
  '4 Social security tax withheld': '3405.73',
  '5 Medicare wages and tips': '54931.18',
  '6 Medicare tax withheld': '796.50',
  '7 Social security tips': '',
  '8 Allocated tips': '',
  '10 Dependent care benefits': '',
  '12a Code': 'D',
  '12a Amount': '2500.00',
  '12b Code': '',
  '12b Amount': '',
  '15 State (line 1)': 'LA',
  "15 Employer's state ID number (line 1)": '1234567-001',
  '16 State wages, tips, etc. (line 1)': '52431.18',
  '17 State income tax (line 1)': '1420.55',
  '18 Local wages, tips, etc. (line 1)': '',
};

describe('form extraction schemas', () => {
  it.each(Object.values(FORM_EXTRACTION_SCHEMAS) as FormExtractionSchema[])(
    '$formType has unique keys and template fields',
    (schema) => {
      const keys = schema.boxes.map((b) => b.key);
      expect(new Set(keys).size).toBe(keys.length);
      const template = buildExtractionTemplate(schema);
      expect(Object.keys(template.template)).toHaveLength(schema.boxes.length);
      expect(Object.values(template.template).every((v) => v === '')).toBe(true);
      expect(template.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    },
  );

  it('returns null for forms without a schema', () => {
    expect(getFormExtractionSchema('K-1')).toBeNull();
    expect(getFormExtractionSchema(null)).toBeNull();
  });
});

describe('boxValuesFromTemplate', () => {
  it('drops blank and non-string fields instead of reading them as zero', () => {
    const template = buildExtractionTemplate(W2);
    const values = boxValuesFromTemplate(
      { '1 Wages, tips, other compensation': '52431.18', '7 Social security tips': '', '8 Allocated tips': null },
      template,
      W2,
    );
    expect(values).toEqual({ '1': '52431.18' });
  });

  it('treats symbol-only and label-echo transcriptions as blank (real model outputs)', () => {
    const int = getFormExtractionSchema('1099-INT')!;
    const mortgage = getFormExtractionSchema('1098')!;
    const values = boxValuesFromTemplate(
      { "Payer's RTN (optional)": '(optional)', '1 Interest income': '1,284.66', '2 Early withdrawal penalty': '$' },
      buildExtractionTemplate(int),
      int,
    );
    expect(values).toEqual({ '1': '1,284.66' });
    const m = boxValuesFromTemplate(
      { '4 Refund of overpaid interest': '$', '5 Mortgage insurance premiums': '$ ', '1 Mortgage interest received from payer(s)/borrower(s)': '$ 9,412.37' },
      buildExtractionTemplate(mortgage),
      mortgage,
    );
    expect(m).toEqual({ '1': '$ 9,412.37' });
  });
});

describe('mapBoxesToTool', () => {
  it('maps a real model W-2 transcription to add_w2 arguments', () => {
    const values = boxValuesFromTemplate(GLM_W2_OUTPUT, buildExtractionTemplate(W2), W2);
    const mapped = mapBoxesToTool(W2, values);
    expect(mapped.tool).toBe('add_w2');
    expect(mapped.reviewBoxes).toEqual([]);

    const structured = extractStructuredFields('w2', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({
      employerEin: '72-1234567',
      wages: 52431.18,
      federalTaxWithheld: 5873.4,
      socialSecurityWages: 54931.18,
      socialSecurityTax: 3405.73,
      medicareWages: 54931.18,
      medicareTax: 796.5,
      stateWages: 52431.18,
      stateTaxWithheld: 1420.55,
      employerName: 'RIVERBEND LOGISTICS LLC',
      state: 'LA',
      box12: [{ code: 'D', amount: 2500 }],
    });
    // Blank boxes never become arguments, so they can never become zero.
    expect(structured.args).not.toHaveProperty('socialSecurityTips');
    expect(Object.values(structured.args)).not.toContain(0);
  });

  it('routes filled boxes that no tool accepts to review instead of dropping them', () => {
    const mapped = mapBoxesToTool(W2, { '1': '100.00', '2': '10.00', '10': '5,000.00', '18.1': '100.00' });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['10', '18.1']);
    expect(mapped.bag).not.toHaveProperty('dependentCareBenefits');
  });

  it('routes a second state row to review', () => {
    const mapped = mapBoxesToTool(W2, { '15.state.2': 'MS', '16.2': '1,000.00' });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['15.state.2', '16.2']);
  });

  it('holds half a box 12 entry for review', () => {
    const mapped = mapBoxesToTool(W2, { '12a.amount': '2500.00' });
    expect(mapped.bag).not.toHaveProperty('box12');
    expect(mapped.reviewBoxes).toEqual([{ key: '12a', label: 'Box 12a', text: '(no code) 2500.00' }]);
  });

  it('only applies checkboxes with an explicit mark; ambiguous text goes to review', () => {
    const mapped = mapBoxesToTool(W2, { '13.retirement': 'X', '13.statutory': 'Statutory employee' });
    expect(mapped.bag.box13).toEqual({ retirementPlan: true });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['13.statutory']);
  });

  it('parses state from "State/Payer\'s state no." cells and leaves unreadable cells unknown', () => {
    const nec = getFormExtractionSchema('1099-NEC')!;
    expect(mapBoxesToTool(nec, { '6.1': 'LA/1234567' }).bag.stateCode).toBe('LA');
    const unreadable = mapBoxesToTool(nec, { '6.1': '12345' });
    expect(unreadable.bag).toHaveProperty('stateCode', undefined);
    expect(unreadable.rawText.stateCode).toBe('12345');
    const structured = extractStructuredFields('1099nec', unreadable.bag, unreadable.rawText);
    expect(structured.args).toHaveProperty('stateCode', undefined);
  });

  it('does not route unchecked review checkboxes, but does route checked or unreadable ones', () => {
    const r = getFormExtractionSchema('1099-R')!;
    expect(mapBoxesToTool(r, { '2b.notDetermined': 'no', '7c': 'no', '12': 'no' }).reviewBoxes).toEqual([]);
    expect(mapBoxesToTool(r, { '2b.notDetermined': 'X', '7c': '?' }).reviewBoxes.map((b) => b.key)).toEqual(['2b.notDetermined', '7c']);
  });

  it('maps the 1099-R IRA checkbox and distribution code', () => {
    const r = getFormExtractionSchema('1099-R')!;
    const mapped = mapBoxesToTool(r, { 'payer.name': 'SUMMIT TRUST\n8401 UNITED PLAZA', '1': '18,500.00', '7a': '7', '7b': '✔' });
    const structured = extractStructuredFields('1099r', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({ payerName: 'SUMMIT TRUST', grossDistribution: 18500, distributionCode: '7', isIRA: true });
  });

  it('routes every filled tax box on a form without a tax tool to review', () => {
    const mortgage = getFormExtractionSchema('1098')!;
    const mapped = mapBoxesToTool(mortgage, { '1': '9,412.37', '2': '214,880.15', 'lender.name': 'CRESCENT CITY MORTGAGE CO' });
    expect(mapped.tool).toBeNull();
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['1', '2']);
  });
});

describe('isBlankTranscription', () => {
  const byKey = (formType: 'W-2' | '1099-R', key: string) => getFormExtractionSchema(formType)!.boxes.find((b) => b.key === key)!;
  it.each([
    ['$', 'W-2', '1', true],
    ['N/A', 'W-2', '1', true],
    ['0.00', 'W-2', '1', false],
    ['Other', 'W-2', '14a', true],
    ['LA', 'W-2', '15.state.1', false],
    ['7', '1099-R', '7a', false],
    ['%', '1099-R', '9a', true],
  ] as const)('%j in %s box %s → %j', (text, formType, key, blank) => {
    expect(isBlankTranscription(text, byKey(formType, key))).toBe(blank);
  });
});

describe('checkboxState / stateCodeFromCell', () => {
  it.each([
    ['X', true], ['✔', true], ['checked', true], ['no', false], ['', undefined], ['Retirement plan', undefined],
  ])('checkbox %j → %j', (text, expected) => {
    expect(checkboxState(text)).toBe(expected);
  });

  it.each([
    ['LA', 'LA'], ['la/1234567', 'LA'], ['LA 1234567', 'LA'], ['1234567', undefined], ['LOUISIANA', undefined],
  ])('state cell %j → %j', (text, expected) => {
    expect(stateCodeFromCell(text)).toBe(expected);
  });
});
