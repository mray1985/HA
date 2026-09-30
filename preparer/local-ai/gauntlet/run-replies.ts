/**
 * Client-reply gauntlet (work order §25, §56).
 *
 * Realistic client replies to the questions clientQuestions.ts asks, each with
 * the answer the words give (or null when the words give none: the client is
 * unsure, estimates, or does not answer). Every question is read the way the
 * product reads it — clientAnswerPrompt + clientAnswerSchema on the approved
 * reader model through ModelRuntime, then confirmClientAnswer — and scored:
 *
 *   right     a value recorded, and it is the client's answer
 *   WRONG     a value recorded that is not (must be 0)
 *   missed    the words give an answer, but it was left for the preparer
 *   open      the words give none, and nothing was recorded
 *
 * Usage: npx tsx local-ai/gauntlet/run-replies.ts [--out report.json]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientAnswerPrompt, clientAnswerSchema, confirmClientAnswer, type ClientAnswerValue } from '../src/clientAnswers.js';
import type { ClientQuestion } from '../src/clientQuestions.js';
import { ModelRuntime } from '../src/modelRuntime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const YEAR = 2025;
const months = (name: string): ClientQuestion => ({
  id: `months:${name}`, kind: 'months', max: 12, subjectName: name, text: `How many months of ${YEAR} did ${name} live with you?`,
  target: { kind: 'dependent', field: 'monthsLivedWithYou', person: { firstName: name, lastName: 'Lee' } },
});
const relationship = (name: string): ClientQuestion => ({
  id: `relationship:${name}`, kind: 'relationship', subjectName: name, text: `How is ${name} Lee related to you?`,
  target: { kind: 'dependent', field: 'relationship', person: { firstName: name, lastName: 'Lee' } },
});
const residency = (code: string, name: string): ClientQuestion => ({
  id: `residency:${code}`, kind: 'residency', text: `Did you live in ${name} for all of ${YEAR}, for part of ${YEAR}, or not at all?`,
  target: { kind: 'residency', field: 'residencyType', stateCode: code },
});
const days = (code: string, name: string): ClientQuestion => ({
  id: `days:${code}`, kind: 'days', max: 366, text: `How many days of ${YEAR} did you live in ${name}?`,
  target: { kind: 'residency', field: 'daysLivedInState', stateCode: code },
});
const qtp: ClientQuestion = {
  id: 'qtp', kind: 'amount',
  text: `How much did you pay in ${YEAR} for qualified education expenses (tuition, required fees, books, supplies, and room and board) for the student on the 1099-Q from VANGUARD 529 PLAN?`,
  target: { kind: 'form', tool: 'add_1099_q', formKey: 'Q#0', field: 'qualifiedExpenses' },
};
const hsa: ClientQuestion = {
  id: 'hsa', kind: 'yes_no', text: `Was all of the ${YEAR} distribution on the 1099-SA from HEALTHEQUITY INC used to pay qualified medical expenses?`,
  target: { kind: 'form', tool: 'add_1099_sa', formKey: 'SA#0', field: 'usedForQualifiedMedicalExpenses' },
};
const filing: ClientQuestion = {
  id: 'filing', kind: 'filing_status',
  text: `How do you want to file your ${YEAR} return: single, married filing jointly, married filing separately, head of household, or qualifying surviving spouse?`,
  target: { kind: 'filing_status' },
};

interface ReplyCase {
  id: string;
  reply: string;
  /** Each question asked, with the answer the words give (null: none). */
  asks: Array<[ClientQuestion, ClientAnswerValue | null]>;
}

const CASES: ReplyCase[] = [
  { id: 'full-year', reply: 'Hi Sarah, yes Maya lived with me the whole year. Thanks!', asks: [[months('Maya'), 12]] },
  { id: 'two-children', reply: 'Maya lived with us all year. Leo lived with us 8 months, he moved out when he started his job.', asks: [[months('Maya'), 12], [months('Leo'), null]] },
  { id: 'daughter-all-2025', reply: "She's my daughter and she lived with me all of 2025.", asks: [[relationship('Maya'), 'Daughter'], [months('Maya'), 12]] },
  { id: 'nephew-moved-in', reply: 'Leo is my nephew. He moved in with us in March after his mom got sick.', asks: [[relationship('Leo'), 'Nephew'], [months('Leo'), null]] },
  { id: 'unsure-months', reply: 'I think she was with us most of the year, maybe 9 or 10 months?', asks: [[months('Maya'), null]] },
  { id: 'lives-with-mom', reply: "No she didn't live with me, she lives with her mom full time.", asks: [[months('Maya'), 0]] },
  { id: 'numbered', reply: '1. Yes all year\n2. She is my granddaughter\n3. $3,200 for her books and tuition', asks: [[months('Maya'), 12], [relationship('Maya'), 'Grandchild'], [qtp, 3200]] },
  { id: 'not-whole-year', reply: 'She did not live with us the whole year, only from June.', asks: [[months('Maya'), null]] },
  { id: 'both-in-one-sentence', reply: 'Leo lived with us 12 months and Maya 6 months.', asks: [[months('Leo'), null], [months('Maya'), null]] },
  { id: 'girlfriends-son', reply: "Leo is my girlfriend's son, he lives with us.", asks: [[relationship('Leo'), null]] },
  { id: 'stepson', reply: "Leo's my stepson. He's been with us all year.", asks: [[relationship('Leo'), 'Stepson'], [months('Leo'), 12]] },
  { id: 'joint', reply: "We're married and want to file jointly like always.", asks: [[filing, 'married_filing_jointly']] },
  { id: 'refund-please', reply: 'Filing status - whatever gets us the bigger refund lol', asks: [[filing, null]] },
  { id: 'hoh', reply: 'Please file me as head of household again this year.', asks: [[filing, 'head_of_household']] },
  { id: 'tuition-fees', reply: 'For the 529, we paid $14,250 in tuition and fees for Emma this year.', asks: [[qtp, 14250]] },
  { id: 'tuition-and-dorm', reply: 'Tuition was $9,000 and her dorm was $6,500.', asks: [[qtp, null]] },
  { id: 'estimate', reply: 'About $12k I think, I can look for the receipts.', asks: [[qtp, null]] },
  { id: 'hsa-yes', reply: 'Yes, the whole thing went to my surgery bills.', asks: [[hsa, true]] },
  { id: 'hsa-partial', reply: 'Mostly medical, but I used some of it for a new laptop.', asks: [[hsa, null]] },
  { id: 'hsa-no', reply: 'No - I took it out to pay off a credit card.', asks: [[hsa, false]] },
  { id: 'resident', reply: 'Yep, lived in Baton Rouge all year.', asks: [[residency('LA', 'Louisiana'), 'resident']] },
  { id: 'worked-there', reply: 'I never lived in Texas, I just worked there on a project for a few months.', asks: [[residency('TX', 'Texas'), 'nonresident']] },
  { id: 'other-state', reply: "I only worked in Texas, I've always lived in Louisiana.", asks: [[residency('TX', 'Texas'), null]] },
  { id: 'moved-here', reply: 'We moved here in August 2025.', asks: [[residency('LA', 'Louisiana'), 'part_year']] },
  { id: 'days-exact', reply: 'We were in Louisiana 153 days in 2025.', asks: [[days('LA', 'Louisiana'), 153]] },
  { id: 'days-about', reply: 'About 150 days or so.', asks: [[days('LA', 'Louisiana'), null]] },
  { id: 'nothing-useful', reply: "Thanks, I'll send the rest of my paperwork next week!", asks: [[months('Maya'), null], [qtp, null], [filing, null]] },
  {
    id: 'long-email',
    reply: [
      'Hi, sorry for the delay!',
      'Maya is my daughter, she lived with me all year like always.',
      'For the college account we paid $11,480 for her tuition.',
      "The HSA money was all for Leo's braces, every penny.",
      'We will file married filing jointly.',
    ].join('\n'),
    asks: [[relationship('Maya'), 'Daughter'], [months('Maya'), 12], [qtp, 11480], [hsa, true], [filing, 'married_filing_jointly']],
  },
];

/**
 * Written after the reader was tuned on CASES and run once as they are: the
 * measure of replies the reader has not seen.
 */
const HELD_OUT: ReplyCase[] = [
  { id: 'grandparents', reply: 'Maya lived with her grandparents all year while I was deployed.', asks: [[months('Maya'), null]] },
  { id: 'son-age', reply: "Leo is my son, he's 12.", asks: [[relationship('Leo'), 'Son'], [months('Leo'), null]] },
  { id: 'scholarship', reply: 'We paid 4,000 for tuition in 2025 and she got a $1,500 scholarship.', asks: [[qtp, null]] },
  { id: 'single', reply: 'Single.', asks: [[filing, 'single']] },
  { id: 'divorced', reply: "I'm divorced now, the kids are with me.", asks: [[filing, null]] },
  { id: 'until-may', reply: 'We lived in Louisiana until May, then moved to Texas for my job.', asks: [[residency('LA', 'Louisiana'), null]] },
  { id: 'never-moved', reply: "I'm still in Shreveport, never moved.", asks: [[residency('LA', 'Louisiana'), 'resident']] },
  { id: 'half-year-days', reply: 'We moved in on July 1st so about half the year.', asks: [[days('LA', 'Louisiana'), null]] },
  { id: 'wifes-nephew', reply: "He's my wife's nephew, he's lived with us since 2023.", asks: [[relationship('Leo'), null]] },
  { id: 'since-born', reply: "Maya's been with us since she was born.", asks: [[months('Maya'), null]] },
  { id: 'twelve-months', reply: 'twelve months', asks: [[months('Maya'), 12]] },
  { id: 'hospital', reply: '10 months, she was in the hospital for 2.', asks: [[months('Maya'), null]] },
  { id: 'qtp-exact', reply: 'Total qualified expenses were $18,302.44 per the bursar statement.', asks: [[qtp, 18302.44]] },
  { id: 'hsa-dental', reply: 'Yes it was all dental work.', asks: [[hsa, true]] },
  { id: 'hsa-unsure', reply: "I don't remember what that one was for.", asks: [[hsa, null]] },
  {
    id: 'family-update',
    reply: 'Leo is my stepson and lived with us all year. Maya moved out in April to live with her dad. Please file us jointly.',
    asks: [[relationship('Leo'), 'Stepson'], [months('Leo'), 12], [months('Maya'), null], [filing, 'married_filing_jointly']],
  },
];

/**
 * Written after the reader was changed for the first held-out run's one wrong
 * value ("10 months, she was in the hospital for 2"), and run once as they are.
 */
const HELD_OUT_2: ReplyCase[] = [
  { id: 'camp', reply: 'She lived with me the entire year except for 3 weeks at summer camp.', asks: [[months('Maya'), null]] },
  { id: 'dash-list', reply: 'Leo - 11 months, Maya - 12.', asks: [[months('Leo'), 11], [months('Maya'), 12]] },
  { id: 'every-month', reply: 'My daughter Maya stayed with us every month of 2025.', asks: [[relationship('Maya'), 'Daughter'], [months('Maya'), 12]] },
  { id: 'books-fees', reply: 'We spent $2,350.75 on her books and fees, tuition was paid by her grant.', asks: [[qtp, 2350.75]] },
  { id: 'hsa-except', reply: 'Yes except for the $200 I used on vitamins.', asks: [[hsa, null]] },
  { id: 'mfs', reply: "Married filing separately please, we're separated.", asks: [[filing, 'married_filing_separately']] },
  { id: 'left-texas', reply: 'I moved out of Texas in February.', asks: [[residency('TX', 'Texas'), 'part_year']] },
  { id: 'live-in-la', reply: 'We live in Louisiana.', asks: [[residency('LA', 'Louisiana'), null]] },
  { id: 'brothers-son', reply: "He's my brother's son.", asks: [[relationship('Leo'), null]] },
  { id: 'both-kids', reply: 'Both kids lived with us all year.', asks: [[months('Maya'), 12], [months('Leo'), 12]] },
  { id: 'gap-year', reply: 'No expenses this year, she took a gap year.', asks: [[qtp, 0]] },
  { id: 'about-hsa', reply: 'About the HSA: yes, 100% medical.', asks: [[hsa, true]] },
  { id: 'foster', reply: 'She is my foster daughter and has lived with us since 2022.', asks: [[relationship('Maya'), 'Foster Child'], [months('Maya'), null]] },
];

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = argOf('--out') ?? join(HERE, 'out', 'replies-qwen35-0.8b.json');
  const stateDir = join(HERE, 'out', '.runtime');
  mkdirSync(stateDir, { recursive: true });
  const runtime = new ModelRuntime({
    modelsDir: join(REPO, 'models'),
    llamaServer: join(REPO, 'tools', 'llama-cpp', 'bin', 'llama-server.exe'),
    stateDir,
    log: (m) => console.error(`[runtime] ${m}`),
  });

  const tallies = {
    tuned: { right: 0, wrong: 0, missed: 0, open: 0 },
    heldOut: { right: 0, wrong: 0, missed: 0, open: 0 },
    heldOut2: { right: 0, wrong: 0, missed: 0, open: 0 },
  };
  const rows: unknown[] = [];
  let ms = 0;
  let calls = 0;
  try {
    for (const [set, c] of [...CASES.map((c) => ['tuned', c] as const), ...HELD_OUT.map((c) => ['heldOut', c] as const), ...HELD_OUT_2.map((c) => ['heldOut2', c] as const)]) {
      const tally = tallies[set];
      const names = c.asks.map(([q]) => q.subjectName).filter((n): n is string => Boolean(n));
      for (const [q, want] of c.asks) {
        const { content, run } = await runtime.read('reader', { prompt: clientAnswerPrompt(q, c.reply), name: 'answer', jsonSchema: clientAnswerSchema(q) as Record<string, unknown> });
        ms += run.ms;
        calls += 1;
        const outcome = confirmClientAnswer(q, c.reply, content, { otherNames: [...new Set(names)], alone: c.asks.filter(([o]) => o.kind === q.kind).length === 1 });
        const recorded = outcome.status === 'answered' ? outcome.value : null;
        const verdict = recorded !== null
          ? (recorded === want ? 'right' : 'WRONG')
          : (want === null ? 'open' : 'missed');
        tally[verdict === 'WRONG' ? 'wrong' : verdict] += 1;
        rows.push({ set, case: c.id, question: q.id, want, model: content, outcome, verdict, ms: run.ms });
        const why = outcome.status === 'unclear' ? ` (${outcome.reason})` : outcome.status === 'not_answered' ? ' (not stated)' : '';
        console.log(`${verdict.padEnd(6)} ${set === 'tuned' ? '' : `[${set}] `}${c.id} / ${q.id}: want ${JSON.stringify(want)} got ${JSON.stringify(recorded)}${why}  model=${content}`);
      }
    }
  } finally {
    await runtime.shutdown();
  }
  console.log('');
  for (const [set, t] of Object.entries(tallies)) {
    console.log(`${set}: ${t.right + t.wrong + t.missed + t.open} questions | right ${t.right} | WRONG ${t.wrong} | missed ${t.missed} | open ${t.open}`);
  }
  console.log(`${(ms / calls / 1000).toFixed(1)}s per question`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ model: 'Qwen3.5-0.8B (reader)', tallies, secondsPerQuestion: ms / calls / 1000, rows }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
