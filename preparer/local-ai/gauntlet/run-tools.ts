/**
 * Tool-calling gauntlet (work order §5, §56).
 *
 * Gives a local model normalized evidence (TaxFacts) plus the tax-tool
 * definitions generated from the validator schemas, and scores its calls:
 * correct tool selection, correct / missing / extra / invalid arguments,
 * hallucinated tools, duplicate calls, and whether a missing value was ever
 * passed as zero. Every call is also run through invokeTaxTool, the same
 * validator the product uses.
 *
 * Usage:
 *   npx tsx local-ai/gauntlet/run-tools.ts --model <gguf> [--out report.json]
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAX_TOOL_NAMES, invokeTaxTool, type TaxToolName } from '../src/taxTools.js';
import { openAiTools, taxToolDefinitions } from '../src/toolDefinitions.js';
import { FILING_STATUS_ANSWER_PROMPT, confirmFilingStatusCandidate, filingStatusAnswerSchema, groundedToolDefinitions, verifyGroundedCall } from '../src/groundedToolCall.js';
import { factsFromFields, type TaxFact } from '../src/taxFact.js';
import type { ClassifiableFormType } from '../src/documentClassifier.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

interface ToolCase {
  id: string;
  evidence: string;
  /** null = the correct behavior is to call no tool. */
  expectedTool: TaxToolName | null;
  expectedArgs: Record<string, unknown>;
  /** Fields that are unknown in the evidence: passing any value (esp. 0) is a failure. */
  mustOmit?: string[];
  /** Classified form of the source document; null for non-document evidence. */
  formType: ClassifiableFormType | null;
  /** Document facts when they differ from expectedArgs (a form with no tool). */
  factArgs?: Record<string, unknown>;
  /** The client's own words, for non-document evidence. */
  clientWords?: string;
}

/** The case's evidence as TaxFacts (unknown fields included as unknown facts). */
function caseFacts(tc: ToolCase): TaxFact[] {
  const fields: Record<string, unknown> = { ...(tc.factArgs ?? tc.expectedArgs) };
  for (const k of tc.mustOmit ?? []) fields[k] = undefined;
  return factsFromFields({ returnId: 'R', taxYear: 2026, documentId: `DOC-${tc.id}`, fileName: `${tc.id}.pdf`, extractor: 'gauntlet', factTypeFor: (f) => f, fields });
}

const SYSTEM =
  'You add tax documents to a tax return by calling tools. Use only the facts given. ' +
  'Copy values exactly. Never pass a field whose fact is unknown or absent, and never pass 0 for a missing value. ' +
  'If no tool fits the evidence, do not call any tool.';

function factLines(formLabel: string, args: Record<string, unknown>, unknown: string[] = []): string {
  const lines = Object.entries(args).map(([k, v]) => `- ${k} = ${JSON.stringify(v)}`);
  for (const k of unknown) lines.push(`- ${k} = UNKNOWN (box present but unreadable)`);
  return `Document: ${formLabel}\nExtracted facts:\n${lines.join('\n')}\n\nAdd this document to the return.`;
}

function buildCases(): ToolCase[] {
  const out: ToolCase[] = [];
  const casesDir = join(HERE, 'cases');
  for (const f of readdirSync(casesDir).filter((x) => x.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(join(casesDir, f), 'utf8'));
    if (!(TAX_TOOL_NAMES as readonly string[]).includes(c.expected.tool)) {
      out.push({ id: `${c.id}-no-tool`, evidence: factLines(`Form ${c.formType}`, c.expected.args), expectedTool: null, expectedArgs: {}, formType: c.formType, factArgs: c.expected.args });
      continue;
    }
    out.push({ id: c.id, evidence: factLines(`Form ${c.formType}`, c.expected.args), expectedTool: c.expected.tool, expectedArgs: c.expected.args, formType: c.formType });
  }
  // Unknown must never become zero.
  out.push({
    id: 'w2-wages-unknown',
    evidence: factLines('Form W-2', { employerName: 'RIVERBEND LOGISTICS LLC', federalTaxWithheld: 5873.4, state: 'LA' }, ['wages', 'socialSecurityWages']),
    expectedTool: 'add_w2',
    expectedArgs: { employerName: 'RIVERBEND LOGISTICS LLC', federalTaxWithheld: 5873.4, state: 'LA' },
    mustOmit: ['wages', 'socialSecurityWages'],
    formType: 'W-2',
  });
  // A printed zero is a real value and must be kept.
  out.push({
    id: '1099int-printed-zero',
    evidence: factLines('Form 1099-INT', { payerName: 'FIRST HARBOR BANK', amount: 42.17, federalTaxWithheld: 0 }),
    expectedTool: 'add_1099_int',
    expectedArgs: { payerName: 'FIRST HARBOR BANK', amount: 42.17, federalTaxWithheld: 0 },
    formType: '1099-INT',
  });
  // Client response → filing-status candidate only.
  out.push({
    id: 'client-filing-status',
    evidence: 'Client response to "What is your marital status and how do you want to file?":\n"We got married in June and want to file together."\n\nRecord what the client said.',
    expectedTool: 'set_filing_status_candidate',
    expectedArgs: { status: 'married_filing_jointly' },
    formType: null,
    clientWords: 'We got married in June and want to file together.',
  });
  // Client answers: a status is recorded only when the client's words state one.
  // Facts that might make someone eligible (kids at home, a spouse who died) are
  // not a stated status — eligibility is the engine's job (work order §21).
  const answers: Array<[string, string, string | null]> = [
    ['client-joint-return', 'My wife and I will file a joint return like last year.', 'married_filing_jointly'],
    ['client-separate', "I'm married but we keep our finances separate, so I'll file my own return.", 'married_filing_separately'],
    ['client-single', "I'm single, never been married.", 'single'],
    ['client-single-short', 'Single.', 'single'],
    ['client-asks-hoh', 'Please file me as head of household.', 'head_of_household'],
    ['client-status-not-stated', 'Not sure yet, I need to ask my accountant what is best.', null],
    ['client-facts-only-divorced', 'Divorced last year. My two kids live with me full time and I pay all the bills.', null],
    ['client-facts-only-widowed', 'My husband passed away last year. I have a 6 year old at home.', null],
    ['client-asks-advice', "We're married, do whatever saves us the most money.", null],
  ];
  for (const [id, words, status] of answers) {
    out.push({
      id,
      evidence: `Client response to "What is your marital status and how do you want to file?":\n"${words}"\n\nRecord what the client said.`,
      expectedTool: status ? 'set_filing_status_candidate' : null,
      expectedArgs: status ? { status } : {},
      formType: null,
      clientWords: words,
    });
  }
  return out;
}

function findServer(): string {
  const stack = [join(REPO, 'tools', 'llama-cpp', 'bin')];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'llama-server.exe' || e.name === 'llama-server') return p;
    }
  }
  throw new Error('llama-server not found');
}

async function startServer(model: string, port: number): Promise<ChildProcess> {
  const child = spawn(findServer(), ['-m', model, '--port', String(port), '--host', '127.0.0.1', '-c', '8192', '--jinja', '--no-webui', '-np', '1'], { stdio: 'ignore', windowsHide: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('llama-server did not become healthy');
}

interface ParsedCall { name: string; args: Record<string, unknown> | null; raw: string }

function parseCalls(message: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }): ParsedCall[] {
  return (message.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> | null = null;
    try { args = JSON.parse(tc.function.arguments); } catch { /* invalid JSON arguments */ }
    return { name: tc.function.name, args, raw: tc.function.arguments };
  });
}

async function main() {
  const i = process.argv.indexOf('--model');
  const model = resolve(process.argv[i + 1]!);
  const oi = process.argv.indexOf('--out');
  const outFile = oi >= 0 ? process.argv[oi + 1] : undefined;
  const port = 18090;
  const grounded = process.argv.includes('--grounded');
  if (!existsSync(model)) throw new Error(`Missing ${model}`);

  const child = await startServer(model, port);
  const results: unknown[] = [];
  const totals = { cases: 0, toolOk: 0, argsExact: 0, missing: 0, extra: 0, wrong: 0, invalid: 0, hallucinated: 0, duplicates: 0, zeroForUnknown: 0, ms: 0 };
  try {
    for (const tc of buildCases()) {
      // Grounded mode: tools come from the document's facts; a form with no tool is never sent.
      const facts = caseFacts(tc);
      const tools = grounded
        ? tc.formType === null
          ? taxToolDefinitions().filter((d) => d.name === 'set_filing_status_candidate')
          : groundedToolDefinitions(tc.formType, facts)
        : null;
      if (grounded && tools!.length === 0) {
        const ok = tc.expectedTool === null;
        totals.cases++;
        if (ok) { totals.toolOk++; totals.argsExact++; }
        results.push({ id: tc.id, ms: 0, toolOk: ok, argsExact: ok, calls: [], skipped: 'no grounded tool for this document' });
        console.log(`${tc.id}: not sent to the model (no tax tool for this document) | ${ok ? 'OK' : 'WRONG'}`);
        continue;
      }
      const t0 = Date.now();
      // Grounded client answers use a JSON grammar (status or not_stated), not the tools API.
      const clientAnswer = grounded && tc.formType === null;
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          temperature: 0,
          max_tokens: 600,
          chat_template_kwargs: { enable_thinking: false },
          ...(clientAnswer
            ? {
                response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: filingStatusAnswerSchema() } },
                messages: [{
                  role: 'user',
                  content: `${tc.evidence}\n\n${FILING_STATUS_ANSWER_PROMPT}`,
                }],
              }
            : {
                tools: grounded ? openAiTools(tools!) : openAiTools(),
                tool_choice: grounded ? 'required' : 'auto',
                messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: tc.evidence }],
              }),
        }),
      });
      const body = (await r.json()) as { choices?: Array<{ message: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>; error?: unknown };
      const ms = Date.now() - t0;
      const message = body.choices?.[0]?.message ?? { content: JSON.stringify(body.error ?? body) };
      let calls = parseCalls(message);
      if (clientAnswer) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(message.content ?? ''); } catch { /* not JSON → no call */ }
        // The candidate is recorded only when the model and the deterministic reading agree.
        const confirmed = confirmFilingStatusCandidate(parsed, tc.clientWords ?? '');
        const call = confirmed.call;
        calls = call ? [{ name: call.name, args: call.args, raw: message.content ?? '' }] : [];
        if (!call && confirmed.reason) console.log(`   ${tc.id}: ${confirmed.reason}`);
      }

      const hallucinated = calls.filter((c) => !(TAX_TOOL_NAMES as readonly string[]).includes(c.name)).length;
      const duplicates = Math.max(0, calls.length - 1);
      const first = calls[0];
      const toolOk = tc.expectedTool === null ? calls.length === 0 : first?.name === tc.expectedTool;
      let missing: string[] = [];
      let extra: string[] = [];
      let wrong: string[] = [];
      let invalid = false;
      let zeroForUnknown: string[] = [];
      if (first && first.args && tc.expectedTool) {
        missing = Object.keys(tc.expectedArgs).filter((k) => !(k in first.args!));
        extra = Object.keys(first.args).filter((k) => !(k in tc.expectedArgs));
        wrong = Object.keys(tc.expectedArgs).filter((k) => k in first.args! && JSON.stringify(first.args![k]) !== JSON.stringify(tc.expectedArgs[k]));
        zeroForUnknown = (tc.mustOmit ?? []).filter((k) => k in first.args!);
        if ((TAX_TOOL_NAMES as readonly string[]).includes(first.name)) {
          const v = invokeTaxTool({
            tool: first.name as TaxToolName,
            args: first.args,
            context: { returnId: 'R', taxYear: 2026, sourceDocumentId: 'DOC', sourceFileName: 'f.pdf', extractor: basename(model) },
          });
          invalid = !v.ok;
        }
      } else if (first && !first.args) {
        invalid = true;
      }
      // Grounded mode: the deterministic verifier decides whether the call may be applied.
      const verification = grounded && first && tc.formType !== null
        ? verifyGroundedCall({ name: first.name, args: first.args }, tc.formType, facts)
        : null;
      if (verification && !verification.ok) invalid = true;
      const argsExact = toolOk && missing.length === 0 && extra.length === 0 && wrong.length === 0 && !invalid;

      totals.cases++; totals.ms += ms;
      if (toolOk) totals.toolOk++;
      if (argsExact) totals.argsExact++;
      totals.missing += missing.length; totals.extra += extra.length; totals.wrong += wrong.length;
      if (invalid) totals.invalid++;
      totals.hallucinated += hallucinated; totals.duplicates += duplicates; totals.zeroForUnknown += zeroForUnknown.length;

      results.push({ id: tc.id, ms, toolOk, argsExact, calls, missing, extra, wrong, invalid, zeroForUnknown, verification, content: message.content });
      if (verification && !verification.ok) console.log(`   verifier rejected: ${verification.errors.join('; ')}`);
      console.log(`${tc.id}: ${ms} ms | tool ${first?.name ?? '(none)'} ${toolOk ? 'OK' : 'WRONG'} | args ${argsExact ? 'EXACT' : 'no'}${missing.length ? ` missing[${missing}]` : ''}${extra.length ? ` extra[${extra}]` : ''}${wrong.length ? ` wrong[${wrong}]` : ''}${invalid ? ' INVALID' : ''}${zeroForUnknown.length ? ` PASSED-UNKNOWN[${zeroForUnknown}]` : ''}${hallucinated ? ` hallucinated ${hallucinated}` : ''}${duplicates ? ` +${duplicates} extra calls` : ''}`);
      if (!first && tc.expectedTool) console.log(`   content: ${String(message.content ?? '').slice(0, 300).replace(/\n/g, ' ')}`);
    }
  } finally {
    child.kill();
  }
  console.log(`TOTAL ${basename(model)}${grounded ? ' (grounded)' : ''}: tool ${totals.toolOk}/${totals.cases} | exact args ${totals.argsExact}/${totals.cases} | missing ${totals.missing} extra ${totals.extra} wrong ${totals.wrong} invalid ${totals.invalid} | hallucinated ${totals.hallucinated} dup ${totals.duplicates} | unknown-passed ${totals.zeroForUnknown} | ${(totals.ms / totals.cases / 1000).toFixed(1)} s/call`);
  if (outFile) writeFileSync(resolve(outFile), JSON.stringify({ model: basename(model), totals, results }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
