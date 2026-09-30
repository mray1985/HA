import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingStatus } from '@hatax/engine';
import { invokeTaxTool } from '@hatax/local-ai';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { loadAudit, loadModelRuns } from '../services/caseAudit';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { acceptNoteOffer, caseQuestionLetter, caseQuestions, readClientReply } from '../services/clientReplies';
import { applyStatedFilingStatus } from '../services/preparerDecisions';
import { loadTaxFacts, saveTaxFacts } from '../services/preparerTaxFacts';
import { recordPriorYearDependents } from '../services/recordTools';

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

/** The local reader, answering each question's prompt as `answers` says. */
function stubReader(answers: Array<[RegExp, Record<string, unknown>]>) {
  let n = 0;
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const { prompt } = JSON.parse(init?.body ?? '{}') as { prompt: string };
    // A question's text is on the prompt's second line; a note call is matched by its instruction.
    const target = prompt.startsWith('A client of a tax preparer') ? prompt.split('\n').slice(-2).join('\n') : prompt.split('\n')[1] ?? '';
    const found = answers.find(([re]) => re.test(target));
    n += 1;
    return new Response(JSON.stringify({
      content: JSON.stringify(found ? found[1] : { quote: '', answer: 'not_stated' }),
      run: { runId: `run-${n}`, role: 'reader', modelId: 'qwen3.5-0.8b', modelName: 'Qwen3.5-0.8B', quantization: 'Q4_K_M', revision: 'r', weightsSha256: 'a'.repeat(64), startedAt: '2026-09-30T00:00:00Z', ms: 800, ok: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let returnId = '';
const review = () => buildCaseReview({ taxReturn: getReturn(returnId), facts: loadTaxFacts(returnId), documents: [] });

describe("a client's reply on a case (§24, §25)", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    returnId = createReturn(2025).id;
    updateReturn(returnId, { w2Income: [{ id: 'w', employerName: 'Acme', wages: 48000, federalTaxWithheld: 4000 }] });
    recordPriorYearDependents(returnId, [{ firstName: 'Maya', lastName: 'Lee', relationship: 'DAUGHTER' }], 2024);
  });

  it('asks only what the case cannot settle', () => {
    expect(caseQuestions(returnId).map((q) => q.text)).toEqual([
      'How do you want to file your 2025 return: single, married filing jointly, married filing separately, head of household, or qualifying surviving spouse?',
      'How many months of 2025 did Maya live with you?',
    ]);
    expect(caseQuestionLetter(returnId)).toContain('We still need to confirm:\n\n1. How do you want to file');
  });

  it('records the answers the model and the words agree on, and keeps the reply', async () => {
    stubReader([
      [/How many months/, { quote: 'Maya lived with us all year', answer: '12' }],
      [/How do you want to file/, { quote: 'We will file jointly', answer: 'married_filing_jointly' }],
    ]);
    const reply = 'Hi! Maya lived with us all year. We will file jointly again.';
    const result = await readClientReply(returnId, reply);

    expect(result.answers.map((a) => a.outcome.status)).toEqual(['answered', 'answered']);
    // Maya is on the return now, from the client's verified answer.
    expect(getReturn(returnId).dependents).toEqual([expect.objectContaining({ firstName: 'Maya', lastName: 'Lee', monthsLivedWithYou: 12 })]);
    const months = loadTaxFacts(returnId).find((f) => f.factType === 'DEPENDENT_monthsLivedWithYou' && f.sourceKind === 'client_response');
    expect(months).toMatchObject({ value: 12, verified: true, rawText: 'Maya lived with us all year', modelRunId: 'run-2' });
    // Two questions, then the reply read as a note (dependents and payments; it names no state).
    expect(loadModelRuns(returnId).map((r) => r.runId)).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
    expect(result.offers).toEqual([]);

    // The stated filing status waits for the preparer.
    expect(getReturn(returnId).filingStatus).toBeFalsy();
    const item = review().items.find((i) => i.action?.kind === 'filing_status');
    expect(item?.message).toContain('states the filing status married filing jointly ("We will file jointly")');
    expect(applyStatedFilingStatus(returnId, FilingStatus.MarriedFilingJointly, 'married filing jointly')).toMatchObject({ ok: true });
    expect(getReturn(returnId).filingStatus).toBe(FilingStatus.MarriedFilingJointly);
    expect(review().items.some((i) => i.action?.kind === 'filing_status')).toBe(false);

    // The reply is in the audit trail word for word, with each answer.
    const trail = loadAudit(returnId);
    expect(trail).toContainEqual(expect.objectContaining({ kind: 'client_reply', text: reply, answered: 2, left: 0 }));
    expect(trail).toContainEqual(expect.objectContaining({ kind: 'client_answer', recorded: true, answer: '12 months', quote: 'Maya lived with us all year' }));
    expect(caseQuestions(returnId)).toEqual([]);
  });

  it('records nothing the words do not state, and says why', async () => {
    stubReader([[/How many months/, { quote: 'Maya lived with us 8 months', answer: '12' }]]);
    const result = await readClientReply(returnId, 'Maya lived with us 8 months.');
    expect(result.answers.map((a) => a.outcome)).toEqual([
      { status: 'not_answered' },
      { status: 'unclear', reason: "the model read 12 but the client's words state 8", quote: 'Maya lived with us 8 months' },
    ]);
    expect(getReturn(returnId).dependents).toEqual([]);
    expect(loadTaxFacts(returnId).some((f) => f.sourceKind === 'client_response')).toBe(false);
    expect(loadAudit(returnId)).toContainEqual(expect.objectContaining({ kind: 'client_answer', recorded: false, detail: "the model read 12 but the client's words state 8" }));
  });

  it("puts a 1099-Q on the return once the client's qualified expenses are confirmed", async () => {
    updateReturn(returnId, { filingStatus: FilingStatus.Single });
    const form = invokeTaxTool({
      tool: 'add_1099_q',
      args: { payerName: 'VANGUARD 529 PLAN', grossDistribution: 15000, earnings: 3200, basisReturn: 11800, recipientNotDesignatedBeneficiary: false },
      context: { returnId, taxYear: 2025, sourceDocumentId: 'Q-DOC', sourceFileName: '1099q.pdf', extractor: 'test' },
    });
    if (!form.ok) throw new Error(form.error);
    saveTaxFacts(returnId, [...loadTaxFacts(returnId), ...form.facts]);
    expect(caseQuestions(returnId).map((q) => q.kind)).toEqual(['months', 'amount']);

    stubReader([[/qualified education expenses/, { quote: 'we paid $14,250 in tuition', answer: '14250' }]]);
    await readClientReply(returnId, 'For the 529, we paid $14,250 in tuition and fees.');
    expect(getReturn(returnId).income1099Q).toEqual([expect.objectContaining({ grossDistribution: 15000, qualifiedExpenses: 14250 })]);
    expect(loadTaxFacts(returnId).find((f) => f.factType === '1099Q_qualifiedExpenses')).toMatchObject({ sourceKind: 'client_response', verified: true, sourceDocumentId: 'Q-DOC', rawText: 'we paid $14,250 in tuition' });
  });

  it('offers a new dependent a note states, recorded only when the preparer adds it', async () => {
    updateReturn(returnId, { filingStatus: FilingStatus.Single });
    stubReader([[/List each child or relative/, { people: [{ quote: 'we had a baby girl, Lily Lee, born March 3, 2025', firstName: 'Lily', lastName: 'Lee', relationship: 'Daughter', dateOfBirth: '2025-03-03' }] }]]);
    const result = await readClientReply(returnId, 'Big news: we had a baby girl, Lily Lee, born March 3, 2025!');
    expect(result.offers.map((o) => o.description)).toEqual(['Add Lily Lee as a dependent (born 2025-03-03)']);
    expect(result.offers[0]!.proposal.dropped).toEqual(['relationship']);
    // Nothing is recorded until the preparer adds it.
    expect(loadTaxFacts(returnId).some((f) => f.sourceFileName.startsWith('Client reply'))).toBe(false);

    expect(acceptNoteOffer(returnId, result, result.offers[0]!, 0)).toMatchObject({ ok: true });
    const lily = loadTaxFacts(returnId).filter((f) => f.factType.startsWith('DEPENDENT_') && f.sourceKind === 'client_response');
    expect(lily.map((f) => [f.sourceField, f.value, f.verified])).toEqual([['firstName', 'Lily', true], ['lastName', 'Lee', true], ['dateOfBirth', '2025-03-03', true]]);
    // What the note did not say is asked next.
    expect(caseQuestions(returnId).map((q) => q.text)).toContain('How is Lily Lee related to you?');
    expect(loadAudit(returnId)).toContainEqual(expect.objectContaining({ kind: 'client_note', accepted: true, description: 'Add Lily Lee as a dependent (born 2025-03-03)' }));
  });
});
