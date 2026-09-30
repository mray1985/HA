/**
 * Model gauntlet runner (work order §54–§57).
 *
 * Runs a GGUF vision model + mmproj projector on CPU through llama.cpp
 * `llama-server` and scores it end to end with the product's own modules:
 *
 *   1. ask for the printed form number + tax year under a JSON grammar whose
 *      form number is an enum of the forms the pipeline knows (or OTHER)
 *   2. fill that form's extraction template under a JSON grammar (the image
 *      encoding from pass 1 is reused by llama-server's prompt cache)
 *   3. boxValuesFromTemplate → mapBoxesToTool → extractStructuredFields
 *   4. compare the resulting tax-tool arguments with the case's known values,
 *      and count any value reported for a box that is blank on the form.
 *
 * Usage:
 *   npx tsx local-ai/gauntlet/run.ts --model <gguf> --mmproj <gguf>
 *        [--case id ...] [--image-suffix -150dpi] [--style glm|plain]
 *        [--out report.json]
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLASSIFIABLE_FORM_TYPES, type ClassifiableFormType } from '../src/documentClassifier.js';
import {
  boxValuesFromTemplate,
  buildExtractionTemplate,
  getFormExtractionSchema,
  mapBoxesToTool,
} from '../src/formSchemas.js';
import { extractStructuredFields, parseMoneyToken } from '../src/structuredExtraction.js';
import { applyPageEvidence, type FormEvidenceResult } from '../src/formEvidence.js';
import type { PageRaster, PageWord } from '../src/pageEvidence.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT_DIR = join(HERE, 'out');

interface ExpectedBox { money?: number; text?: string; contains?: string }
interface GauntletCase {
  id: string;
  formType: ClassifiableFormType;
  expectedBoxes: Record<string, ExpectedBox>;
  blankBoxes: string[];
  expected: { tool: string; args: Record<string, unknown> };
}

const TEMPLATE_PROMPTS: Record<string, string> = {
  // GLM-OCR's documented information-extraction prompt.
  glm: '请按下列JSON格式输出图中信息:\n',
  plain:
    'Fill in this JSON with the values printed in each box of the tax form in the image. ' +
    'Copy each value exactly as printed. Use "" for a blank box; never write 0 for a blank box. ' +
    'The value is never the printed box label.\n',
};

function argOf(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function argsOf(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]!] : []));
}

function findServer(): string {
  const stack = [join(REPO, 'tools', 'llama-cpp', 'bin')];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'llama-server.exe' || e.name === 'llama-server') return p;
    }
  }
  throw new Error('llama-server not found under tools/llama-cpp/bin');
}

async function startServer(model: string, mmproj: string, port: number): Promise<{ child: ChildProcess; loadMs: number }> {
  const child = spawn(findServer(), [
    '-m', model, '--mmproj', mmproj, '--port', String(port), '--host', '127.0.0.1',
    '-c', '8192', '--jinja', '--no-webui', '-np', '1',
  ], { stdio: 'ignore', windowsHide: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, loadMs: Date.now() - t0 };
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('llama-server did not become healthy');
}

async function chat(port: number, image: string, prompt: string, extra: Record<string, unknown>) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      temperature: 0,
      max_tokens: 2500,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
          { type: 'text', text: prompt },
        ],
      }],
      ...extra,
    }),
  });
  const body = (await r.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: Record<string, number>;
  };
  return {
    ms: Date.now() - t0,
    content: body.choices?.[0]?.message?.content ?? '',
    finish: body.choices?.[0]?.finish_reason,
    usage: body.usage,
  };
}

/**
 * Page evidence for a native-PDF case: text-layer words in PNG pixel space and
 * the PNG as grayscale. (Scanned-image cases use OCR word boxes instead.)
 */
async function pageEvidenceFor(caseId: string, png: string): Promise<{ words: PageWord[]; raster: PageRaster }> {
  const { loadImage, createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const img = await loadImage(readFileSync(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
  const gray = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(sep).join('/') + '/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(OUT_DIR, `${caseId}.pdf`))), standardFontDataUrl: fonts }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const sx = img.width / vp.width;
  const sy = img.height / vp.height;
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
  return { words, raster: { width: img.width, height: img.height, gray } };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Printed box id → combined text of every schema key for that box. */
function textByPrintedBox(formType: ClassifiableFormType, values: Record<string, string>): Map<string, string> {
  const schema = getFormExtractionSchema(formType);
  const out = new Map<string, string>();
  if (!schema) return out;
  for (const b of schema.boxes) {
    const v = values[b.key];
    if (v === undefined) continue;
    const id = (b.box || b.key).toLowerCase();
    out.set(id, out.has(id) ? `${out.get(id)} ${v}` : v);
  }
  return out;
}

async function main() {
  const model = resolve(argOf('--model')!);
  const mmproj = resolve(argOf('--mmproj')!);
  const port = Number(argOf('--port', '18080'));
  const suffix = argOf('--image-suffix', '')!;
  const style = argOf('--style', 'glm')!;
  const outFile = argOf('--out');
  const ids = argsOf('--case');
  for (const f of [model, mmproj]) if (!existsSync(f)) throw new Error(`Missing ${f}`);
  if (!TEMPLATE_PROMPTS[style]) throw new Error(`Unknown --style ${style}`);

  const cases: GauntletCase[] = readdirSync(join(HERE, 'cases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(HERE, 'cases', f), 'utf8')))
    .filter((c) => ids.length === 0 || ids.includes(c.id));

  const { child, loadMs } = await startServer(model, mmproj, port);
  const report: Record<string, unknown> = { model: basename(model), mmproj: basename(mmproj), style, loadMs, cases: [] };
  let totals = { argsOk: 0, argsTotal: 0, modelOnlyArgsOk: 0, invented: 0, classified: 0, cases: 0, ms: 0 };
  try {
    for (const c of cases) {
      const png = join(OUT_DIR, `${c.id}${suffix}.png`);
      if (!existsSync(png)) throw new Error(`Render ${c.id}${suffix} first (render-cases.mjs)`);
      const image = readFileSync(png).toString('base64');

      // 1. Classify: printed form number + tax year, constrained to known forms.
      const classifyTemplate = { 'Form number': '', 'Tax year': '' };
      const t = await chat(port, image, TEMPLATE_PROMPTS[style] + JSON.stringify(classifyTemplate, null, 2), {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'classify',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['Form number', 'Tax year'],
              properties: {
                'Form number': { type: 'string', enum: [...CLASSIFIABLE_FORM_TYPES, 'OTHER'] },
                'Tax year': { type: 'string' },
              },
            },
          },
        },
      });
      let classified: { 'Form number'?: string; 'Tax year'?: string } = {};
      try { classified = JSON.parse(t.content); } catch { /* scored as unclassified */ }
      const formType = (CLASSIFIABLE_FORM_TYPES as readonly string[]).includes(classified['Form number'] ?? '')
        ? (classified['Form number'] as ClassifiableFormType)
        : null;
      const classification = { reason: `model reported form ${classified['Form number'] ?? '(none)'}, tax year ${classified['Tax year'] ?? '(none)'}` };
      const schema = getFormExtractionSchema(formType);

      let extraction: Record<string, unknown> | null = null;
      let e: Awaited<ReturnType<typeof chat>> | null = null;
      let values: Record<string, string> = {};
      if (schema) {
        // 2. Template extraction under a JSON grammar.
        const tpl = buildExtractionTemplate(schema);
        e = await chat(port, image, TEMPLATE_PROMPTS[style] + JSON.stringify(tpl.template, null, 2), {
          response_format: { type: 'json_schema', json_schema: { name: 'form', schema: tpl.jsonSchema } },
        });
        try { extraction = JSON.parse(e.content); } catch { extraction = null; }
        if (extraction) values = boxValuesFromTemplate(extraction, tpl, schema);
      }

      // 3. Deterministic page evidence: locate values, read checkboxes and box 12 codes.
      const modelOnlyValues = values;
      let evidence: FormEvidenceResult | null = null;
      if (schema) {
        evidence = applyPageEvidence(schema, values, await pageEvidenceFor(c.id, png));
        values = evidence.values;
      }

      // 4. Deterministic mapping → tool arguments (with and without page evidence).
      const toArgs = (vals: Record<string, string>) => {
        const m = schema ? mapBoxesToTool(schema, vals) : null;
        return {
          mapped: m,
          args: m?.tool
            ? extractStructuredFields(
                { add_w2: 'w2', add_1099_int: '1099int', add_1099_div: '1099div', add_1099_nec: '1099nec', add_1099_r: '1099r' }[m.tool],
                m.bag,
                m.rawText,
              ).args
            : {},
        };
      };
      const modelOnly = toArgs(modelOnlyValues);
      const { mapped, args } = toArgs(values);
      const modelOnlyArgsOk = Object.entries(c.expected.args).filter(([k, want]) => valuesEqual(modelOnly.args[k], want)).length;
      const locatedCount = Object.values(evidence?.located ?? {}).filter(Boolean).length;
      const locatableCount = Object.keys(evidence?.located ?? {}).length;

      // 4. Score.
      const argChecks = Object.entries(c.expected.args).map(([k, want]) => ({
        arg: k, want, got: args[k], ok: valuesEqual(args[k], want),
      }));
      const unexpectedArgs = Object.keys(args).filter((k) => !(k in c.expected.args) && args[k] !== undefined);
      const byBox = formType ? textByPrintedBox(formType, values) : new Map<string, string>();
      const boxChecks = Object.entries(c.expectedBoxes).map(([bx, spec]) => {
        const got = byBox.get(bx.toLowerCase());
        const ok = got !== undefined && (
          spec.money !== undefined ? got.split(/\s+/).some((tok) => parseMoneyToken(tok) === spec.money)
            : spec.contains !== undefined ? got.toUpperCase().includes(spec.contains.toUpperCase())
              : got.trim() === spec.text
        );
        return { box: bx, ok, got, want: spec.money ?? spec.text ?? spec.contains };
      });
      // An explicit "no" on a checkbox is the deterministic reader's "unchecked", not a value.
      const invented = c.blankBoxes
        .filter((bx) => byBox.has(bx.toLowerCase()) && !/^(no\s*)+$/i.test(byBox.get(bx.toLowerCase())!.trim()))
        .map((bx) => ({ box: bx, got: byBox.get(bx.toLowerCase()) }));
      const ms = t.ms + (e?.ms ?? 0);

      const entry = {
        id: c.id, ms, transcribeMs: t.ms, extractMs: e?.ms ?? null,
        classified: formType, classificationOk: formType === c.formType, classificationReason: classification.reason,
        argsOk: argChecks.filter((x) => x.ok).length, argsTotal: argChecks.length, argChecks, unexpectedArgs, modelOnlyArgsOk,
        located: locatedCount, locatable: locatableCount, checkboxes: evidence?.checkboxes ?? {}, box12Codes: evidence?.box12Codes ?? {},
        boxesOk: boxChecks.filter((x) => x.ok).length, boxesTotal: boxChecks.length, boxChecks,
        invented, reviewBoxes: mapped?.reviewBoxes ?? [], finish: e?.finish, usage: { transcribe: t.usage, extract: e?.usage },
        transcript: t.content, extraction,
      };
      (report.cases as unknown[]).push(entry);
      totals = {
        argsOk: totals.argsOk + entry.argsOk, argsTotal: totals.argsTotal + entry.argsTotal, modelOnlyArgsOk: totals.modelOnlyArgsOk + modelOnlyArgsOk,
        invented: totals.invented + invented.length, classified: totals.classified + (entry.classificationOk ? 1 : 0),
        cases: totals.cases + 1, ms: totals.ms + ms,
      };
      console.log(`${c.id}: ${(ms / 1000).toFixed(0)}s (classify ${(t.ms / 1000).toFixed(0)}s + extract ${((e?.ms ?? 0) / 1000).toFixed(0)}s) | class ${formType ?? 'none'} ${entry.classificationOk ? 'OK' : 'WRONG'} | tool args ${entry.argsOk}/${entry.argsTotal} (model only ${modelOnlyArgsOk}) | located ${locatedCount}/${locatableCount} | boxes ${entry.boxesOk}/${entry.boxesTotal} | invented ${invented.length} | review ${entry.reviewBoxes.length}`);
      for (const x of argChecks) if (!x.ok) console.log(`   ARG ${x.arg}: want ${JSON.stringify(x.want)} got ${JSON.stringify(x.got)}`);
      for (const k of unexpectedArgs) console.log(`   EXTRA ARG ${k}: ${JSON.stringify(args[k])}`);
      for (const x of invented) console.log(`   INVENTED box ${x.box}: ${JSON.stringify(x.got)}`);
      for (const [k, r] of Object.entries(evidence?.checkboxes ?? {})) console.log(`   checkbox ${k}: ${r.state} (${r.reason}${r.inkRatio !== undefined ? `, ink ${r.inkRatio.toFixed(3)}` : ''})`);
      for (const [k, code] of Object.entries(evidence?.box12Codes ?? {})) console.log(`   box 12 ${k}: code ${code} read from page`);
      for (const [k, e2] of Object.entries(evidence?.box12FromPage ?? {})) console.log(`   box 12 ${k}: ${e2.code} ${e2.amount} read from page (model returned nothing)`);
    }
  } finally {
    child.kill();
  }
  report.totals = totals;
  console.log(`TOTAL: class ${totals.classified}/${totals.cases} | tool args ${totals.argsOk}/${totals.argsTotal} (model only ${totals.modelOnlyArgsOk}) | invented ${totals.invented} | ${(totals.ms / 1000 / Math.max(1, totals.cases)).toFixed(0)}s per page`);
  if (outFile) writeFileSync(resolve(outFile), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
