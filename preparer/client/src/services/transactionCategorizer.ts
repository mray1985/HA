/**
 * Transaction categorizer — builds the per-category summaries and the result
 * the review screen shows from categorized transactions. Transactions are
 * categorized by rules on the preparer's machine (transactionCrossValidator
 * categorizeByRules); nothing is sent anywhere.
 */

import type {
  CategorizedTransaction,
  CategorySummary,
  CategorizationResult,
  TransactionCategory,
} from './transactionCategorizerTypes';
import { CATEGORY_META } from './transactionCategorizerTypes';

// ─── Summary Builder ───────────────────────────────

/**
 * Build category summaries from categorized transactions.
 */
export function buildCategorySummaries(transactions: CategorizedTransaction[]): CategorySummary[] {
  const map = new Map<TransactionCategory, CategorySummary>();

  for (const ct of transactions) {
    // Include all categories including personal (for review UI)

    const existing = map.get(ct.category);
    const amount = Math.abs(ct.transaction.amount) * (ct.businessUsePercent / 100);

    if (existing) {
      existing.totalAmount += amount;
      existing.transactionCount++;
      existing.confidenceCounts[ct.confidence]++;
    } else {
      const meta = CATEGORY_META[ct.category];
      map.set(ct.category, {
        category: ct.category,
        label: meta.label,
        totalAmount: amount,
        transactionCount: 1,
        confidenceCounts: {
          high: ct.confidence === 'high' ? 1 : 0,
          medium: ct.confidence === 'medium' ? 1 : 0,
          low: ct.confidence === 'low' ? 1 : 0,
        },
        targetForm: meta.targetForm,
        approved: false,
      });
    }
  }

  return [...map.values()].sort((a, b) => b.totalAmount - a.totalAmount);
}

/**
 * Build the full categorization result.
 */
export function buildCategorizationResult(transactions: CategorizedTransaction[]): CategorizationResult {
  const summaries = buildCategorySummaries(transactions);
  const personalCount = transactions.filter(t => t.category === 'personal').length;
  const reviewNeeded = transactions.filter(t => t.category === 'unclear' || t.confidence === 'low').length;
  const deductibleTotal = summaries
    .filter(s => s.category !== 'personal' && s.category !== 'unclear')
    .reduce((sum, s) => sum + s.totalAmount, 0);

  return {
    transactions,
    summaries,
    totalProcessed: transactions.length,
    personalCount,
    reviewNeededCount: reviewNeeded,
    estimatedDeductibleTotal: Math.round(deductibleTotal),
  };
}

