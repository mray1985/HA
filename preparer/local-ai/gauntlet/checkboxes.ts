/**
 * Checkbox gauntlet: the deterministic checkbox reader on every case, on the
 * native render and each scan variant, scored against the filled PDF. No model
 * is involved — the form instance region comes from the case's known amounts,
 * the way the located model values define it in run.ts.
 *
 * A WRONG reading (checked read as empty, or empty as checked) is the failure
 * that matters; "unknown" routes the box to preparer review.
 *
 * Usage: npx tsx local-ai/gauntlet/checkboxes.ts [--variant scan ...] [--case id ...]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ClassifiableFormType } from '../src/documentClassifier.js';
import { applyPageEvidence } from '../src/formEvidence.js';
import { getFormExtractionSchema } from '../src/formSchemas.js';
import { closeOcr, HERE, nativePage, OUT_DIR, scanPage } from './pages.js';

/** Checkboxes the case fills; every other checkbox on the form is empty. */
const CHECKED: Record<string, string[]> = {
  'w2-basic-single': ['13.retirement'],
  '1099r-ira': ['7b'],
  '1098-mortgage': ['7'],
  '1098t-university': ['8'],
  '1099b-sale': ['2.long', '3.collectibles', '6.gross', '12'],
  '1099q-529': ['5b', '6'],
  '1099sa-archer': ['5.archer'],
  '1099c-card': ['5'],
  '1099g-unemployment': ['8'],
  '1099misc-rents': ['7'],
  '1099oid-bond': ['fatca'],
};

interface Case {
  id: string;
  formType: ClassifiableFormType;
  expectedBoxes: Record<string, { money?: number }>;
}

function argsOf(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]!] : []));
}

async function main() {
  const variants = argsOf('--variant');
  const ids = argsOf('--case');
  const cases: Case[] = readdirSync(join(HERE, 'cases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(HERE, 'cases', f), 'utf8')))
    .filter((c) => ids.length === 0 || ids.includes(c.id));
  const totals: Record<string, { right: number; unknown: number; wrong: number }> = {};
  try {
    for (const variant of variants.length ? variants : ['native', 'scan', 'fax', 'faded']) {
      const t = (totals[variant] = { right: 0, unknown: 0, wrong: 0 });
      for (const c of cases) {
        const schema = getFormExtractionSchema(c.formType)!;
        const png = join(OUT_DIR, variant === 'native' ? `${c.id}.png` : `${c.id}-${variant}.png`);
        if (!existsSync(png)) throw new Error(`Render ${png} first`);
        const page = variant === 'native' ? await nativePage(c.id, png) : await scanPage(png);
        // The case's known amounts stand in for model values: they locate the form instance.
        const known: Record<string, string> = {};
        const used = new Set<string>();
        for (const b of schema.boxes) {
          const money = c.expectedBoxes[b.box]?.money;
          if (b.kind !== 'money' || money === undefined || used.has(b.box)) continue;
          known[b.key] = money.toFixed(2);
          used.add(b.box);
        }
        const { checkboxes } = applyPageEvidence(schema, known, page);
        for (const [key, reading] of Object.entries(checkboxes)) {
          const want = (CHECKED[c.id] ?? []).includes(key) ? 'checked' : 'unchecked';
          const verdict = reading.state === want ? 'right' : reading.state === 'unknown' ? 'unknown' : 'wrong';
          t[verdict]++;
          if (verdict !== 'right') {
            console.log(`${variant.padEnd(6)} ${c.id.padEnd(17)} ${key.padEnd(15)} ${verdict.toUpperCase().padEnd(7)} want ${want}, read ${reading.state}: ${reading.reason}`);
          }
        }
      }
    }
  } finally {
    await closeOcr();
  }
  for (const [variant, t] of Object.entries(totals)) {
    console.log(`${variant.padEnd(6)} right ${t.right} | unknown ${t.unknown} | WRONG ${t.wrong}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
