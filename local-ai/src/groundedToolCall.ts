/**
 * Grounded tool calling (work order §5, §26, §59, §72).
 *
 * A tool-calling model may choose among tax tools and fields, but it may not
 * supply values. Measured sub-1B controllers passed `wages: 0` for an unknown
 * wage and invented a whole 1099-NEC for a 1098 — both schema-valid. So:
 *
 *   1. only the tool matching the document's classified form is offered
 *      (a form with no tax tool is never sent to the model);
 *   2. each offered argument is fixed to its extracted fact value with a JSON
 *      Schema `const`, which llama.cpp turns into a grammar — unknown facts are
 *      simply absent, so a model cannot generate them;
 *   3. every returned call is verified again deterministically before anything
 *      is written; a call that fails verification is rejected with reasons.
 *
 * Non-document evidence (a client's answer) keeps the tool's own enum
 * constraints; its result is a candidate fact, never a final decision.
 */

import type { ClassifiableFormType } from './documentClassifier.js';
import { toolForForm } from './formSchemas.js';
import type { TaxFact, TaxFactValue } from './taxFact.js';
import { FILING_STATUS_CANDIDATES, TAX_TOOL_NAMES, type TaxToolName } from './taxTools.js';
import { taxToolDefinitions, type JsonSchema, type ToolDefinition } from './toolDefinitions.js';

/** The one tax tool a classified document may feed, or null when none exists yet. */
export function toolForFormType(formType: ClassifiableFormType | null | undefined): TaxToolName | null {
  return toolForForm(formType);
}

function baseDefinition(tool: TaxToolName): ToolDefinition {
  return taxToolDefinitions().find((d) => d.name === tool)!;
}

/**
 * Tool definitions for one document's facts. Returns [] when the form has no
 * tax tool or no extracted fact feeds one — the model is then not asked.
 */
export function groundedToolDefinitions(
  formType: ClassifiableFormType | null | undefined,
  facts: readonly TaxFact[],
): ToolDefinition[] {
  const tool = toolForFormType(formType);
  if (!tool) return [];
  const base = baseDefinition(tool);
  const baseProps = (base.parameters as { properties: Record<string, JsonSchema> }).properties;
  const properties: Record<string, JsonSchema> = {};
  for (const fact of facts) {
    if (fact.status !== 'extracted') continue;
    if (!Object.prototype.hasOwnProperty.call(baseProps, fact.sourceField)) continue;
    properties[fact.sourceField] = { const: fact.value as TaxFactValue };
  }
  if (Object.keys(properties).length === 0) return [];
  return [
    {
      name: tool,
      description:
        `${base.description} Every allowed field is already fixed to the value read from the document; ` +
        'include each field that belongs on this form.',
      parameters: { type: 'object', properties, additionalProperties: false },
    },
  ];
}

export interface ProposedToolCall {
  name: string;
  args: Record<string, unknown> | null;
}

export interface GroundedVerification {
  ok: boolean;
  /** Why the call was rejected (empty when ok). */
  errors: string[];
  /** Extracted fact fields the call left out — reported, not an error. */
  omittedFields: string[];
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Deterministic check of a model's call against the document's facts. Every
 * argument must equal an extracted fact for the same field; unknown facts,
 * values that differ from the document, unknown fields and other tools fail.
 */
export function verifyGroundedCall(
  call: ProposedToolCall,
  formType: ClassifiableFormType | null | undefined,
  facts: readonly TaxFact[],
): GroundedVerification {
  const errors: string[] = [];
  const allowed = toolForFormType(formType);
  if (!(TAX_TOOL_NAMES as readonly string[]).includes(call.name)) {
    errors.push(`"${call.name}" is not a tax tool`);
  } else if (call.name !== allowed) {
    errors.push(allowed ? `tool "${call.name}" does not match a ${formType} (expected "${allowed}")` : `no tax tool accepts a ${formType ?? 'unclassified document'}`);
  }
  if (!call.args || typeof call.args !== 'object') {
    errors.push('arguments are not a JSON object');
    return { ok: false, errors, omittedFields: [] };
  }
  const byField = new Map(facts.map((f) => [f.sourceField, f]));
  for (const [field, value] of Object.entries(call.args)) {
    const fact = byField.get(field);
    if (!fact) {
      errors.push(`"${field}" has no fact in the document`);
    } else if (fact.status !== 'extracted') {
      errors.push(`"${field}" is unknown in the document and must be omitted (got ${JSON.stringify(value)})`);
    } else if (!sameValue(fact.value, value)) {
      errors.push(`"${field}" is ${JSON.stringify(fact.value)} on the document, not ${JSON.stringify(value)}`);
    }
  }
  const omittedFields = facts
    .filter((f) => f.status === 'extracted' && !(f.sourceField in call.args!))
    .map((f) => f.sourceField);
  return { ok: errors.length === 0, errors, omittedFields };
}

// ─── Non-document evidence: client answers ───────────────────

/** The model's explicit "the answer does not say" choice. */
export const NOT_STATED = 'not_stated' as const;

/**
 * JSON grammar for reading a filing-status candidate from a client's own
 * words. The model must pick one of the five statuses or "not_stated"; it
 * cannot answer in prose or invent a status. Measured: without a grammar,
 * Qwen3.5-0.8B answered a clear "we want to file together" in prose.
 */
export function filingStatusAnswerSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['filingStatusCandidate'],
    properties: {
      filingStatusCandidate: { type: 'string', enum: [...FILING_STATUS_CANDIDATES, NOT_STATED] },
    },
  };
}

/** Turn the grammar-constrained answer into a candidate tool call, or none. */
export function filingStatusCallFromAnswer(output: unknown): ProposedToolCall | null {
  if (!output || typeof output !== 'object') return null;
  const status = (output as { filingStatusCandidate?: unknown }).filingStatusCandidate;
  if (typeof status !== 'string' || status === NOT_STATED) return null;
  if (!(FILING_STATUS_CANDIDATES as readonly string[]).includes(status)) return null;
  return { name: 'set_filing_status_candidate', args: { status } };
}

/**
 * Instruction paired with filingStatusAnswerSchema. Defines each status in the
 * plain words clients use, so "we want to file together" maps to joint filing,
 * and keeps "not_stated" as the answer whenever the words do not say.
 */
export const FILING_STATUS_ANSWER_PROMPT = [
  'Which filing status do the client\'s own words state? Meanings:',
  '- married_filing_jointly: a married couple filing one return together',
  '- married_filing_separately: a married person filing their own return apart from their spouse',
  '- single: unmarried and not claiming head of household',
  '- head_of_household: unmarried and paying to keep up a home for a qualifying person',
  '- qualifying_surviving_spouse: spouse died in one of the two prior years and a dependent child lives at home',
  'Answer "not_stated" if the client is unsure, asks for advice, or does not say. Do not decide eligibility; only record what the client said.',
].join('\n');

/**
 * Deterministic reading of a filing status the client explicitly states.
 * Returns null when the words state none, hedge, ask for advice, or negate.
 * Describing circumstances ("my kids live with me") is not a stated status:
 * eligibility is decided by the engine, never inferred here.
 */
export function filingStatusFromClientWords(words: string): (typeof FILING_STATUS_CANDIDATES)[number] | null {
  const t = ` ${words.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  if (/\b(not sure|unsure|don't know|do not know|whatever|what(ever)? is best|which is best|saves? (us|me)|advice|recommend|should (we|i))\b/.test(t)) return null;
  if (/\b(not|don't|do not|never) (want to )?(file )?(jointly|together|separately|a joint)\b/.test(t)) return null;
  const found = new Set<(typeof FILING_STATUS_CANDIDATES)[number]>();
  if (/\bqualifying (surviving spouse|widow(er)?)\b/.test(t)) found.add('qualifying_surviving_spouse');
  if (/\bhead of (the )?household\b/.test(t)) found.add('head_of_household');
  if (/\b(file|filing|return)\b.*\b(jointly|together|joint)\b|\bjoint return\b|\bmarried filing jointly\b/.test(t)) found.add('married_filing_jointly');
  if (/\b(file|filing)\b.*\bseparately\b|\bmy own return\b|\bseparate returns?\b|\bmarried filing separately\b/.test(t)) found.add('married_filing_separately');
  if (/\bsingle\b/.test(t) && !/\bmarried\b/.test(t.replace(/\bnever (been )?married\b/g, ''))) found.add('single');
  return found.size === 1 ? [...found][0]! : null;
}

export interface FilingStatusConfirmation {
  call: ProposedToolCall | null;
  /** Why no candidate was recorded, when none was. */
  reason?: string;
}

/**
 * A filing-status candidate is recorded only when the model's grammar-
 * constrained answer and the deterministic phrase reading agree. Any
 * disagreement records nothing and leaves the question to the preparer.
 */
export function confirmFilingStatusCandidate(modelOutput: unknown, clientWords: string): FilingStatusConfirmation {
  const modelCall = filingStatusCallFromAnswer(modelOutput);
  const stated = filingStatusFromClientWords(clientWords);
  const modelStatus = (modelCall?.args?.status as string | undefined) ?? null;
  if (modelStatus === stated) return stated ? { call: modelCall } : { call: null, reason: 'the client did not state a filing status' };
  return {
    call: null,
    reason: `model read ${modelStatus ?? 'no status'} but the client's words state ${stated ?? 'no status'}; left for the preparer`,
  };
}
