/**
 * Client-note gauntlet (work order §25).
 *
 * Notes a client writes that answer no open question, each with the record
 * tool calls its words support. Every note is read the way the app reads it —
 * notePrompt + noteSchema per kind on the approved reader through
 * ModelRuntime, then confirmNoteProposals — and each proposal the preparer
 * would be shown is scored against the expected ones (matched by person,
 * state, or payee and amount):
 *
 *   right     every value it proposes is right (it may leave some unknown)
 *   WRONG     a value is not what the words say, or the note states no such
 *             person, state or payment (must be 0)
 *   missed    an expected one was not proposed
 *
 * Usage: npx tsx local-ai/gauntlet/run-notes.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { confirmNoteCall, noteCalls, type NoteKind, type NoteProposal, type NoteReading } from '../src/clientNotes.js';
import { ModelRuntime } from '../src/modelRuntime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const YEAR = 2025;

type Expected = Record<string, unknown>;

interface NoteCase {
  id: string;
  note: string;
  /** Whose return the note is on, when the case knows. */
  client?: string;
  expect: Partial<Record<NoteKind, Expected[]>>;
}

const CASES: NoteCase[] = [
  { id: 'baby', note: 'Big news: we had a baby girl, Lily Lee, born March 3, 2025!', expect: { dependents: [{ firstName: 'Lily', lastName: 'Lee', dateOfBirth: '2025-03-03' }] } },
  { id: 'move', note: 'I moved from Texas to Louisiana in June.', expect: { states: [{ stateCode: 'TX', residencyType: 'part_year' }, { stateCode: 'LA', residencyType: 'part_year' }] } },
  { id: 'irs-payment', note: 'I paid the IRS $1,500 in estimated tax on April 15, 2025.', expect: { payments: [{ jurisdiction: 'federal', amount: 1500, datePaid: '2025-04-15' }] } },
  { id: 'two-payments', note: 'We made two estimated payments to Louisiana, $400 each.', expect: {} },
  { id: 'mother', note: 'My mother Rosa Diaz moved in with us in May, she has no income.', expect: { dependents: [{ firstName: 'Rosa', lastName: 'Diaz', relationship: 'Mother' }] } },
  { id: 'nothing', note: 'Thanks! Nothing new this year.', expect: {} },
  { id: 'son-college', note: 'My son Leo started college in Baton Rouge.', expect: { dependents: [{ firstName: 'Leo', relationship: 'Son' }] } },
  { id: 'still-ohio', note: 'We still live in Ohio, no changes.', expect: {} },
  { id: 'q3', note: 'Paid my Q3 estimate of $2,250 to the IRS on 9/15/2025.', expect: { payments: [{ jurisdiction: 'federal', amount: 2250, datePaid: '2025-09-15' }] } },
  { id: 'twins', note: 'We welcomed twins, Ava and Noah Lee, on August 9, 2025.', expect: { dependents: [{ firstName: 'Ava', lastName: 'Lee', dateOfBirth: '2025-08-09' }, { firstName: 'Noah', lastName: 'Lee', dateOfBirth: '2025-08-09' }] } },
  { id: 'nevada', note: 'Moved out of California last January, been in Nevada since.', expect: { states: [{ stateCode: 'CA', residencyType: 'part_year' }, { stateCode: 'NV', residencyType: 'part_year' }] } },
  { id: 'state-payment', note: 'I sent $600 to the state of Louisiana for my 2025 estimated taxes in January 2026.', expect: { payments: [{ jurisdiction: 'LA', amount: 600 }] } },
  {
    id: 'long-update',
    note: 'Hi Sarah, a few updates for this year. We adopted a little boy, Mateo Cruz, in October. We are still in Houston, Texas. I also paid $900 in estimated tax to the IRS on June 16, 2025.',
    expect: { dependents: [{ firstName: 'Mateo', lastName: 'Cruz' }], payments: [{ jurisdiction: 'federal', amount: 900, datePaid: '2025-06-16' }] },
  },
];

/** Written before the per-state change was first run, and run as they are. */
const HELD_OUT: NoteCase[] = [
  { id: 'granddaughter', note: 'Our granddaughter Sofia Reyes has lived with us since her parents moved overseas.', expect: { dependents: [{ firstName: 'Sofia', lastName: 'Reyes', relationship: 'Grandchild' }] } },
  { id: 'fl-to-ga', note: 'We relocated from Florida to Georgia on July 1st.', expect: { states: [{ stateCode: 'FL', residencyType: 'part_year' }, { stateCode: 'GA', residencyType: 'part_year' }] } },
  { id: 'ny-all-year', note: 'Lived in New York all year, same apartment.', expect: { states: [{ stateCode: 'NY', residencyType: 'resident' }] } },
  { id: 'dog', note: 'We got a puppy named Max in February!', expect: {} },
  { id: 'estimate-guess', note: 'I think I paid around $1,000 in estimated tax sometime in the spring.', expect: {} },
  { id: 'ca-payment', note: 'Paid California $750 estimated tax on 6/15/2025.', expect: { payments: [{ jurisdiction: 'CA', amount: 750, datePaid: '2025-06-15' }] } },
  { id: 'born-no-year', note: 'Our son Eli was born on May 20.', expect: { dependents: [{ firstName: 'Eli', relationship: 'Son' }] } },
  { id: 'worked-in-state', note: 'I work in New Jersey but live in Pennsylvania, same as last year.', expect: {} },
  { id: 'friend', note: 'My friend Jordan Park stayed with us for a couple weeks in July.', expect: {} },
  {
    id: 'mixed',
    note: 'Quick update: my nephew Omar Haddad moved in with us in January. I also sent the IRS $1,200 for estimated taxes on 1/15/2025.',
    expect: { dependents: [{ firstName: 'Omar', lastName: 'Haddad', relationship: 'Nephew' }], payments: [{ jurisdiction: 'federal', amount: 1200, datePaid: '2025-01-15' }] },
  },
];

/** Replies from the 2026-10-01 stress run and their neighbours: a new client's family, a spouse, a business expense. */
const STRESS_RUN: NoteCase[] = [
  {
    id: 'okafor',
    client: 'Ben Okafor',
    note: 'Ben and I (Cara Okafor, SSN 000-31-5502, born July 19, 1988) are married and file jointly. Ben was born March 2, 1986. Our kids Noah Okafor (born April 12, 2016, SSN 000-55-1201) and Lily Okafor (born September 30, 2019, SSN 000-55-1202) lived with us all year. We all live in Illinois.',
    expect: {
      dependents: [
        { firstName: 'Noah', lastName: 'Okafor', dateOfBirth: '2016-04-12', ssn: '000-55-1201' },
        { firstName: 'Lily', lastName: 'Okafor', dateOfBirth: '2019-09-30', ssn: '000-55-1202', monthsLivedWithYou: 12 },
      ],
      spouse: [{ firstName: 'Cara', lastName: 'Okafor', dateOfBirth: '1988-07-19', ssn: '000-31-5502' }],
      states: [{ stateCode: 'IL', residencyType: 'resident' }],
    },
  },
  {
    id: 'whitfield',
    client: 'Dana Whitfield',
    note: "I'm filing as head of household. My son Marcus Whitfield (born February 3, 2014, SSN 000-66-3001) lived with me all year and I paid all the household costs.",
    expect: { dependents: [{ firstName: 'Marcus', lastName: 'Whitfield', relationship: 'Son', dateOfBirth: '2014-02-03', ssn: '000-66-3001', monthsLivedWithYou: 12 }] },
  },
  {
    id: 'moreno',
    client: 'Fay Moreno',
    note: "I'm single with no dependents, a Texas resident. I'm a freelance designer; my business expenses were $3,200 for software and equipment.",
    expect: { expenses: [{ amount: 3200, description: 'software and equipment' }], states: [{ stateCode: 'TX', residencyType: 'resident' }] },
  },
  { id: 'married-no-name', note: 'My wife and I are filing jointly again this year.', expect: {} },
  { id: 'new-roof', note: 'We spent $4,000 on a new roof for the house.', expect: {} },
  { id: 'newlywed', note: 'I got married in June to Priya Shah, born February 14, 1990.', expect: { spouse: [{ firstName: 'Priya', lastName: 'Shah', dateOfBirth: '1990-02-14' }] } },
];

const keyOf = (kind: NoteKind, v: Record<string, unknown>) =>
  kind === 'dependents' || kind === 'spouse' ? String(v.firstName).toLowerCase()
    : kind === 'states' ? String(v.stateCode)
    : kind === 'expenses' ? String(v.amount)
    : `${v.jurisdiction}|${v.amount}`;

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = argOf('--out') ?? join(HERE, 'out', 'notes-qwen35-0.8b.json');
  const stateDir = join(HERE, 'out', '.runtime');
  mkdirSync(stateDir, { recursive: true });
  const runtime = new ModelRuntime({
    modelsDir: join(REPO, 'models'),
    llamaServer: join(REPO, 'tools', 'llama-cpp', 'bin', 'llama-server.exe'),
    stateDir,
    log: (m) => console.error(`[runtime] ${m}`),
  });

  const tallies = {
    tuned: { right: 0, full: 0, wrong: 0, missed: 0, rejected: 0 },
    heldOut: { right: 0, full: 0, wrong: 0, missed: 0, rejected: 0 },
    stressRun: { right: 0, full: 0, wrong: 0, missed: 0, rejected: 0 },
  };
  const rows: unknown[] = [];
  let ms = 0;
  let calls = 0;
  try {
    for (const [set, c] of [...CASES.map((c) => ['tuned', c] as const), ...HELD_OUT.map((c) => ['heldOut', c] as const), ...STRESS_RUN.map((c) => ['stressRun', c] as const)]) {
      const tally = tallies[set];
      // Every call for the note, pooled by kind (one per named state for states).
      const byKind = new Map<NoteKind, { reading: NoteReading; models: string[] }>();
      for (const call of noteCalls(c.note, YEAR, c.client)) {
        const { content, run } = await runtime.read('reader', { prompt: call.prompt, name: call.name, jsonSchema: call.schema as Record<string, unknown> });
        ms += run.ms;
        calls += 1;
        const r = confirmNoteCall(call, c.note, content, YEAR);
        const pooled = byKind.get(call.kind) ?? { reading: { proposals: [], rejected: [] }, models: [] };
        pooled.reading.proposals.push(...r.proposals);
        pooled.reading.rejected.push(...r.rejected);
        pooled.models.push(content);
        byKind.set(call.kind, pooled);
      }
      for (const kind of ['dependents', 'states', 'payments', 'spouse', 'expenses'] as const) {
        const { reading, models: content } = byKind.get(kind) ?? { reading: { proposals: [], rejected: [] }, models: [] };
        const expected = c.expect[kind] ?? [];
        const verdicts: string[] = [];
        const seen = new Set<string>();
        for (const p of reading.proposals as NoteProposal[]) {
          const want = expected.find((e) => keyOf(kind, e) === keyOf(kind, p.args));
          // An expense's description is the client's own words, not a value to match.
          const sameValues = want !== undefined && Object.entries(p.args).every(([k, v]) => (kind === 'expenses' && k === 'description') || want[k] === v);
          if (sameValues) {
            tally.right += 1;
            seen.add(keyOf(kind, p.args));
            const full = Object.keys(want).length === Object.keys(p.args).length;
            if (full) tally.full += 1;
            verdicts.push(`right${full ? '' : ' (fewer fields)'} ${JSON.stringify(p.args)}${p.dropped.length ? ` dropped ${p.dropped.join(',')}` : ''}`);
          } else {
            tally.wrong += 1;
            verdicts.push(`WRONG ${JSON.stringify(p.args)} want ${JSON.stringify(want ?? 'nothing')}`);
          }
        }
        for (const e of expected) {
          if (!seen.has(keyOf(kind, e))) {
            tally.missed += 1;
            verdicts.push(`missed ${JSON.stringify(e)}`);
          }
        }
        tally.rejected += reading.rejected.length;
        rows.push({ set, case: c.id, kind, model: content, reading, verdicts });
        const tag = set === 'heldOut' ? '[held out] ' : set === 'stressRun' ? '[stress run] ' : '';
        for (const v of verdicts) console.log(`${tag}${c.id} / ${kind}: ${v}`);
        for (const r of reading.rejected) console.log(`${tag}${c.id} / ${kind}: rejected — ${r.reason}${r.quote ? ` ("${r.quote}")` : ''}`);
      }
    }
  } finally {
    await runtime.shutdown();
  }
  console.log('');
  for (const [set, t] of Object.entries(tallies)) {
    console.log(`${set}: PROPOSALS right ${t.right} (all fields ${t.full}) | WRONG ${t.wrong} | missed ${t.missed} | rejected by the words ${t.rejected}`);
  }
  console.log(`${(ms / calls / 1000).toFixed(1)}s per call, ${(calls / (CASES.length + HELD_OUT.length + STRESS_RUN.length)).toFixed(1)} calls per note`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ model: 'Qwen3.5-0.8B (reader)', tallies, secondsPerCall: ms / calls / 1000, rows }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
