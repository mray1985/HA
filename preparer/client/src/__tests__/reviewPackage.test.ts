/**
 * The final review package (work order §38), read back from the PDF.
 */

import { describe, expect, it } from 'vitest';
import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { buildCaseReview } from '../services/caseReview';
import { generateReviewPackagePDF, pdfSafe } from '../services/reviewPackage';
import { extractWithSyncfusion } from '../services/syncfusionExtractor';

const tr = {
  id: 'c', taxYear: 2025, status: 'in_progress', currentStep: 0, currentSection: 'review',
  firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456', filingStatus: FilingStatus.Single,
  addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802',
  dependents: [], w2Income: [{ id: 'w', employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 }],
  income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [], income1099MISC: [],
  income1099B: [], incomeK1: [], income1099SA: [], rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard',
  educationCredits: [], incomeDiscovery: {}, createdAt: '', updatedAt: '',
  priorYearSummary: { source: 'hatax-case', taxYear: 2024, totalIncome: 50000, agi: 50000, taxableIncome: 35400, deductionAmount: 14600, totalTax: 3900, totalCredits: 0, totalPayments: 5000, refundAmount: 1100, amountOwed: 0, effectiveTaxRate: 0.078, totalWages: 50000 },
} as unknown as TaxReturn;

describe('the final review package', () => {
  it('summarizes the case, its review and its sources', async () => {
    const calculation = calculateForm1040(tr);
    const review = buildCaseReview({ taxReturn: tr, calculation, facts: [], documents: [] });
    const bytes = await generateReviewPackagePDF({
      taxReturn: tr, calculation, review, missingDocuments: [],
      documents: [{ documentId: 'DOC-1', returnId: 'c', fileName: 'w2.pdf', mimeType: 'application/pdf', byteLength: 1, contentHash: 'abcdef0123456789', ingestedAt: '', status: 'extracted', formTypes: ['W-2'], extractor: 'text layer' }],
      now: new Date('2026-03-01T12:00:00Z'),
    });
    // Text blocks are words and phrases: compare on one spaced line.
    const text = extractWithSyncfusion(bytes).textBlocks.map((b) => b.text).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Final review package');
    expect(text).toContain('Maya Testpayer');
    expect(text).toContain('SSN ending 3456');
    expect(text).toContain('Wages (line 1z)');
    expect(text).toContain('$52,431.18');
    expect(text).toContain('CHANGE FROM 2024');
    expect(text).toContain('w2.pdf');
    expect(text).toContain('1 of 1 documents read.');
    expect(text).not.toContain('000123456');
  });

  it('writes characters the PDF font cannot encode plainly', () => {
    expect(pdfSafe('§121 → ≥ 5 years — “ok”')).toBe('Sec. 121 -> >= 5 years — “ok”');
    expect(pdfSafe('☃')).toBe('?');
  });
});
