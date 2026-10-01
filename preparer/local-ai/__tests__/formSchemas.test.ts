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
    // A second local line is a situation the tool cannot represent.
    const mapped = mapBoxesToTool(W2, { '1': '100.00', '2': '10.00', '10': '5,000.00', '18.2': '100.00' });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['10', '18.2']);
    expect(mapped.bag).not.toHaveProperty('dependentCareBenefits');
  });

  it('takes the name from the first line, without the comma a model puts at its end', () => {
    const mapped = mapBoxesToTool(W2, { c: 'CIRCLE CITY MACHINING INC,\n200 W WASHINGTON ST,\nINDIANAPOLIS IN 46204' });
    expect(mapped.bag.employerName).toBe('CIRCLE CITY MACHINING INC');
    expect(mapBoxesToTool(W2, { c: 'ACME CO., INC.\nMAIN ST' }).bag.employerName).toBe('ACME CO., INC.');
  });

  it('applies the first local line: boxes 18, 19 and 20', () => {
    const mapped = mapBoxesToTool(W2, { '15.state.1': 'IN', '17.1': '1,800.00', '18.1': '60,000.00', '19.1': '1,212.00', '20.1': 'MARION' });
    expect(mapped.reviewBoxes).toEqual([]);
    expect(mapped.bag).toMatchObject({ state: 'IN', localWages: '60,000.00', localTaxWithheld: '1,212.00', localityName: 'MARION' });
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
    const noTool: FormExtractionSchema = {
      formType: 'W-2G',
      revision: 'test',
      boxes: [
        { key: '1', box: '1', label: 'Reportable winnings', kind: 'money', use: 'tool' },
        { key: 'payer', box: '', label: "PAYER'S name", kind: 'text', use: 'info' },
      ],
    };
    const mapped = mapBoxesToTool(noTool, { '1': '4,200.00', payer: 'RIVER CITY CASINO' });
    expect(mapped.tool).toBeNull();
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['1']);
  });

  it('maps a 1099-DIV and routes boxes without an engine field to review', () => {
    const div = getFormExtractionSchema('1099-DIV')!;
    const mapped = mapBoxesToTool(div, {
      'payer.block': 'SUMMIT INDEX FUNDS\nPO BOX 100',
      '1a': '2,410.55', '1b': '1,980.02', '2a': '310.00', '5': '44.10', '14.1': 'LA', '16.1': '20.00',
    });
    expect(extractStructuredFields('add_1099_div', mapped.bag, mapped.rawText).args).toEqual({
      ordinaryDividends: 2410.55, qualifiedDividends: 1980.02, capitalGainDistributions: 310,
      stateTaxWithheld: 20, payerName: 'SUMMIT INDEX FUNDS', stateCode: 'LA',
    });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['5']);
  });

  it('maps 1099-DIV boxes 2b and 2d (Schedule D worksheets) and keeps 2c for review', () => {
    const div = getFormExtractionSchema('1099-DIV')!;
    const mapped = mapBoxesToTool(div, { 'payer.block': 'REIT FUND', '1a': '100.00', '2a': '900.00', '2b': '400.00', '2c': '50.00', '2d': '120.00' });
    expect(extractStructuredFields('add_1099_div', mapped.bag, mapped.rawText).args).toMatchObject({
      capitalGainDistributions: 900, unrecapturedSection1250Gain: 400, collectiblesGain: 120,
    });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['2c']);
  });

  it('maps an SSA-1099, keeping a negative net benefit as printed', () => {
    const ssa = getFormExtractionSchema('SSA-1099')!;
    const mapped = mapBoxesToTool(ssa, { '1': 'MAYA TESTPAYER', '3': '1,200.00', '4': '1,450.00', '5': '(250.00)', '6': '0.00' });
    expect(mapped.tool).toBe('add_ssa_1099');
    expect(extractStructuredFields('add_ssa_1099', mapped.bag, mapped.rawText).args).toEqual({
      benefitsPaid: 1200, benefitsRepaid: 1450, netBenefits: -250, federalTaxWithheld: 0, beneficiaryName: 'MAYA TESTPAYER',
    });
  });

  it('maps a 1098 including points, the address checkbox and the property count', () => {
    const mortgage = getFormExtractionSchema('1098')!;
    const mapped = mapBoxesToTool(mortgage, {
      'lender.block': 'CRESCENT CITY MORTGAGE CO\n1500 POYDRAS ST', 'lender.tin': '72-3334445',
      '1': '9,412.37', '2': '214,880.15', '3': '03/14/2021', '6': '1,200.00', '7': 'X', '9': '1',
    });
    expect(mapped.tool).toBe('add_mortgage_interest');
    expect(mapped.reviewBoxes).toEqual([]);
    expect(extractStructuredFields('add_mortgage_interest', mapped.bag, mapped.rawText).args).toEqual({
      lenderTin: '72-3334445', mortgageInterest: 9412.37, outstandingPrincipal: 214880.15, originationDate: '03/14/2021',
      points: 1200, numberOfProperties: 1, lenderName: 'CRESCENT CITY MORTGAGE CO', propertyAddressSameAsBorrower: true,
    });
  });

  it('maps a 1098-T with its checkboxes', () => {
    const tuition = getFormExtractionSchema('1098-T')!;
    const mapped = mapBoxesToTool(tuition, {
      'filer.name': 'BAYOU STATE UNIVERSITY', 'filer.ein': '72-6000111', '1': '8,420.00', '5': '3,000.00', '7': 'no', '8': 'X', '9': 'no',
    });
    expect(extractStructuredFields('add_education_expense', mapped.bag, mapped.rawText).args).toEqual({
      institutionEin: '72-6000111', tuitionPaid: 8420, scholarships: 3000, institutionName: 'BAYOU STATE UNIVERSITY',
      includesNextPeriod: false, halfTimeStudent: true, graduateStudent: false,
    });
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

describe('corrected forms (work order §15 "corrected W-2 handling", §72)', () => {
  it('routes a checked CORRECTED box to review, and ignores an unchecked one', () => {
    const int = getFormExtractionSchema('1099-INT')!;
    expect(mapBoxesToTool(int, { corrected: 'X', '1': '100.00' }).reviewBoxes.map((b) => b.key)).toEqual(['corrected']);
    expect(mapBoxesToTool(int, { corrected: 'no', '1': '100.00' }).reviewBoxes).toEqual([]);
  });

  it('gives every 1099, 1098 and 1098-T schema a CORRECTED checkbox', () => {
    for (const formType of ['1099-INT', '1099-DIV', '1099-NEC', '1099-R', '1098', '1098-T'] as const) {
      const b = getFormExtractionSchema(formType)!.boxes.find((x) => x.key === 'corrected');
      expect(b, formType).toMatchObject({ kind: 'checkbox', use: 'review', checkbox: { labelPhrase: 'CORRECTED', direction: 'left' } });
    }
  });
});
