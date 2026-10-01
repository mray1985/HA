/**
 * Deduction Finder Hook
 *
 * Manages the scan lifecycle: file upload → parse → scan → insights.
 * Supports multi-file accumulation with cross-file deduplication.
 *
 * Scan state (transactions, files, insights, AI results) is held in a Zustand
 * store so it survives component unmount/remount during step navigation.
 * Only dismissed/addressed IDs are persisted to the TaxReturn via updateField.
 */

import { useMemo, useCallback, useRef, useState } from 'react';
import { useCaseStore } from '../store/caseStore';
import { useDeductionFinderStore } from '../store/deductionFinderStore';
import { parseTransactionCSV, transactionHash, deduplicateTransactions } from '../services/transactionParser';
import { parsePDFStatement } from '../services/pdfStatementParser';
import { scanForSignals } from '../services/deductionFinderEngine';
import { buildReturnContext } from '../services/deductionFinderContext';
import type {
  DeductionFinderState,
  DeductionInsight,
  NormalizedTransaction,
  UploadedFileInfo,
} from '../services/deductionFinderTypes';
import { buildCategorizationResult } from '../services/transactionCategorizer';
import { categorizeByRules } from '../services/transactionCrossValidator';
import type { CategorizationResult } from '../services/transactionCategorizerTypes';

export interface UseDeductionFinderResult {
  /** All loaded transactions (across all uploaded files) */
  allTransactions: NormalizedTransaction[];
  /** Current scan state (null if no scan has been run) */
  scanState: DeductionFinderState | null;
  /** Insights not yet addressed or dismissed */
  visibleInsights: DeductionInsight[];
  /** Addressed insights (grayed, shown at bottom) */
  addressedInsights: DeductionInsight[];
  /** Dismissed insight count */
  dismissedCount: number;
  /** Whether to show dismissed insights */
  showDismissed: boolean;
  setShowDismissed: (show: boolean) => void;
  /** Dismissed insights (only visible when showDismissed is true) */
  dismissedInsights: DeductionInsight[];
  /** Process an uploaded CSV or PDF file (additive — merges with existing) */
  processFile: (file: File) => Promise<void>;
  /** Remove a previously uploaded file and re-scan */
  removeFile: (fileName: string) => void;
  /** Mark an insight as addressed */
  addressInsight: (id: string) => void;
  /** Dismiss an insight */
  dismissInsight: (id: string) => void;
  /** Whether a file is being processed */
  isProcessing: boolean;
  /** Categorization error message */
  aiError: string | null;
  /** Categorize every transaction by rules, on this machine */
  categorizeTransactions: () => Promise<void>;
  /** Stop showing an in-progress categorization */
  cancelCategorization: () => void;
  /** Categorization result (null if not yet run) */
  categorizationResult: CategorizationResult | null;
  /** Whether categorization is in progress */
  isCategorizing: boolean;
  /** Categorization progress text */
  categorizationProgress: string | null;
  /** Approve all transactions in a category */
  approveCategory: (category: string) => void;
  /** Update a single transaction's category */
  updateTransaction: (index: number, patch: Partial<import('../services/transactionCategorizerTypes').CategorizedTransaction>) => void;
}

export function useDeductionFinder(): UseDeductionFinderResult {
  const taxReturn = useCaseStore((s) => s.taxReturn);
  const calculation = useCaseStore((s) => s.calculation);
  const updateField = useCaseStore((s) => s.updateField);

  // Zustand store — survives unmount
  const scanState = useDeductionFinderStore((s) => s.scanState);
  const setScanState = useDeductionFinderStore((s) => s.setScanState);
  const allTransactions = useDeductionFinderStore((s) => s.allTransactions);
  const setAllTransactions = useDeductionFinderStore((s) => s.setAllTransactions);
  const uploadedFiles = useDeductionFinderStore((s) => s.uploadedFiles);
  const setUploadedFiles = useDeductionFinderStore((s) => s.setUploadedFiles);
  const isProcessing = useDeductionFinderStore((s) => s.isProcessing);
  const setIsProcessing = useDeductionFinderStore((s) => s.setIsProcessing);
  const aiError = useDeductionFinderStore((s) => s.aiError);
  const setAiError = useDeductionFinderStore((s) => s.setAiError);

  // Local UI state (OK to reset on remount)
  const [showDismissed, setShowDismissed] = useState(false);
  const latestRequestIdRef = useRef(0);

  // Read persisted state from TaxReturn
  const addressedIds = useMemo(
    () => new Set(taxReturn?.deductionFinder?.addressedInsightIds ?? []),
    [taxReturn?.deductionFinder?.addressedInsightIds],
  );
  const dismissedIds = useMemo(
    () => new Set(taxReturn?.deductionFinder?.dismissedInsightIds ?? []),
    [taxReturn?.deductionFinder?.dismissedInsightIds],
  );

  // Filter insights into categories
  const visibleInsights = useMemo(() => {
    if (!scanState) return [];
    return scanState.insights.filter(
      (i) => !addressedIds.has(i.id) && !dismissedIds.has(i.id),
    );
  }, [scanState, addressedIds, dismissedIds]);

  const addressedInsights = useMemo(() => {
    if (!scanState) return [];
    return scanState.insights.filter((i) => addressedIds.has(i.id));
  }, [scanState, addressedIds]);

  const dismissedInsights = useMemo(() => {
    if (!scanState) return [];
    return scanState.insights.filter((i) => dismissedIds.has(i.id));
  }, [scanState, dismissedIds]);

  const dismissedCount = dismissedInsights.length;

  /** Run the scan engine on a merged transaction set and update state. */
  const runScan = useCallback((
    merged: NormalizedTransaction[],
    files: UploadedFileInfo[],
    allWarnings: string[],
    crossFileDuplicateCount: number,
  ) => {
    if (!taxReturn) return;
    const context = buildReturnContext(taxReturn, calculation);
    const insights = scanForSignals(merged, context, taxReturn.taxYear);

    setScanState({
      insights,
      fileName: files.length > 0 ? files[files.length - 1].name : '',
      uploadedFiles: files,
      detectedFormat: files.length === 1 ? files[0].format : `${files.length} files`,
      warnings: allWarnings,
      scannedAt: new Date().toISOString(),
      totalTransactionCount: merged.length,
      crossFileDuplicateCount,
    });
  }, [taxReturn, calculation, setScanState]);

  // Process uploaded file — additive (merges with existing transactions)
  const processFile = useCallback(async (file: File) => {
    if (!taxReturn) return;
    setIsProcessing(true);

    try {
      // Parse based on file extension
      const ext = file.name.split('.').pop()?.toLowerCase();
      let newTransactions: NormalizedTransaction[];
      let format: string;
      let fileWarnings: string[];

      if (ext === 'pdf') {
        const result = await parsePDFStatement(file);
        newTransactions = result.transactions;
        format = result.detectedFormat;
        fileWarnings = result.warnings;
      } else {
        const content = await file.text();
        const result = parseTransactionCSV(content);
        newTransactions = result.transactions;
        format = result.detectedFormat;
        fileWarnings = result.warnings;
      }

      // Tag each transaction with source file
      newTransactions = newTransactions.map((t) => ({ ...t, sourceFile: file.name }));

      // Read latest state directly from store (not stale closure) for sequential processing
      const currentTransactions = useDeductionFinderStore.getState().allTransactions;
      const currentFiles = useDeductionFinderStore.getState().uploadedFiles;

      // Merge with existing transactions
      const merged = [...currentTransactions, ...newTransactions];

      // Cross-file deduplication
      const { unique, duplicateCount } = deduplicateTransactions(merged);

      // Build warnings
      const warnings = [...fileWarnings];
      if (duplicateCount > 0) {
        warnings.push(`Removed ${duplicateCount} duplicate(s) across files`);
      }

      // Update file list
      const newFileInfo: UploadedFileInfo = {
        name: file.name,
        format,
        transactionCount: newTransactions.length,
        addedAt: new Date().toISOString(),
      };
      const newFiles = [...currentFiles, newFileInfo];

      // Persist state
      setAllTransactions(unique);
      setUploadedFiles(newFiles);

      // Run engine
      runScan(unique, newFiles, warnings, duplicateCount);
    } catch (err) {
      setScanState({
        insights: scanState?.insights ?? [],
        fileName: file.name,
        uploadedFiles: scanState?.uploadedFiles ?? [],
        detectedFormat: 'error',
        warnings: [`Failed to read ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`],
        scannedAt: new Date().toISOString(),
        totalTransactionCount: scanState?.totalTransactionCount ?? 0,
        crossFileDuplicateCount: scanState?.crossFileDuplicateCount ?? 0,
      });
    } finally {
      setIsProcessing(false);
    }
  }, [taxReturn, calculation, allTransactions, uploadedFiles, runScan, scanState, setScanState, setAllTransactions, setUploadedFiles, setIsProcessing]);

  // Remove a previously uploaded file
  const removeFile = useCallback((fileName: string) => {
    const remaining = allTransactions.filter((t) => t.sourceFile !== fileName);
    const remainingFiles = uploadedFiles.filter((f) => f.name !== fileName);

    setAllTransactions(remaining);
    setUploadedFiles(remainingFiles);

    if (remainingFiles.length === 0) {
      setScanState(null);
    } else {
      runScan(remaining, remainingFiles, [], 0);
    }
  }, [allTransactions, uploadedFiles, runScan, setAllTransactions, setUploadedFiles, setScanState]);

  // Persist addressed/dismissed state
  const addressInsight = useCallback((id: string) => {
    const current = taxReturn?.deductionFinder ?? { addressedInsightIds: [], dismissedInsightIds: [] };
    if (current.addressedInsightIds.includes(id)) return;
    updateField('deductionFinder', {
      ...current,
      addressedInsightIds: [...current.addressedInsightIds, id],
    });
  }, [taxReturn?.deductionFinder, updateField]);

  const dismissInsight = useCallback((id: string) => {
    const current = taxReturn?.deductionFinder ?? { addressedInsightIds: [], dismissedInsightIds: [] };
    if (current.dismissedInsightIds.includes(id)) return;
    updateField('deductionFinder', {
      ...current,
      dismissedInsightIds: [...current.dismissedInsightIds, id],
    });
  }, [taxReturn?.deductionFinder, updateField]);

  // ── New categorizer state ──
  const categorizationResult = useDeductionFinderStore((s) => s.categorizationResult);
  const isCategorizing = useDeductionFinderStore((s) => s.isCategorizing);
  const categorizationProgress = useDeductionFinderStore((s) => s.categorizationProgress);
  const approveCategory = useDeductionFinderStore((s) => s.approveCategory);
  const updateTransaction = useDeductionFinderStore((s) => s.updateCategorizedTransaction);

  const cancelCategorization = useCallback(() => {
    const store = useDeductionFinderStore.getState();
    store.setIsCategorizing(false);
    store.setCategorizationProgress(null);
  }, []);

  // ── Categorization by rules (pattern engine + tax-context gates) ──
  const categorizeTransactions = useCallback(async () => {
    if (!taxReturn || allTransactions.length === 0) return;
    const store = useDeductionFinderStore.getState();
    store.setIsCategorizing(true);
    store.setCategorizationProgress(null);
    setAiError(null);
    try {
      const context = buildReturnContext(taxReturn, calculation);
      const hints = taxReturn.expenseScanner?.contextHints || {};
      const enabled = new Set(store.enabledCategories);
      const categorized = categorizeByRules(allTransactions, context, hints).map((ct) =>
        enabled.size > 0 && ct.category !== 'personal' && !enabled.has(ct.category)
          ? { ...ct, category: 'personal' as const, originalCategory: ct.category, confidence: 'low' as const, reasoning: 'Category not selected for this scan.' }
          : ct,
      );
      store.setCategorizationResult(buildCategorizationResult(categorized));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Categorization failed');
    } finally {
      store.setIsCategorizing(false);
      store.setCategorizationProgress(null);
    }
  }, [taxReturn, calculation, allTransactions, setAiError]);

  return {
    allTransactions,
    scanState,
    visibleInsights,
    addressedInsights,
    dismissedCount,
    showDismissed,
    setShowDismissed,
    dismissedInsights,
    processFile,
    removeFile,
    addressInsight,
    dismissInsight,
    isProcessing,
    aiError,
    categorizeTransactions,
    cancelCategorization,
    categorizationResult,
    isCategorizing,
    categorizationProgress,
    approveCategory,
    updateTransaction,
  };
}
