import { describe, expect, it } from 'vitest';
import { FilingStatus, type TaxReturn } from '@hatax/engine';
import { invokeTaxTool, type IngestedDocument, type TaxFact, type TaxToolName, type TaxToolSuccess } from '@hatax/local-ai';
import { approveCase, buildCaseReview, groupForSection, reopenItem, resolveItem, type CaseReviewRecord } from '../services/caseReview';

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'case-1', taxYear: 2026, status: 'in_progress', currentStep: 0, currentSection: 'review',
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [], income1099INT: [], income1099DIV: [],
    income1099R: [], income1099G: [], income1099MISC: [], income1099B: [], incomeK1: [], income1099SA: [],
    rentalProperties: [], otherIncome: 0, expenses: [], deductionMethod: 'standard', educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  } as TaxReturn;
}

const PERSON = {
  firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456', filingStatus: FilingStatus.Single,
  addressStreet: '815 Magnolia Ave', addressCity: 'Baton Rouge', addressState: 'LA', addressZip: '70802', dateOfBirth: '1988-04-02',
} as Partial<TaxReturn>;

const W2 = { id: 'w1', employerName: 'Riverbend Logistics LLC', wages: 52431.18, federalTaxWithheld: 5873.4 } as TaxReturn['w2Income'][number];

function doc(documentId: string, status: IngestedDocument['status'] = 'extracted'): IngestedDocument {
  return { documentId, returnId: 'case-1', fileName: `${documentId}.pdf`, mimeType: 'application/pdf', byteLength: 10, contentHash: 'h', ingestedAt: '', status };
}

function factsOf(tool: TaxToolName, args: Record<string, unknown>, documentId: string): TaxFact[] {
  const r = invokeTaxTool({ tool, args, context: { returnId: 'case-1', taxYear: 2026, sourceDocumentId: documentId, sourceFileName: `${documentId}.pdf`, extractor: 'test' } });
  return (r as TaxToolSuccess).facts;
}

describe('buildCaseReview', () => {
  it('waits for documents on a new case', () => {
    expect(buildCaseReview({ taxReturn: makeReturn(), facts: [], documents: [] }).status).toBe('waiting_for_documents');
  });

  it('does not let a case be approved while a document has boxes it could not place', () => {
    // The Documents tab lists these boxes, but approval can be reached without
    // that tab ever being open. A preparer inspecting the return cannot know
    // which boxes the app was unsure about unless the case says so, so the list
    // has to be an open item rather than a note in a tab nobody opened.
    const withGaps: IngestedDocument = {
      ...doc('DOC-W2'),
      boxGaps: [{
        formType: 'W-2',
        declared: 25,
        read: 23,
        boxes: [
          { box: '7', label: 'Social security tips', state: 'unread' },
          { box: '14b', label: 'Treasury Tipped Occupation Code(s)', state: 'unread' },
        ],
      }],
    };
    const review = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [], documents: [withGaps] });
    expect(review.canApprove).toBe(false);
    const item = review.open.find((i) => i.id.startsWith('document:gaps:'))!;
    expect(item).toBeDefined();
    expect(item.category).toBe('REVIEW');
    // It names the document, the count and the boxes, so the note recorded
    // against it says what was checked.
    expect(item.message).toContain('DOC-W2.pdf');
    expect(item.message).toContain('2 boxes on W-2');
    expect(item.message).toContain('box 7');
  });

  it('asks again when a re-read leaves a different number of boxes', () => {
    // The count is in the item id, so a document read again with a different set
    // of gaps cannot inherit the acknowledgement given for the last one.
    const gapsFor = (n: number) => [{
      formType: 'W-2', declared: 25, read: 25 - n,
      boxes: Array.from({ length: n }, (_, i) => ({ box: String(i + 1), label: `Box ${i + 1}`, state: 'unread' as const })),
    }];
    const first = buildCaseReview({
      taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [],
      documents: [{ ...doc('DOC-W2'), boxGaps: gapsFor(2) }],
    });
    const acknowledged = resolveItem({ resolutions: {} }, first.open.find((i) => i.id.startsWith('document:gaps:'))!, 'accepted', 'Checked both boxes against the form.');
    const settled = buildCaseReview({
      taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [],
      documents: [{ ...doc('DOC-W2'), boxGaps: gapsFor(2) }], record: acknowledged,
    });
    expect(settled.canApprove).toBe(true);

    // Same file, read again, one more box it could not place.
    const reread = buildCaseReview({
      taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [],
      documents: [{ ...doc('DOC-W2'), boxGaps: gapsFor(3) }], record: acknowledged,
    });
    expect(reread.canApprove).toBe(false);
    expect(reread.open.some((i) => i.id.startsWith('document:gaps:'))).toBe(true);
  });

  it('does not raise a gap item for a document with nothing left over', () => {
    const review = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [], documents: [doc('DOC-W2')] });
    expect(review.items.some((i) => i.id.startsWith('document:gaps:'))).toBe(false);
    expect(review.canApprove).toBe(true);
  });

  it('is ready when nothing is open, and informational items never block', () => {
    const review = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [], documents: [doc('DOC-W2')] });
    expect(review.open).toEqual([]);
    expect(review).toMatchObject({ status: 'ready', canApprove: true });
  });

  it('asks for a date of birth it does not have, which reads as under 65', () => {
    const { dateOfBirth: _dob, ...noBirth } = PERSON;
    const single = buildCaseReview({ taxReturn: makeReturn({ ...noBirth, w2Income: [W2] }), facts: [], documents: [doc('DOC-W2')] });
    expect(single.open.map((i) => i.id)).toEqual(['case:dateOfBirth']);
    expect(single.open[0]).toMatchObject({ category: 'REVIEW', group: 'personal', action: { kind: 'return_field', field: 'dateOfBirth' } });
    const joint = buildCaseReview({
      taxReturn: makeReturn({ ...PERSON, filingStatus: FilingStatus.MarriedFilingJointly, spouseFirstName: 'Lee', spouseLastName: 'Testpayer', spouseSsn: '000987654', w2Income: [W2] }),
      facts: [], documents: [doc('DOC-W2')],
    });
    expect(joint.items.map((i) => i.id)).toContain('case:spouseDateOfBirth');
  });

  it('blocks on a form that validation holds, in the documents group', () => {
    const facts = factsOf('add_1099_div', { payerName: 'Summit Index Funds', ordinaryDividends: 100, qualifiedDividends: 250 }, 'DOC-DIV');
    const review = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts, documents: [doc('DOC-DIV')] });
    const held = review.items.find((i) => i.id === 'document:held:DOC-DIV#0');
    expect(held).toMatchObject({ category: 'BLOCKING', group: 'documents', documentId: 'DOC-DIV' });
    expect(held!.message).toContain('DOC-DIV.pdf is held');
    expect(review.status).toBe('needs_attention');
  });

  it('warns of a form for another tax year, and says nothing when the year matches', () => {
    const w2For = (year: string) => ({ ...doc('DOC-W2'), formTypes: ['W-2'], taxYearsPrinted: [year] });
    const other = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [], documents: [w2For('2025')] });
    expect(other.items.find((i) => i.id === 'document:year:DOC-W2#0')).toMatchObject({ category: 'WARNING', group: 'documents' });
    expect(other.items.find((i) => i.id === 'document:year:DOC-W2#0')!.message).toContain('is a 2025 W-2; this is the 2026 return');
    expect(other.canApprove).toBe(false);
    const same = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts: [], documents: [w2For('2026')] });
    expect(same.items.find((i) => i.id.startsWith('document:year:'))).toBeUndefined();
  });

  it('asks for the education credit choice and flags unreadable documents', () => {
    const facts = factsOf('add_education_expense', { institutionName: 'Bayou State University', tuitionPaid: 8400 }, 'DOC-1098T');
    const review = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2] }), facts, documents: [doc('DOC-1098T'), doc('SCAN-1', 'unclassified')] });
    expect(review.items.find((i) => i.id === 'document:education-choice:DOC-1098T#0')).toMatchObject({ category: 'REVIEW', group: 'credits' });
    expect(review.items.find((i) => i.id === 'document:unclassified:SCAN-1')).toMatchObject({ category: 'REVIEW', group: 'documents' });
    expect(review.status).toBe('needs_review');
  });
});

describe('resolving and approving', () => {
  const scan = doc('SCAN-1', 'unclassified');
  const tr = makeReturn({ ...PERSON, w2Income: [W2] });

  it('resolves a review item with a note, and never waives an error or blocker', () => {
    let record: CaseReviewRecord = { resolutions: {} };
    const review = buildCaseReview({ taxReturn: tr, facts: [], documents: [scan], record });
    const item = review.open[0]!;
    expect(() => resolveItem(record, item, 'accepted', '  ')).toThrow('note');
    record = resolveItem(record, item, 'not_applicable', 'Bank letter, not a tax form.');
    expect(buildCaseReview({ taxReturn: tr, facts: [], documents: [scan], record })).toMatchObject({ status: 'ready', canApprove: true });
    expect(buildCaseReview({ taxReturn: tr, facts: [], documents: [scan], record: reopenItem(record, item.id) }).status).toBe('needs_review');

    const blocker = buildCaseReview({ taxReturn: makeReturn({ ...PERSON, w2Income: [W2], ssn: '' }), facts: [], documents: [] }).open
      .find((i) => i.category === 'BLOCKING')!;
    expect(() => resolveItem(record, blocker, 'accepted', 'fine')).toThrow('fixing the return');
  });

  it('approves only when nothing is open, and any change to the return withdraws the approval', () => {
    const open = buildCaseReview({ taxReturn: tr, facts: [], documents: [scan] });
    expect(() => approveCase({ resolutions: {} }, open, tr)).toThrow('still open');

    const ready = buildCaseReview({ taxReturn: tr, facts: [], documents: [] });
    const record = approveCase({ resolutions: {} }, ready, tr);
    expect(buildCaseReview({ taxReturn: tr, facts: [], documents: [], record }).status).toBe('approved');
    const changed = { ...tr, w2Income: [{ ...W2, wages: 52000 }] };
    expect(buildCaseReview({ taxReturn: changed, facts: [], documents: [], record }).status).toBe('ready');
    expect(buildCaseReview({ taxReturn: { ...tr, updatedAt: 'later' }, facts: [], documents: [], record }).status).toBe('approved');
  });

  it('withdraws the approval when new evidence opens an item without changing the return', () => {
    const record = approveCase({ resolutions: {} }, buildCaseReview({ taxReturn: tr, facts: [], documents: [] }), tr);
    // A document nobody could identify arrives after approval: the return is unchanged, the case is not approved.
    const after = buildCaseReview({ taxReturn: tr, facts: [], documents: [scan], record });
    expect(after.open.length).toBeGreaterThan(0);
    expect(after.approval).toBeUndefined();
    expect(after.status).toBe('needs_review');
  });
});

describe('groupForSection', () => {
  it.each([
    ['w2_income', 'income'], ['expense_categories', 'income'], ['dependents', 'dependents'], ['child_tax_credit', 'credits'],
    ['dependent_care', 'credits'], ['itemized_deductions', 'deductions'], ['student_loan_ded', 'deductions'],
    ['estimated_payments', 'payments'], ['filing_status', 'personal'], ['amt_review', 'other'],
  ] as const)('%s → %s', (section, group) => {
    expect(groupForSection(section)).toBe(group);
  });
});
