/**
 * Forms Mode — Syncfusion PDF Viewer Wrapper
 *
 * Uses deferred initialization via requestAnimationFrame to survive React
 * StrictMode's mount→unmount→remount cycle. Without this, the first mount's
 * WASM worker gets destroyed mid-init, corrupting the global WASM state.
 */
import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { PdfViewer, Toolbar, Magnification, Navigation, FormFields, FormDesigner, Print, TextSearch } from '@syncfusion/ej2-pdfviewer';
import type { FormFieldFocusOutEventArgs } from '@syncfusion/ej2-pdfviewer';
import { useCaseStore } from '../../store/caseStore';
import type { IRSFormTemplate } from '@hatax/engine';
import { classifyFields } from '@hatax/engine';
import type { ClassifiedField } from '@hatax/engine';
import { populateFormFields, updateComputedFields, enforceReadOnlyDOM, pdfLibToNormalizedKey, normalizeSyncfusionName } from '../../services/formsModeFiller';
import { ensureDiscoveryFlags } from '../../services/formsModeSync';
import { resolveSourcePathFromLineId } from '../../services/traceFormLinker';

PdfViewer.Inject(Toolbar, Magnification, Navigation, FormFields, FormDesigner, Print, TextSearch);

const RESOURCE_URL = `${window.location.origin}/ej2-pdfviewer-lib`;

/** Clears the current field highlight, if any. Set by focusFieldOnPdf. */
let clearCurrentHighlight: (() => void) | null = null;

/**
 * Navigate to a PDF field and highlight it with an amber outline.
 * The highlight persists until clearCurrentHighlight() is called
 * (triggered by clicking elsewhere on the PDF or selecting another field).
 */
function focusFieldOnPdf(
  viewer: PdfViewer,
  cf: ClassifiedField,
): void {
  // Clear any existing highlight first
  if (clearCurrentHighlight) {
    clearCurrentHighlight();
    clearCurrentHighlight = null;
  }

  // Try formFieldCollections first, then retrieveFormFields() as fallback
  let formFields = viewer.formFieldCollections;
  if (!formFields?.length) {
    try { formFields = viewer.retrieveFormFields(); } catch { /* noop */ }
  }
  if (!formFields?.length) return;

  const normalizedKey = pdfLibToNormalizedKey(cf.mapping.pdfFieldName);
  const pdfField = formFields.find(
    (ff) => normalizeSyncfusionName((ff as never as Record<string, string>).name) === normalizedKey,
  );
  if (!pdfField) return;

  const fieldId = (pdfField as never as Record<string, string>).id;

  // Navigate to the field's page (pageIndex is 0-based, goToPage is 1-based)
  const pageIndex = ((pdfField as never as Record<string, number>).pageIndex ?? 0);
  try {
    viewer.navigation.goToPage(pageIndex + 1);
  } catch { /* viewer may not support goToPage in all states */ }

  // Apply highlight via direct DOM styling after page navigation settles
  setTimeout(() => {
    if (!fieldId) return;
    const el =
      document.getElementById(fieldId + '_content_html_element') ||
      document.getElementById(fieldId + '_input_element') ||
      document.getElementById(fieldId);
    if (!el) return;

    const wrapper = el.closest('[style*="position"]') as HTMLElement || el.parentElement as HTMLElement || el;

    const prev = {
      outline: wrapper.style.outline,
      boxShadow: wrapper.style.boxShadow,
      transition: wrapper.style.transition,
    };

    wrapper.style.transition = 'outline 0.15s, box-shadow 0.15s';
    wrapper.style.outline = '3px solid #F59E0B';
    wrapper.style.boxShadow = '0 0 12px rgba(245, 158, 11, 0.5)';

    // Store cleanup function — called when user clicks elsewhere or selects another field
    clearCurrentHighlight = () => {
      wrapper.style.outline = prev.outline;
      wrapper.style.boxShadow = prev.boxShadow;
      setTimeout(() => { wrapper.style.transition = prev.transition; }, 200);
    };
  }, 300);
}

/**
 * Find a PDF field matching the given trace lineId and scroll/highlight it.
 * Uses the lineId→sourcePath mapping to locate the correct form field.
 */
function focusFieldByLineId(
  viewer: PdfViewer,
  lineId: string,
  classifiedFields: ClassifiedField[],
): void {
  const targetSourcePath = resolveSourcePathFromLineId(lineId);
  if (!targetSourcePath) return;

  const targetCf = classifiedFields.find(cf => cf.mapping.sourcePath === targetSourcePath);
  if (!targetCf) return;

  focusFieldOnPdf(viewer, targetCf);
}

interface PdfFormViewerProps {
  template: IRSFormTemplate;
  instanceIndex: number;
}

export default function PdfFormViewer({ template, instanceIndex }: PdfFormViewerProps) {
  const viewerRef = useRef<PdfViewer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { taxReturn, calculation, updateDeepField, updateField } = useCaseStore();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const pdfUrl = `${window.location.origin}/irs-forms/${template.pdfFileName}`;

  const fields = useMemo(() => {
    if (!taxReturn || !calculation) return template.fields;
    if (template.fieldsForInstance) {
      return template.fieldsForInstance(instanceIndex, taxReturn, calculation);
    }
    return template.fields;
  }, [template, instanceIndex, taxReturn, calculation]);

  const classifiedFields = useMemo(() => classifyFields(fields), [fields]);

  // Key by normalized name so Syncfusion's reversed field names match our pdf-lib-style names.
  // pdfLibToNormalizedKey reverses segments + strips non-alphanumeric to match Syncfusion's format.
  const fieldMap = useMemo(() => {
    const map = new Map<string, ClassifiedField>();
    for (const cf of classifiedFields) {
      map.set(pdfLibToNormalizedKey(cf.mapping.pdfFieldName), cf);
    }
    return map;
  }, [classifiedFields]);

  // Deferred init: requestAnimationFrame ensures the callback only fires
  // AFTER StrictMode's first mount→unmount cycle completes. The cancelled
  // flag prevents viewer creation if cleanup runs before rAF fires.
  useEffect(() => {
    let cancelled = false;

    const frameId = requestAnimationFrame(() => {
      if (cancelled) return;
      const el = containerRef.current;
      if (!el) return;

      const viewer = new PdfViewer({
        resourceUrl: RESOURCE_URL,
        documentPath: pdfUrl,
        enableFormFields: true,
        enableFormDesigner: true,
        enableAnnotation: false,
        toolbarSettings: {
          showTooltip: true,
          toolbarItems: ['PageNavigationTool', 'MagnificationTool', 'SearchOption', 'PrintTool', 'DownloadTool'] as never,
        },
        height: '100%',
        width: '100%',
        documentLoad: () => {
          setStatus('ready');
          const st = useCaseStore.getState();
          if (st.taxReturn && st.calculation) {
            try {
              populateFormFields(viewer, template, st.taxReturn, st.calculation, classifiedFields);
            } catch (e) {
              console.error('[FormsMode] populate error:', e);
            }
            // Enforce read-only on computed fields after Syncfusion finishes rendering DOM
            setTimeout(() => {
              try { enforceReadOnlyDOM(viewer, classifiedFields); } catch { /* best-effort */ }
            }, 500);
          }
          // Focus the pending field if navigated from audit trail
          if (st.pendingFocusLineId) {
            focusFieldByLineId(viewer, st.pendingFocusLineId, classifiedFields);
            useCaseStore.getState().clearPendingFocus();
          }
        },
        documentLoadFailed: () => {
          setStatus('error');
          setErrorMsg(`Failed to load ${template.displayName}. Check browser console.`);
        },
      });

      viewer.appendTo(el);
      viewerRef.current = viewer;
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      if (viewerRef.current) {
        try { viewerRef.current.destroy(); } catch { /* ignore */ }
        viewerRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bind form field edit handler
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.formFieldFocusOut = (args: FormFieldFocusOutEventArgs) => {
      if (!taxReturn || !args.fieldName || typeof args.fieldName !== 'string') return;
      const cf = fieldMap.get(normalizeSyncfusionName(args.fieldName));
      if (!cf || !cf.isEditable) return;

      const displayValue = args.value ?? '';

      if (cf.mapping.validate) {
        const err = cf.mapping.validate(displayValue, taxReturn);
        if (err) return;
      }

      let storageValue: unknown;
      if (cf.mapping.inverseTransform) {
        storageValue = cf.mapping.inverseTransform(displayValue, taxReturn);
        if (cf.mapping.formLabel?.startsWith('Line') && typeof storageValue === 'object' && storageValue !== null) {
          updateField('itemizedDeductions', storageValue);
          ensureDiscoveryFlags(template.formId, taxReturn, updateField);
          return;
        }
      } else if (cf.mapping.format === 'dollarNoCents' || cf.mapping.format === 'dollarCents' || cf.mapping.format === 'integer') {
        storageValue = Number(displayValue.replace(/[,$]/g, '')) || 0;
      } else if (cf.mapping.format === 'checkbox') {
        storageValue = displayValue === 'true';
      } else {
        storageValue = displayValue;
      }

      if (cf.writePath) {
        updateDeepField(cf.writePath, storageValue);
      }
      ensureDiscoveryFlags(template.formId, taxReturn, updateField);
    };
  }, [taxReturn, fieldMap, updateDeepField, updateField, template.formId]);

  // Reactive update of computed fields
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !taxReturn || !calculation) return;
    updateComputedFields(viewer, template, taxReturn, calculation, classifiedFields);
  }, [calculation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-enforce read-only DOM whenever Syncfusion re-renders form fields (zoom, page nav, etc.).
  // Uses MutationObserver to detect when Syncfusion rebuilds its DOM elements.
  useEffect(() => {
    const viewer = viewerRef.current;
    const container = containerRef.current;
    if (!viewer || !container || status !== 'ready') return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try { enforceReadOnlyDOM(viewer, classifiedFields); } catch { /* best-effort */ }
      }, 200);
    });

    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [status, classifiedFields]);

  // Clear field highlight when clicking on the PDF background (not on a form field)
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (clearCurrentHighlight) {
      clearCurrentHighlight();
      clearCurrentHighlight = null;
    }
  }, []);

  return (
    <div ref={containerRef} className="flex-1 min-w-0 min-h-0 relative" onClick={handleContainerClick}>
      {status === 'loading' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-800 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-HATaxService-blue-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Loading {template.displayName}...</p>
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-800">
          <div className="text-center max-w-md px-6">
            <p className="text-red-400 font-medium mb-2">Failed to load form</p>
            <p className="text-sm text-slate-400">{errorMsg}</p>
          </div>
        </div>
      )}

    </div>
  );
}
