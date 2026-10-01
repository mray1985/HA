/**
 * Missing documents on a case (work order §23): last year's documents for the
 * same client, compared with this year's (local-ai missingDocuments.ts).
 *
 * Last year comes from, in order: last year's case for the same client in this
 * app (the same SSN; or, where either has none, the same name and date of
 * birth), then the prior-year return imported on this case — its documents
 * when it was a HATax return, its totals otherwise.
 */

import {
  documentAnswers,
  findMissingDocuments,
  priorYearFromCase,
  priorYearFromSummary,
  receivedDocuments,
  type IngestedDocument,
  type MissingDocument,
  type PriorYearEvidence,
  type TaxFact,
} from '@hatax/local-ai';
import type { TaxReturn } from '@hatax/engine';
import { listReturns } from '../api/client';
import { loadTaxFacts } from './preparerTaxFacts';

const ssnOf = (tr: TaxReturn) => {
  const d = (tr.ssn ?? '').replace(/\D/g, '');
  return d.length === 9 ? d : undefined;
};
const name = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The same client: the same SSN; without two SSNs, the same full name and date of birth. */
export function sameClient(a: TaxReturn, b: TaxReturn): boolean {
  const sa = ssnOf(a);
  const sb = ssnOf(b);
  if (sa && sb) return sa === sb;
  return Boolean(name(a.firstName) && name(a.lastName) && a.dateOfBirth &&
    name(a.firstName) === name(b.firstName) && name(a.lastName) === name(b.lastName) && a.dateOfBirth === b.dateOfBirth);
}

/** Last year's case for this client, when exactly one exists. */
export function priorYearCase(taxReturn: TaxReturn): TaxReturn | null {
  const candidates = listReturns().filter((r) => r.id !== taxReturn.id && r.taxYear === taxReturn.taxYear - 1 && sameClient(r, taxReturn));
  return candidates.length === 1 ? candidates[0]! : null;
}

export function priorYearEvidence(taxReturn: TaxReturn): PriorYearEvidence | null {
  const prior = priorYearCase(taxReturn);
  if (prior) return priorYearFromCase(prior, loadTaxFacts(prior.id));
  const summary = taxReturn.priorYearSummary;
  return summary && summary.taxYear === taxReturn.taxYear - 1 ? priorYearFromSummary(summary) : null;
}

/** Last year's documents this case does not have, with the client's answers about them. */
export function caseMissingDocuments(taxReturn: TaxReturn, facts: readonly TaxFact[], documents: readonly IngestedDocument[]): MissingDocument[] {
  const classified = documents.flatMap((d) => d.formTypes ?? []);
  return findMissingDocuments(priorYearEvidence(taxReturn), receivedDocuments(facts, taxReturn, classified), documentAnswers(facts));
}
