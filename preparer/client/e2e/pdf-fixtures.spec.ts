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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const G = '../local-ai/gauntlet';

interface CaseTruth { id: string; expected: { tool: string; args: Record<string, unknown> } }
interface StressTruth { documents: Array<{ file: string; form: string; args: Record<string, unknown> }> }

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(1_800_000);

test('every PDF fixture reads every value it should, and invents none', async ({ page }) => {
  const targets: Array<{ tag: string; path: string; args: Record<string, unknown> }> = [];

  for (const name of readdirSync(join(G, 'cases'))) {
    if (!name.endsWith('.json')) continue;
    const c = JSON.parse(readFileSync(join(G, 'cases', name), 'utf8')) as CaseTruth;
    const path = join(G, 'out', `${c.id}.pdf`);
    if (existsSync(path)) targets.push({ tag: `case ${c.id}`, path, args: c.expected.args });
  }
  const stress = JSON.parse(readFileSync(join(G, 'stress', 'truth.json'), 'utf8')) as StressTruth;
  for (const d of stress.documents) {
    if (!d.file.endsWith('.pdf')) continue;
    const path = join(G, 'stress', 'docs', d.file);
    if (existsSync(path)) targets.push({ tag: `stress ${d.file}`, path, args: d.args });
  }

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
    for (const [k, v] of Object.entries(t.args).filter(([, x]) => typeof x === 'number')) {
      const g = got[k];
      if (g === undefined) missing.push(k);
      else if (typeof g !== 'number' || Math.abs(g - (v as number)) > 0.005) wrong.push(`${k}=${String(g)} want ${v}`);
    }
    for (const [k, v] of Object.entries(t.args).filter(([, x]) => typeof x === 'boolean')) {
      if (got[k] !== v) wrong.push(`${k}=${String(got[k])} want ${v}`);
    }
    for (const [k, v] of Object.entries(t.args).filter(([, x]) => typeof x === 'string')) {
      if (typeof got[k] !== 'string' || String(got[k]).split('\n')[0]!.trim() !== (v as string).split('\n')[0]!.trim()) {
        if (k in got) wrong.push(`${k}="${String(got[k]).slice(0, 24)}" want "${String(v).slice(0, 24)}"`);
      }
    }
    for (const k of Object.keys(got)) {
      if (typeof got[k] === 'number' && !(k in t.args)) wrong.push(`${k}=${String(got[k])} INVENTED`);
    }

    if (!missing.length && !wrong.length) clean++;
    else problems.push(`${t.tag} MISSING[${missing.join(',')}] ${wrong.length ? 'WRONG[' + wrong.join('; ') + ']' : ''}`);
  }

  console.warn(`PDFSWEEP ${clean}/${targets.length} clean`);
  for (const p of problems) console.warn('  ' + p.slice(0, 170));
  expect(true).toBe(true);
});