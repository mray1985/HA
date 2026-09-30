#!/usr/bin/env node
/**
 * Model gauntlet case renderer (work order §54 / §58).
 *
 * Fills an official IRS blank (forms/) with a case's synthetic values, keeps
 * the one copy page the taxpayer receives, flattens it, and renders it to PNG
 * with pdf.js — the same rasterizer the preparer app uses. Expected values
 * live next to the inputs in the case file, so accuracy is measured against
 * independently known numbers, never against model output.
 *
 * Usage: node local-ai/gauntlet/render-cases.mjs [caseId ...] [--dpi 200] [--suffix -150dpi]
 * Output: local-ai/gauntlet/out/<caseId>.pdf and .png (gitignored)
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFCheckBox, PDFTextField } = require('pdf-lib');

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMS_DIR = join(HERE, 'forms');
const CASES_DIR = join(HERE, 'cases');
const OUT_DIR = join(HERE, 'out');

function parseArgs(argv) {
  const ids = [];
  let dpi = 200;
  let suffix = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dpi') dpi = Number(argv[++i]);
    else if (argv[i] === '--suffix') suffix = argv[++i];
    else ids.push(argv[i]);
  }
  if (!Number.isFinite(dpi) || dpi < 72 || dpi > 600) throw new Error(`Bad --dpi ${dpi}`);
  return { ids, dpi, suffix };
}

function loadCases(ids) {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  const cases = files.map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')));
  if (ids.length === 0) return cases;
  const wanted = new Set(ids);
  const picked = cases.filter((c) => wanted.has(c.id));
  const missing = ids.filter((id) => !picked.some((c) => c.id === id));
  if (missing.length) throw new Error(`Unknown case id(s): ${missing.join(', ')}`);
  return picked;
}

async function fillCase(testCase) {
  const source = await PDFDocument.load(readFileSync(join(FORMS_DIR, testCase.form)));
  const form = source.getForm();
  for (const [shortName, value] of Object.entries(testCase.fields)) {
    const field = form.getField(testCase.fieldPrefix + shortName);
    if (field instanceof PDFCheckBox) {
      if (value === true) field.check();
      else field.uncheck();
    } else if (field instanceof PDFTextField) {
      field.setText(String(value));
    } else {
      throw new Error(`${testCase.id}: unsupported field type for ${shortName}`);
    }
  }
  form.updateFieldAppearances();
  form.flatten();

  // Keep only the copy page the recipient receives.
  const single = await PDFDocument.create();
  const [page] = await single.copyPages(source, [testCase.pageIndex]);
  single.addPage(page);
  return single.save();
}

async function renderPng(pdfBytes, dpi) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    // Node's pdf.js font loader reads with fs, so it needs a plain path, not a file:// URL.
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts').split(sep).join('/') + '/',
    disableFontFace: true,
  }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvasFactory = doc.canvasFactory;
  const { canvas, context } = canvasFactory.create(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  const png = await canvas.encode('png');
  await doc.destroy();
  return { png, width: canvas.width, height: canvas.height };
}

async function main() {
  const { ids, dpi, suffix } = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  for (const testCase of loadCases(ids)) {
    const pdfBytes = await fillCase(testCase);
    writeFileSync(join(OUT_DIR, `${testCase.id}.pdf`), pdfBytes);
    const { png, width, height } = await renderPng(pdfBytes, dpi);
    writeFileSync(join(OUT_DIR, `${testCase.id}${suffix}.png`), png);
    console.log(`${testCase.id}: ${resolve(OUT_DIR, testCase.id + suffix + '.png')} (${width}x${height} @ ${dpi} dpi)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
