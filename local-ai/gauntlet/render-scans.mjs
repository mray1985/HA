#!/usr/bin/env node
/**
 * Scan-condition variants for the gauntlet (work order §54 "document conditions").
 *
 * Takes each case's clean 300 DPI render and produces deterministic degraded
 * copies that stand in for real intake: an office scan, a fax, and a faded
 * copy. Every transform is seeded, so a run is reproducible. These images have
 * no text layer — the pipeline must read them with OCR, as it would a scan.
 *
 * Usage: node local-ai/gauntlet/render-scans.mjs [caseId ...]
 * Needs: out/<caseId>-300dpi.png (render-cases.mjs --dpi 300 --suffix -300dpi)
 * Writes: out/<caseId>-<variant>.png
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

/** Mulberry32: small deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export const VARIANTS = {
  /** Office flatbed scan: 300 DPI, 1.2° skew, sensor noise, JPEG q60, slight blur. */
  scan: { dpi: 300, skewDeg: 1.2, noise: 10, blurPx: 0.6, jpegQuality: 60, contrast: 1, threshold: null, seed: 11 },
  /** Fax: 200 DPI, 2.5° skew, hard black/white threshold. */
  fax: { dpi: 200, skewDeg: -2.5, noise: 18, blurPx: 0.8, jpegQuality: null, contrast: 1, threshold: 150, seed: 23 },
  /** Faded photocopy: 200 DPI, low contrast, gray background, 0.8° skew. */
  faded: { dpi: 200, skewDeg: 0.8, noise: 6, blurPx: 1.0, jpegQuality: 70, contrast: 0.45, threshold: null, seed: 37 },
};

async function makeVariant(caseId, name, v) {
  const src = await loadImage(readFileSync(join(OUT_DIR, `${caseId}-300dpi.png`)));
  const scale = v.dpi / 300;
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((v.skewDeg * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  if (v.blurPx) ctx.filter = `blur(${v.blurPx}px)`;
  ctx.drawImage(src, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rand = rng(v.seed);
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = 255 - (255 - g) * v.contrast; // fade toward white
    if (v.contrast < 1) g -= 18; // gray paper
    g += gaussian(rand) * v.noise;
    if (v.threshold !== null) g = g < v.threshold ? 0 : 255;
    g = Math.max(0, Math.min(255, g));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);

  let bytes;
  if (v.jpegQuality !== null) {
    // Round-trip through JPEG to add real compression artifacts, then store as PNG.
    const jpeg = await canvas.encode('jpeg', v.jpegQuality);
    const back = await loadImage(jpeg);
    const c2 = createCanvas(w, h);
    c2.getContext('2d').drawImage(back, 0, 0);
    bytes = await c2.encode('png');
  } else {
    bytes = await canvas.encode('png');
  }
  const out = join(OUT_DIR, `${caseId}-${name}.png`);
  writeFileSync(out, bytes);
  return { out, w, h };
}

async function main() {
  const ids = process.argv.slice(2);
  const cases = (ids.length ? ids : readdirSync(join(HERE, 'cases')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
  for (const id of cases) {
    for (const [name, v] of Object.entries(VARIANTS)) {
      const { out, w, h } = await makeVariant(id, name, v);
      console.log(`${id}-${name}: ${w}x${h} ${out}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
