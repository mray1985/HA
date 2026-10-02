/**
 * Forms service — deterministic helpers for the form viewer:
 * 1. Form search by name or description
 * 2. Field completeness (sidebar badges)
 */

import type { IRSFormTemplate, TaxReturn, CalculationResult } from '@hatax/engine';
import { classifyFields } from '@hatax/engine';
import { resolveFieldValue } from './formFieldResolver';
import { ALL_TEMPLATES } from './irsFormFiller';

// ─── Form Search ───────────────────────────────────

interface FormSearchResult {
  template: IRSFormTemplate;
  relevance: 'high' | 'medium' | 'low';
  reason: string;
}

/** Keywords mapped to form IDs for common natural-language queries. */
const FORM_KEYWORDS: Record<string, string[]> = {
  f1040: ['1040', 'main', 'return', 'tax return', 'income tax'],
  f1040sa: ['schedule a', 'itemized', 'deductions', 'medical', 'charity', 'mortgage interest', 'salt'],
  f1040sb: ['schedule b', 'interest', 'dividends', 'dividend'],
  f1040sc: ['schedule c', 'business', 'self-employed', 'freelance', 'sole proprietor', '1099-nec', 'profit and loss'],
  f1040sd: ['schedule d', 'capital gains', 'capital losses', 'stock', 'crypto', 'investment'],
  f1040se: ['schedule e', 'rental', 'royalt', 'partnership', 'k-1', 's corp'],
  f1040sf: ['schedule f', 'farm', 'farming', 'agriculture'],
  f1040sh: ['schedule h', 'household', 'nanny', 'domestic'],
  f1040sr: ['schedule r', 'elderly', 'disabled', 'retirement credit'],
  f1040sse: ['schedule se', 'self-employment tax', 'se tax'],
  f1040s1: ['schedule 1', 'additional income', 'adjustments', 'hsa', 'student loan', 'educator', 'alimony'],
  f1040s2: ['schedule 2', 'additional tax', 'amt', 'alternative minimum', 'se tax'],
  f1040s3: ['schedule 3', 'additional credits', 'foreign tax credit', 'education credit', 'estimated tax'],
  f8949: ['8949', 'sales', 'dispositions', 'capital assets', 'stock sale', 'crypto sale'],
  f8962: ['8962', 'premium tax credit', 'ptc', 'marketplace', 'aca', 'obamacare', 'health insurance'],
  f5695: ['5695', 'energy', 'solar', 'clean energy', 'ev charger', 'heat pump', 'residential energy'],
  f8863: ['8863', 'education', 'tuition', 'american opportunity', 'lifetime learning', 'aotc', 'llc'],
  f8889: ['8889', 'hsa', 'health savings', 'health savings account'],
  f4562: ['4562', 'depreciation', 'amortization', 'section 179', 'bonus depreciation'],
  f8936: ['8936', 'ev', 'electric vehicle', 'clean vehicle', 'ev credit'],
  f8911: ['8911', 'ev charger', 'refueling', 'alternative fuel'],
  f4797: ['4797', 'business property', 'sale of property', 'section 1231'],
  f6251: ['6251', 'amt', 'alternative minimum tax'],
  f8606: ['8606', 'ira', 'nondeductible ira', 'roth conversion', 'backdoor roth'],
  f5329: ['5329', 'early distribution', 'penalty', 'retirement penalty', 'ira penalty'],
  f8283: ['8283', 'noncash', 'donation', 'charitable', 'property donation'],
  f2555: ['2555', 'foreign earned', 'foreign income', 'expat', 'living abroad'],
  f8582: ['8582', 'passive', 'passive activity', 'rental loss'],
  f4952: ['4952', 'investment interest', 'margin interest'],
};

/**
 * Search for forms by natural language query.
 * Returns matching templates sorted by relevance.
 */
export function searchForms(
  query: string,
  taxReturn?: TaxReturn | null,
  calculation?: CalculationResult | null,
): FormSearchResult[] {
  const q = query.toLowerCase().trim();
  const results: FormSearchResult[] = [];

  for (const template of ALL_TEMPLATES) {
    const formId = template.formId;
    const keywords = FORM_KEYWORDS[formId] || [];
    const displayLower = template.displayName.toLowerCase();

    // Check display name match
    const nameMatch = displayLower.includes(q) || q.includes(formId.replace('f', ''));

    // Check keyword match
    const keywordMatch = keywords.some(kw => q.includes(kw) || kw.includes(q));

    if (nameMatch || keywordMatch) {
      const isApplicable = taxReturn && calculation
        ? template.condition(taxReturn, calculation)
        : true;

      results.push({
        template,
        relevance: nameMatch && keywordMatch ? 'high' : nameMatch || keywordMatch ? 'medium' : 'low',
        reason: isApplicable
          ? `${template.displayName} — applies to this return`
          : `${template.displayName} — not currently applicable (may need more data)`,
      });
    }
  }

  // Sort: high first, then applicable, then alphabetical
  results.sort((a, b) => {
    const relOrder = { high: 0, medium: 1, low: 2 };
    return relOrder[a.relevance] - relOrder[b.relevance];
  });

  return results;
}

// ─── Field Completeness (Sidebar Badges) ───────────

export interface FormCompleteness {
  formId: string;
  totalEditable: number;
  filled: number;
  /** 0–100 percentage */
  percent: number;
  /** 'complete' (100%), 'partial' (1-99%), 'empty' (0%) */
  status: 'complete' | 'partial' | 'empty';
  /** True if form has errors (e.g., negative values, missing required) */
  hasIssues: boolean;
}

/**
 * Compute field completeness for a single form.
 */
export function getFormCompleteness(
  template: IRSFormTemplate,
  taxReturn: TaxReturn,
  calculation: CalculationResult,
  instanceIndex: number = 0,
): FormCompleteness {
  const fields = template.fieldsForInstance
    ? template.fieldsForInstance(instanceIndex, taxReturn, calculation)
    : template.fields;
  const classified = classifyFields(fields);

  let totalEditable = 0;
  let filled = 0;
  let hasIssues = false;

  for (const cf of classified) {
    if (!cf.isEditable) continue;
    totalEditable++;

    const { rawValue } = resolveFieldValue(cf.mapping, taxReturn, calculation);
    if (rawValue != null && rawValue !== '' && rawValue !== 0) {
      filled++;
    }

    // Flag negative values as issues
    if (typeof rawValue === 'number' && rawValue < 0) {
      hasIssues = true;
    }
  }

  const percent = totalEditable > 0 ? Math.round((filled / totalEditable) * 100) : 100;
  const status = percent === 100 ? 'complete' : percent > 0 ? 'partial' : 'empty';

  return { formId: template.formId, totalEditable, filled, percent, status, hasIssues };
}
