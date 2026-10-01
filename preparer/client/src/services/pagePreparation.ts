/**
 * Pages for the local document reader (work order §3–§4): each page of a PDF
 * or photo as the models see it and as page evidence reads it.
 *
 * - Evidence page: rendered at 200 dpi (the resolution the checkbox reader was
 *   measured at) as grayscale, with word boxes from the PDF text layer or,
 *   when the page has none (a scan or a photo), from Tesseract after it
 *   straightens the page.
 * - Model image: the same page at about 150 dpi (letter width 1,275 px), which
 *   bounds the model's image tokens on a CPU.
 *
 * Runs in the browser; nothing leaves the computer.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PDFJS_DOCUMENT_OPTIONS } from './pdfWorkerInit';
import { wordsFromTesseract, type PageRaster, type PageWord, type ReaderPage, type TesseractBlocks } from '@hatax/local-ai';
import { recognizeUpright } from './ocrService';

const EVIDENCE_DPI = 200;
const MODEL_WIDTH = 1275;
/** Pages read per file — a statement or brokerage package can be long. */
export const MAX_PAGES = 12;

function grayscale(canvas: HTMLCanvasElement): PageRaster {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  }
  return { width: canvas.width, height: canvas.height, gray };
}

function modelImage(canvas: HTMLCanvasElement): string {
  const scale = Math.min(1, MODEL_WIDTH / canvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/png').split(',')[1]!;
}

async function canvasFromDataUrl(url: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return canvas;
}

/** A scanned page or photo: Tesseract straightens it and supplies the words. */
async function ocrPage(canvas: HTMLCanvasElement, pageNumber: number): Promise<ReaderPage> {
  const { data } = await recognizeUpright(canvas);
  const upright = data.imageGrey ? await canvasFromDataUrl(data.imageGrey) : canvas;
  return {
    pageNumber,
    words: wordsFromTesseract(data as unknown as TesseractBlocks),
    raster: grayscale(upright),
    imagePng: modelImage(upright),
  };
}

/** Pages of a PDF: text-layer words where the page has them, OCR otherwise. */
export async function pdfReaderPages(file: File, onPage?: (n: number, of: number) => void): Promise<ReaderPage[]> {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), ...PDFJS_DOCUMENT_OPTIONS }).promise;
  try {
    const count = Math.min(pdf.numPages, MAX_PAGES);
    const pages: ReaderPage[] = [];
    for (let n = 1; n <= count; n++) {
      onPage?.(n, count);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: EVIDENCE_DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;

      const content = await page.getTextContent();
      const words: PageWord[] = [];
      for (const item of content.items as Array<{ str?: string; transform: number[]; width: number; height: number }>) {
        if (!item.str || !item.str.trim()) continue;
        const [x0, y0] = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
        const h = (item.height || Math.abs(item.transform[3]!)) * viewport.scale;
        const w = item.width * viewport.scale;
        words.push({ text: item.str, source: 'pdf-text', box: [x0!, y0! - h, x0! + w, y0!] });
      }
      // A page with no text layer is a scan: read it with OCR.
      pages.push(words.length >= 5
        ? { pageNumber: n, words, raster: grayscale(canvas), imagePng: modelImage(canvas) }
        : await ocrPage(canvas, n));
    }
    return pages;
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

/** A photo or image of one form. */
export async function imageReaderPages(file: File): Promise<ReaderPage[]> {
  const url = URL.createObjectURL(file);
  try {
    return [await ocrPage(await canvasFromDataUrl(url), 1)];
  } finally {
    URL.revokeObjectURL(url);
  }
}
