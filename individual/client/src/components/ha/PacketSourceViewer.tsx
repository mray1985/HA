import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import '../../services/pdfWorkerInit';
import type { PacketSource } from '../../services/taxPacketCorrelation';
import type { PacketDocument } from '../../services/taxPacketReader';

export default function PacketSourceViewer({ document, source }: { document?: PacketDocument; source?: PacketSource }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 612, height: 792 });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!document || !source) return;
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | undefined;
    let render: pdfjs.RenderTask | undefined;
    setMessage('Loading source page…');
    void (async () => {
      const data = new Uint8Array(await document.file.arrayBuffer());
      if (cancelled) return;
      task = pdfjs.getDocument({ data });
      const pdf = await task.promise, page = await pdf.getPage(source.page), viewport = page.getViewport({ scale: 1.5 });
      if (cancelled) return;
      const buffer = window.document.createElement('canvas'); buffer.width = viewport.width; buffer.height = viewport.height;
      render = page.render({ canvas: buffer, viewport });
      await render.promise;
      if (cancelled || !canvas.current) return;
      canvas.current.width = buffer.width; canvas.current.height = buffer.height;
      canvas.current.getContext('2d')?.drawImage(buffer, 0, 0);
      setSize({ width: viewport.width / 1.5, height: viewport.height / 1.5 }); setMessage('');
    })().catch(() => { if (!cancelled) setMessage('Could not render this source page. Use the extracted text and original PDF to review it.'); });
    return () => { cancelled = true; render?.cancel(); void task?.destroy(); };
  }, [document, source?.page]);
  useEffect(() => { if (source && canvas.current && scroll.current) scroll.current.scrollTo({ top: Math.max(0, source.y * canvas.current.clientWidth / size.width - 140) }); }, [source, size]);
  if (!document || !source) return <p>Select extracted text to see its original page.</p>;
  return <div><p className="ha-small">{document.name} · page {source.page}</p><p role="status">{message}</p><div className="ha-packet-source" ref={scroll}><div className="ha-pdf-page"><canvas ref={canvas} role="img" aria-label={`${document.name}, page ${source.page}. Selected text: ${source.text}`} /><div className="ha-pdf-highlight" aria-hidden="true" style={{ left: `${source.x / size.width * 100}%`, top: `${source.y / size.height * 100}%`, width: `${source.width / size.width * 100}%`, height: `${source.height / size.height * 100}%` }} /></div></div></div>;
}
