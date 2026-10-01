/**
 * Reading a tax form page with the approved local models (work order §3–§4,
 * §33) — the product's pipeline, which the model gauntlet also runs.
 *
 *   1. The reader (Qwen3.5-0.8B) reports the printed form number and tax year
 *      under a JSON grammar whose form number is an enum of the known forms.
 *   2. It fills that form's extraction template under a JSON grammar that
 *      always allows "" for a blank box (a grammar forbidding "" made models
 *      write 0 into blank boxes).
 *   3. Page evidence (deterministic): every value is located on the page,
 *      checkboxes and W-2 box 12 are read from the page, values the page does
 *      not print are dropped, and boxes left blank although the page prints an
 *      amount are found.
 *   4. The second reader (GLM-OCR) reads only what the page could not confirm
 *      and the boxes the reader missed.
 *   5. Deterministic mapping of the verified values to the form tool's
 *      arguments, with each argument's source boxes and locations.
 *
 * Browser-safe: the models are reached through a `VisionModel`, which the app
 * implements over its local model runtime and the gauntlet over llama-server.
 * Steps 1–3 and 4 are separate calls, so a batch can run every page on the
 * reader before loading the second reader once (one model in memory at a time).
 */

import {
  classifyModelReading,
  CLASSIFIABLE_FORM_TYPES,
  type ClassifiableFormType,
  type DocumentClassification,
} from './documentClassifier.js';
import { applyPageEvidence, type FormEvidenceResult, type PageEvidence } from './formEvidence.js';
import {
  boxValuesFromTemplate,
  buildExtractionTemplate,
  getFormExtractionSchema,
  mapBoxesToTool,
  type FormExtractionSchema,
  type ToolMapping,
} from './formSchemas.js';
import type { ModelRole } from './modelManifest.js';
import type { PixelBox } from './pageEvidence.js';
import {
  keysNeedingSecondReader,
  secondReaderSchema,
  valuesAfterVerification,
  verifyReadings,
  type FieldReading,
} from './secondReading.js';
import { identityFromValues, type PartyIdentity } from './identity.js';
import { extractStructuredFields } from './structuredExtraction.js';
import type { TaxFactSecondReading, TaxFactSourceLocation } from './taxFact.js';
import type { DocumentToolName } from './taxTools.js';

/** Reader prompt (measured best for Qwen3.5-0.8B: gauntlet style "plain"). */
export const READER_PROMPT =
  'Fill in this JSON with the values printed in each box of the tax form in the image. ' +
  'Copy each value exactly as printed. Use "" for a blank box; never write 0 for a blank box. ' +
  'The value is never the printed box label.\n';

/** Second-reader prompt: GLM-OCR's documented information-extraction prompt. */
export const SECOND_READER_PROMPT = '请按下列JSON格式输出图中信息:\n';

export interface ModelCallResult {
  content: string;
  ms: number;
  /** The runtime's record of this call (model provenance, §42). */
  runId?: string;
}

/** One grammar-constrained call to a vision model. */
export interface VisionModel {
  chat(role: ModelRole, request: { imagePng: string; prompt: string; name: string; jsonSchema: Record<string, unknown> }): Promise<ModelCallResult>;
}

export interface ReaderPage extends PageEvidence {
  /** The page image the model sees (PNG, base64, about 150 dpi). */
  imagePng: string;
  /** 1-based page number in its file. */
  pageNumber: number;
}

export interface ModelRun {
  role: ModelRole;
  stage: 'classify' | 'extract' | 'second';
  ms: number;
  runId?: string;
}

/** Steps 1–3: what the reader and the page establish. */
export interface PrimaryReading {
  pageNumber: number;
  formType: ClassifiableFormType | null;
  /** The tax year the reader saw printed, as text. */
  taxYearPrinted?: string;
  /** Why the page is (not) a known form. */
  classificationReason: string;
  /** The model's form number checked against the page's printed markers. */
  classification: DocumentClassification;
  /** Box values the reader transcribed, before page evidence. */
  modelValues: Record<string, string>;
  evidence: FormEvidenceResult | null;
  /** Keys the second reader should read (unconfirmed and missed boxes). */
  secondReaderKeys: string[];
  runs: ModelRun[];
}

/** Steps 4–5: the verified reading and the tool arguments it maps to. */
export interface PageReading extends PrimaryReading {
  readings: FieldReading[];
  /** Box values after page evidence and second-reader verification. */
  values: Record<string, string>;
  mapping: ToolMapping | null;
  tool: DocumentToolName | null;
  /** The form tool's arguments (unreadable values present as undefined → unknown facts). */
  args: Record<string, unknown>;
  rawText: Record<string, string>;
  /** Where each argument's value was printed (page pixel box), when located. */
  locations: Record<string, { page: number; box: PixelBox; pageSize: { width: number; height: number } }>;
  /** The second reader's text per argument, where it read one of the argument's boxes. */
  secondReadings: Record<string, { text: string; agrees: boolean }>;
  /**
   * Agreement score per argument: 1 when the page or the second reader
   * confirmed it, 0.5 when only the reader read it, 0 when readers disagree.
   */
  confidence: Record<string, number>;
  /** The person the form is about (employee, recipient, borrower), with what an independent reader confirmed. */
  identity: PartyIdentity | null;
}

const FORM_NUMBER = 'Form number';
const TAX_YEAR = 'Tax year';

function parse(content: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Steps 1–3 on one page with the reader. */
export async function readPagePrimary(page: ReaderPage, model: VisionModel): Promise<PrimaryReading> {
  const runs: ModelRun[] = [];
  const classifyTemplate = { [FORM_NUMBER]: '', [TAX_YEAR]: '' };
  const c = await model.chat('reader', {
    imagePng: page.imagePng,
    prompt: READER_PROMPT + JSON.stringify(classifyTemplate, null, 2),
    name: 'classify',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: [FORM_NUMBER, TAX_YEAR],
      properties: {
        [FORM_NUMBER]: { type: 'string', enum: [...CLASSIFIABLE_FORM_TYPES, 'OTHER'] },
        [TAX_YEAR]: { type: 'string' },
      },
    },
  });
  runs.push({ role: 'reader', stage: 'classify', ms: c.ms, ...(c.runId ? { runId: c.runId } : {}) });
  const classified = parse(c.content) ?? {};
  const printed = typeof classified[FORM_NUMBER] === 'string' ? (classified[FORM_NUMBER] as string) : undefined;
  const modelFormType = printed && (CLASSIFIABLE_FORM_TYPES as readonly string[]).includes(printed) ? (printed as ClassifiableFormType) : null;
  const taxYearPrinted = typeof classified[TAX_YEAR] === 'string' && classified[TAX_YEAR] ? (classified[TAX_YEAR] as string) : undefined;
  const classification = classifyModelReading({ modelFormType, pageText: page.words.map((w) => w.text).join(' ') });
  const formType = classification.status === 'classified' ? classification.formType : null;
  const classificationReason = `${classification.reason} (tax year read: ${taxYearPrinted ?? 'none'})`;

  const schema = getFormExtractionSchema(formType);
  if (!schema) {
    // Unclassified, or a known form with no extraction schema (W-2G, K-1, 1098-E,
    // 1095-A): nothing is transcribed; the caller reads such a file another way.
    return { pageNumber: page.pageNumber, formType, ...(taxYearPrinted ? { taxYearPrinted } : {}), classificationReason, classification, modelValues: {}, evidence: null, secondReaderKeys: [], runs };
  }

  const template = buildExtractionTemplate(schema);
  const e = await model.chat('reader', {
    imagePng: page.imagePng,
    prompt: READER_PROMPT + JSON.stringify(template.template, null, 2),
    name: 'form',
    jsonSchema: template.jsonSchema,
  });
  runs.push({ role: 'reader', stage: 'extract', ms: e.ms, ...(e.runId ? { runId: e.runId } : {}) });
  const filled = parse(e.content);
  const modelValues = filled ? boxValuesFromTemplate(filled, template, schema) : {};
  const evidence = applyPageEvidence(schema, modelValues, page);
  return {
    pageNumber: page.pageNumber,
    formType,
    ...(taxYearPrinted ? { taxYearPrinted } : {}),
    classificationReason,
    classification,
    modelValues,
    evidence,
    secondReaderKeys: keysNeedingSecondReader(schema, evidence),
    runs,
  };
}

/** Step 4 on one page: the second reader's text for the boxes the page could not settle. */
export async function readPageSecond(primary: PrimaryReading, page: ReaderPage, model: VisionModel): Promise<{ values: Record<string, string>; run: ModelRun } | null> {
  const schema = getFormExtractionSchema(primary.formType);
  if (!schema || primary.secondReaderKeys.length === 0) return null;
  const sub = secondReaderSchema(schema, primary.secondReaderKeys);
  const template = buildExtractionTemplate(sub);
  const s = await model.chat('second_reader', {
    imagePng: page.imagePng,
    prompt: SECOND_READER_PROMPT + JSON.stringify(template.template, null, 2),
    name: 'form',
    jsonSchema: template.jsonSchema,
  });
  const filled = parse(s.content);
  return {
    values: filled ? boxValuesFromTemplate(filled, template, sub) : {},
    run: { role: 'second_reader', stage: 'second', ms: s.ms, ...(s.runId ? { runId: s.runId } : {}) },
  };
}

function schemaOf(primary: PrimaryReading): FormExtractionSchema | null {
  return getFormExtractionSchema(primary.formType);
}

/** Step 5: verify, map to the form tool's arguments, and attach sources. */
export function finishReading(primary: PrimaryReading, page: Pick<ReaderPage, 'raster'>, second?: { values: Record<string, string>; run: ModelRun } | null): PageReading {
  const schema = schemaOf(primary);
  const runs = second ? [...primary.runs, second.run] : primary.runs;
  if (!schema || !primary.evidence) {
    return { ...primary, runs, readings: [], values: {}, mapping: null, tool: null, args: {}, rawText: {}, locations: {}, secondReadings: {}, confidence: {}, identity: null };
  }
  const readings = verifyReadings(schema, primary.evidence, second?.values);
  const values = valuesAfterVerification(primary.evidence.values, readings);
  const mapping = mapBoxesToTool(schema, values);
  const structured = mapping.tool ? extractStructuredFields(mapping.tool, mapping.bag, mapping.rawText) : null;

  const pageSize = { width: page.raster.width, height: page.raster.height };
  const locations: PageReading['locations'] = {};
  const secondReadings: PageReading['secondReadings'] = {};
  const byKey = new Map(readings.map((r) => [r.key, r]));
  for (const [field, keys] of Object.entries(mapping.sourceKeys)) {
    const located = keys.map((k) => primary.evidence!.located[k]).filter((l): l is NonNullable<typeof l> => Boolean(l));
    if (located.length > 0) {
      const box: PixelBox = [
        Math.min(...located.map((l) => l.box[0])), Math.min(...located.map((l) => l.box[1])),
        Math.max(...located.map((l) => l.box[2])), Math.max(...located.map((l) => l.box[3])),
      ];
      locations[field] = { page: primary.pageNumber, box, pageSize };
    }
    const r = keys.map((k) => byKey.get(k)).find((x) => x?.second !== undefined && x.confirmedBy !== 'page');
    if (r?.second !== undefined) secondReadings[field] = { text: r.second, agrees: r.status === 'confirmed' || r.status === 'recovered' };
  }

  const args: Record<string, unknown> = { ...(structured?.args ?? {}) };
  const rawText: Record<string, string> = { ...(structured?.rawText ?? {}) };

  // Per argument: how independently its boxes were read.
  const confidence: Record<string, number> = {};
  const RANK: Record<string, number> = { confirmed: 1, recovered: 1, unconfirmed: 0.5, conflict: 0 };
  for (const [field, keys] of Object.entries(mapping.sourceKeys)) {
    const scores = keys.map((k) => byKey.get(k)?.status).filter((s): s is FieldReading['status'] => Boolean(s)).map((s) => RANK[s] ?? 0.5);
    // Checkbox and box 12 values come from the page itself.
    confidence[field] = scores.length > 0 ? Math.min(...scores) : 1;
  }

  // A box the page prints but neither model read stays unknown with the page's
  // text, so the form is held for the preparer — never read as zero.
  for (const r of readings) {
    if (r.status !== 'missed' || !r.page) continue;
    const probe = mapBoxesToTool(schema, { [r.key]: r.page });
    for (const field of Object.keys(probe.bag)) {
      if (args[field] !== undefined) continue;
      args[field] = undefined;
      rawText[field] = r.page;
      confidence[field] = 0;
    }
  }

  // A box 12 slot printed in that no reader read: box 12 stays unknown, so the form is held.
  const unread = readings.filter((r) => r.status === 'missed' && !r.page && (primary.evidence!.printedUnread ?? []).includes(r.key));
  if (unread.length > 0 && schema.formType === 'W-2') {
    const slots = [...new Set(unread.map((r) => r.key.split('.')[0]))];
    args.box12 = undefined;
    rawText.box12 = `box ${slots.join(', ')} is printed in but no reader read it`;
    confidence.box12 = 0;
  }

  const confirmedBox = (key: string) => {
    const status = byKey.get(key)?.status;
    return status === 'confirmed' || status === 'recovered';
  };
  const identity = primary.formType
    ? identityFromValues(primary.formType, values, confirmedBox, { nameColumns: (primary.evidence.nameColumns ?? []).length > 0 })
    : null;

  return {
    ...primary,
    runs,
    readings,
    values,
    mapping,
    tool: mapping.tool,
    args,
    rawText,
    locations,
    secondReadings,
    confidence,
    identity,
  };
}

/**
 * What a page reading contributes to its facts: the printed text, the
 * agreement score, where each value is printed, and the second reader's text.
 */
export function factSourcesOf(reading: PageReading, secondReaderName: string): {
  rawText: Record<string, string>;
  confidence: Record<string, number>;
  sourceLocation: Record<string, TaxFactSourceLocation>;
  secondReading: Record<string, TaxFactSecondReading>;
} {
  const sourceLocation: Record<string, TaxFactSourceLocation> = {};
  for (const [field, l] of Object.entries(reading.locations)) {
    sourceLocation[field] = {
      page: l.page,
      box: { x: l.box[0], y: l.box[1], width: l.box[2] - l.box[0], height: l.box[3] - l.box[1] },
      pageSize: l.pageSize,
    };
  }
  const secondReading: Record<string, TaxFactSecondReading> = {};
  for (const [field, s] of Object.entries(reading.secondReadings)) {
    secondReading[field] = { source: 'model', reader: secondReaderName, text: s.text, agrees: s.agrees };
  }
  return { rawText: reading.rawText, confidence: reading.confidence, sourceLocation, secondReading };
}
