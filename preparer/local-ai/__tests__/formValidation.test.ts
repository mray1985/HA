import { describe, expect, it } from 'vitest';
import { formKeyOf, validateImportedFacts } from '../src/factValidation.js';
import { invokeTaxTool, type DocumentToolName } from '../src/taxTools.js';
import type { TaxFact } from '../src/taxFact.js';

function facts(tool: DocumentToolName, args: Record<string, unknown>, documentId = 'DOC-1', formIndex?: number): TaxFact[] {
  const r = invokeTaxTool({
    tool,
    args,
    context: { returnId: 'R1', taxYear: 2026, sourceDocumentId: documentId, sourceFileName: `${documentId}.pdf`, extractor: 'test' },
  });
  if (!r.ok) throw new Error(r.error);
  return formIndex ? r.facts.map((f) => ({ ...f, sourceFormIndex: formIndex })) : r.facts;
}

const codes = (fs: TaxFact[]) => validateImportedFacts(fs, { taxYear: 2026 }).issues.map((i) => i.code);

describe('required amounts hold the whole form (UNKNOWN != ZERO at the return)', () => {
  it('holds a W-2 whose wages are unreadable', () => {
    const v = validateImportedFacts(facts('add_w2', { employerName: 'ACME', wages: undefined, federalTaxWithheld: 100 }));
    expect(v.heldForms).toEqual(['DOC-1#0']);
    expect(v.issues.find((i) => i.code === 'REQUIRED_AMOUNT_UNKNOWN')).toMatchObject({ sourceField: 'wages', holdsForm: true, observed: 'unknown' });
  });

  it('holds a W-2 whose withholding box was never read', () => {
    const v = validateImportedFacts(facts('add_w2', { employerName: 'ACME', wages: 52431.18 }));
    expect(v.heldForms).toEqual(['DOC-1#0']);
    expect(v.issues[0]!.message).toMatch(/federalTaxWithheld is not on the form/);
  });

  it('does not hold a complete form, and keeps a printed zero as known', () => {
    const v = validateImportedFacts(facts('add_1099_int', { payerName: 'BANK', amount: 42.17, federalTaxWithheld: 0 }));
    expect(v.heldForms).toEqual([]);
    expect(v.ready).toBe(true);
  });
});

describe('impossible relationships hold the form', () => {
  it('1099-DIV qualified above ordinary', () => {
    expect(codes(facts('add_1099_div', { payerName: 'FUND', ordinaryDividends: 100, qualifiedDividends: 180 }))).toContain('DIV_QUALIFIED_EXCEEDS_ORDINARY');
  });

  it('1099-R taxable or withholding above gross, and invalid distribution codes', () => {
    const c = codes(facts('add_1099_r', { payerName: 'TRUST', grossDistribution: 1000, taxableAmount: 1500, federalTaxWithheld: 1200, distributionCode: 'Z9' }));
    expect(c).toEqual(expect.arrayContaining(['R_TAXABLE_EXCEEDS_GROSS', 'R_WITHHOLDING_EXCEEDS_GROSS', 'R_INVALID_DISTRIBUTION_CODE']));
    expect(codes(facts('add_1099_r', { payerName: 'TRUST', grossDistribution: 1000, taxableAmount: 1000, distributionCode: '7' }))).toEqual([]);
    expect(codes(facts('add_1099_r', { payerName: 'TRUST', grossDistribution: 1000, taxableAmount: 1000, distributionCode: 'G4' }))).toEqual([]);
  });

  it('SSA-1099 net benefits must equal paid minus repaid', () => {
    expect(codes(facts('add_ssa_1099', { benefitsPaid: 1200, benefitsRepaid: 1450, netBenefits: -250 }))).toEqual([]);
    expect(codes(facts('add_ssa_1099', { benefitsPaid: 21600, benefitsRepaid: 0, netBenefits: 26100 }))).toContain('SSA_NET_MISMATCH');
  });
});

describe('warnings that do not hold the form', () => {
  it('W-2 withholding above wages (§34 outlier)', () => {
    const v = validateImportedFacts(facts('add_w2', { wages: 1000, federalTaxWithheld: 1500 }));
    expect(v.issues.map((i) => i.code)).toContain('WITHHOLDING_EXCEEDS_WAGES');
    expect(v.heldForms).toEqual([]);
  });

  it('1098 refund of overpaid interest, and pre-TCJA debt above $750,000', () => {
    const v = validateImportedFacts(facts('add_mortgage_interest', {
      lenderName: 'LENDER', mortgageInterest: 30000, refundOfOverpaidInterest: 120, outstandingPrincipal: 900000, originationDate: '06/01/2016',
    }));
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['MORTGAGE_REFUND_REVIEW', 'MORTGAGE_GRANDFATHERED_DEBT']));
    expect(v.heldForms).toEqual([]);
    const recent = validateImportedFacts(facts('add_mortgage_interest', { mortgageInterest: 30000, outstandingPrincipal: 900000, originationDate: '2021-03-14' }));
    expect(recent.issues.map((i) => i.code)).not.toContain('MORTGAGE_GRANDFATHERED_DEBT');
  });
});

describe('duplicate forms across files', () => {
  it('holds the second copy of the same W-2 (PDF and photo)', () => {
    const w2 = { employerEin: '72-1234567', wages: 52431.18, federalTaxWithheld: 5873.4 };
    const v = validateImportedFacts([...facts('add_w2', w2, 'DOC-pdf'), ...facts('add_w2', w2, 'DOC-photo')]);
    expect(v.heldForms).toEqual(['DOC-photo#0']);
    expect(v.issues.find((i) => i.code === 'DUPLICATE_FORM')!.message).toMatch(/matches DOC-pdf#0/);
  });

  it('keeps the clean copy when the first copy is held for a misreading (a photo, then the PDF)', () => {
    const w2 = { employerEin: '72-1234567', wages: 68250, federalTaxWithheld: 7120, medicareTax: 1029.5 };
    const photo = facts('add_w2', w2, 'DOC-photo').map((f) => (f.sourceField === 'medicareTax'
      ? { ...f, secondReading: { source: 'model' as const, reader: 'GLM-OCR', text: '2,750.00', agrees: false } }
      : f));
    const v = validateImportedFacts([...photo, ...facts('add_w2', w2, 'DOC-pdf')]);
    // The PDF goes on the return; the photo stays held, now also as a copy of it.
    expect(v.heldForms).toEqual(['DOC-photo#0']);
    expect(v.issues.find((i) => i.code === 'DUPLICATE_FORM')).toMatchObject({ formKey: 'DOC-photo#0', message: expect.stringMatching(/matches DOC-pdf#0/) });
  });

  it('does not treat two different W-2s from one employer as duplicates', () => {
    const v = validateImportedFacts([
      ...facts('add_w2', { employerEin: '72-1234567', wages: 52431.18, federalTaxWithheld: 5873.4 }, 'DOC-a'),
      ...facts('add_w2', { employerEin: '72-1234567', wages: 11000, federalTaxWithheld: 900 }, 'DOC-b'),
    ]);
    expect(v.issues.map((i) => i.code)).not.toContain('DUPLICATE_FORM');
  });

  it('checks two W-2s inside one file separately', () => {
    const v = validateImportedFacts([
      ...facts('add_w2', { wages: 100, federalTaxWithheld: 10 }, 'DOC-1', 0),
      ...facts('add_w2', { wages: undefined, federalTaxWithheld: 10 }, 'DOC-1', 1),
    ]);
    expect(v.heldForms).toEqual(['DOC-1#1']);
    expect(formKeyOf({ sourceDocumentId: 'DOC-1', sourceFormIndex: 1 })).toBe('DOC-1#1');
  });
});
