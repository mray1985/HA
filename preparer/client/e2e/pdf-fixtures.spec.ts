/**
 * Every PDF fixture with a known answer, checked against what it should read.
 *
 * Two truth sources: gauntlet/cases/*.json (each form's expected tool arguments)
 * and gauntlet/stress/truth.json (the household documents). Photographs are out of
 * scope - this measures the uploaded-PDF path.
 *
 * It checks both directions: a value truth expects must be read, and a number
 * written that truth does not mention is invented. Comparing only the expected
 * numbers is blind to invention, which is how a fabricated 1099-DIV box 2b went
 * unnoticed - the label "Unrecap. Sec. 1250 gain" supplied the value.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const G = '../local-ai/gauntlet';

interface CaseTruth { id: string; expected: { tool: string; args: Record<string, unknown> } }
interface StressTruth { documents: Array<{ file: string; form: string; args: Record<string, unknown> }> }

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(1_800_000);

function firstLine(value: string): string {
  return value.split('\n')[0]!.trim();
}

/** Walk the expected arguments, including nested box12 rows and box13 flags. */
function compareExpected(
  expected: unknown,
  got: unknown,
  path: string,
  missing: string[],
  wrong: string[],
): void {
  if (typeof expected === 'number') {
    if (typeof got !== 'number') missing.push(path);
    else if (Math.abs(got - expected) > 0.005) wrong.push(`${path}=${String(got)} want ${expected}`);
    return;
  }
  if (typeof expected === 'boolean') {
    if (typeof got !== 'boolean') missing.push(path);
    else if (got !== expected) wrong.push(`${path}=${String(got)} want ${expected}`);
    return;
  }
  if (typeof expected === 'string') {
    if (typeof got !== 'string') missing.push(path);
    else if (firstLine(got) !== firstLine(expected)) {
      wrong.push(`${path}="${firstLine(got).slice(0, 24)}" want "${firstLine(expected).slice(0, 24)}"`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(got)) { missing.push(path); return; }
    expected.forEach((item, i) => compareExpected(item, got[i], `${path}[${i}]`, missing, wrong));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!got || typeof got !== 'object' || Array.isArray(got)) { missing.push(path); return; }
    for (const [key, value] of Object.entries(expected)) {
      compareExpected(value, (got as Record<string, unknown>)[key], path ? `${path}.${key}` : key, missing, wrong);
    }
  }
}

interface Target { tag: string; path: string; args: Record<string, unknown> }

/** The filled PDFs are generated, not committed. A missing one is a failed run, not a skip. */
function loadTargets(generate = true): Target[] {
  const targets: Target[] = [];
  const missing: string[] = [];

  for (const name of readdirSync(join(G, 'cases'))) {
    if (!name.endsWith('.json')) continue;
    const c = JSON.parse(readFileSync(join(G, 'cases', name), 'utf8')) as CaseTruth;
    const path = join(G, 'out', `${c.id}.pdf`);
    if (!existsSync(path)) missing.push(path);
    else targets.push({ tag: `case ${c.id}`, path, args: c.expected.args });
  }
  const stress = JSON.parse(readFileSync(join(G, 'stress', 'truth.json'), 'utf8')) as StressTruth;
  for (const d of stress.documents) {
    if (!d.file.endsWith('.pdf')) continue;
    const path = join(G, 'stress', 'docs', d.file);
    if (!existsSync(path)) missing.push(path);
    else targets.push({ tag: `stress ${d.file}`, path, args: d.args });
  }

  if (missing.length === 0) return targets;
  if (!generate) {
    throw new Error(`${missing.length} fixture PDFs are missing:\n${missing.join('\n')}`);
  }

  const gauntlet = join(G);
  const rendered = spawnSync(process.execPath, ['render-cases.mjs'], { cwd: gauntlet, stdio: 'inherit' });
  const documented = spawnSync(process.execPath, ['make-docs.mjs'], { cwd: join(gauntlet, 'stress'), stdio: 'inherit' });
  if (rendered.status !== 0 || documented.status !== 0) {
    throw new Error(`Could not generate the ${missing.length} fixture PDFs this sweep reads`);
  }
  return loadTargets(false);
}

test('every PDF fixture reads every value it should, and invents none', async ({ page }) => {
  const targets = loadTargets();
  expect(targets.length, 'the sweep has no fixture PDFs to read').toBeGreaterThan(0);

  await page.goto('/preparer');
  await page.waitForTimeout(2500);

  let clean = 0;
  const problems: string[] = [];

  for (const t of targets) {
    const bytes = readFileSync(t.path).toString('base64');
    const name = t.path.split(/[\\/]/).pop()!;
    const got = await page.evaluate(async ({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mod = await import('/src/services/pdfImporter.ts');
      const res = await mod.extractFromPDF(new File([bytes], name, { type: 'application/pdf' }));
      const d = res.extractedData as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== null && v !== '') out[k] = v;
      return out;
    }, { b64: bytes, name });

    const missing: string[] = [];
    const wrong: string[] = [];
    compareExpected(t.args, got, '', missing, wrong);
    for (const k of Object.keys(got)) {
      if (typeof got[k] === 'number' && !(k in t.args)) wrong.push(`${k}=${String(got[k])} INVENTED`);
    }

    if (!missing.length && !wrong.length) clean++;
    else problems.push(`${t.tag} MISSING[${missing.join(',')}] ${wrong.length ? 'WRONG[' + wrong.join('; ') + ']' : ''}`);
  }

  console.warn(`PDFSWEEP ${clean}/${targets.length} clean`);
  for (const p of problems) console.warn('  ' + p.slice(0, 300));
  expect(problems, problems.join('\n')).toEqual([]);
});
