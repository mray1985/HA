/**
 * Reading uploaded documents with the local models (work order §3–§4, §33, §47).
 *
 * A batch is read in two phases so each model is loaded once (the runtime
 * keeps one model in memory): every page is read by the reader first, then
 * the second reader reads only the boxes the pages could not confirm.
 *
 * A file the models cannot read — the runtime failed, or a page is a form
 * with no extraction schema (W-2G, K-1, 1098-E, 1095-A) — is returned for the
 * text-layer / OCR path, with the reason; nothing is guessed.
 */

import {
  finishReading,
  readPagePrimary,
  readPageSecond,
  selectDocumentExtractKind,
  type IngestedDocument,
  type PageReading,
  type PrimaryReading,
  type ReaderPage,
} from '@hatax/local-ai';
import { localVisionModel, type ModelRunRecord } from './localModels';
import { imageReaderPages, pdfReaderPages } from './pagePreparation';

export interface ModelReadItem {
  document: IngestedDocument;
  file: File;
}

export type ModelReadResult =
  | { item: ModelReadItem; readings: PageReading[]; seconds: number }
  | { item: ModelReadItem; fallback: string };

export async function readWithLocalModels(
  items: ModelReadItem[],
  onProgress: (message: string) => void,
  runs: ModelRunRecord[] = [],
): Promise<ModelReadResult[]> {
  const model = localVisionModel(runs);
  const started = new Map<ModelReadItem, number>();
  const primary = new Map<ModelReadItem, Array<{ page: ReaderPage; reading: PrimaryReading }>>();
  const results = new Map<ModelReadItem, ModelReadResult>();

  // Phase 1: every page on the reader.
  for (const item of items) {
    started.set(item, Date.now());
    try {
      const isImage = selectDocumentExtractKind({ mimeType: item.file.type, fileName: item.file.name }) === 'image';
      onProgress(`Preparing ${item.file.name}…`);
      const pages = isImage ? await imageReaderPages(item.file) : await pdfReaderPages(item.file, (n, of) => onProgress(`Preparing ${item.file.name} (page ${n} of ${of})…`));
      const read: Array<{ page: ReaderPage; reading: PrimaryReading }> = [];
      for (const page of pages) {
        onProgress(`Reading ${item.file.name}${pages.length > 1 ? ` (page ${page.pageNumber} of ${pages.length})` : ''} with Qwen3.5-0.8B…`);
        read.push({ page, reading: await readPagePrimary(page, model) });
      }
      const unschemed = read.find((r) => r.reading.classification.status === 'classified' && !r.reading.evidence);
      if (unschemed) {
        results.set(item, { item, fallback: `${unschemed.reading.formType} is read from the text layer (the models have no template for it)` });
      } else {
        primary.set(item, read);
      }
    } catch (err) {
      results.set(item, { item, fallback: `the local models could not read it (${err instanceof Error ? err.message : String(err)})` });
    }
  }

  // Phase 2: the second reader, only for what the pages could not settle.
  for (const [item, read] of primary) {
    const readings: PageReading[] = [];
    for (const { page, reading } of read) {
      let second: Awaited<ReturnType<typeof readPageSecond>> = null;
      if (reading.secondReaderKeys.length > 0) {
        onProgress(`Checking ${reading.secondReaderKeys.length} box${reading.secondReaderKeys.length === 1 ? '' : 'es'} of ${item.file.name} with GLM-OCR…`);
        try {
          second = await readPageSecond(reading, page, model);
        } catch {
          // Without a second reading those values stay unconfirmed and are reviewed.
          second = null;
        }
      }
      readings.push(finishReading(reading, page, second));
    }
    results.set(item, { item, readings, seconds: Math.round((Date.now() - started.get(item)!) / 1000) });
  }

  return items.map((item) => results.get(item)!);
}
