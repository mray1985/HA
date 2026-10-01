/**
 * Married couples whose documents started two cases: each spouse's W-2 names
 * only that spouse, so a batch makes a case for each. The joint return takes
 * the other case's person as the spouse, with that case's documents (their
 * facts and source files) — each form applied on the joint return, a W-2 or
 * 1099-R marked as the spouse's — and the other case is removed. Never done
 * unasked: the review offers it, and the preparer joins the cases. A case
 * with work beyond its documents is never joined: that work would be lost.
 */

import { FilingStatus, type TaxReturn } from '@hatax/engine';
import { formKeyOf } from '@hatax/local-ai';
import { ARRAY_FIELD_MAP, deleteReturn, getReturn, listReturns, updateReturn } from '../api/client';
import { runBackgroundWork } from './backgroundWork';
import { appendAudit, appendModelRuns, loadAudit, loadModelRuns, loadReviewRecord, mergeAudit } from './caseAudit';
import { clientNameOf } from './caseIdentity';
import { copyDocumentFile, deleteDocumentFile } from './documentFiles';
import { loadDocuments, upsertDocument } from './documentIngestion';
import { reapplyForm } from './preparerDecisions';
import { loadTaxFacts, saveTaxFacts } from './preparerTaxFacts';
import { markSpouseItems, SOURCE_FORM_KEY } from './returnApplier';

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

/** Identity and address edits: the person is copied as the spouse and the joint return keeps its own address. */
const MOVABLE_EDITS = new Set(['firstName', 'lastName', 'ssn', 'dateOfBirth', 'filingStatus', 'addressStreet', 'aptNumber', 'addressCity', 'addressState', 'addressZip']);

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * What the other case holds beyond its documents and its person: client-reply
 * facts, items or edits entered by hand, review decisions. A join moves only
 * the documents and the person and then removes the case, so any of these
 * would be lost — the cases are not joined while there are any.
 */
export function joinBlockers(fromId: string): string[] {
  const from = getReturn(fromId);
  const documents = new Set(loadDocuments(fromId).map((d) => d.documentId));
  const out: string[] = [];
  const otherFacts = loadTaxFacts(fromId).filter((f) => !documents.has(f.sourceDocumentId));
  if (otherFacts.length > 0) out.push(`${count(otherFacts.length, 'fact')} from client replies or notes`);
  const lists = new Set<keyof TaxReturn>([...Object.values(ARRAY_FIELD_MAP), 'stateReturns']);
  const byHand = [...lists].reduce((n, field) => {
    const items = from[field];
    return n + (Array.isArray(items) ? items.filter((i) => !(i as Record<string, unknown>)[SOURCE_FORM_KEY]).length : 0);
  }, 0);
  if (byHand > 0) out.push(`${count(byHand, 'item')} entered by hand`);
  const edits = [...new Set(loadAudit(fromId).flatMap((e) => (e.kind === 'correction' && !MOVABLE_EDITS.has(e.field) ? [e.field] : [])))];
  if (edits.length > 0) out.push(`${count(edits.length, 'field')} edited by hand (${edits.slice(0, 3).join(', ')}${edits.length > 3 ? ', …' : ''})`);
  const record = loadReviewRecord(fromId);
  const decided = Object.keys(record.resolutions).length;
  if (decided > 0) out.push(count(decided, 'review decision'));
  if (record.approval) out.push('its approval');
  return out;
}

/**
 * Join the other case to this one as its spouse: the person, the documents
 * and every form on them, the model runs that read them, and the case's audit
 * trail. Refused while the other case holds anything else (joinBlockers).
 * Every source file is copied and checked before either case changes, and the
 * join is background work, so a lock waits for it.
 */
export function joinSpouseCase(intoId: string, fromId: string): Promise<{ ok: true; moved: string[] } | { ok: false; error: string }> {
  return runBackgroundWork(() => joinNow(intoId, fromId));
}

async function joinNow(intoId: string, fromId: string): Promise<{ ok: true; moved: string[] } | { ok: false; error: string }> {
  const into = getReturn(intoId);
  const from = getReturn(fromId);
  if (into.taxYear !== from.taxYear) return { ok: false, error: 'The cases are for different tax years.' };
  if (digits(into.spouseSsn) && digits(from.ssn) && digits(into.spouseSsn) !== digits(from.ssn)) {
    return { ok: false, error: `This return already has a spouse other than ${clientNameOf(from)}.` };
  }
  const blockers = joinBlockers(fromId);
  if (blockers.length > 0) {
    return { ok: false, error: `${clientNameOf(from)}'s case has ${blockers.join('; ')}, which joining would lose. Enter those details on this return, then remove that case.` };
  }

  // Every source file is copied and checked first: nothing changes unless all are here.
  const have = new Set(loadDocuments(intoId).map((d) => d.documentId));
  const moving = loadDocuments(fromId).filter((d) => !have.has(d.documentId));
  const copied: string[] = [];
  for (const doc of moving) {
    const copy = await copyDocumentFile(fromId, intoId, doc.documentId);
    if (copy === 'failed') {
      for (const id of copied) await deleteDocumentFile(intoId, id);
      return { ok: false, error: `The source file ${doc.fileName} could not be copied, so the cases are not joined. Unlock HATax and try again.` };
    }
    if (copy === 'copied') copied.push(doc.documentId);
  }

  // The other case's taxpayer is the spouse.
  updateReturn(intoId, {
    ...(from.firstName ? { spouseFirstName: from.firstName } : {}),
    ...(from.lastName ? { spouseLastName: from.lastName } : {}),
    ...(from.ssn ? { spouseSsn: from.ssn } : from.ssnLastFour ? { spouseSsnLastFour: from.ssnLastFour } : {}),
    ...(from.dateOfBirth ? { spouseDateOfBirth: from.dateOfBirth } : {}),
  });

  // Its documents, their facts, and the model runs that read them.
  for (const doc of moving) upsertDocument(intoId, { ...doc, returnId: intoId });
  const movingIds = new Set(moving.map((d) => d.documentId));
  const facts = loadTaxFacts(fromId).filter((f) => movingIds.has(f.sourceDocumentId));
  saveTaxFacts(intoId, [...loadTaxFacts(intoId), ...facts.map((f) => ({ ...f, returnId: intoId }))]);
  appendModelRuns(intoId, loadModelRuns(fromId));

  // Each form on the joint return, by the same applier as the documents.
  for (const formKey of new Set(facts.map((f) => formKeyOf(f)))) reapplyForm(intoId, formKey);
  markSpouseItems(intoId);

  // The other case's history stays with the return it joined.
  mergeAudit(intoId, loadAudit(fromId));
  const moved = moving.map((d) => d.fileName);
  appendAudit(intoId, {
    kind: 'decision',
    subject: 'Joint return',
    detail: `${clientNameOf(from)}'s ${from.taxYear} case joined as the spouse${moved.length ? `, with ${moved.join(', ')}` : ''}`,
  });
  deleteReturn(fromId);
  return { ok: true, moved };
}
