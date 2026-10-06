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
import type { ClassifiableFormType } from '../src/documentClassifier.js';
import { IDENTITY_KEYS } from '../src/identity.js';
import { invokeTaxTool } from '../src/taxTools.js';

const ctx = { returnId: 'ret-1', taxYear: 2025, sourceDocumentId: 'DOC-1', sourceFileName: 'w2.pdf', extractor: 'test' };

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

  it('returns null when there is no schema for the form', () => {
    // Every classifiable form now has one; a form nobody can read still must not
    // be handed a schema.
    expect(getFormExtractionSchema('NOT-A-FORM' as ClassifiableFormType)).toBeNull();
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
    // Every classifiable form now has a tax tool, so this exercises the
    // fallback through a form type outside the union on purpose: the guarantee
    // is that a filled box is never silently dropped, and it has to survive a
    // future form that ships with a schema but no tool.
    const noTool: FormExtractionSchema = {
      formType: 'FUTURE-1099' as ClassifiableFormType,
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

describe('Form W-2G (Rev. January 2026)', () => {
  const W2G = getFormExtractionSchema('W-2G')!;

  it('names box 1 as the form prints it, "Reportable winnings"', () => {
    // The engine's IncomeW2G field is still called grossWinnings, but this
    // revision of the form prints "Reportable winnings". Sending a preparer to
    // a label the form does not have is the failure printedBoxLabels guards.
    expect(W2G.boxes.find((b) => b.key === '1')).toMatchObject({
      box: '1',
      label: 'Reportable winnings',
      kind: 'money',
      use: 'tool',
    });
  });

  it('reads the type of wager from box 3, where the form prints it', () => {
    // IncomeW2G in shared/types/index.ts comments this as "Box 4 description".
    // Box 4 is federal income tax withheld; the wager type is box 3.
    expect(W2G.boxes.find((b) => b.key === '3')).toMatchObject({ box: '3', label: 'Type of wager', use: 'tool' });
    expect(W2G.boxes.find((b) => b.key === '4')).toMatchObject({ box: '4', label: 'Federal income tax withheld' });
  });

  it('keys the winner TIN by its printed box 9', () => {
    expect(W2G.boxes.find((b) => b.key === '9')).toMatchObject({ box: '9', label: "WINNER'S TIN" });
  });

  it('maps boxes to add_w2g arguments and nothing else', () => {
    const mapped = mapBoxesToTool(W2G, {
      'payer.name': 'RIVERBEND CASINO\n4100 CANAL ST\nNEW ORLEANS LA 70119',
      '1': '24,600.00',
      '3': 'Poker tournament',
      '4': '4,920.00',
      '13': 'LA/98765',
      '15': '1,230.00',
      '7': '600.00',
    });
    expect(mapped.tool).toBe('add_w2g');
    const structured = extractStructuredFields('w2g', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({
      payerName: 'RIVERBEND CASINO',
      grossWinnings: 24600,
      typeOfWager: 'Poker tournament',
      federalTaxWithheld: 4920,
      // Only the two-letter code; the payer's state ID in the same cell is not
      // passed as an argument.
      stateCode: 'LA',
      stateTaxWithheld: 1230,
    });
  });

  it('routes winnings from identical wagers to review, since no argument takes them', () => {
    const mapped = mapBoxesToTool(W2G, { '1': '1,000.00', '7': '250.00', '16': '100.00' });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['7', '16']);
    expect(mapped.bag).not.toHaveProperty('identicalWagers');
  });

  it('leaves a blank box out of the arguments entirely', () => {
    const mapped = mapBoxesToTool(W2G, { '1': '500.00', '4': '' });
    const structured = extractStructuredFields('w2g', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({ grossWinnings: 500 });
    expect(Object.values(structured.args)).not.toContain(0);
  });
});
describe('Form 1098-E (Rev. 2026)', () => {
  const SLI = getFormExtractionSchema('1098-E')!;

  it('reads only the two boxes the form prints', () => {
    expect(SLI.boxes.filter((b) => /^\d+$/.test(b.box)).map((b) => b.box)).toEqual(['1', '2']);
  });

  it('names box 1 as the form prints it, "Student loan interest received by lender"', () => {
    expect(SLI.boxes.find((b) => b.key === '1')).toMatchObject({
      box: '1',
      label: 'Student loan interest received by lender',
      kind: 'money',
      use: 'tool',
    });
  });

  it('maps box 1 to the tool and box 2 to a boolean', () => {
    const mapped = mapBoxesToTool(SLI, {
      'lender.block': 'MOUNT HOREAN NATIONAL BANK\nPO BOX 88\nCONCORD NH 03301',
      '1': '1,842.55',
      '2': 'X',
    });
    expect(mapped.tool).toBe('add_1098_e');
    const structured = extractStructuredFields('1098e', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({
      lenderName: 'MOUNT HOREAN NATIONAL BANK',
      studentLoanInterest: 1842.55,
      originationFeesExcluded: true,
    });
  });

  it('reads an unchecked box 2 as false, not as absent', () => {
    const mapped = mapBoxesToTool(SLI, { '1': '500.00', '2': 'no' });
    const structured = extractStructuredFields('1098e', mapped.bag, mapped.rawText);
    expect(structured.args).toEqual({ studentLoanInterest: 500, originationFeesExcluded: false });
  });

  it('sends an unreadable box 2 to review rather than guessing it was unchecked', () => {
    const mapped = mapBoxesToTool(SLI, { '1': '500.00', '2': 'maybe' });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['2']);
    expect(mapped.bag).not.toHaveProperty('originationFeesExcluded');
  });
});
describe('Schedule K-1 (Form 1065, 2025)', () => {
  const K1 = getFormExtractionSchema('K-1')!;
  const printed: Record<string, string> = {
    a: '72-1234567',
    b: 'RIVERBEND PARTNERS LP\n4100 CANAL ST\nNEW ORLEANS LA 70119',
    '1': '48,200.00',
    '2': '6,400.00',
    '4c': '1,500.00',
    '5': '212.00',
    '6a': '900.00',
    '6b': '450.00',
    '7': '1,100.00',
    '8': '(2,300.00)',
    '9a': '15,750.00',
    '10': '(4,100.00)',
    '11': '320.00',
    '12': '9,000.00',
    '13': '4,200.00',
    '14': '48,200.00',
    '15': '310.00',
  };

  it('reads the printed form number as the entity kind', () => {
    const partnership = mapBoxesToTool(K1, { a: '72-1234567', b: 'RIVERBEND PARTNERS LP' }, { matchedMarkers: ['schedule k-1', 'form 1065'] });
    expect(extractStructuredFields('k1', partnership.bag, partnership.rawText).args.entityType).toBe('partnership');
    const scorp = mapBoxesToTool(K1, { a: '72-1234567', b: 'RIVERBEND INC' }, { matchedMarkers: ['schedule k-1', 'form 1120-s'] });
    expect(extractStructuredFields('k1', scorp.bag, scorp.rawText).args.entityType).toBe('s_corp');
  });

  it('leaves the entity kind unset for a Form 1041, which is an estate or a trust', () => {
    // The page does not say which, and the engine codes anything that is not a
    // partnership as an S corporation on Schedule E - so guessing would file a
    // trust's income as a corporation's. Unset holds the form (FED.K1.ENTITY_TYPE).
    const mapped = mapBoxesToTool(K1, { a: '72-1234567', b: 'THE ESTATE' }, { matchedMarkers: ['schedule k-1', 'form 1041'] });
    const args = extractStructuredFields('k1', mapped.bag, mapped.rawText).args;
    expect(args).not.toHaveProperty('entityType');
  });

  it('leaves the entity kind unset when the page says nothing about the form', () => {
    const mapped = mapBoxesToTool(K1, { a: '72-1234567', b: 'RIVERBEND PARTNERS LP' });
    expect(extractStructuredFields('k1', mapped.bag, mapped.rawText).args).not.toHaveProperty('entityType');
  });

  it('never guesses partnership when the form number was not read', () => {
    const mapped = mapBoxesToTool(K1, { a: '72-1234567', b: 'RIVERBEND PARTNERS LP', '1': '48,200.00' });
    const args = extractStructuredFields('k1', mapped.bag, mapped.rawText).args;
    expect(args).not.toHaveProperty('entityType');
    // The rest of the form is still read; only the kind is withheld.
    expect(args).toMatchObject({ ordinaryBusinessIncome: 48200 });
  });

  it('places the boxes that stand on their own', () => {
    const mapped = mapBoxesToTool(K1, printed, { matchedMarkers: ['schedule k-1', 'form 1065'] });
    const args = extractStructuredFields('k1', mapped.bag, mapped.rawText).args;
    expect(args).toEqual({
      entityEin: '72-1234567',
      entityName: 'RIVERBEND PARTNERS LP',
      entityType: 'partnership',
      ordinaryBusinessIncome: 48200,
      rentalIncome: 6400,
      guaranteedPayments: 1500,
      interestIncome: 212,
      ordinaryDividends: 900,
      qualifiedDividends: 450,
      royalties: 1100,
      shortTermCapitalGain: -2300,
      longTermCapitalGain: 15750,
      netSection1231Gain: -4100,
      otherIncome: 320,
      section179Deduction: 9000,
      selfEmploymentIncome: 48200,
    });
  });

  it('sends boxes 13 and 15 to review rather than splitting them by guesswork', () => {
    // One undivided number each; what they comprise is carried by codes printed
    // elsewhere, so no box13*/box15* field may be filled from the total.
    const mapped = mapBoxesToTool(K1, printed, { matchedMarkers: ['form 1065'] });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(expect.arrayContaining(['13', '15']));
    const args = extractStructuredFields('k1', mapped.bag, mapped.rawText).args;
    for (const key of Object.keys(args)) {
      expect(key).not.toMatch(/box13|box15|box131231|box15Other/);
    }
  });

  it('sends the rate- and entity-dependent boxes to review, keeping their value', () => {
    const mapped = mapBoxesToTool(K1, { ...printed, '9b': '1,000.00', '9c': '2,500.00' }, { matchedMarkers: ['form 1065'] });
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(expect.arrayContaining(['9b', '9c']));
    // The value is kept: extractK1Fields() already reads these, and dropping them
    // would leave a 28% or 25% gain unapplied with nothing flagging it.
    expect(mapped.bag).toMatchObject({ collectiblesGain28: '1,000.00', unrecapturedSection1250Gain: '2,500.00' });
  });

  it('names box 14 as the self-employment figure the form prints', () => {
    expect(K1.boxes.find((b) => b.key === '14')).toMatchObject({ box: '14', label: 'Self-employment earnings (loss)', use: 'tool' });
  });

  it('reads the partner out of box E, where the form prints their SSN or TIN', () => {
    expect(K1.boxes.find((b) => b.key === 'e')).toMatchObject({ box: 'e', kind: 'tin' });
    expect(IDENTITY_KEYS['K-1']).toEqual({ tin: 'e', name: 'f', address: [] });
  });
});
describe('Form 1095-A (2025)', () => {
  const PTC = getFormExtractionSchema('1095-A')!;

  it('reads Part I, the five covered individuals and the twelve months', () => {
    // Part I prints lines 1-15 unnumbered by column. Part II's five rows carry
    // an A-E column (25 boxes), each of the twelve months carries A-C (36), and
    // line 33 carries the annual totals A-C (3). The month name is a row label,
    // so it is not counted as a printed box.
    expect(PTC.boxes.filter((b) => /^\d+$/.test(b.box)).map((b) => b.box)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15',
    ]);
    expect(PTC.boxes.filter((b) => /^\d+[a-e]$/.test(b.box))).toHaveLength(5 * 5 + 12 * 3 + 3);
    expect(PTC.boxes.filter((b) => /^\d+\.month$/.test(b.key))).toHaveLength(12);
  });

  it('names Part II columns as the form prints them', () => {
    expect(PTC.boxes.find((b) => b.key === '16.a')).toMatchObject({ box: '16a', label: 'Covered individual name (line 16)' });
    expect(PTC.boxes.find((b) => b.key === '16.b')).toMatchObject({ box: '16b', kind: 'tin' });
    expect(PTC.boxes.find((b) => b.key === '16.d')).toMatchObject({ box: '16d', label: 'Coverage start date (line 16)' });
  });

  it('names line 33 as the annual totals the form prints', () => {
    expect(PTC.boxes.find((b) => b.key === '33.a')).toMatchObject({ box: '33a', kind: 'money', use: 'tool' });
    expect(PTC.boxes.find((b) => b.key === '33.c')).toMatchObject({ box: '33c', use: 'review' });
  });

  it('records the statement without writing the premium tax credit', () => {
    const mapped = mapBoxesToTool(PTC, {
      '1': '31-1234567',
      '2': 'P-987654321',
      '3': 'RIVERBEND MARKETPLACE',
      '4': 'ALEX RIVERBEND',
      '5': '000-12-3456',
      '33.a': '14,400.00',
      '33.b': '11,220.00',
      '33.c': '2,880.00',
    });
    expect(mapped.tool).toBe('add_1095_a');
    expect(mapped.bag).toEqual({
      marketplaceIdentifier: '31-1234567',
      policyNumber: 'P-987654321',
      policyIssuerName: 'RIVERBEND MARKETPLACE',
      recipientName: 'ALEX RIVERBEND',
      recipientSsn: '000-12-3456',
      annualEnrollmentPremiums: '14,400.00',
      annualSLCSPPremium: '11,220.00',
    });
    // The annual advance payment is review: it is a credit decision, not a reading.
    expect(mapped.reviewBoxes.map((b) => b.key)).toEqual(['33.c']);
    expect(mapped.bag).not.toHaveProperty('annualAdvancePayment');
  });

  it('records the statement as a fact and never as a return amount', () => {
    const result = invokeTaxTool({
      tool: 'add_1095_a',
      args: { recipientName: 'ALEX RIVERBEND', annualEnrollmentPremiums: 14400 },
      context: { ...ctx, sourceFileName: 'f1095a.pdf' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.application).toEqual({ kind: 'candidate_fact' });
    expect(result.incomeType).toBeUndefined();
    expect(result.facts.some((f) => f.factType === '1095A_recipientName')).toBe(true);
  });
});