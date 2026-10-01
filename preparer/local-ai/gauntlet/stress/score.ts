// Scores a stress run: what the app stored for each document against the true
// values (truth.json), and each case's computed return.
// Usage (from preparer/): npx tsx local-ai/gauntlet/stress/score.ts local-ai/gauntlet/stress
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateForm1040 } from '../../../shared/src/engine/form1040.ts';

const DIR = process.argv[2]!;
const truth = JSON.parse(readFileSync(join(DIR, 'truth.json'), 'utf8'));
const cases: Array<{ taxReturn: any; documents: any[]; facts?: any[] }> = JSON.parse(readFileSync(join(DIR, 'run', 'cases-final.json'), 'utf8'));
const replies = JSON.parse(readFileSync(join(DIR, 'run', 'replies.json'), 'utf8'));
const reviews: Record<string, string> = JSON.parse(readFileSync(join(DIR, 'run', 'reviews.json'), 'utf8'));
const summary = JSON.parse(readFileSync(join(DIR, 'run', 'summary.json'), 'utf8'));

const ARRAY: Record<string, string> = {
  add_w2: 'w2Income', add_1099_int: 'income1099INT', add_1099_div: 'income1099DIV', add_1099_g: 'income1099G',
  add_education_expense: 'educationCredits', add_1099_r: 'income1099R', add_1099_nec: 'income1099NEC',
  add_1099_misc: 'income1099MISC', add_1099_b: 'income1099B', add_1099_oid: 'income1099OID', add_1099_c: 'income1099C',
  add_1099_sa: 'income1099SA',
};

const name = (r: any) => [r.firstName, r.lastName].filter(Boolean).join(' ') || '(no name)';
const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function same(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) < 0.005;
  if (typeof expected === 'boolean') return actual === expected || (expected === false && actual === undefined);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => Object.entries(e).every(([k, v]) => same(v, a?.[k]))));
  }
  if (expected && typeof expected === 'object') {
    return Object.entries(expected).every(([k, v]) => same(v, (actual as any)?.[k]));
  }
  return norm(actual).includes(norm(expected)) || (norm(expected).includes(norm(actual)) && norm(actual).length > 3);
}

const lines: string[] = [];
const out = (s = '') => lines.push(s);
let fieldsRight = 0, fieldsTotal = 0;
const problems: string[] = [];

out(`# Stress run — ${cases.length} cases, ${truth.documents.length} documents`);
out(`batch: ${summary.batchSeconds}s; placed by the preparer: ${JSON.stringify(summary.preparerPlaced)}; notes: ${summary.notes.join('; ') || 'none'}`);
out();

for (const doc of truth.documents) {
  const hits = cases.flatMap((c) => c.documents.filter((d: any) => d.fileName === doc.file).map((d: any) => ({ c, d })));
  out(`## ${doc.file} (${doc.form}, ${doc.household}, ${doc.person}${doc.expect ? `; ${doc.expect}` : ''})`);
  if (!hits.length) { out('  NOT ON ANY CASE'); problems.push(`${doc.file}: on no case`); continue; }
  for (const { c, d } of hits) {
    const r = c.taxReturn;
    const onRight = name(r).toUpperCase() === doc.household.toUpperCase();
    out(`  case ${name(r)}${onRight ? '' : '  <-- not the household case'} | status ${d.status} | forms ${JSON.stringify(d.formTypes ?? d.classifications?.map((x: any) => x.formType))} | applied ${JSON.stringify(d.appliedAs)} | years ${JSON.stringify(d.taxYearsPrinted)}`);
    if (!onRight && doc.person !== 'spouse') problems.push(`${doc.file}: placed on ${name(r)}`);
    const arr = ARRAY[doc.tool];
    const items = arr ? (r[arr] ?? []).filter((it: any) => String(it.sourceFormKey ?? '').startsWith(`${d.documentId}#`)) : [];
    if (doc.tool === 'add_mortgage_interest') {
      const got = r.itemizedDeductions?.mortgageInterest;
      fieldsTotal++;
      if (same(doc.args.mortgageInterest, got)) fieldsRight++; else problems.push(`${doc.file}: mortgage interest ${got} (true ${doc.args.mortgageInterest})`);
      out(`  itemized mortgage interest: ${got} (true ${doc.args.mortgageInterest})`);
      continue;
    }
    if (!items.length) { out(`  no ${arr} item from this document`); if (!doc.expect) problems.push(`${doc.file}: no ${arr} item`); continue; }
    if (doc.expect) problems.push(`${doc.file}: became a ${arr} item (${doc.expect})`);
    for (const item of items) {
      const wrong: string[] = [];
      for (const [k, v] of Object.entries(doc.args)) {
        fieldsTotal++;
        // A box kept as a fact but not on the engine item (1099-C box 5) is checked on the facts.
        const fact = k in item ? undefined : (c.facts ?? []).find((f: any) => f.sourceDocumentId === d.documentId && f.sourceField === k && f.status === 'extracted');
        const got = k in item ? item[k] : fact?.value;
        if (same(v, got)) fieldsRight++;
        else wrong.push(`${k}: ${JSON.stringify(got)} (true ${JSON.stringify(v)})`);
      }
      out(`  item ${arr}: ${wrong.length ? `WRONG/MISSING ${wrong.join('; ')}` : 'all fields right'}`);
      if (wrong.length) problems.push(`${doc.file}: ${wrong.join('; ')}`);
    }
  }
}

out();
out('# Cases');
for (const { taxReturn: r, documents } of cases) {
  let f: any;
  try { f = calculateForm1040(r).form1040; } catch (e) { f = { error: String(e) }; }
  const reply = replies.find((x: any) => x.returnId === r.id);
  out(`## ${name(r)} — ${r.filingStatus ?? 'no filing status'}, ${r.dependents?.length ?? 0} dependents, spouse ${[r.spouseFirstName, r.spouseLastName].filter(Boolean).join(' ') || '-'}, ${documents.length} documents`);
  out(`  AGI ${f.agi} | deduction ${f.deductionAmount} | taxable ${f.taxableIncome} | income tax ${f.incomeTax} | credits ${f.totalCredits} | SE ${f.seTax} | total tax ${f.totalTax} | payments ${f.totalPayments} | refund ${f.refundAmount} | owed ${f.amountOwed}${f.error ? ` | ERROR ${f.error}` : ''}`);
  if (reply) out(`  reply: ${reply.answered} in ${reply.seconds}s; offers: ${reply.offers.join(' || ') || 'none'}`);
  const review = reviews[r.id] ?? '';
  const open = review.split('\n').filter((l) => /required|missing|warning|confirm|decide|check|not |waits|review/i.test(l)).slice(0, 25);
  out(`  review lines: ${open.length}`);
  for (const l of open) out(`    - ${l.trim().slice(0, 220)}`);
}

out();
out(`# Fields read right: ${fieldsRight}/${fieldsTotal}`);
out('# Problems');
for (const p of problems) out(`- ${p}`);
writeFileSync(join(DIR, 'run', 'score.md'), lines.join('\n'));
console.log(lines.join('\n'));
