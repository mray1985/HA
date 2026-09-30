/**
 * Model OCR bridge for the client extract path.
 *
 * Cascade (work order): Granite Docling Q4_K_M → LightOnOCR Q4_K_M → Tesseract.
 * Browser builds cannot see gitignored models/ or spawn llama-cpp-python, so
 * presence defaults to absent and Tesseract runs. A host (Node / Electron /
 * tests) may register presence + a runner that calls shared ggufOcr.
 *
 * Empty model text must not become zero — callers leave amounts unclassified.
 */

import {
  selectOcrBackend,
  type OcrBackend,
} from '@hatax/local-ai';
import type { TextBlock } from './pdfExtractHelpers';
import { normalizeOCRText } from './ocrTextMatching';

export interface OcrModelPresenceFlags {
  granitePresent: boolean;
  lightonPresent: boolean;
}

export interface ModelOcrRunResult {
  ok: boolean;
  engine: OcrBackend;
  text: string;
  /** Optional pre-built blocks; when omitted, text is split into lines. */
  blocks?: TextBlock[];
}

export type ModelOcrRunner = (input: {
  images: Array<ImageBitmap | HTMLCanvasElement>;
  scaleFactor: number;
  engine: Exclude<OcrBackend, 'tesseract'>;
}) => Promise<ModelOcrRunResult | null>;

let presenceOverride: OcrModelPresenceFlags | null = null;
let modelOcrRunner: ModelOcrRunner | null = null;

/** Tests / desktop hosts: declare whether Q4_K_M OCR GGUFs are on disk. */
export function setOcrModelPresenceForTests(
  presence: OcrModelPresenceFlags | null,
): void {
  presenceOverride = presence;
}

/** Tests / desktop hosts: run Granite/LightOn OCR instead of Tesseract. */
export function registerModelOcrRunner(runner: ModelOcrRunner | null): void {
  modelOcrRunner = runner;
}

export function getOcrModelPresence(): OcrModelPresenceFlags {
  if (presenceOverride) return presenceOverride;
  // Web runtime cannot probe gitignored models/ — treat as absent → Tesseract.
  return { granitePresent: false, lightonPresent: false };
}

export function preferredClientOcrBackend(): OcrBackend {
  return selectOcrBackend(getOcrModelPresence());
}

/** Turn plain OCR text into line TextBlocks (no reliable bboxes from VLMs). */
export function textToOcrLineBlocks(
  text: string,
  page = 1,
  scaleFactor = 1,
): TextBlock[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => normalizeOCRText(l.trim()))
    .filter((l) => l.length > 0);
  const s = scaleFactor || 1;
  return lines.map((line, i) => ({
    text: line,
    x: 0,
    y: (i * 14) / s,
    width: 500 / s,
    height: 12 / s,
    page,
  }));
}

/**
 * Try Granite Docling / LightOnOCR when a runner + model presence say so.
 * Returns null → caller must use Tesseract.
 */
export async function tryPreferredModelOcr(input: {
  images: Array<ImageBitmap | HTMLCanvasElement>;
  scaleFactor?: number;
}): Promise<{ engine: OcrBackend; blocks: TextBlock[] } | null> {
  const backend = preferredClientOcrBackend();
  if (backend === 'tesseract' || !modelOcrRunner) return null;

  try {
    const result = await modelOcrRunner({
      images: input.images,
      scaleFactor: input.scaleFactor ?? 1,
      engine: backend,
    });
    if (!result?.ok) return null;
    if (result.blocks && result.blocks.length > 0) {
      return { engine: result.engine, blocks: result.blocks };
    }
    const text = (result.text ?? '').trim();
    // Empty OCR text → null so caller can still try Tesseract rather than
    // inventing amounts from a blank model response.
    if (!text) return null;
    return {
      engine: result.engine,
      blocks: textToOcrLineBlocks(text, 1, input.scaleFactor ?? 1),
    };
  } catch {
    return null;
  }
}
