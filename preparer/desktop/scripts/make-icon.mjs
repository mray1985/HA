#!/usr/bin/env node
/**
 * Builds the Windows icon (build/icon.ico) from the site's app icon
 * (client/public/icons/icon-512.png), so the installer, the program and its
 * shortcuts carry the HA Tax mark.
 *
 * Each size is drawn from the 512 px image by halving steps, which keeps the
 * small sizes sharp. Sizes below 256 px are stored as 32-bit bitmaps and the
 * 256 px size as PNG, the layout Windows Explorer and NSIS both read.
 *
 * Usage: node scripts/make-icon.mjs (from preparer/desktop)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', 'client', 'public', 'icons', 'icon-512.png');
const OUT = join(HERE, '..', 'build', 'icon.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** The source drawn at `size` px, halving from 512 so no step skips pixels. */
function draw(image, size) {
  let current = image;
  let width = image.width;
  while (width / 2 >= size) {
    width = Math.max(size, Math.floor(width / 2));
    const step = createCanvas(width, width);
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, width, width);
    current = step;
  }
  if (width !== size) {
    const last = createCanvas(size, size);
    const ctx = last.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, size, size);
    current = last;
  }
  return current;
}

/** A 32-bit BGRA DIB with its AND mask, as an .ico entry stores it (bottom-up rows). */
function bitmapEntry(canvas, size) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, size, size);
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0); // header size
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // colour rows + mask rows
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bits per pixel
  out.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      out[o++] = data[i + 2];
      out[o++] = data[i + 1];
      out[o++] = data[i];
      out[o++] = data[i + 3];
    }
  }
  // AND mask: all zero — the alpha channel carries transparency.
  return out;
}

const image = await loadImage(SOURCE);
if (image.width !== image.height || image.width < 256) throw new Error(`${SOURCE} must be square and at least 256 px`);

const entries = SIZES.map((size) => {
  const canvas = draw(image, size);
  return { size, data: size >= 256 ? canvas.toBuffer('image/png') : bitmapEntry(canvas, size) };
});

const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ size, data }, i) => {
  const d = 6 + 16 * i;
  header[d] = size >= 256 ? 0 : size; // 0 means 256
  header[d + 1] = size >= 256 ? 0 : size;
  header.writeUInt16LE(1, d + 4); // planes
  header.writeUInt16LE(32, d + 6); // bits per pixel
  header.writeUInt32LE(data.length, d + 8);
  header.writeUInt32LE(offset, d + 12);
  offset += data.length;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([header, ...entries.map((e) => e.data)]));
console.log(`${OUT}: ${SIZES.join(', ')} px`);
