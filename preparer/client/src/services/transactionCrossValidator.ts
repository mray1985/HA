/**
 * Transaction Cross-Validator
 *
 * Runs the deterministic pattern engine against AI-categorized transactions
 * to boost or reduce confidence:
 *
 *   AI + Pattern agree    → confidence: HIGH
 *   AI only (no pattern)  → confidence: unchanged (MEDIUM or as AI said)
 *   AI and Pattern differ → confidence: LOW (flagged for review)
 *   Pattern says X, AI says PERSONAL → confidence: LOW (flag)
 *
 * Also applies deterministic gates from the tax context:
 *   - Childcare requires minorDependentCount > 0
 *   - Medical itemized requires deductionMethod = 'itemized' (or warns)
 *   - Home office requires hasScheduleC or hasHomeOffice flag
 *   - Vehicle business use requires hasScheduleC
 */

import type { NormalizedTransaction, ReturnContext } from './deductionFinderTypes';
import type { CategorizedTransaction, TransactionCategory } from './transactionCategorizerTypes';
import { scanForSignals } from './deductionFinderEngine';
import type { DeductionInsight, InsightCategory } from './deductionFinderTypes';

// ─── Category Mapping ──────────────────────────────

/** Map pattern engine InsightCategory → TransactionCategory. */
const INSIGHT_TO_CATEGORY: Partial<Record<InsightCategory, TransactionCategory>> = {
  student_loan: 'student_loan',
  childcare: 'childcare',
  charitable: 'charitable',
  mortgage: 'personal', // mortgage payments aren't a deduction category here
  hsa: 'hsa',
  medical: 'medical',
  home_office_supplies: 'home_office',
  se_health_insurance: 'health_insurance_se',
  educator_expenses: 'education',
  retirement_contributions: 'retirement',
  tax_prep: 'business_expense',
  business_software: 'business_expense',
  business_travel: 'business_expense',
  business_telecom: 'business_expense',
  energy_efficiency: 'personal', // energy credits are separate
  therapy_mental_health: 'medical',
  advertising_marketing: 'business_expense',
  payment_processing_fees: 'business_expense',
  contract_labor: 'business_expense',
  vehicle_business: 'vehicle',
  professional_development: 'business_expense',
  coworking_office_rent: 'business_expense',
  business_insurance: 'business_expense',
  gambling_losses: 'personal',
  education_credits: 'education',
  salt_property_tax: 'salt',
  business_meals: 'business_expense',
  military_moving: 'personal',
  professional_dues: 'business_expense',
  continuing_education: 'education',
};

// ─── Deterministic Gates ───────────────────────────

interface GateResult {
  blocked: boolean;
  reason?: string;
}

/** Check if a category assignment is valid given the tax context + user hints. */
function checkGate(category: TransactionCategory, context: ReturnContext, hints?: Record<string, boolean>): GateResult {
  // User-confirmed self-employment overrides hasScheduleC check
  const isSelfEmployed = context.hasScheduleC || hints?.isSelfEmployed === true;
  const hasKids = context.minorDependentCount > 0 || hints?.hasKids === true;
  const worksFromHome = context.hasHomeOffice || hints?.worksFromHome === true;

  switch (category) {
    case 'childcare':
      if (!hasKids) {
        return { blocked: true, reason: 'No dependents under 13 — childcare credit requires qualifying children' };
      }
      break;

    case 'home_office':
      if (!isSelfEmployed && !worksFromHome) {
        return { blocked: false, reason: 'Home office deduction typically requires self-employment (Schedule C)' };
      }
      break;

    case 'vehicle':
      if (!isSelfEmployed) {
        return { blocked: false, reason: 'Business vehicle deduction requires self-employment — commuting is not deductible' };
      }
      break;

    case 'business_expense':
      if (!isSelfEmployed) {
        return { blocked: true, reason: 'Business expenses require self-employment (Schedule C)' };
      }
      break;

    case 'health_insurance_se':
      if (!isSelfEmployed) {
        return { blocked: true, reason: 'SE health insurance deduction requires self-employment' };
      }
      break;

    case 'rental_property':
      // No gate check — user may not have entered rental yet
      break;

    case 'medical':
      if (context.deductionMethod === 'standard') {
        return { blocked: false, reason: 'Medical deductions require itemizing (only amount exceeding 7.5% of AGI is deductible)' };
      }
      break;

    case 'charitable':
      if (context.deductionMethod === 'standard') {
        return { blocked: false, reason: 'Charitable deductions require itemizing for amounts above $300' };
      }
      break;
  }

  return { blocked: false };
}

/**
 * Transactions the deduction-finder pattern engine matched (merchant tokens,
 * evidence and negative tokens, MCC codes, return-context gates), by index.
 */
function patternCategories(allTransactions: NormalizedTransaction[], context: ReturnContext): Map<number, InsightCategory> {
  const matches = new Map<number, InsightCategory>();
  for (const insight of scanForSignals(allTransactions, context)) {
    for (const desc of insight.sampleDescriptions) {
      for (let i = 0; i < allTransactions.length; i++) {
        if (allTransactions[i].description.toUpperCase().includes(desc.toUpperCase())) {
          matches.set(i, insight.category);
        }
      }
    }
  }
  return matches;
}

// ─── Rule categorization ───────────────────────────

/**
 * Categorize transactions by rules alone: the pattern engine's matches, then
 * the category gates above. A transaction no rule matches stays personal with
 * low confidence, for the preparer to review. Nothing leaves the machine.
 */
export function categorizeByRules(
  allTransactions: NormalizedTransaction[],
  context: ReturnContext,
  contextHints?: Record<string, boolean>,
): CategorizedTransaction[] {
  const matches = patternCategories(allTransactions, context);
  return allTransactions.map((transaction, index) => {
    const base = { transactionIndex: index, transaction, subCategory: 'general' as const, source: 'pattern' as const, approved: false, businessUsePercent: 100 };
    const insight = matches.get(index);
    const category = insight ? INSIGHT_TO_CATEGORY[insight] : undefined;
    if (!category) {
      return { ...base, category: 'personal' as TransactionCategory, confidence: 'low' as const, reasoning: 'No rule matched this transaction — review it.' };
    }
    const gate = checkGate(category, context, contextHints);
    if (gate.blocked) {
      return { ...base, category: 'personal' as TransactionCategory, originalCategory: category, confidence: 'low' as const, reasoning: gate.reason ?? 'Blocked by tax context' };
    }
    return { ...base, category, confidence: 'medium' as const, reasoning: gate.reason ?? `Matched the ${insight!.replace(/_/g, ' ')} merchant pattern.` };
  });
}

// ─── Cross-Validation ──────────────────────────────

/**
 * Cross-validate AI-categorized transactions against the pattern engine.
 * Modifies confidence levels in place and returns gate warnings.
 *
 * @param contextHints - User-provided hints from setup screen (overrides return context for gating)
 */
export function crossValidate(
  categorized: CategorizedTransaction[],
  allTransactions: NormalizedTransaction[],
  context: ReturnContext,
  contextHints?: Record<string, boolean>,
): { gateWarnings: Map<number, string> } {
  const patternMatches = patternCategories(allTransactions, context);

  const gateWarnings = new Map<number, string>();

  for (const ct of categorized) {
    const idx = ct.transactionIndex;

    // 1. Apply deterministic gates (respecting user context hints)
    const gate = checkGate(ct.category, context, contextHints);
    if (gate.blocked) {
      // Reclassify to personal if gate blocks it
      ct.originalCategory = ct.category;
      ct.category = 'personal';
      ct.confidence = 'low';
      ct.reasoning = gate.reason || 'Blocked by tax context';
      continue;
    }
    if (gate.reason) {
      gateWarnings.set(idx, gate.reason);
    }

    // 2. Cross-validate with pattern engine
    const patternCategory = patternMatches.get(idx);
    if (!patternCategory) {
      // AI only — no pattern match. Keep AI confidence as-is.
      continue;
    }

    const mappedPatternCategory = INSIGHT_TO_CATEGORY[patternCategory];
    if (!mappedPatternCategory) continue;

    if (mappedPatternCategory === ct.category) {
      // AI and pattern agree — boost to HIGH
      ct.confidence = 'high';
      ct.source = 'both';
    } else if (ct.category === 'personal' && mappedPatternCategory !== 'personal') {
      // Pattern found something but AI said personal — flag for review
      ct.confidence = 'low';
      ct.reasoning = `Pattern engine suggests "${mappedPatternCategory}" but AI classified as personal — please review`;
    } else {
      // AI and pattern disagree — lower confidence
      ct.confidence = 'low';
      ct.reasoning = `AI says "${ct.category}" but pattern engine suggests "${mappedPatternCategory}" — please review`;
    }
  }

  return { gateWarnings };
}
