/**
 * Indiana full-year residents (TY2025 corpus TAX-006): Schedule 3 exemptions
 * and the Schedule CT-40 county tax. Amounts are worked by hand from the 2025
 * IT-40 (line 7 × 3%), Schedule 3, and the Schedule CT-40 county rate chart
 * (Marion .0202, Hamilton .011, Perry .014; 2024: Monroe .02035).
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { assessIndiana } from '../src/engine/state/in.js';
import { stateQuestions } from '../src/engine/unsupported.js';
import { FilingStatus, type Dependent, type StateReturnConfig, type TaxReturn } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'in-test', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
    filingStatus: FilingStatus.Single, firstName: 'Test', lastName: 'Payer', addressState: 'IN', dateOfBirth: '1985-05-01',
    dependents: [], w2Income: [{ id: 'w', employerName: 'Acme', wages: 60000, federalTaxWithheld: 6000, state: 'IN', stateWages: 60000, stateTaxWithheld: 1700 }],
    income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [], income1099Q: [], incomeK1: [],
    income1099SA: [], incomeW2G: [], rentalProperties: [], otherIncome: 0, businesses: [], deductionMethod: 'standard',
    expenses: [], educationCredits: [], incomeDiscovery: {}, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  } as TaxReturn;
}

const indiana = (answers: Record<string, unknown> = {}, residencyType: StateReturnConfig['residencyType'] = 'resident'): StateReturnConfig =>
  ({ stateCode: 'IN', residencyType, stateSpecificData: answers } as StateReturnConfig);

const child = (id: string, relationship: string, dateOfBirth?: string, o: Partial<Dependent> = {}): Dependent =>
  ({ id, firstName: id, lastName: 'Payer', relationship, dateOfBirth, monthsLivedWithYou: 12, ...o });

function run(overrides: Partial<TaxReturn>) {
  const result = calculateForm1040(makeTaxReturn(overrides));
  return {
    state: result.stateResults?.find((s) => s.stateCode === 'IN'),
    findings: (result.unsupported ?? []).filter((u) => u.jurisdiction === 'IN'),
  };
}

describe('the Indiana county tax (Schedule CT-40)', () => {
  it("taxes IT-40 line 7 at the rate of the county lived in on January 1, and counts county tax withheld", () => {
    const { state, findings } = run({ stateReturns: [indiana({ inCounty: '49', inCountyTaxWithheld: 1150 })] });
    // Line 7: $60,000 − $1,000 = $59,000. State 3% = $1,770. Marion .0202 = $1,191.80.
    expect(findings).toEqual([]);
    expect(state).toMatchObject({
      stateTaxableIncome: 59000, stateIncomeTax: 1770, localTax: 1191.8, totalStateTax: 2961.8,
      stateWithholding: 2850, stateRefundOrOwed: -111.8,
      additionalLines: expect.objectContaining({ countyTax: 1191.8, countyRate: 0.0202, countyTaxWithheld: 1150 }),
    });
    expect(state?.traces?.find((t) => t.lineId === 'state.totalTax')?.value).toBe(2961.8);
  });

  it('uses the 2024 chart for 2024', () => {
    const { state } = run({ taxYear: 2024, stateReturns: [indiana({ inCounty: '53', inCountyTaxWithheld: 0 })] });
    // Monroe 2024 .02035 × $59,000 = $1,200.65 (2025: .0214).
    expect(state).toMatchObject({ stateTaxableIncome: 59000, localTax: 1200.65 });
  });

  it('asks the county, and the county tax withheld, before figuring it', () => {
    const { state, findings } = run({ stateReturns: [indiana()] });
    expect(findings.map((f) => [f.itemId, f.question?.key, f.question?.kind])).toEqual([
      ['county', 'inCounty', 'choice'],
      ['county-withheld', 'inCountyTaxWithheld', 'amount'],
    ]);
    expect(findings[0]!.question?.options).toHaveLength(93);
    expect(findings[0]!.question?.options).toContainEqual({ value: '49', label: '49 Marion' });
    expect(state?.unsupported).toHaveLength(2);
    // No Indiana withholding forms: nothing withheld to ask about.
    expect(run({ w2Income: [{ id: 'w', employerName: 'Acme', wages: 60000, federalTaxWithheld: 6000, state: 'OH' }], stateReturns: [indiana({ inCounty: '49' })] }).findings).toEqual([]);
  });

  it('takes county tax withheld from W-2 box 19, and asks only when a W-2 does not show it', () => {
    const w2 = (id: string, box19?: number) => ({ id, employerName: `Employer ${id}`, wages: 30000, federalTaxWithheld: 3000, state: 'IN', stateWages: 30000, stateTaxWithheld: 850, ...(box19 !== undefined ? { localTaxWithheld: box19, localityName: 'MARION' } : {}) });
    // Both W-2s show box 19: $600 + $590 = $1,190, nothing asked. Line 7 $59,000 × .0202 = $1,191.80.
    const read = run({ w2Income: [w2('a', 600), w2('b', 590)], stateReturns: [indiana({ inCounty: '49' })] });
    expect(read.findings).toEqual([]);
    expect(read.state).toMatchObject({ localTax: 1191.8, stateWithholding: 2890, additionalLines: expect.objectContaining({ countyTaxWithheld: 1190 }) });
    // A W-2 without box 19 (not read, or blank): asked, never taken as $0.
    expect(run({ w2Income: [w2('a', 600), w2('b')], stateReturns: [indiana({ inCounty: '49' })] }).findings.map((f) => f.itemId)).toEqual(['county-withheld']);
  });

  it('stops spouses who lived in different counties', () => {
    const joint = { filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Pat', spouseDateOfBirth: '1986-01-01' };
    expect(run({ ...joint, stateReturns: [indiana({ inCounty: '29', inCountyTaxWithheld: 0 })] }).findings.map((f) => f.itemId)).toEqual(['spouse-county']);
    const apart = run({ ...joint, stateReturns: [indiana({ inCounty: '29', inSpouseCounty: '49', inCountyTaxWithheld: 0 })] }).findings;
    expect(apart).toEqual([expect.objectContaining({ itemId: 'spouse-county', message: expect.stringContaining('different counties') })]);
    expect(apart[0]!.question).toBeUndefined();
  });

  it('subtracts the Perry rate on income taxed by certain Kentucky localities', () => {
    expect(run({ stateReturns: [indiana({ inCounty: '62', inCountyTaxWithheld: 0 })] }).findings.map((f) => f.itemId)).toEqual(['perry']);
    // Line 4: $59,000 × .014 = $826; line 6: $20,000 × .014 = $280; line 7 = $546.
    expect(run({ stateReturns: [indiana({ inCounty: '62', inCountyTaxWithheld: 0, inPerryKentuckyIncome: 20000 })] }).state)
      .toMatchObject({ localTax: 546, additionalLines: expect.objectContaining({ perryKentuckyOffset: 280 }) });
  });

  it('owes no county tax for code 00 (stationed outside Indiana), and stops a year without a chart', () => {
    expect(run({ stateReturns: [indiana({ inCounty: '00', inCountyTaxWithheld: 0 })] }).state).toMatchObject({ localTax: 0, totalStateTax: 1770 });
    expect(run({ taxYear: 2026, stateReturns: [indiana({ inCounty: '49', inCountyTaxWithheld: 0 })] }).findings.map((f) => f.itemId)).toEqual(['county-rates']);
  });
});

describe('Indiana exemptions (Schedule 3)', () => {
  it('gives each dependent $1,000, each young dependent child $1,500 more, and a newborn $1,500 more again', () => {
    const { state, findings } = run({
      filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Pat', dateOfBirth: '1958-03-01', spouseDateOfBirth: '1970-01-01',
      w2Income: [{ id: 'w', employerName: 'Acme', wages: 100000, federalTaxWithheld: 9000, state: 'IN', stateTaxWithheld: 2500 }],
      dependents: [child('Leo', 'Son', '2015-04-02'), child('Ada', 'Daughter', '2025-02-10')],
      stateReturns: [indiana({ inCounty: '29', inSpouseCounty: '29', inAdoptedChildren: 0, inFirstTimeChildren: 0, inCountyTaxWithheld: 0 })],
    });
    // Line 1 $2,000; line 2 2 × $1,000; line 3 $1,500 × (2 children + 1 newborn); line 4 $1,000 (age 67); line 5 none (AGI ≥ $40,000).
    // Exemptions $9,500. Line 7 $90,500. State $2,715. Hamilton .011 = $995.50.
    expect(findings).toEqual([]);
    expect(state).toMatchObject({ stateExemptions: 9500, stateTaxableIncome: 90500, stateIncomeTax: 2715, localTax: 995.5 });
  });

  it('adds $500 at 65 or older when federal AGI is under $40,000, and $1,000 for blindness', () => {
    const w2Income = [{ id: 'w', employerName: 'Acme', wages: 30000, federalTaxWithheld: 2000, state: 'IN' }];
    const tr = makeTaxReturn({ dateOfBirth: '1955-06-01', isLegallyBlind: true, w2Income } as Partial<TaxReturn>);
    // $1,000 + line 4 ($1,000 age + $1,000 blind) + line 5 $500 = $3,500.
    expect(assessIndiana({ ...tr, stateReturns: [indiana()] }, 30000).exemptions).toMatchObject({ line1: 1000, line4: 2000, line5: 500, total: 3500 });
    expect(assessIndiana({ ...tr, stateReturns: [indiana()] }, 40000).exemptions.line5).toBe(0);
  });

  it('gives a qualifying surviving spouse $1,000 on line 1, not the joint $2,000', () => {
    const tr = makeTaxReturn({ filingStatus: FilingStatus.QualifyingSurvivingSpouse, stateReturns: [indiana()] });
    expect(assessIndiana(tr, 60000).exemptions.line1).toBe(1000);
  });

  it('asks about adopted, first-time and guardian children, and the date of birth it needs', () => {
    const { findings } = run({
      dependents: [
        child('Leo', 'Son', '2012-01-01'),
        child('Mia', 'Grandchild', '2014-01-01'),
        child('Sam', 'Stepson'),
        child('Ann', 'Mother', '1950-01-01'),
      ],
      stateReturns: [indiana({ inCounty: '49', inCountyTaxWithheld: 0 })],
    });
    expect(findings.map((f) => [f.itemId, f.question?.key, f.question?.max])).toEqual([
      ['dob:Sam', undefined, undefined],
      ['guardian', 'inGuardianChildren', 1],
      ['adopted', 'inAdoptedChildren', 1],
      ['first-time', 'inFirstTimeChildren', 1],
    ]);
  });

  it('counts answered adopted, first-time and guardian children', () => {
    const tr = makeTaxReturn({
      dependents: [child('Leo', 'Son', '2012-01-01'), child('Mia', 'Grandchild', '2008-01-01', { isStudent: true })],
      stateReturns: [indiana({ inCounty: '49', inCountyTaxWithheld: 0, inGuardianChildren: 1, inAdoptedChildren: 1, inFirstTimeChildren: 1 })],
    });
    // Line 2 $2,000; line 3 $1,500 × (1 child + 1 ward + 1 first-time) = $4,500; line 6 $3,000.
    expect(assessIndiana(tr, 60000)).toMatchObject({ findings: [], exemptions: { line1: 1000, line2: 2000, line3: 4500, line6: 3000, total: 10500 } });
    expect(stateQuestions(tr, calculateForm1040(tr)).map((q) => q.key)).toEqual([
      'inGuardianChildren', 'inAdoptedChildren', 'inFirstTimeChildren', 'inCounty', 'inCountyTaxWithheld',
    ]);
  });

  it('leaves part-year and nonresident returns to TAX-008', () => {
    const findings = run({ stateReturns: [{ ...indiana({}, 'part_year'), daysLivedInState: 100 } as StateReturnConfig] }).findings;
    expect(findings.map((f) => f.ruleId)).toEqual(['TAX-008']);
  });
});
