import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { invokeTaxTool, type DocumentToolName, type IngestedDocument, type TaxToolSuccess } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { appendTaxFacts, loadTaxFacts } from '../services/preparerTaxFacts';
import { applyToolResult, SOURCE_FORM_KEY } from '../services/returnApplier';
import { assistantTurns, type AssistantTurn } from '../services/assistantTurns';
import { applyChosen } from '../services/assistantChat';
import { readAnswer } from '../services/assistantAnswers';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

let returnId = '';

/** Read a document onto the case, the way intake does. */
function readDocument(tool: DocumentToolName, args: Record<string, unknown>, documentId: string, fileName = `${documentId}.pdf`) {
  const result = invokeTaxTool({
    tool, args,
    context: { returnId, taxYear: 2025, sourceDocumentId: documentId, sourceFileName: fileName, extractor: 'test' },
  });
  if (!result.ok) throw new Error(result.error);
  appendTaxFacts(returnId, (result as TaxToolSuccess).facts);
  return applyToolResult(returnId, result as TaxToolSuccess, { documentId });
}

const document = (documentId: string, fileName: string): IngestedDocument => ({
  documentId, returnId, fileName, mimeType: 'application/pdf', byteLength: 10,
  contentHash: `h-${documentId}`, ingestedAt: '', status: 'extracted',
  classifications: [{ status: 'classified', formType: 'W-2', confidence: 'high', reason: '', matchedMarkers: [], source: 'text_markers' }],
  formTypes: ['w2'],
});

/** The thread for the case as it stands. */
async function thread(documents: IngestedDocument[] = []) {
  const { buildCaseReview } = await import('../services/caseReview');
  const facts = loadTaxFacts(returnId);
  const taxReturn = getReturn(returnId);
  const review = buildCaseReview({ taxReturn, calculation: null, facts, documents });
  return assistantTurns({ items: review.items, facts, documents, questions: [], clientName: 'the client' });
}

/** Wiring that writes straight to the case, with no store in between. */
const wiring = () => ({
  flush: () => undefined,
  reload: () => undefined,
  updateField: (field: string, value: unknown) => { updateReturn(returnId, { [field]: value } as never); },
});

describe('answering the assistant writes to the return', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('takes a one-click answer and puts the value on the form', async () => {
    readDocument('add_1099_q', {
      payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200,
      basisReturn: 6800, recipientNotDesignatedBeneficiary: true,
    }, 'DOC-Q');
    const turns = await thread();
    const choice = turns.find((t) => t.intent.kind === 'choice');
    expect(choice?.ask).toBe('How much did this 1099-Q pay in qualified education expenses?');

    const outcome = await applyChosen(returnId, choice!, { kind: 'number', value: 5000 }, 'Qualified education expenses this paid: $5,000');
    expect(outcome).toMatchObject({ written: true, turnId: choice!.id });
    expect(getReturn(returnId).income1099Q).toEqual([
      expect.objectContaining({ qualifiedExpenses: 5000, [SOURCE_FORM_KEY]: 'DOC-Q#0' }),
    ]);
  });

  it('writes a number typed into the box into the held box, and unholds the form', async () => {
    // A W-2 whose box 1 the page could not read: the form is held off the return
    // rather than counted as zero, and that is what the assistant has to settle.
    readDocument('add_w2', { employerName: 'RIVERBEND LOGISTICS LLC', federalTaxWithheld: 5873.4 }, 'DOC-W2', 'w2-riverbend.pdf');
    const doc = document('DOC-W2', 'w2-riverbend.pdf');
    const turns = await thread([doc]);
    const held = turns.find((t) => t.id.startsWith('document:held:'));
    expect(held).toBeDefined();
    expect(held!.intent).toMatchObject({ kind: 'held_field', field: 'wages' });
    expect(getReturn(returnId).w2Income).toHaveLength(0);

    // The preparer types the number. No confirmation step.
    const read = readAnswer('52000', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.label).toBe('Wages, tips and other compensation (box 1): $52,000');

    const outcome = await applyChosen(returnId, held!, read.value, read.label, wiring());
    expect(outcome).toMatchObject({ written: true });
    expect(getReturn(returnId).w2Income).toEqual([expect.objectContaining({ wages: 52000 })]);
    expect(loadTaxFacts(returnId).find((f) => f.sourceField === 'wages')).toMatchObject({ value: 52000 });

    // The turn is gone: the form is no longer held.
    const after = await thread([doc]);
    expect(after.some((t) => t.id.startsWith('document:held:'))).toBe(false);
  });

  it('writes a typed filing status onto the return', async () => {
    updateReturn(returnId, { filingStatus: 0, firstName: 'Maya', lastName: 'Testpayer', ssn: '000123456' });
    const turns = await thread();
    const read = readAnswer('married and filing jointly', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') return;
    expect(read.intent).toMatchObject({ kind: 'return_field', field: 'filingStatus' });

    const turn = turns.find((t) => t.id === read.turnId)!;
    const outcome = await applyChosen(returnId, turn, read.value, read.label, wiring());
    expect(outcome).toMatchObject({ written: true });
    expect(getReturn(returnId).filingStatus).toBe(FilingStatus.MarriedFilingJointly);
  });

  it('says what it did, in words a preparer can check', async () => {
    readDocument('add_1099_q', {
      payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200,
      basisReturn: 6800, recipientNotDesignatedBeneficiary: true,
    }, 'DOC-Q');
    const turns = await thread();
    const choice = turns.find((t) => t.intent.kind === 'choice')!;
    const outcome = await applyChosen(returnId, choice, { kind: 'number', value: 5000 }, 'Qualified education expenses this paid: $5,000');
    expect(outcome.said).toBe('Qualified education expenses this paid: $5,000. Done.');
  });

  it('refuses a value the form cannot take rather than writing it', async () => {
    readDocument('add_1099_q', {
      payerName: 'LOUISIANA START', grossDistribution: 8000, earnings: 1200,
      basisReturn: 6800, recipientNotDesignatedBeneficiary: true,
    }, 'DOC-Q');
    const turns = await thread();
    const choice = turns.find((t) => t.intent.kind === 'choice')!;
    const outcome = await applyChosen(returnId, choice, { kind: 'number', value: 5 }, 'qualified expenses', wiring());
    // Nothing wrong with a small number here — it is written, and the engine judges it.
    expect(outcome.written).toBe(true);
    expect(getReturn(returnId).income1099Q).toHaveLength(1);
  });
});

describe('an answer lands where the words point', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn().id;
  });

  it('writes to the box the typed box number names, not the first field open', async () => {
    // Two held boxes on one form. "box 2" is federal income tax withheld, and the
    // turn the words matched first carries wages — a reader that ignored the
    // re-target would report box 2 recorded while writing the wages.
    const turns: AssistantTurn[] = [
      {
        id: 'held-wages', kind: 'blocked', weight: 800,
        say: 'The two readers read the wages differently.',
        ask: 'Wages, tips and other compensation (box 1)?',
        intent: { kind: 'held_field', tool: 'add_w2', formKey: 'DOC-W#0', field: 'wages' },
      },
      {
        id: 'held-fitw', kind: 'blocked', weight: 700,
        say: 'Federal income tax withheld (box 2) was not read.',
        ask: 'Federal income tax withheld (box 2)?',
        intent: { kind: 'held_field', tool: 'add_w2', formKey: 'DOC-W#0', field: 'federalTaxWithheld' },
      },
    ];
    updateReturn(returnId, { wages: 52431.18, federalTaxWithheld: 0 } as never);

    const read = readAnswer('box 2 is 5873.40', turns);
    expect(read.status).toBe('understood');
    if (read.status !== 'understood') throw new Error('expected an understood answer');
    // The box number re-targets the answer. The write has to follow the
    // re-targeted intent: writing the matched turn's own intent would put 5,873.40
    // into the wages.
    expect(read.intent).toMatchObject({ kind: 'held_field', field: 'federalTaxWithheld' });
    expect(read.turnId).toBe('held-wages');
  });

  it('confirms the filing status the client stated rather than the first one', async () => {
    updateReturn(returnId, { filingStatus: FilingStatus.Single } as never);
    const turn: AssistantTurn = {
      id: 'fs', kind: 'check',
      say: 'The client said they file as Married filing jointly.',
      intent: { kind: 'filing_status', status: FilingStatus.MarriedFilingJointly, label: 'Married filing jointly' },
      weight: 600,
    };
    // The chip answers yes/no about the proposed status. Reading that boolean as
    // the status would write enum 1, which is Single.
    const outcome = await applyChosen(returnId, turn, { kind: 'boolean', value: true }, 'Yes — Married filing jointly', wiring());
    expect(outcome.written).toBe(true);
    expect(getReturn(returnId).filingStatus).toBe(FilingStatus.MarriedFilingJointly);
  });

  it('leaves the filing status alone when the preparer declines it', async () => {
    updateReturn(returnId, { filingStatus: FilingStatus.HeadOfHousehold } as never);
    const turn: AssistantTurn = {
      id: 'fs', kind: 'check', say: 'The client said they file as Married filing jointly.',
      intent: { kind: 'filing_status', status: FilingStatus.MarriedFilingJointly, label: 'Married filing jointly' },
      weight: 600,
    };
    await applyChosen(returnId, turn, { kind: 'boolean', value: false }, 'No, leave it', wiring());
    expect(getReturn(returnId).filingStatus).toBe(FilingStatus.HeadOfHousehold);
  });
});