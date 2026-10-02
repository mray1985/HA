/**
 * Form 8615 (2025) line by line on the child's return. Every expected figure
 * is worked by hand from the form's instructions, the Line 5 Worksheets and
 * the Qualified Dividends and Capital Gain Tax Worksheet; Tax Table amounts
 * are the IRS's own (fixtures/irs-tax-table-2025.json).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { calculateForm8615, figureForm8615 } from '../src/engine/form8615.js';
import { FORM_8615_FIELDS, FORM_8615_TEMPLATE } from '../src/constants/irsForm8615Map.js';
import { FilingStatus, type CalculationResult, type Form8615Info, type Form8615Result, type TaxReturn } from '../src/types/index.js';
import { taxTable2025 } from './irsTaxTable2025.js';

function childReturn(extra: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'child', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Ava', lastName: 'Lee', ssn: '123456789',
    dateOfBirth: '2010-05-01', canBeClaimedAsDependent: true, dependents: [],
    w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [],
    deductionMethod: 'standard', expenses: [], educationCredits: [], incomeDiscovery: {},
    createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...extra,
  } as TaxReturn;
}

const interest = (amount: number) => [{ id: 'i', payerName: 'Bank', amount }];

/** The parent's figures, all entered: married filing jointly, $80,000 taxable income. */
const PARENT: Form8615Info = {
  applies: true,
  parentName: 'Sam Lee', parentSsn: '987654321', parentFilingStatus: FilingStatus.MarriedFilingJointly,
  parentTaxableIncome: 80_000, parentTax: 9_126,
  parentQualifiedDividends: 0, parentNetCapitalGain: 0, otherChildrenNetUnearnedIncome: 0, parentSpecialComputation: false,
};

function figured(result: CalculationResult): Form8615Result {
  expect(result.form8615?.status).toBe('figured');
  return (result.form8615 as { result: Form8615Result }).result;
}

function pdf(tr: TaxReturn, calc: CalculationResult): Record<string, string | boolean | undefined> {
  return Object.fromEntries(FORM_8615_FIELDS.map((f) => [f.pdfFieldName.replace('topmostSubform[0].Page1[0].', ''), f.transform!(tr, calc)]));
}

describe('Form 8615 (2025)', () => {
  it('taxes interest above $2,700 at the parent\'s rate (no earned income)', () => {
    // Child, 15, $10,000 interest: AGI 10,000, dependent standard deduction 1,350, taxable 8,650.
    const tr = childReturn({ income1099INT: interest(10_000), form8615: PARENT });
    const result = calculateForm1040(tr);
    const f = figured(result);
    // The parent's line 10 is the Tax Table on $80,000 jointly.
    expect(taxTable2025(80_000, 'MFJ')).toBe(9_126);
    expect(f).toMatchObject({
      applies: true,
      line1: 10_000, line2: 2_700, line3: 7_300, line4: 8_650, line5: 7_300,
      line6: 80_000, line7: 0, line8: 87_300,
      line9: 10_002, line10: 9_126, line11: 876, line13: 876,
      line14: 1_350, line15: 136, line16: 1_012, line17: 868, line18: 1_012,
    });
    expect([f.line9, f.line15, f.line17]).toEqual([taxTable2025(87_300, 'MFJ'), taxTable2025(1_350, 'Single'), taxTable2025(8_650, 'Single')]);
    expect(f.line12a).toBeUndefined();
    // Line 18 is the child's Form 1040 line 16, and nothing is added on top of it.
    expect(result.form1040.taxableIncome).toBe(8_650);
    expect(result.form1040.incomeTax).toBe(1_012);
    expect(result.form1040.kiddieTaxAmount).toBe(0);
    expect(result.unsupported ?? []).toEqual([]);

    const fields = pdf(tr, result);
    expect(fields).toMatchObject({
      'f1_1[0]': 'Ava Lee', 'f1_2[0]': '123456789', 'f1_3[0]': 'Sam Lee', 'f1_4[0]': '987654321',
      'c1_1[0]': false, 'c1_1[1]': true,
      'f1_5[0]': '10000', 'f1_6[0]': '2700', 'f1_7[0]': '7300', 'f1_8[0]': '8650', 'f1_9[0]': '7300',
      'f1_10[0]': '80000', 'f1_11[0]': undefined, 'f1_12[0]': '87300', 'f1_13[0]': '10002', 'f1_14[0]': '9126', 'f1_15[0]': '876',
      'f1_16[0]': undefined, 'f1_17[0]': undefined, 'f1_18[0]': '876',
      'f1_19[0]': '1350', 'f1_20[0]': '136', 'f1_21[0]': '1012', 'f1_22[0]': '868', 'f1_23[0]': '1012',
      'Line9_ReadOrder[0].c1_2[0]': false, 'Line15_ReadOrder[0].c1_4[0]': false, 'Line17_ReadOrder[0].c1_5[0]': false,
    });
    expect(FORM_8615_TEMPLATE.condition(tr, result)).toBe(true);
  });

  it('splits line 8 by line 12b when other children use the same parent (line 7)', () => {
    const tr = childReturn({ income1099INT: interest(10_000), form8615: { ...PARENT, otherChildrenNetUnearnedIncome: 3_000, otherChildrenQualifiedDividends: 0, otherChildrenNetCapitalGain: 0 } });
    const result = calculateForm1040(tr);
    const f = figured(result);
    // Line 8 = 7,300 + 80,000 + 3,000 = 90,300; line 9 by the Tax Table, MFJ.
    expect(taxTable2025(90_300, 'MFJ')).toBe(10_362);
    // 12a = 10,300; 12b = 7,300 / 10,300 = 0.709; line 13 = 1,236 × 0.709 = 876.32.
    expect(f).toMatchObject({ line7: 3_000, line8: 90_300, line9: 10_362, line11: 1_236, line12a: 10_300, line12b: 0.709, line13: 876.32, line16: 1_012.32, line18: 1_012.32 });
    expect(result.form1040.incomeTax).toBe(1_012.32);
    expect(pdf(tr, result)).toMatchObject({ 'f1_11[0]': '3000', 'f1_16[0]': '10300', 'f1_17[0]': '709', 'f1_18[0]': '876' });
  });

  it('splits qualified dividends and net capital gain by Line 5 Worksheet #1', () => {
    // Child, 15: wages 2,000; dividends 6,000 (4,000 qualified) and 2,000 capital gain distributions.
    // Total income 10,000; standard deduction 2,000 + 450 = 2,450; taxable 7,550.
    // Line 1 = 10,000 − 2,000 earned = 8,000; line 3 = 5,300 = line 5.
    // Worksheet #1: 4,000/8,000 = 0.5, 2,000/8,000 = 0.25; QD on line 5 = 4,000 − 1,350 = 2,650; NCG = 2,000 − 675 = 1,325.
    const tr = childReturn({
      w2Income: [{ id: 'w', employerName: 'Store', wages: 2_000, federalTaxWithheld: 0, socialSecurityWages: 2_000, socialSecurityTax: 124, medicareWages: 2_000, medicareTax: 29 }],
      income1099DIV: [{ id: 'd', payerName: 'Fund', ordinaryDividends: 6_000, qualifiedDividends: 4_000, capitalGainDistributions: 2_000 }],
      form8615: { ...PARENT, parentFilingStatus: FilingStatus.Single, parentTaxableIncome: 60_000, parentTax: 8_050, parentQualifiedDividends: 1_000 },
    });
    const result = calculateForm1040(tr);
    const f = figured(result);
    expect(f.line5Worksheet).toBe(1);
    expect(f.included.line5).toEqual({ qd: 2_650, ncg: 1_325 });
    expect(f.included.line8).toEqual({ qd: 3_650, ncg: 1_325 });
    expect(f.included.line14).toEqual({ qd: 1_350, ncg: 675 });
    // Line 9, QDCG worksheet (Single): 65,300 with 4,975 preferential, all above the 0% band:
    // Tax Table on 60,325 (8,186) + 15% × 4,975 (746.25) = 8,932.25, less than the Tax Table on 65,300 (9,286).
    expect(taxTable2025(60_325, 'Single')).toBe(8_186);
    expect(taxTable2025(65_300, 'Single')).toBe(9_286);
    // Line 15: 2,250 with 2,025 preferential at 0%: the Tax Table on 225 = 24.
    // Line 17: 7,550 with 6,000 preferential at 0%: the Tax Table on 1,550 = 156.
    expect([taxTable2025(225, 'Single'), taxTable2025(1_550, 'Single')]).toEqual([24, 156]);
    expect(f).toMatchObject({
      line1: 8_000, line2: 2_700, line3: 5_300, line4: 7_550, line5: 5_300,
      line6: 60_000, line8: 65_300, line9: 8_932.25, line10: 8_050, line11: 882.25, line13: 882.25,
      line14: 2_250, line15: 24, line16: 906.25, line17: 156, line18: 906.25,
      worksheet: { line9: true, line15: true, line17: true },
    });
    expect(result.form1040.incomeTax).toBe(906.25);
    expect(pdf(tr, result)).toMatchObject({
      'c1_1[0]': true, 'Line9_ReadOrder[0].c1_2[0]': true, 'Line10_ReadOrder[0].c1_3[0]': true,
      'Line15_ReadOrder[0].c1_4[0]': true, 'Line17_ReadOrder[0].c1_5[0]': true, 'f1_13[0]': '8932', 'f1_23[0]': '906',
    });
  });

  it('splits qualified dividends by Line 5 Worksheet #3 when line 5 is less than line 3', () => {
    // Child, 17, not claimed as a dependent: interest 20,000 and qualified dividends 10,000.
    // AGI 30,000; standard deduction 15,750; taxable 14,250. Line 3 = 27,300 > line 4 → line 5 = 14,250.
    // Worksheet #3: line 14 = 10,000 / 30,000 = 0.333; line 15 = 15,750 × 0.333 = 5,244.75 (all to dividends);
    // QD on line 5 = 10,000 − 5,244.75 = 4,755.25.
    const tr = childReturn({
      dateOfBirth: '2008-03-01', canBeClaimedAsDependent: false,
      income1099INT: interest(20_000),
      income1099DIV: [{ id: 'd', payerName: 'Fund', ordinaryDividends: 10_000, qualifiedDividends: 10_000 }],
      form8615: { ...PARENT, parentFilingStatus: FilingStatus.HeadOfHousehold, parentTaxableIncome: 40_000, parentTax: 4_463 },
    });
    const result = calculateForm1040(tr);
    const f = figured(result);
    expect(taxTable2025(40_000, 'HOH')).toBe(4_463);
    expect(f.line5Worksheet).toBe(3);
    expect(f.included.line5).toEqual({ qd: 4_755.25, ncg: 0 });
    // Line 9, QDCG (head of household): 54,250 is inside the 0% band, so the Tax Table on 49,494.75 = 5,597.
    // Line 17, QDCG (single): 14,250 with 10,000 at 0%, the Tax Table on 4,250 (the 4,250–4,300 row) = 428.
    expect([taxTable2025(49_494.75, 'HOH'), taxTable2025(4_250, 'Single')]).toEqual([5_597, 428]);
    expect(f).toMatchObject({
      line1: 30_000, line3: 27_300, line4: 14_250, line5: 14_250,
      line8: 54_250, line9: 5_597, line10: 4_463, line11: 1_134, line13: 1_134,
      line14: 0, line15: 0, line16: 1_134, line17: 428, line18: 1_134,
    });
    expect(result.form1040.incomeTax).toBe(1_134);
    // "If lines 4 and 5 above are the same, enter -0- on line 15."
    expect(pdf(tr, result)).toMatchObject({ 'f1_19[0]': undefined, 'f1_20[0]': '0', 'c1_1[3]': true });
  });

  it('stops at line 3 and keeps the child\'s own tax', () => {
    const tr = childReturn({ income1099INT: interest(2_600), form8615: PARENT });
    const result = calculateForm1040(tr);
    const f = figured(result);
    expect(f).toMatchObject({ applies: false, line1: 2_600, line2: 2_700, line3: -100 });
    // Taxable 1,250: the Tax Table.
    expect(result.form1040.incomeTax).toBe(taxTable2025(1_250, 'Single'));
    const fields = pdf(tr, result);
    expect(fields).toMatchObject({ 'f1_5[0]': '2600', 'f1_6[0]': '2700', 'f1_7[0]': '-100', 'f1_8[0]': undefined, 'f1_23[0]': undefined });
    expect(FORM_8615_TEMPLATE.condition(tr, result)).toBe(true);
  });

  it('asks whether it applies when a young taxpayer\'s unearned income is over $2,700', () => {
    const ask = calculateForm1040(childReturn({ income1099INT: interest(10_000) }));
    expect(ask.form8615).toEqual({ status: 'ask', unearnedIncome: 10_000, age: 15 });
    expect(ask.form1040.incomeTax).toBe(taxTable2025(8_650, 'Single'));
    expect(ask.unsupported?.map((u) => `${u.ruleId}:${u.itemId}`)).toEqual(['FED.8615.APPLIES:applies']);
    expect(FORM_8615_TEMPLATE.condition(childReturn(), ask)).toBe(false);

    // Not when the preparer says it does not apply, the taxpayer is 24 or older, or files jointly.
    expect(calculateForm1040(childReturn({ income1099INT: interest(10_000), form8615: { applies: false } })).form8615).toBeUndefined();
    expect(calculateForm1040(childReturn({ income1099INT: interest(10_000), dateOfBirth: '2001-06-01' })).form8615).toBeUndefined();
    expect(calculateForm1040(childReturn({ income1099INT: interest(10_000), filingStatus: FilingStatus.MarriedFilingJointly })).form8615).toBeUndefined();
    expect(calculateForm1040(childReturn({ income1099INT: interest(2_700) })).form8615).toBeUndefined();
    // No taxable income is no exception: the form stops at line 5 but is still attached.
    const zero = {
      taxYear: 2025, childFilingStatus: FilingStatus.Single, totalIncome: 20_000, agi: 20_000, taxableIncome: 0,
      deduction: 25_000, itemizes: true, wages: 0, businessIncome: 0, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false, age: 17,
    };
    expect(figureForm8615(zero)).toEqual({ status: 'ask', unearnedIncome: 20_000, age: 17 });
    const stopped = figureForm8615({ ...zero, info: { ...PARENT, childDirectlyConnectedDeductions: 0 } });
    expect(stopped).toMatchObject({ status: 'figured', result: { applies: false, line3: 17_300, line4: 0, line5: 0 } });
    // With no date of birth, a taxpayer someone can claim as a dependent is asked about.
    expect(calculateForm1040(childReturn({ income1099INT: interest(10_000), dateOfBirth: undefined })).form8615).toEqual({ status: 'ask', unearnedIncome: 10_000 });
  });

  it('asks for each of the parent\'s figures before figuring anything', () => {
    const result = calculateForm1040(childReturn({ income1099INT: interest(10_000), form8615: { applies: true } }));
    expect(result.form8615).toEqual({
      status: 'missing',
      missing: ['parentName', 'parentSsn', 'parentFilingStatus', 'parentTaxableIncome', 'parentTax', 'parentQualifiedDividends', 'parentNetCapitalGain', 'otherChildrenNetUnearnedIncome', 'parentSpecialComputation'],
    });
    expect(result.form1040.incomeTax).toBe(taxTable2025(8_650, 'Single'));
    expect(result.unsupported?.filter((u) => u.ruleId === 'FED.8615.PARENT')).toHaveLength(9);

    // Line 7's dividends and gain, and the child's directly connected deductions when itemizing, are asked for too.
    const more = figureForm8615({
      info: { ...PARENT, otherChildrenNetUnearnedIncome: 1_000, otherChildrenQualifiedDividends: undefined },
      taxYear: 2025, childFilingStatus: FilingStatus.Single, totalIncome: 10_000, agi: 10_000, taxableIncome: 8_650,
      deduction: 1_350, itemizes: true, wages: 0, businessIncome: 0, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false,
    });
    expect(more).toEqual({ status: 'missing', missing: ['otherChildrenQualifiedDividends', 'otherChildrenNetCapitalGain', 'childDirectlyConnectedDeductions'] });
  });

  it('holds what it does not figure, and keeps the child\'s own tax', () => {
    const worksheet = calculateForm1040(childReturn({ income1099INT: interest(10_000), form8615: { ...PARENT, parentSpecialComputation: true } }));
    expect(figured(worksheet).applies).toBe(false);
    expect(worksheet.form1040.incomeTax).toBe(taxTable2025(8_650, 'Single'));
    expect(worksheet.unsupported?.map((u) => u.ruleId)).toEqual(['FED.8615.PARENT_WORKSHEET']);

    const base = {
      info: PARENT, taxYear: 2025, childFilingStatus: FilingStatus.Single, totalIncome: 10_000, agi: 10_000, taxableIncome: 8_650,
      deduction: 1_350, itemizes: false, wages: 0, businessIncome: 0, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false,
    };
    expect(calculateForm8615({ ...base, has28RateOr1250Gain: true, netCapitalGain: 1_000 }).unsupported.map((u) => u.ruleId)).toEqual(['FED.8615.SCHEDULE_D_WORKSHEET']);
    expect(calculateForm8615({ ...base, filesForm2555: true }).unsupported.map((u) => u.ruleId)).toEqual(['FED.8615.FORM2555']);
    expect(calculateForm8615({ ...base, childFilingStatus: FilingStatus.MarriedFilingJointly }).unsupported.map((u) => u.ruleId)).toEqual(['FED.8615.JOINT_RETURN']);
    // Line 2 above $2,700 with dividends: the part directly connected with them is not known.
    const itemized = calculateForm8615({ ...base, itemizes: true, deduction: 4_000, taxableIncome: 6_000, qualifiedDividends: 3_000, info: { ...PARENT, childDirectlyConnectedDeductions: 2_000 } });
    expect(itemized.line2).toBe(3_350);
    expect(itemized.unsupported.map((u) => u.ruleId)).toEqual(['FED.8615.DIRECTLY_CONNECTED']);
    // Without dividends or gain, line 2 above $2,700 needs no worksheet.
    const plain = calculateForm8615({ ...base, itemizes: true, deduction: 4_000, taxableIncome: 6_000, info: { ...PARENT, childDirectlyConnectedDeductions: 2_000 } });
    expect(plain).toMatchObject({ applies: true, line2: 3_350, line3: 6_650, line5: 6_000, unsupported: [] });
  });

  it("uses each year's amounts: $2,600 for 2024 (Form 8615 (2024) line 2), $2,700 for 2025", () => {
    // 2024: $10,000 of interest, the dependent standard deduction $1,300, taxable $8,700.
    const r2024 = calculateForm8615({
      info: PARENT, taxYear: 2024, childFilingStatus: FilingStatus.Single, totalIncome: 10_000, agi: 10_000, taxableIncome: 8_700,
      deduction: 1_300, itemizes: false, wages: 0, businessIncome: 0, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false,
    });
    expect(r2024).toMatchObject({ line1: 10_000, line2: 2_600, line3: 7_400, line4: 8_700, line5: 7_400 });
    // $2,650 of unearned income is over 2024's amount, not 2025's.
    const small = {
      taxYear: 2024, childFilingStatus: FilingStatus.Single, totalIncome: 2_650, agi: 2_650, taxableIncome: 1_350,
      deduction: 1_300, itemizes: false, wages: 0, businessIncome: 0, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false, age: 14,
    };
    expect(figureForm8615(small)).toMatchObject({ status: 'ask', unearnedIncome: 2_650 });
    expect(figureForm8615({ ...small, taxYear: 2025 })).toBeUndefined();
  });

  it('uses the Alternate Worksheet for line 1 with a net loss from self-employment', () => {
    // Line 9 total income 9,000 (interest 10,000, Schedule C loss 1,000): A + B = 10,000; earned income 0.
    const r = calculateForm8615({
      info: PARENT, taxYear: 2025, childFilingStatus: FilingStatus.Single, totalIncome: 9_000, agi: 9_000, taxableIncome: 7_650,
      deduction: 1_350, itemizes: false, wages: 0, businessIncome: -1_000, farmIncome: 0, earlyWithdrawalPenalty: 0, nolDeduction: 0,
      qualifiedDividends: 0, netCapitalGain: 0, has28RateOr1250Gain: false, filesForm2555: false,
    });
    expect(r.line1).toBe(10_000);
    expect(r.line5).toBe(7_300);
  });

  it('does not add a kiddie tax estimate for a child listed on the parent\'s return (Form 8814)', () => {
    const result = calculateForm1040(childReturn({
      dateOfBirth: '1980-01-01', canBeClaimedAsDependent: false,
      w2Income: [{ id: 'w', employerName: 'Employer', wages: 90_000, federalTaxWithheld: 0, socialSecurityWages: 90_000, socialSecurityTax: 0, medicareWages: 90_000, medicareTax: 0 }],
      kiddieTaxEntries: [{ id: 'k', childName: 'Ava', childUnearnedIncome: 8_000, childAge: 14, parentMarginalRate: 0.24 }],
    }));
    expect(result.form1040.kiddieTaxAmount).toBe(0);
    expect(result.form1040.incomeTax).toBe(calculateForm1040(childReturn({
      dateOfBirth: '1980-01-01', canBeClaimedAsDependent: false,
      w2Income: [{ id: 'w', employerName: 'Employer', wages: 90_000, federalTaxWithheld: 0, socialSecurityWages: 90_000, socialSecurityTax: 0, medicareWages: 90_000, medicareTax: 0 }],
    })).form1040.incomeTax);
    expect(result.unsupported?.map((u) => u.ruleId)).toEqual(['FED.8814']);
  });
});
