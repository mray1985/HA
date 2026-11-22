import * as pdfjs from 'pdfjs-dist';
import './pdfWorkerInit';
import { correlateTaxPacket, type PacketBlock, type TaxPacketReport } from './taxPacketCorrelation';

export interface PacketDocument { id: string; name: string; file: File; pageCount: number; }
export async function readTaxPacket(files: File[], onProgress: (message: string) => void, useOCR: boolean, signal?: AbortSignal): Promise<{ report: TaxPacketReport; documents: PacketDocument[] }> {
  if (!files.length || files.length > 12) throw new Error('Choose 1–12 PDF files for one packet.');
  if (files.some(f => f.size > 25 * 1024 * 1024)) throw new Error('Each PDF must be 25 MB or smaller.');
  const blocks: PacketBlock[] = [], documents: PacketDocument[] = [];
  let totalPages = 0;
  for (const file of files) {
    if (signal?.aborted) throw new Error('Reading cancelled.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (documents.some(d => d.id === id)) throw new Error('The same document was selected more than once.');
    const task = pdfjs.getDocument({ data: bytes });
    try {
      const pdf = await task.promise;
      totalPages += pdf.numPages;
      if (totalPages > 200) throw new Error('This group exceeds 200 pages. Split it into smaller packets; no pages have been silently skipped.');
      documents.push({ id, name: file.name, file, pageCount: pdf.numPages });
      for (let p = 1; p <= pdf.numPages; p++) {
        if (signal?.aborted) throw new Error('Reading cancelled.');
        onProgress(`Reading ${file.name} · page ${p} of ${pdf.numPages}`);
        const page = await pdf.getPage(p), viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let pageBlocks: PacketBlock[] = content.items.flatMap(item => {
          if (!('str' in item) || !item.str.trim()) return [];
          const h = Math.max(8, item.height || Math.abs(item.transform[3]));
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([item.transform[4], item.transform[5], item.transform[4] + item.width, item.transform[5] + h]);
          return [{ documentId: id, fileName: file.name, page: p, text: item.str.trim(), x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }];
        });
        // Interactive PDF values may be absent from the normal text layer.
        const annotations = await page.getAnnotations();
        for (const a of annotations) {
          if (a.subtype !== 'Widget' || !a.fieldValue || typeof a.fieldValue !== 'string' || !a.rect) continue;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
          const x = Math.min(x1, x2), y = Math.min(y1, y2);
          if (pageBlocks.some(b => b.text === a.fieldValue && Math.abs(b.x - x) < 12 && Math.abs(b.y - y) < 12)) continue;
          pageBlocks.push({ documentId: id, fileName: file.name, page: p, text: a.fieldValue, x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
        }
        if (pageBlocks.reduce((n, b) => n + b.text.length, 0) < 40 && useOCR) {
          onProgress(`Reading scanned text in ${file.name} · page ${p}`);
          const canvas = document.createElement('canvas'), scaled = page.getViewport({ scale: 3 });
          canvas.width = scaled.width; canvas.height = scaled.height;
          try {
            await page.render({ canvas, viewport: scaled }).promise;
            const { recognizeImage } = await import('./ocrService');
            const recognized = await recognizeImage(canvas, undefined, 3);
            pageBlocks = recognized.map(b => ({ ...b, documentId: id, fileName: file.name, page: p, ocr: true }));
          } finally { canvas.width = 0; canvas.height = 0; }
        }
        if (!pageBlocks.length) pageBlocks.push({ documentId: id, fileName: file.name, page: p, text: '', x: 0, y: 0, width: 0, height: 0 });
        blocks.push(...pageBlocks);
        page.cleanup();
      }
    } finally { await task.destroy(); }
  }
  const report = correlateTaxPacket(blocks, documents.map(d => d.id.slice(0, 16)).sort().join('-'));
  return { report, documents };
}
