import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import type { IRSFormTemplate } from '@hatax/engine';
import { useTaxReturnStore } from '../../store/taxReturnStore';
import { fillIRSForm } from '../../services/irsFormFiller';
import '../../services/pdfWorkerInit';

export default function IRSWorkspaceViewer({ template, sourcePath }: { template: IRSFormTemplate; sourcePath: string }) {
  const tr = useTaxReturnStore(s => s.taxReturn);
  const calc = useTaxReturnStore(s => s.calculation);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState({ width: 612, height: 792 });
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(1);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [message, setMessage] = useState('Loading IRS form…');
  const [bounds, setBounds] = useState<{ x: number; y: number; w: number; h: number; page: number } | null>(null);
  useEffect(() => { setPage(1); }, [template.formId]);
  useEffect(() => {
    let cancelled = false;
    setBytes(null); setMessage('Updating IRS form…');
    if (!tr || !calc) { setMessage('Enter income in the interview to populate the IRS form.'); return; }
    if (tr.taxYear !== 2025) { setMessage(`These installed IRS PDF templates are for 2025. A verified ${tr.taxYear} template set is required to display this return.`); return; }
    fillIRSForm(template, tr, calc, { flatten: false }).then(data => { if (!cancelled) { setBytes(data); setMessage(''); } }).catch(() => { if (!cancelled) setMessage('Could not populate this form. Return to the interview and try again.'); });
    return () => { cancelled = true; };
  }, [template, tr, calc]);
  useEffect(() => {
    let cancelled = false;
    setBounds(null);
    if (!bytes) return;
    void PDFDocument.load(bytes).then(doc => {
      const mapping = template.fields.find(f => f.sourcePath === sourcePath);
      const fields = doc.getForm().getFields();
      const field = mapping && fields.find(f => f.getName() === mapping.pdfFieldName || f.getName().split('.').pop() === mapping.pdfFieldName.split('.').pop());
      const widget = field?.acroField.getWidgets()[0];
      if (!widget || cancelled) return;
      const rect = widget.getRectangle();
      const pages = doc.getPages();
      const pageIndex = pages.findIndex(p => p.ref.toString() === widget.P()?.toString());
      const p = Math.max(0, pageIndex);
      setBounds({ x: rect.x, y: pages[p].getHeight() - rect.y - rect.height, w: rect.width, h: rect.height, page: p + 1 });
      setPage(p + 1);
    }).catch(() => { /* The PDF remains readable if no highlight mapping exists. */ });
    return () => { cancelled = true; };
  }, [bytes, sourcePath, template]);
  useEffect(() => {
    if (!bytes || !canvas.current) return;
    let cancelled = false;
    const task = pdfjs.getDocument({ data: bytes.slice() });
    let render: pdfjs.RenderTask | undefined;
    void task.promise.then(async doc => {
      if (cancelled) return;
      setCount(doc.numPages);
      const pdfPage = await doc.getPage(Math.min(page, doc.numPages));
      if (cancelled || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      const el = document.createElement('canvas');
      el.width = viewport.width; el.height = viewport.height;
      render = pdfPage.render({ canvas: el, viewport });
      await render.promise;
      if (!cancelled && canvas.current) {
        canvas.current.width = el.width; canvas.current.height = el.height;
        canvas.current.getContext('2d')?.drawImage(el, 0, 0);
        setPageSize({ width: viewport.width / 1.5, height: viewport.height / 1.5 });
      }
    }).catch(() => { if (!cancelled) setMessage('Unable to display this PDF. Download it to review.'); });
    return () => { cancelled = true; render?.cancel(); void task.destroy(); };
  }, [bytes, page]);
  useEffect(() => {
    if (!bounds || bounds.page !== page || !scroller.current || !canvas.current) return;
    const scale = canvas.current.clientWidth / pageSize.width;
    scroller.current.scrollTo({ top: Math.max(0, bounds.y * scale - 170), behavior: 'smooth' });
  }, [bounds, page, pageSize]);
  function download() {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = `HA-${tr?.taxYear}-${template.formId}-review.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="ha-pdf" ref={scroller}><div className="ha-pdf-toolbar"><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page} of {count}</span><button disabled={page >= count} onClick={() => setPage(p => p + 1)}>Next</button><button disabled={!bytes} onClick={download}>Download</button></div>{message && <p role="status">{message}</p>}<div className="ha-pdf-page"><canvas ref={canvas} hidden={!bytes} aria-label={`${template.displayName}, page ${page}. Populated values and explanations are available in the adjacent panels.`} role="img" />{bytes && bounds && bounds.page === page && <div aria-hidden="true" className="ha-pdf-highlight" style={{ left: `${bounds.x / pageSize.width * 100}%`, top: `${bounds.y / pageSize.height * 100}%`, width: `${bounds.w / pageSize.width * 100}%`, height: `${bounds.h / pageSize.height * 100}%` }} />}</div></div>;
}
