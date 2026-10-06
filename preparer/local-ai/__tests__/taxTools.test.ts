import { describe, expect, it } from 'vitest';
import {
  addW2,
  engineItemFields,
  formToolForIncomeType,
  invokeTaxTool,
  setFilingStatusCandidate,
  toolNameForIncomeType,
} from '../src/taxTools.js';
import { incomeTypeForFormType } from '../src/documentClassifier.js';
import { getFormExtractionSchema, mapBoxesToTool } from '../src/formSchemas.js';
import type { TaxFact } from '../src/taxFact.js';

const ctx = {
  returnId: 'ret-1',
  taxYear: 2025,
  sourceDocumentId: 'DOC-1',
  sourceFileName: 'w2.pdf',
  extractor: 'local-pdf',
};

describe('tax tools (HA-AI-011)', () => {
  it('accepts a valid W-2 tool call and returns facts plus add-income fields', () => {
    const result = addW2(
      {
        employerName: 'Acme Corp',
        wages: 52000,
        federalTaxWithheld: 7800,
        socialSecurityWages: 52000,
      },
      {
        ...ctx,
        rawText: { wages: '52,000.00', federalTaxWithheld: '7,800.00' },
        confidence: { wages: 0.97, federalTaxWithheld: 0.95, employerName: 0.9 },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tool).toBe('add_w2');
    expect(result.incomeType).toBe('w2');
    expect(result.fields).toEqual({
      employerName: 'Acme Corp',
      wages: 52000,
      federalTaxWithheld: 7800,
      socialSecurityWages: 52000,
    });
    expect(result.fields).not.toHaveProperty('medicareWages');

    const wages = result.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('extracted');
    expect(wages?.value).toBe(52000);
    expect(wages?.rawText).toBe('52,000.00');
    expect(wages?.confidence).toBe(0.97);
    expect(wages?.sourceDocumentId).toBe('DOC-1');
    expect(wages?.factType).toBe('W2_wages');
  });

  it('omits missing wages instead of writing zero', () => {
    const result = addW2(
      {
        employerName: 'Acme',
        wages: undefined,
        federalTaxWithheld: null,
        socialSecurityWages: 0,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
    });
    expect(result.fields).not.toHaveProperty('wages');
    expect(result.fields).not.toHaveProperty('federalTaxWithheld');

    const wagesFact = result.facts.find((f) => f.sourceField === 'wages');
    expect(wagesFact?.status).toBe('unknown');
    expect(wagesFact && 'value' in wagesFact).toBe(false);

    const withheld = result.facts.find((f) => f.sourceField === 'federalTaxWithheld');
    expect(withheld?.status).toBe('unknown');
    expect(withheld && 'value' in withheld).toBe(false);

    const ss = result.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
  });

  it('keeps an explicit zero amount', () => {
    const result = invokeTaxTool({
      tool: 'add_1099_int',
      args: { payerName: 'Chase', amount: 0, federalTaxWithheld: 0 },
      context: {
        ...ctx,
        sourceFileName: '1099int.pdf',
        rawText: { amount: '0.00' },
        confidence: { amount: 0.88 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomeType).toBe('1099int');
    expect(result.fields.amount).toBe(0);
    expect(result.fields.federalTaxWithheld).toBe(0);

    const amount = result.facts.find((f) => f.sourceField === 'amount');
    expect(amount?.status).toBe('extracted');
    expect(amount?.value).toBe(0);
    expect(amount?.rawText).toBe('0.00');
  });

  it('rejects unknown fields', () => {
    const result = addW2(
      {
        employerName: 'Acme',
        wages: 1000,
        form1040Line1a: 1000,
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/form1040Line1a|unrecognized/i);
  });

  it('rejects invalid amount types', () => {
    const result = addW2({ wages: 'fifty-two thousand' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('records filing status as a candidate fact without applying it', () => {
    const result = setFilingStatusCandidate(
      { status: 'married_filing_jointly' },
      { ...ctx, sourceFileName: 'intake.pdf', extractor: 'automation' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliesFilingStatus).toBe(false);
    expect(result.incomeType).toBeUndefined();
    expect(result.fields).toEqual({ status: 'married_filing_jointly' });

    const [fact] = result.facts;
    expect(fact.factType).toBe('FILING_STATUS_CANDIDATE');
    expect(fact.status).toBe('extracted');
    expect(fact.value).toBe('married_filing_jointly');
  });

  it('maps income types to tool names for supported forms only', () => {
    expect(toolNameForIncomeType('w2')).toBe('add_w2');
    expect(toolNameForIncomeType('1099int')).toBe('add_1099_int');
    expect(toolNameForIncomeType('1099misc')).toBe('add_1099_misc');
    expect(toolNameForIncomeType('w2g')).toBe('add_w2g');
    // Preparer-choice forms are not income-item tools.
    expect(toolNameForIncomeType('1099q')).toBeNull();
  });

  it('round-trips W-2 box12 codes and box13 flags through the tool', () => {
    const result = addW2(
      {
        employerName: 'Acme',
        wages: 60000,
        box12: [
          { code: 'D', amount: 5000 },
          { code: 'DD', amount: 0 },
        ],
        box13: {
          statutoryEmployee: false,
          retirementPlan: true,
          thirdPartySickPay: true,
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fields.box12).toEqual([
      { code: 'D', amount: 5000 },
      { code: 'DD', amount: 0 },
    ]);
    expect(result.fields.box13).toEqual({
      statutoryEmployee: false,
      retirementPlan: true,
      thirdPartySickPay: true,
    });

    const box12Fact = result.facts.find((f) => f.sourceField === 'box12');
    expect(box12Fact?.status).toBe('extracted');
    expect(box12Fact?.value).toEqual([
      { code: 'D', amount: 5000 },
      { code: 'DD', amount: 0 },
    ]);

    const box13Fact = result.facts.find((f) => f.sourceField === 'box13');
    expect(box13Fact?.status).toBe('extracted');
    expect(box13Fact?.value).toEqual({
      statutoryEmployee: false,
      retirementPlan: true,
      thirdPartySickPay: true,
    });
  });

  it('accepts 1099-R Roth basis, QCD, and simplified-method fields', () => {
    const result = invokeTaxTool({
      tool: 'add_1099_r',
      args: {
        payerName: 'Fidelity',
        grossDistribution: 20000,
        taxableAmount: 15000,
        isRothIRA: true,
        rothContributionBasis: 8000,
        qcdAmount: 0,
        useSimplifiedMethod: true,
        simplifiedMethod: {
          totalContributions: 40000,
          ageAtStartDate: 65,
          isJointAndSurvivor: false,
          paymentsThisYear: 12,
          priorYearTaxFreeRecovery: 0,
        },
      },
      context: {
        ...ctx,
        sourceFileName: '1099r.pdf',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.incomeType).toBe('1099r');
    expect(result.fields.rothContributionBasis).toBe(8000);
    expect(result.fields.qcdAmount).toBe(0);
    expect(result.fields.useSimplifiedMethod).toBe(true);
    expect(result.fields.simplifiedMethod).toEqual({
      totalContributions: 40000,
      ageAtStartDate: 65,
      isJointAndSurvivor: false,
      paymentsThisYear: 12,
      priorYearTaxFreeRecovery: 0,
    });

    const roth = result.facts.find((f) => f.sourceField === 'rothContributionBasis');
    expect(roth?.status).toBe('extracted');
    expect(roth?.value).toBe(8000);

    const qcd = result.facts.find((f) => f.sourceField === 'qcdAmount');
    expect(qcd?.status).toBe('extracted');
    expect(qcd?.value).toBe(0);
  });

  it('unknown TaxFact status cannot carry a value', () => {
    const result = addW2({ employerName: 'Acme' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Construct an unknown fact the same way callers must: no value key.
    const unknown: TaxFact = {
      factId: 'DOC-1:wages',
      returnId: 'ret-1',
      taxYear: 2025,
      factType: 'W2_wages',
      sourceDocumentId: 'DOC-1',
      sourceFileName: 'w2.pdf',
      sourceField: 'wages',
      rawText: '',
      confidence: null,
      extractor: 'local-pdf',
      verified: false,
      status: 'unknown',
    };
    expect(unknown.value).toBeUndefined();
    expect('value' in unknown).toBe(false);

    // @ts-expect-error unknown status cannot carry a value
    const carried: TaxFact = { ...unknown, status: 'unknown', value: 0 };
    expect(carried.status).toBe('unknown');
  });
});

describe('SSA-1099, 1098 and 1098-T tools', () => {
  const context = { returnId: 'R1', taxYear: 2026, sourceDocumentId: 'DOC-1', sourceFileName: 'f.pdf', extractor: 'test' };

  it('reports how each result applies to the return', () => {
    const ssa = invokeTaxTool({ tool: 'add_ssa_1099', args: { netBenefits: -250 }, context });
    const mortgage = invokeTaxTool({ tool: 'add_mortgage_interest', args: { mortgageInterest: 9412.37, numberOfProperties: 1 }, context });
    const tuition = invokeTaxTool({ tool: 'add_education_expense', args: { tuitionPaid: 8420, halfTimeStudent: true }, context });
    const w2 = invokeTaxTool({ tool: 'add_w2', args: { wages: 1 }, context });
    expect(ssa.ok && ssa.application).toEqual({ kind: 'aggregate', target: 'socialSecurityBenefits' });
    expect(mortgage.ok && mortgage.application).toEqual({ kind: 'aggregate', target: 'mortgageInterest' });
    expect(tuition.ok && tuition.application).toEqual({ kind: 'needs_preparer_choice', target: 'educationCredit', choice: 'creditType' });
    expect(w2.ok && w2.application).toEqual({ kind: 'income_item', itemType: 'w2' });
    // Only income-item tools carry an addIncomeItem type.
    expect(ssa.ok && ssa.incomeType).toBeUndefined();
    expect(w2.ok && w2.incomeType).toBe('w2');
  });

  it('keeps a negative SSA net benefit and prefixes its facts', () => {
    const r = invokeTaxTool({ tool: 'add_ssa_1099', args: { netBenefits: -250, federalTaxWithheld: 0 }, context });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({ netBenefits: -250, federalTaxWithheld: 0 });
    expect(r.facts.map((f) => f.factType)).toEqual(['SSA1099_netBenefits', 'SSA1099_federalTaxWithheld']);
  });

  it('rejects invented fields and a fractional property count', () => {
    expect(invokeTaxTool({ tool: 'add_mortgage_interest', args: { mortgageInterest: 1, escrow: 500 }, context }).ok).toBe(false);
    expect(invokeTaxTool({ tool: 'add_mortgage_interest', args: { numberOfProperties: 1.5 }, context }).ok).toBe(false);
    expect(invokeTaxTool({ tool: 'add_education_expense', args: { creditType: 'american_opportunity' }, context }).ok).toBe(false);
  });

  it('keeps a missing 1098-T amount unknown, never zero', () => {
    const r = invokeTaxTool({ tool: 'add_education_expense', args: { tuitionPaid: undefined, scholarships: 3000 }, context });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({ scholarships: 3000 });
    expect(r.facts.find((f) => f.sourceField === 'tuitionPaid')?.status).toBe('unknown');
  });
});

describe('Form W-2G tool', () => {
  it('records gambling winnings as an income item with W2G facts', () => {
    const result = invokeTaxTool({
      tool: 'add_w2g',
      args: {
        payerName: 'RIVERBEND CASINO',
        grossWinnings: 24600,
        typeOfWager: 'Poker tournament',
        federalTaxWithheld: 4920,
        stateCode: 'LA',
        stateTaxWithheld: 1230,
      },
      context: { ...ctx, sourceFileName: 'fw2g.pdf' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomeType).toBe('w2g');
    expect(result.application).toEqual({ kind: 'income_item', itemType: 'w2g' });
    expect(result.fields).toEqual({
      payerName: 'RIVERBEND CASINO',
      grossWinnings: 24600,
      typeOfWager: 'Poker tournament',
      federalTaxWithheld: 4920,
      stateCode: 'LA',
      stateTaxWithheld: 1230,
    });
    // Field names must match shared/types IncomeW2G so the item stores as-is.
    for (const key of Object.keys(result.fields)) {
      expect(result.facts.some((f) => f.factType === `W2G_${key}`), key).toBe(true);
    }
  });

  it('rejects a field the form does not have rather than inventing one', () => {
    const result = invokeTaxTool({
      tool: 'add_w2g',
      args: { grossWinnings: 100, netWinnings: 100 },
      context: ctx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('netWinnings');
  });

  it('omits an absent box instead of passing zero for it', () => {
    const result = invokeTaxTool({
      tool: 'add_w2g',
      args: { grossWinnings: 500, federalTaxWithheld: null, stateTaxWithheld: '' },
      context: ctx,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ grossWinnings: 500 });
    expect(result.fields).not.toHaveProperty('federalTaxWithheld');
    expect(Object.values(result.fields)).not.toContain(0);
  });
});
describe('Schedule K-1 tool', () => {
  it('records pass-through income as an income item with K1 facts', () => {
    const result = invokeTaxTool({
      tool: 'add_k1',
      args: {
        entityName: 'RIVERBEND PARTNERS LP',
        entityEin: '72-1234567',
        entityType: 'partnership',
        ordinaryBusinessIncome: 48200,
        selfEmploymentIncome: 48200,
      },
      context: { ...ctx, sourceFileName: 'f1065sk1.pdf' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomeType).toBe('k1');
    expect(result.application).toEqual({ kind: 'income_item', itemType: 'k1' });
    expect(result.facts.some((f) => f.factType === 'K1_ordinaryBusinessIncome')).toBe(true);
  });

  it('never supplies an entity kind of its own when none is given', () => {
    // Withholding an unreadable form number is the mapper's job (mapBoxesToTool);
    // the tool's part is not to fill the gap with a default, because the kind
    // decides self-employment treatment.
    const result = invokeTaxTool({ tool: 'add_k1', args: { entityName: 'THE ESTATE' }, context: ctx });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ entityName: 'THE ESTATE' });
    expect(result.fields).not.toHaveProperty('entityType');
  });

  it('rejects an entity kind that is not one of the four the engine knows', () => {
    const result = invokeTaxTool({ tool: 'add_k1', args: { entityType: 'llc' }, context: ctx });
    expect(result.ok).toBe(false);
  });

  it('rejects a code-split box 13 or box 15 field the page cannot support', () => {
    for (const key of ['box13CharitableCash', 'box15ForeignTaxPaid']) {
      const result = invokeTaxTool({ tool: 'add_k1', args: { [key]: 100 }, context: ctx });
      expect(result.ok, key).toBe(false);
    }
  });
});

describe('every classifiable form reaches a tool', () => {
  it.each([
    ['W-2G', 'w2g', 'add_w2g'],
    ['1098-E', '1098e', 'add_1098_e'],
    ['K-1', 'k1', 'add_k1'],
    ['1095-A', '1095a', 'add_1095_a'],
  ] as const)('%s reaches %s through its classified income type', (formType, incomeType, tool) => {
    // A schema and an application are not enough: intake resolves a classified
    // form through formToolForIncomeType, so a form missing from that map is read
    // and then reported to the preparer as not applied.
    expect(incomeTypeForFormType(formType)).toBe(incomeType);
    expect(formToolForIncomeType(incomeType)).toBe(tool);
  });
});

describe('Schedule K-1 boxes the reader may not set on its own', () => {
  it('accepts a preparer correction for a held box, so the held field is not lost', () => {
    // The box is not mapped from the page, so nothing automatic carries it - but
    // the field has to survive in the schema, or a preparer who types the Code A
    // amount from the review panel is silently discarded.
    const result = invokeTaxTool({
      tool: 'add_k1',
      args: { entityName: 'RIVERBEND PARTNERS LP', entityType: 'partnership', selfEmploymentIncome: 48200 },
      context: ctx,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toMatchObject({ selfEmploymentIncome: 48200 });
    expect(engineItemFields('k1', result.fields)).not.toHaveProperty('selfEmploymentIncome');
  });

  it.each(['collectiblesGain28', 'unrecapturedSection1250Gain', 'selfEmploymentIncome', 'section179Deduction', 'guaranteedPayments'])(
    'never strips a preparer-supplied %s',
    (field) => {
      const result = invokeTaxTool({ tool: 'add_k1', args: { [field]: 100 }, context: ctx });
      expect(result.ok, field).toBe(true);
      if (!result.ok) return;
      expect(result.fields, field).toMatchObject({ [field]: 100 });
      // Held from the engine item for a machine read; the applier exempts a
      // preparer correction by the fact's sourceKind.
      expect(engineItemFields('k1', result.fields), field).not.toHaveProperty(field);
    },
  );
});