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
 *   3. page evidence: locate values, read checkboxes and box 12, and find
 *      boxes the model left blank although the page prints an amount
 *   4. with --second-model: a second document model (GLM-OCR) reads only the
 *      boxes the page could not confirm plus the missed ones (§33)
 *   5. boxValuesFromTemplate → mapBoxesToTool → extractStructuredFields
 *   6. compare the resulting tax-tool arguments with the case's known values,
 *      count any value reported for a box that is blank on the form, and count
 *      confirmed values that are wrong (would be applied without review).
 *
 * Usage:
 *   npx tsx local-ai/gauntlet/run.ts --model <gguf> --mmproj <gguf>
 *        [--second-model <gguf> --second-mmproj <gguf>]
 *        [--case id ...] [--image-suffix -150dpi | --scan scan|fax|faded]
 *        [--style glm|plain] [--out report.json]
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { ClassifiableFormType } from '../src/documentClassifier.js';
import { finishReading, readPagePrimary, readPageSecond, type ReaderPage, type VisionModel } from '../src/documentReader.js';
import { getFormExtractionSchema, mapBoxesToTool } from '../src/formSchemas.js';
import { extractStructuredFields, parseMoneyToken } from '../src/structuredExtraction.js';
import type { FieldReading } from '../src/secondReading.js';
import { createRequire } from 'node:module';
import { closeOcr, HERE, nativePage, OUT_DIR, REPO, scanPage } from './pages.js';

const require = createRequire(import.meta.url);

interface ExpectedBox { money?: number; text?: string; contains?: string; firstLine?: string }
interface GauntletCase {
  id: string;
  formType: ClassifiableFormType;
  expectedBoxes: Record<string, ExpectedBox>;
  /** Expectations by schema key, where a printed box holds several keys (12a code) or none (payer block). */
  expectedKeys?: Record<string, ExpectedBox>;
  blankBoxes: string[];
  expected: { tool: string; args: Record<string, unknown> };
}

/**
 * Whether the value a reading would apply is right: by the case's expectation
 * for the key, or for its printed box when the box is blank, holds one key, or
 * this is its first money key. Undefined when the case does not say.
 */
function readingIsRight(c: GauntletCase, formType: ClassifiableFormType, r: FieldReading): boolean | undefined {
  const schema = getFormExtractionSchema(formType)!;
  const b = schema.boxes.find((x) => x.key === r.key);
  if (!b) return undefined;
  const text = r.status === 'recovered' ? r.second : r.primary;
  if (b.box && c.blankBoxes.includes(b.box)) return text === undefined;
  const sameBox = schema.boxes.filter((x) => b.box && x.box === b.box);
  const byBox = b.box && (sameBox.length === 1 || (b.kind === 'money' && sameBox.find((x) => x.kind === 'money')?.key === b.key))
    ? c.expectedBoxes[b.box] : undefined;
  const spec = c.expectedKeys?.[r.key] ?? byBox;
  if (!spec) return undefined;
  if (text === undefined) return false;
  if (spec.money !== undefined) return parseMoneyToken(text.replace(/\s+/g, '')) === spec.money;
  if (spec.text !== undefined) return text.trim().toUpperCase() === spec.text.toUpperCase();
  if (spec.firstLine !== undefined) return text.split(/\r?\n/)[0]!.trim().toUpperCase() === spec.firstLine.toUpperCase();
  if (spec.contains !== undefined) return text.toUpperCase().includes(spec.contains.toUpperCase());
  return undefined;
}

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

/** The model sees the scan at about 150 DPI (letter width 1275 px) to bound image tokens. */
async function modelImageFor(bytes: Buffer): Promise<string> {
  const { loadImage, createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const img = await loadImage(bytes);
  const scale = Math.min(1, 1275 / img.width);
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return (await canvas.encode('png')).toString('base64');
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
  const secondModel = argOf('--second-model') ? resolve(argOf('--second-model')!) : null;
  const secondMmproj = argOf('--second-mmproj') ? resolve(argOf('--second-mmproj')!) : null;
  if (!!secondModel !== !!secondMmproj) throw new Error('--second-model and --second-mmproj go together');
  const port = Number(argOf('--port', '18080'));
  const suffix = argOf('--image-suffix', '')!;
  // --scan <variant>: read out/<case>-<variant>.png with OCR evidence (no text layer).
  const scan = argOf('--scan');
  const outFile = argOf('--out');
  const ids = argsOf('--case');
  for (const f of [model, mmproj, secondModel, secondMmproj]) if (f && !existsSync(f)) throw new Error(`Missing ${f}`);

  const cases: GauntletCase[] = readdirSync(join(HERE, 'cases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(HERE, 'cases', f), 'utf8')))
    .filter((c) => ids.length === 0 || ids.includes(c.id));

  const { child, loadMs } = await startServer(model, mmproj, port);
  const second = secondModel && secondMmproj ? await startServer(secondModel, secondMmproj, port + 1) : null;
  const report: Record<string, unknown> = {
    model: basename(model), mmproj: basename(mmproj), secondModel: secondModel ? basename(secondModel) : null, loadMs, cases: [],
  };
  // The product's reading pipeline (documentReader), with the models on llama-server.
  const vision: VisionModel = {
    async chat(role, req) {
      const r = await chat(role === 'reader' ? port : port + 1, req.imagePng, req.prompt, {
        response_format: { type: 'json_schema', json_schema: { name: req.name, schema: req.jsonSchema } },
      });
      return { content: r.content, ms: r.ms };
    },
  };
  let totals = { argsOk: 0, argsTotal: 0, modelOnlyArgsOk: 0, invented: 0, classified: 0, cases: 0, ms: 0 };
  const readingTotals: Record<string, number> = { confirmed: 0, confirmedByModel: 0, unconfirmed: 0, conflict: 0, missed: 0, recovered: 0, confirmedWrong: 0 };
  try {
    for (const c of cases) {
      const png = join(OUT_DIR, scan ? `${c.id}-${scan}.png` : `${c.id}${suffix}.png`);
      if (!existsSync(png)) throw new Error(`Render ${png} first (render-cases.mjs / render-scans.mjs)`);
      // Scans: straighten and OCR first; the model then reads the upright page.
      const scanned = scan ? await scanPage(png) : null;
      const image = scanned ? await modelImageFor(scanned.deskewed) : readFileSync(png).toString('base64');

      // 1–5: the product pipeline.
      const pageEvidence = scanned ?? (await nativePage(c.id, png));
      const page: ReaderPage = { imagePng: image, raster: pageEvidence.raster, words: pageEvidence.words, pageNumber: 1 };
      const primary = await readPagePrimary(page, vision);
      const secondRead = second ? await readPageSecond(primary, page, vision) : null;
      const reading = finishReading(primary, page, secondRead);
      const formType = reading.formType;
      const classification = { reason: reading.classificationReason };
      const schema = getFormExtractionSchema(formType);
      const evidence = reading.evidence;
      const modelOnlyValues = reading.modelValues;
      let values = reading.values;
      const readings: FieldReading[] = reading.readings;
      const t = { ms: reading.runs.find((r) => r.stage === 'classify')?.ms ?? 0 };
      const e = reading.runs.some((r) => r.stage === 'extract') ? { ms: reading.runs.find((r) => r.stage === 'extract')!.ms } : null;
      const secondMs = secondRead?.run.ms ?? 0;
      const readingChecks = formType ? readings.map((r) => ({ ...r, right: readingIsRight(c, formType, r) })) : [];
      const confirmedWrong = readingChecks.filter((r) => (r.status === 'confirmed' || r.status === 'recovered') && r.right === false);
      for (const r of readings) readingTotals[r.status] = (readingTotals[r.status] ?? 0) + 1;
      readingTotals.confirmedByModel! += readings.filter((r) => r.status === 'confirmed' && r.confirmedBy === 'model').length;
      readingTotals.confirmedWrong! += confirmedWrong.length;

      // 5. Deterministic mapping → tool arguments (with and without page evidence).
      const toArgs = (vals: Record<string, string>) => {
        const m = schema ? mapBoxesToTool(schema, vals) : null;
        return {
          mapped: m,
          args: m?.tool
            ? extractStructuredFields(m.tool, m.bag, m.rawText).args
            : {},
        };
      };
      const modelOnly = toArgs(modelOnlyValues);
      const { mapped, args } = toArgs(values);
      const modelOnlyArgsOk = Object.entries(c.expected.args).filter(([k, want]) => valuesEqual(modelOnly.args[k], want)).length;
      const locatedCount = Object.values(evidence?.located ?? {}).filter(Boolean).length;
      const locatableCount = Object.keys(evidence?.located ?? {}).length;

      // 6. Score.
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
      // An explicit "no" (unchecked) or "?" (unreadable → review) from the
      // checkbox reader is not a value.
      const invented = c.blankBoxes
        .filter((bx) => byBox.has(bx.toLowerCase()) && !/^((no|\?)\s*)+$/i.test(byBox.get(bx.toLowerCase())!.trim()))
        .map((bx) => ({ box: bx, got: byBox.get(bx.toLowerCase()) }));
      const ms = t.ms + (e?.ms ?? 0) + secondMs;

      const entry = {
        id: c.id, ms, transcribeMs: t.ms, extractMs: e?.ms ?? null,
        classified: formType, classificationOk: formType === c.formType, classificationReason: classification.reason,
        argsOk: argChecks.filter((x) => x.ok).length, argsTotal: argChecks.length, argChecks, unexpectedArgs, modelOnlyArgsOk,
        located: locatedCount, locatable: locatableCount, checkboxes: evidence?.checkboxes ?? {}, box12Codes: evidence?.box12Codes ?? {},
        boxesOk: boxChecks.filter((x) => x.ok).length, boxesTotal: boxChecks.length, boxChecks,
        invented, reviewBoxes: mapped?.reviewBoxes ?? [],
        secondMs, readings: readingChecks, confirmedWrong, missed: evidence?.missed ?? [],
        modelValues: modelOnlyValues, runs: reading.runs,
      };
      (report.cases as unknown[]).push(entry);
      totals = {
        argsOk: totals.argsOk + entry.argsOk, argsTotal: totals.argsTotal + entry.argsTotal, modelOnlyArgsOk: totals.modelOnlyArgsOk + modelOnlyArgsOk,
        invented: totals.invented + invented.length, classified: totals.classified + (entry.classificationOk ? 1 : 0),
        cases: totals.cases + 1, ms: totals.ms + ms,
      };
      const tally = (st: string) => readings.filter((r) => r.status === st).length;
      const byModel = readings.filter((r) => r.status === 'confirmed' && r.confirmedBy === 'model').length;
      console.log(`${c.id}: ${(ms / 1000).toFixed(0)}s (classify ${(t.ms / 1000).toFixed(0)}s + extract ${((e?.ms ?? 0) / 1000).toFixed(0)}s + second ${(secondMs / 1000).toFixed(0)}s) | readings: confirmed ${tally('confirmed')} (${byModel} by second model), recovered ${tally('recovered')}, unconfirmed ${tally('unconfirmed')}, conflict ${tally('conflict')}, missed ${tally('missed')}, CONFIRMED WRONG ${confirmedWrong.length} | class ${formType ?? 'none'} ${entry.classificationOk ? 'OK' : 'WRONG'} | tool args ${entry.argsOk}/${entry.argsTotal} (model only ${modelOnlyArgsOk}) | located ${locatedCount}/${locatableCount} | boxes ${entry.boxesOk}/${entry.boxesTotal} | invented ${invented.length} | review ${entry.reviewBoxes.length}`);
      for (const x of argChecks) if (!x.ok) console.log(`   ARG ${x.arg}: want ${JSON.stringify(x.want)} got ${JSON.stringify(x.got)}`);
      for (const k of unexpectedArgs) console.log(`   EXTRA ARG ${k}: ${JSON.stringify(args[k])}`);
      for (const x of invented) console.log(`   INVENTED box ${x.box}: ${JSON.stringify(x.got)}`);
      for (const [k, r] of Object.entries(evidence?.checkboxes ?? {})) console.log(`   checkbox ${k}: ${r.state} (${r.reason}${r.inkRatio !== undefined ? `, ink ${r.inkRatio.toFixed(3)}` : ''})`);
      for (const [k, code] of Object.entries(evidence?.box12Codes ?? {})) console.log(`   box 12 ${k}: code ${code} read from page`);
      for (const k of evidence?.phantoms ?? []) console.log(`   DROPPED ${k}: not backed by the page`);
      for (const k of evidence?.relined ?? []) console.log(`   RELINED ${k}: line breaks restored from the page`);
      for (const [k, e2] of Object.entries(evidence?.box12FromPage ?? {})) console.log(`   box 12 ${k}: ${e2.code} ${e2.amount} read from page (model returned nothing)`);
      for (const r of readingChecks) {
        if (r.status === 'confirmed') continue;
        console.log(`   ${r.status.toUpperCase()} ${r.key}: primary ${JSON.stringify(r.primary)} second ${JSON.stringify(r.second)}${r.page ? ` page ${JSON.stringify(r.page)}` : ''}${r.right === undefined ? '' : r.right ? ' (right)' : ' (wrong)'}`);
      }
      for (const r of confirmedWrong) console.log(`   CONFIRMED WRONG ${r.key}: ${JSON.stringify(r.primary ?? r.second)}`);
    }
  } finally {
    child.kill();
    second?.child.kill();
    await closeOcr();
  }
  report.totals = { ...totals, readings: readingTotals };
  report.scan = scan ?? null;
  console.log(`TOTAL: class ${totals.classified}/${totals.cases} | tool args ${totals.argsOk}/${totals.argsTotal} (model only ${totals.modelOnlyArgsOk}) | invented ${totals.invented} | ${(totals.ms / 1000 / Math.max(1, totals.cases)).toFixed(0)}s per page`);
  console.log(`READINGS: ${Object.entries(readingTotals).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  if (outFile) writeFileSync(resolve(outFile), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
