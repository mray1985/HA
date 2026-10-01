/**
 * Married couples whose documents started two cases: each spouse's W-2 names
 * only that spouse, so a batch makes a case for each. The joint return takes
 * the other case's person as the spouse, with that case's documents (their
 * facts and source files) — each form applied on the joint return, a W-2 or
 * 1099-R marked as the spouse's — and the other case is removed. Never done
 * unasked: the review offers it, and the preparer joins the cases.
 */

import { FilingStatus, type TaxReturn } from '@hatax/engine';
import { formKeyOf } from '@hatax/local-ai';
import { deleteReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { appendAudit } from './caseAudit';
import { clientNameOf } from './caseIdentity';
import { loadDocumentFile, saveDocumentFile } from './documentFiles';
import { loadDocuments, upsertDocument } from './documentIngestion';
import { reapplyForm } from './preparerDecisions';
import { loadTaxFacts, saveTaxFacts } from './preparerTaxFacts';
import { markSpouseItems } from './returnApplier';

export interface SpouseCase {
  returnId: string;
  name: string;
  documents: number;
  /** The other case's taxpayer is this return's spouse, or the two cases are one household. */
  why: 'spouse_ssn' | 'household';
}

const digits = (s: string | undefined) => (s ?? '').replace(/\D/g, '');
const same = (a: string | undefined, b: string | undefined) => Boolean(a?.trim()) && a!.trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const separately = (r: TaxReturn) => r.filingStatus === FilingStatus.MarriedFilingSeparately;

/**
 * The other cases of the year that may be this return's spouse: the one whose
 * taxpayer has this return's spouse SSN, or — when neither has a spouse — one
 * with the same last name, street address and ZIP code. Married filing
 * separately is the couple's choice: those are never offered.
 */
export function spouseCaseCandidates(returnId: string): SpouseCase[] {
  const tr = getReturn(returnId);
  if (separately(tr)) return [];
  const out: SpouseCase[] = [];
  for (const other of listReturns()) {
    if (other.id === returnId || other.taxYear !== tr.taxYear || separately(other)) continue;
    const name = clientNameOf(other);
    const documents = loadDocuments(other.id).length;
    if (digits(tr.spouseSsn) && digits(other.ssn) === digits(tr.spouseSsn)) {
      out.push({ returnId: other.id, name, documents, why: 'spouse_ssn' });
      continue;
    }
    const noSpouse = (r: TaxReturn) => !r.spouseSsn && !r.spouseFirstName;
    if (noSpouse(tr) && noSpouse(other) && same(tr.lastName, other.lastName) && same(tr.addressStreet, other.addressStreet) && same(tr.addressZip, other.addressZip)) {
      out.push({ returnId: other.id, name, documents, why: 'household' });
    }
  }
  return out;
}

/** Join the other case to this one as its spouse: the person, the documents and every form on them. */
export async function joinSpouseCase(intoId: string, fromId: string): Promise<{ ok: true; moved: string[] } | { ok: false; error: string }> {
  const into = getReturn(intoId);
  const from = getReturn(fromId);
  if (into.taxYear !== from.taxYear) return { ok: false, error: 'The cases are for different tax years.' };
  if (digits(into.spouseSsn) && digits(from.ssn) && digits(into.spouseSsn) !== digits(from.ssn)) {
    return { ok: false, error: `This return already has a spouse other than ${clientNameOf(from)}.` };
  }

  // The other case's taxpayer is the spouse.
  updateReturn(intoId, {
    ...(from.firstName ? { spouseFirstName: from.firstName } : {}),
    ...(from.lastName ? { spouseLastName: from.lastName } : {}),
    ...(from.ssn ? { spouseSsn: from.ssn } : from.ssnLastFour ? { spouseSsnLastFour: from.ssnLastFour } : {}),
    ...(from.dateOfBirth ? { spouseDateOfBirth: from.dateOfBirth } : {}),
  });

  // Its documents, their facts and their source files.
  const have = new Set(loadDocuments(intoId).map((d) => d.documentId));
  const moving = loadDocuments(fromId).filter((d) => !have.has(d.documentId));
  for (const doc of moving) {
    upsertDocument(intoId, { ...doc, returnId: intoId });
    const file = await loadDocumentFile(fromId, doc.documentId);
    if (file) await saveDocumentFile(intoId, doc.documentId, file);
  }
  const movingIds = new Set(moving.map((d) => d.documentId));
  const facts = loadTaxFacts(fromId).filter((f) => movingIds.has(f.sourceDocumentId));
  saveTaxFacts(intoId, [...loadTaxFacts(intoId), ...facts.map((f) => ({ ...f, returnId: intoId }))]);

  // Each form on the joint return, by the same applier as the documents.
  for (const formKey of new Set(facts.map((f) => formKeyOf(f)))) reapplyForm(intoId, formKey);
  markSpouseItems(intoId);

  const moved = moving.map((d) => d.fileName);
  appendAudit(intoId, {
    kind: 'decision',
    subject: 'Joint return',
    detail: `${clientNameOf(from)}'s ${from.taxYear} case joined as the spouse${moved.length ? `, with ${moved.join(', ')}` : ''}`,
  });
  deleteReturn(fromId);
  return { ok: true, moved };
}
