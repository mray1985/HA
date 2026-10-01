/**
 * Page evidence loaders for the gauntlet: text-layer words for native PDFs,
 * Tesseract words for scans, and the grayscale raster the checkbox reader uses.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wordsFromTesseract, type PageRaster, type PageWord, type TesseractBlocks } from '../src/pageEvidence.js';

const require = createRequire(import.meta.url);

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
export const OUT_DIR = join(HERE, 'out');

export interface GauntletPage {
  words: PageWord[];
  raster: PageRaster;
}

export interface ScanPage extends GauntletPage {
  ocrMs: number;
  skewDeg: number;
  /** The straightened page (PNG) — what the model is shown. */
  deskewed: Buffer;
}

async function grayscale(bytes: Buffer): Promise<PageRaster> {
  const { loadImage, createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
  const gray = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  }
  return { width: img.width, height: img.height, gray };
}

/**
 * Page evidence for a native-PDF case: text-layer words in PNG pixel space and
 * the PNG as grayscale.
 */
export async function nativePage(caseId: string, png: string): Promise<GauntletPage> {
  const raster = await grayscale(readFileSync(png));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(sep).join('/') + '/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(OUT_DIR, `${caseId}.pdf`))), standardFontDataUrl: fonts }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const sx = raster.width / vp.width;
  const sy = raster.height / vp.height;
  const content = await page.getTextContent();
  const words: PageWord[] = [];
  for (const item of content.items as Array<{ str?: string; transform: number[]; width: number; height: number }>) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4]!;
    const y = item.transform[5]!;
    const h = item.height || Math.abs(item.transform[3]!);
    words.push({ text: item.str, source: 'pdf-text', box: [x * sx, (vp.height - y - h) * sy, (x + item.width) * sx, (vp.height - y) * sy] });
  }
  await doc.destroy();
  return { words, raster };
}

type TesseractWorker = {
  recognize: (img: Buffer, opts: object, out: object) => Promise<{ data: TesseractBlocks & { imageGrey?: string; rotateRadians?: number } }>;
  terminate: () => Promise<unknown>;
};
let worker: TesseractWorker | null = null;

/**
 * Page evidence for a scanned case: no text layer, so words come from
 * Tesseract (the OCR engine bundled with the app). Tesseract straightens the
 * page (rotateAuto) and returns word boxes in the straightened image, so
 * checkboxes and locations are read on an upright page. Results are cached
 * per image under out/ocr-cache.
 */
export async function scanPage(png: string): Promise<ScanPage> {
  const cacheDir = join(OUT_DIR, 'ocr-cache');
  const stamp = `${statSync(png).size}-${Math.round(statSync(png).mtimeMs)}`;
  const base = join(cacheDir, png.split(/[\\/]/).pop()!.replace(/\.png$/, ''));
  if (existsSync(`${base}.json`)) {
    const cached = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as { stamp: string; words: PageWord[]; ocrMs: number; skewDeg: number };
    if (cached.stamp === stamp && existsSync(`${base}.png`)) {
      const deskewed = readFileSync(`${base}.png`);
      return { words: cached.words, raster: await grayscale(deskewed), ocrMs: cached.ocrMs, skewDeg: cached.skewDeg, deskewed };
    }
  }
  if (!worker) {
    const { createWorker } = require('tesseract.js');
    worker = (await createWorker('eng', 1, { langPath: join(REPO, 'client', 'public', 'tesseract-data'), gzip: true, cachePath: OUT_DIR })) as TesseractWorker;
  }
  const t0 = Date.now();
  const { data } = await worker.recognize(readFileSync(png), { rotateAuto: true }, { blocks: true, imageGrey: true });
  const ocrMs = Date.now() - t0;
  const deskewed = Buffer.from(String(data.imageGrey).split(',')[1] ?? '', 'base64');
  const words = wordsFromTesseract(data);
  const skewDeg = ((data.rotateRadians ?? 0) * 180) / Math.PI;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${base}.png`, deskewed);
  writeFileSync(`${base}.json`, JSON.stringify({ stamp, words, ocrMs, skewDeg }));
  return { words, raster: await grayscale(deskewed), ocrMs, skewDeg, deskewed };
}

export async function closeOcr(): Promise<void> {
  if (worker) await worker.terminate();
  worker = null;
}
