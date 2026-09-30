/**
 * Return diagnostics engine (work order §29): every deterministic check of a
 * return, in one list, each with a category.
 *
 *   ERROR          the return contradicts a rule the engine enforces
 *                  (e.g. head of household without a qualifying person)
 *   BLOCKING       the return cannot be finished or filed without it
 *                  (missing name, SSN, filing status, a required form amount)
 *   WARNING        a value that is unusual or inconsistent and must be checked
 *   REVIEW         needs a preparer's eyes: added by the case layer for
 *                  document evidence (unconfirmed or conflicting readings,
 *                  forms held by validation)
 *   INFORMATIONAL  a credit or deduction the facts suggest may be available
 *
 * Run after every meaningful change to the return. Pure: no side effects.
 * Evidence-level review items (unconfirmed readings, held forms) come from
 * the preparer's document pipeline and are added by the case layer.
 */

import type { CalculationResult, TaxReturn } from '../types/index.js';
import { findUnsupportedPatterns } from '../engine/unsupported.js';
import { buildDocumentInventory } from './documentInventory.js';
import { checkExportReadiness } from './readiness.js';
import { getReturnWarnings } from './returnWarnings.js';
import { getSuggestions } from './suggestions.js';

export * from './dateValidation.js';
export * from './documentInventory.js';
export * from './readiness.js';
export * from './returnWarnings.js';
export * from './suggestions.js';

export type DiagnosticCategory = 'ERROR' | 'BLOCKING' | 'WARNING' | 'REVIEW' | 'INFORMATIONAL';

/** Most severe first. */
export const DIAGNOSTIC_CATEGORIES: readonly DiagnosticCategory[] = ['ERROR', 'BLOCKING', 'WARNING', 'REVIEW', 'INFORMATIONAL'];

export type DiagnosticSource = 'filing_status' | 'readiness' | 'inventory' | 'validation' | 'suggestion' | 'unsupported';

export interface Diagnostic {
  /** Stable across runs for the same finding, so a preparer's resolution can be kept. */
  id: string;
  category: DiagnosticCategory;
  source: DiagnosticSource;
  /** Return section the finding concerns, e.g. 'dependents', 'w2_income'. */
  section: string;
  message: string;
  /** Return field path, e.g. 'w2Income[0].federalTaxWithheld', when one applies. */
  field?: string;
  itemIndex?: number;
  itemLabel?: string;
  /** Estimated benefit in dollars (suggestions), when calculable. */
  estimatedBenefit?: number;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function runReturnDiagnostics(taxReturn: TaxReturn, calculation?: CalculationResult | null): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Filing-status rules the engine enforces (IRC §2(b), §2(a), §6013(a)(2)).
  const statusChecks = [
    ['hoh', calculation?.hohValidation],
    ['deceased-spouse', calculation?.deceasedSpouseValidation],
  ] as const;
  for (const [name, result] of statusChecks) {
    if (!result) continue;
    for (const message of result.errors) {
      out.push({ id: `filing_status:${name}:${slug(message)}`, category: 'ERROR', source: 'filing_status', section: 'filing_status', field: 'filingStatus', message });
    }
    for (const message of result.warnings) {
      out.push({ id: `filing_status:${name}:${slug(message)}`, category: 'WARNING', source: 'filing_status', section: 'filing_status', field: 'filingStatus', message });
    }
  }

  // Required information for a complete return.
  for (const issue of checkExportReadiness(taxReturn).blockers) {
    out.push({
      id: `readiness:${issue.sectionId}:${slug(issue.message)}`,
      category: issue.severity === 'blocker' ? 'BLOCKING' : 'WARNING',
      source: 'readiness',
      section: issue.sectionId,
      message: issue.message,
    });
  }

  // What the engine cannot compute to the official rules is never approximated (engine/unsupported.ts).
  for (const u of calculation?.unsupported ?? findUnsupportedPatterns(taxReturn)) {
    out.push({
      id: `unsupported:${u.ruleId}:${u.jurisdiction}`,
      category: 'BLOCKING',
      source: 'unsupported',
      section: u.section === 'state' ? `state_${u.jurisdiction.toLowerCase()}` : u.section,
      message: u.message,
    });
  }

  // Form entries missing required amounts.
  const inventory = buildDocumentInventory(taxReturn);
  for (const group of inventory.incomeGroups) {
    group.entries.forEach((entry, index) => {
      if (entry.status !== 'missing_required') return;
      out.push({
        id: `inventory:${group.formType}:${entry.id}`,
        category: 'BLOCKING',
        source: 'inventory',
        section: group.section,
        message: `${group.formLabel} "${entry.label}" is missing required amounts: ${entry.missingRequired.join(', ')}.`,
        itemIndex: index,
        itemLabel: entry.label,
      });
    });
  }

  // Validation and plausibility warnings.
  for (const w of getReturnWarnings(taxReturn, calculation)) {
    out.push({
      id: `validation:${w.section}:${w.field}:${w.itemIndex ?? ''}:${slug(w.message)}`,
      category: 'WARNING',
      source: 'validation',
      section: w.section,
      field: w.field,
      message: w.message,
      ...(w.itemIndex !== undefined ? { itemIndex: w.itemIndex } : {}),
      ...(w.itemLabel ? { itemLabel: w.itemLabel } : {}),
    });
  }

  // Credits and deductions the facts suggest.
  for (const s of getSuggestions(taxReturn, calculation ?? undefined)) {
    out.push({
      id: `suggestion:${s.id}`,
      category: 'INFORMATIONAL',
      source: 'suggestion',
      section: s.section,
      message: `${s.title}: ${s.description}`,
      ...(s.estimatedBenefit !== undefined ? { estimatedBenefit: s.estimatedBenefit } : {}),
    });
  }

  return out.sort((a, b) => DIAGNOSTIC_CATEGORIES.indexOf(a.category) - DIAGNOSTIC_CATEGORIES.indexOf(b.category));
}
