import { describe, expect, it } from 'vitest';
import { classifyDocument } from '../src/documentClassifier.js';
import { validateImportedFacts } from '../src/factValidation.js';
import {
  buildExtractionTemplate,
  FORM_EXTRACTION_SCHEMAS,
  mapBoxesToTool,
  toolForForm,
  type FormBoxSchema,
} from '../src/formSchemas.js';
import { extractStructuredFields } from '../src/structuredExtraction.js';
import type { TaxFact } from '../src/taxFact.js';
import { engineItemFields, invokeTaxTool, TOOL_APPLICATION, type DocumentToolName } from '../src/taxTools.js';

/** A printed value of the box's kind, as a model would transcribe it. */
function printed(b: FormBoxSchema): string {
  switch (b.kind) {
    case 'money': return '1,234.56';
    case 'percent': return '10%';
    case 'integer': return '2';
    case 'date': return '03/02/2025';
    case 'tin': return '12-3456789';
    case 'stateCode': return 'LA';
    case 'stateAndId': return 'LA/1234567';
    case 'checkbox': return 'X';
    case 'code': return b.key === '6' ? 'F' : b.key === '3' ? '1' : 'A';
    case 'text': return 'ACME HOLDINGS';
  }
}

const context = { returnId: 'R1', taxYear: 2025, sourceDocumentId: 'DOC', sourceFileName: 'doc.pdf', extractor: 'test' };

function call(tool: DocumentToolName, args: Record<string, unknown>): TaxFact[] {
  const r = invokeTaxTool({ tool, args, context });
  if (!r.ok) throw new Error(r.error);
  return r.facts;
}

describe('every form schema with a tax tool', () => {
  const forms = Object.values(FORM_EXTRACTION_SCHEMAS).filter((s) => toolForForm(s!.formType));

  it('covers the work order §16 forms', () => {
    expect(forms.map((s) => s!.formType)).toEqual(expect.arrayContaining([
      '1099-INT', '1099-DIV', '1099-NEC', '1099-MISC', '1099-R', '1099-G', 'SSA-1099', '1099-B', '1099-K', '1099-S', '1099-C', '1099-Q', '1099-SA', '1099-OID',
    ]));
  });

  it('builds a template with one field per box', () => {
    for (const schema of forms) expect(() => buildExtractionTemplate(schema!)).not.toThrow();
  });

  it('maps a fully printed form to arguments its tool accepts', () => {
    for (const schema of forms) {
      const tool = toolForForm(schema!.formType)!;
      // One square of each one-of group (box 2 term, box 5 account) is checked.
      const values = Object.fromEntries(schema!.boxes
        .filter((b) => !/^(2\.(long|ordinary)|5\.(archer|ma))$/.test(b.key))
        .map((b) => [b.key, printed(b)]));
      const mapped = mapBoxesToTool(schema!, values);
      const { args, rawText } = extractStructuredFields(tool, mapped.bag, mapped.rawText);
      const result = invokeTaxTool({ tool, args, context: { ...context, rawText } });
      expect(result.ok, `${schema!.formType}: ${result.ok ? '' : result.error}`).toBe(true);
    }
  });

  it('sends every tool box to the tool or to review — never silently drops one', () => {
    for (const schema of forms) {
      for (const b of schema!.boxes.filter((x) => x.use === 'tool')) {
        const mapped = mapBoxesToTool(schema!, { [b.key]: printed(b) });
        const reached = Object.keys(mapped.bag).length > 0 || mapped.reviewBoxes.length > 0;
        expect(reached, `${schema!.formType} box ${b.key}`).toBe(true);
      }
    }
  });
});

describe('1099-B', () => {
  const schema = FORM_EXTRACTION_SCHEMAS['1099-B']!;

  it('reads the term from the one checked box 2 square', () => {
    // Page evidence writes "X" (checked), "no" (empty) or "?" (unreadable).
    expect(mapBoxesToTool(schema, { '2.long': 'X', '2.short': 'no', '2.ordinary': 'no' }).bag).toMatchObject({ isLongTerm: true });
    expect(mapBoxesToTool(schema, { '2.short': 'X' }).bag).toMatchObject({ isLongTerm: false });
    const both = mapBoxesToTool(schema, { '2.short': 'X', '2.long': 'X' });
    expect(both.bag).not.toHaveProperty('isLongTerm');
    expect(both.reviewBoxes.map((r) => r.key)).toEqual(['2.short', '2.long']);
    const unreadable = mapBoxesToTool(schema, { '2.short': '?', '2.long': 'X' });
    expect(unreadable.bag).not.toHaveProperty('isLongTerm');
    expect(unreadable.reviewBoxes.map((r) => r.key)).toEqual(['2.short', '2.long']);
  });

  it('holds a sale whose basis or term is not known — never zero basis, never assumed short-term', () => {
    const v = validateImportedFacts(call('add_1099_b', { brokerName: 'SUMMIT BROKERAGE', proceeds: 12500 }));
    expect(v.heldForms).toEqual(['DOC#0']);
    expect(v.issues.filter((i) => i.code === 'REQUIRED_AMOUNT_UNKNOWN').map((i) => i.sourceField)).toEqual(['costBasis', 'isLongTerm']);
  });

  it('applies a complete sale as a 1099-B income item', () => {
    const facts = call('add_1099_b', { brokerName: 'SUMMIT BROKERAGE', description: '40 sh. ACME', dateSold: '11/03/2025', proceeds: 12500, costBasis: 9100.5, isLongTerm: true });
    expect(validateImportedFacts(facts).heldForms).toEqual([]);
    expect(TOOL_APPLICATION.add_1099_b).toEqual({ kind: 'income_item', itemType: '1099b' });
  });
});

describe('form checks', () => {
  const held = (tool: DocumentToolName, args: Record<string, unknown>) => validateImportedFacts(call(tool, args)).issues.filter((i) => i.holdsForm).map((i) => i.code);

  it('holds a 1099-MISC or 1099-OID with no income box read', () => {
    expect(held('add_1099_misc', { payerName: 'RIVER PROPERTIES', federalTaxWithheld: 50 })).toEqual(['NO_INCOME_BOX_READ']);
    expect(held('add_1099_misc', { payerName: 'RIVER PROPERTIES', rents: 14400 })).toEqual([]);
    expect(held('add_1099_oid', { payerName: 'TREASURY DIRECT', otherPeriodicInterest: 88.2 })).toEqual([]);
    expect(held('add_1099_oid', { payerName: 'TREASURY DIRECT' })).toEqual(['NO_INCOME_BOX_READ']);
  });

  it('holds a 1099-K whose card-not-present amount exceeds its gross amount', () => {
    expect(held('add_1099_k', { platformName: 'PAYFLOW', grossAmount: 5000, cardNotPresent: 6000 })).toEqual(['K_CARD_NOT_PRESENT_EXCEEDS_GROSS']);
  });

  it('checks a 1099-C: event code, interest within the debt, and personal liability', () => {
    expect(held('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'Z' })).toEqual(['C_INVALID_EVENT_CODE']);
    expect(held('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, interestIncluded: 3500 })).toEqual(['C_INTEREST_EXCEEDS_DEBT']);
    const v = validateImportedFacts(call('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'g', personallyLiable: false }));
    expect(v.heldForms).toEqual([]);
    expect(v.issues).toEqual([expect.objectContaining({ code: 'C_NOT_PERSONALLY_LIABLE', severity: 'warning' })]);
    // Box 5 unread is not box 5 checked: the preparer looks at the form.
    const unread = validateImportedFacts(call('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'g' }));
    expect(unread.heldForms).toEqual([]);
    expect(unread.issues).toEqual([expect.objectContaining({ code: 'C_LIABILITY_UNREAD', severity: 'warning' })]);
    expect(validateImportedFacts(call('add_1099_c', { payerName: 'BAYOU BANK', amountCancelled: 3000, identifiableEventCode: 'g', personallyLiable: true })).issues).toEqual([]);
  });

  it('keeps 1099-C box 5 as a fact but out of the engine item', () => {
    expect(engineItemFields('1099c', { payerName: 'BAYOU BANK', amountCancelled: 3000, personallyLiable: true })).toEqual({ payerName: 'BAYOU BANK', amountCancelled: 3000 });
    expect(engineItemFields('1099misc', { payerName: 'X', rents: 1 })).toEqual({ payerName: 'X', rents: 1 });
  });

  it('holds a 1099-Q whose boxes do not add up, and records a valid one for the preparer', () => {
    expect(held('add_1099_q', { payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200, basisReturn: 6000 })).toEqual(['Q_BOXES_DO_NOT_ADD']);
    expect(held('add_1099_q', { payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: -200, basisReturn: 8200 })).toEqual([]);
    expect(TOOL_APPLICATION.add_1099_q).toMatchObject({ kind: 'needs_preparer_choice', choice: 'qualifiedExpenses' });
  });

  it('holds a 1099-SA with an invalid distribution code', () => {
    expect(held('add_1099_sa', { payerName: 'HEALTH TRUST', grossDistribution: 900, distributionCode: '9' })).toEqual(['SA_INVALID_DISTRIBUTION_CODE']);
    expect(held('add_1099_sa', { payerName: 'HEALTH TRUST', grossDistribution: 900, distributionCode: '1' })).toEqual([]);
  });

  it('reads the 1099-SA account from the one checked box 5 square', () => {
    expect(mapBoxesToTool(FORM_EXTRACTION_SCHEMAS['1099-SA']!, { '5.hsa': 'no', '5.archer': 'X', '5.ma': 'no' }).bag).toMatchObject({ accountType: 'Archer MSA' });
  });

  it('holds the second copy of the same 1099-MISC', () => {
    const first = call('add_1099_misc', { payerName: 'RIVER PROPERTIES', rents: 14400 });
    const second = invokeTaxTool({ tool: 'add_1099_misc', args: { payerName: 'RIVER PROPERTIES', rents: 14400 }, context: { ...context, sourceDocumentId: 'PHOTO' } });
    if (!second.ok) throw new Error(second.error);
    expect(validateImportedFacts([...first, ...second.facts]).heldForms).toEqual(['PHOTO#0']);
  });
});

describe('1099-OID classification', () => {
  it('identifies a 1099-OID from its printed title', () => {
    const c = classifyDocument({
      text: 'Form 1099-OID Original Issue Discount Copy B For Recipient 1 Original issue discount for the year 2 Other periodic interest 6 Acquisition premium',
    } as Parameters<typeof classifyDocument>[0]);
    expect(c).toMatchObject({ formType: '1099-OID', incomeType: '1099oid' });
  });
});
