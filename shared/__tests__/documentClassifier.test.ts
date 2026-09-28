import { describe, expect, it } from 'vitest';
import {
  classificationAllowsIncomeWrite,
  classifyDocument,
} from '../src/taxfacts/documentClassifier.js';
import { addW2, invokeTaxTool } from '../src/taxfacts/taxTools.js';

describe('document classifier (work-order step 4)', () => {
  it('classifies W-2 text from primary form markers and cites the match', () => {
    const result = classifyDocument({
      text: `
        Form W-2 Wage and Tax Statement
        Employer identification number
        Wages, tips, other compensation
        Federal income tax withheld
        Social security wages
      `,
    });
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('W-2');
    expect(result.incomeType).toBe('w2');
    expect(result.source).toBe('text_markers');
    expect(result.matchedMarkers.some((m) => /w-2|wage and tax/i.test(m))).toBe(true);
    expect(result.reason).toMatch(/Matched primary marker/i);
    expect(result.reason).toMatch(/W-2/);
    expect(classificationAllowsIncomeWrite(result)).toBe(true);
  });

  it('classifies 1099-INT / DIV / NEC / R markers correctly', () => {
    const cases = [
      {
        text: 'Form 1099-INT Interest Income Payer name Interest income Early withdrawal penalty',
        formType: '1099-INT',
        incomeType: '1099int',
      },
      {
        text: 'Form 1099-DIV Dividends and Distributions Ordinary dividends Qualified dividends Capital gain distributions',
        formType: '1099-DIV',
        incomeType: '1099div',
      },
      {
        text: 'Form 1099-NEC Nonemployee Compensation Payer TIN Compensation Recipient',
        formType: '1099-NEC',
        incomeType: '1099nec',
      },
      {
        text: 'Form 1099-R Distributions From Pensions Annuities Gross distribution Taxable amount Distribution code',
        formType: '1099-R',
        incomeType: '1099r',
      },
    ] as const;

    for (const item of cases) {
      const result = classifyDocument({ text: item.text });
      expect(result.status).toBe('classified');
      if (result.status !== 'classified') continue;
      expect(result.formType).toBe(item.formType);
      expect(result.incomeType).toBe(item.incomeType);
      expect(result.matchedMarkers.length).toBeGreaterThan(0);
      expect(result.reason).toContain(item.formType);
    }
  });

  it('prefers W-2G over W-2 when gambling markers are present', () => {
    const result = classifyDocument({
      text: 'Form W-2G Certain Gambling Winnings Reportable winnings Gross winnings Type of wager',
    });
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('W-2G');
    expect(result.incomeType).toBe('w2g');
  });

  it('leaves unknown text unclassified and blocks income writes', () => {
    const result = classifyDocument({
      text: 'Meeting notes from Tuesday. Please bring snacks. No IRS form language here.',
    });
    expect(result.status).toBe('unclassified');
    expect(result.formType).toBeNull();
    expect(result.incomeType).toBeNull();
    expect(result.source).toBe('none');
    expect(result.reason).toMatch(/No primary form markers/i);
    expect(classificationAllowsIncomeWrite(result)).toBe(false);
  });

  it('does not classify from a bare importer label without markers', () => {
    const result = classifyDocument({
      detectedFormType: 'W-2',
      matchedMarkers: [],
    });
    expect(result.status).toBe('unclassified');
    expect(result.reason).toMatch(/without citing matched markers/i);
    expect(classificationAllowsIncomeWrite(result)).toBe(false);
  });

  it('classifies from importer markers when text is unavailable', () => {
    const result = classifyDocument({
      detectedFormType: 'W-2',
      matchedMarkers: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
      detectedConfidence: 'high',
    });
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('W-2');
    expect(result.source).toBe('importer_markers');
    expect(result.reason).toMatch(/wage and tax statement/i);
    expect(result.confidence).toBe('high');
  });

  it('stays unclassified when text and importer disagree', () => {
    const result = classifyDocument({
      text: 'Form W-2 Wage and Tax Statement Employer Wages Federal income tax withheld Social security',
      detectedFormType: '1099-INT',
    });
    expect(result.status).toBe('unclassified');
    expect(result.reason).toMatch(/unclassified/i);
    expect(classificationAllowsIncomeWrite(result)).toBe(false);
  });

  it('falls back to importer markers when text has no primary form titles', () => {
    const result = classifyDocument({
      text: 'Scanned page noise … employer wages tips compensation',
      detectedFormType: 'W-2',
      matchedMarkers: ['wage and tax statement', 'employer', 'wages', 'federal income tax withheld'],
      detectedConfidence: 'medium',
    });
    expect(result.status).toBe('classified');
    if (result.status !== 'classified') return;
    expect(result.formType).toBe('W-2');
    expect(result.source).toBe('importer_markers');
  });

  it('keeps explicit 0 amounts and omits missing amounts after a W-2 classification', () => {
    const classified = classifyDocument({
      text: 'Form W-2 Wage and Tax Statement Employer Wages Federal income tax withheld Social security',
    });
    expect(classified.status).toBe('classified');

    const tool = invokeTaxTool({
      tool: 'add_w2',
      args: {
        employerName: 'Acme',
        wages: undefined,
        socialSecurityWages: 0,
        medicareWages: 41000,
      },
      context: {
        returnId: 'ret-1',
        taxYear: 2026,
        sourceDocumentId: 'DOC-class-1',
        sourceFileName: 'w2.pdf',
        extractor: 'local-pdf',
      },
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) return;
    expect(tool.fields).toEqual({
      employerName: 'Acme',
      socialSecurityWages: 0,
      medicareWages: 41000,
    });
    expect(tool.fields).not.toHaveProperty('wages');
    const ss = tool.facts.find((f) => f.sourceField === 'socialSecurityWages');
    expect(ss?.status).toBe('extracted');
    expect(ss?.value).toBe(0);
    const wages = tool.facts.find((f) => f.sourceField === 'wages');
    expect(wages?.status).toBe('unknown');

    // Unclassified path must not create income via tools.
    const blocked = classificationAllowsIncomeWrite(
      classifyDocument({ text: 'random office memo about lunch' }),
    );
    expect(blocked).toBe(false);
    expect(addW2).toBeTypeOf('function');
  });
});
