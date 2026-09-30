/**
 * The practice's case queue (work order §36, §69): every case with its status
 * and what is open, most urgent first — the dashboard's rows, and the case a
 * preparer moves to next.
 */

import { calculateForm1040, FilingStatus, type TaxReturn } from '@hatax/engine';
import { listReturns } from '../api/client';
import { loadReviewRecord } from './caseAudit';
import { buildCaseReview, type CaseStatus } from './caseReview';
import { loadDocuments } from './documentIngestion';
import { caseMissingDocuments } from './missingDocuments';
import { loadTaxFacts } from './preparerTaxFacts';

export interface CaseRow {
  id: string;
  name: string;
  taxYear: number;
  status: CaseStatus;
  open: number;
  documents: number;
  refundAmount?: number;
  amountOwed?: number;
  updatedAt: string;
}

/** Most urgent first: what needs the preparer, then what is ready, then what waits on others. */
export const STATUS_ORDER: CaseStatus[] = ['needs_attention', 'needs_review', 'ready', 'waiting_for_documents', 'approved'];

/** The statuses a preparer works a case in. */
const WORK: ReadonlySet<CaseStatus> = new Set(['needs_attention', 'needs_review', 'ready']);

export function clientName(tr: TaxReturn): string {
  const names = [[tr.firstName, tr.lastName], [tr.spouseFirstName, tr.spouseLastName]]
    .map((p) => p.filter(Boolean).join(' '))
    .filter(Boolean);
  return names.join(' & ') || 'New client';
}

export function summarizeCase(tr: TaxReturn): CaseRow {
  const calculation = (() => {
    try {
      return calculateForm1040({ ...tr, filingStatus: tr.filingStatus || FilingStatus.Single });
    } catch {
      return null;
    }
  })();
  const documents = loadDocuments(tr.id);
  const facts = loadTaxFacts(tr.id);
  const review = buildCaseReview({
    taxReturn: tr,
    calculation,
    facts,
    documents,
    record: loadReviewRecord(tr.id),
    missingDocuments: caseMissingDocuments(tr, facts, documents),
  });
  return {
    id: tr.id,
    name: clientName(tr),
    taxYear: tr.taxYear,
    status: review.status,
    open: review.open.length,
    documents: documents.length,
    ...(calculation ? { refundAmount: calculation.form1040.refundAmount, amountOwed: calculation.form1040.amountOwed } : {}),
    updatedAt: tr.updatedAt,
  };
}

export function sortCases(rows: CaseRow[]): CaseRow[] {
  return [...rows].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Every case, most urgent first. */
export function caseQueue(): CaseRow[] {
  return sortCases(listReturns().map(summarizeCase));
}

/** The next case that needs the preparer, other than the one open; null when none does. */
export function nextCase(currentId: string | null): CaseRow | null {
  return caseQueue().find((r) => r.id !== currentId && WORK.has(r.status)) ?? null;
}
