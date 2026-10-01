/**
 * pdf.js draws the standard fonts a PDF names without embedding them from
 * public/pdfjs-standard-fonts, so page images do not depend on the system
 * fonts of the computer the app runs on.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFJS_DOCUMENT_OPTIONS } from '../services/pdfjsOptions';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = resolve(here, '../../public/pdfjs-standard-fonts');
const installed = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('pdf.js standard fonts', () => {
  it('ships the standard fonts of the installed pdf.js', () => {
    const files = readdirSync(installed).sort();
    expect(readdirSync(bundled).sort()).toEqual(files);
    for (const f of files) expect(statSync(join(bundled, f)).size, f).toBe(statSync(join(installed, f)).size);
    expect(files).toContain('FoxitDingbats.pfb');
    expect(PDFJS_DOCUMENT_OPTIONS.standardFontDataUrl).toBe('/pdfjs-standard-fonts/');
  });

  it('gives them to every document pdf.js opens', () => {
    // Each call is written on one line.
    const calls = sourceFiles(resolve(here, '..')).flatMap((file) =>
      readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.includes('getDocument(')).map((call) => ({ file, call })));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ call }) => !call.includes('PDFJS_DOCUMENT_OPTIONS'))).toEqual([]);
  });
});
