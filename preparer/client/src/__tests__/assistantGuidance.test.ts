import { describe, it, expect } from 'vitest';
import type { IngestedDocument } from '@hatax/local-ai';
import { assistantTurns, type AssistantInput } from '../services/assistantTurns';
import type { ReviewItem } from '../services/caseReview';

const doc = (over: Partial<IngestedDocument> = {}): IngestedDocument =>
  ({
    documentId: 'doc-1',
    returnId: 'r1',
    fileName: 'k1.pdf',
    mimeType: 'application/pdf',
    byteLength: 10,
    contentHash: 'h',
    ingestedAt: '2026-01-01',
    status: 'extracted',
    ...over,
  }) as IngestedDocument;

const input = (over: Partial<AssistantInput> = {}): AssistantInput => ({
  items: [],
  facts: [],
  documents: [],
  questions: [],
  clientName: 'Test',
  ...over,
});

/** The item caseReview builds for a form that was read but not entered. */
const notApplied = (formType: string, index = 0): ReviewItem =>
  ({
    id: `document:not-applied:doc-1#${index}`,
    category: 'REVIEW',
    group: 'documents',
    source: 'document',
    documentId: 'doc-1',
    message: `k1.pdf: the ${formType} was read but is not entered automatically — enter it on the return.`,
  }) as ReviewItem;

describe('a form read but not entered is explained, not just flagged', () => {
  it('says what the form is and what it does to the return', () => {
    const turns = assistantTurns(
      input({
        items: [notApplied('1099-K')],
        documents: [doc({ formTypes: ['1099-K'], classifications: [
          { status: 'classified', formType: '1099-K', confidence: 'high', reason: 'r', matchedMarkers: [], source: 'text_markers' },
        ] })],
      }),
    );
    const turn = turns.find((t) => t.id.startsWith('document:not-applied:'))!;
    expect(turn).toBeDefined();
    // What it is, and what it does — not "it was not entered".
    expect(turn.say).toMatch(/payment company reporting card/i);
    expect(turn.say).toMatch(/self-employment/i);
    expect(turn.say).not.toMatch(/not entered automatically/);
  });

  it('tells the preparer what to do, in the form\'s own words', () => {
    const turns = assistantTurns(
      input({
        items: [notApplied('K-1')],
        documents: [doc({ fileName: 'k1.pdf', formTypes: ['K-1'] })],
      }),
    );
    const turn = turns.find((t) => t.id.startsWith('document:not-applied:'))!;
    // The K-1's own trap: partnership and S corporation are taxed differently.
    expect(turn.ask).toMatch(/1065/);
    expect(turn.ask).toMatch(/1120-S/);
    // Who had to send it is offered as the reason, not asserted.
    expect(turn.why).toBeTruthy();
  });

  it('falls back to words of its own for a form type it has never heard of', () => {
    const turns = assistantTurns(
      input({
        items: [notApplied('1099-ZZ')],
        documents: [doc({ fileName: 'odd.pdf', formTypes: ['1099-ZZ'] })],
      }),
    );
    const turn = turns.find((t) => t.id.startsWith('document:not-applied:'))!;
    expect(turn.say).toBeTruthy();
    expect(turn.ask).toBeTruthy();
  });

  it('picks the right form when one file holds several', () => {
    const turns = assistantTurns(
      input({
        items: [notApplied('SSA-1099', 1)],
        documents: [doc({
          fileName: 'two.pdf',
          formTypes: ['W-2', 'SSA-1099'],
          classifications: [
            { status: 'classified', formType: 'W-2', confidence: 'high', reason: 'r', matchedMarkers: [], source: 'text_markers' },
            { status: 'classified', formType: 'SSA-1099', confidence: 'high', reason: 'r', matchedMarkers: [], source: 'text_markers' },
          ],
        })],
      }),
    );
    const turn = turns.find((t) => t.id.startsWith('document:not-applied:'))!;
    expect(turn.say).toMatch(/Social Security/i);
  });
});
