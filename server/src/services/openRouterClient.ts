/**
 * OpenRouter adapter. The caller's key is used once and not stored.
 * https://openrouter.ai/docs/api-reference/chat-completion
 */

import { parseResponse, buildIrsReferenceData } from '@hatax/engine';
import type { ChatResponse } from '@hatax/engine';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function complete(
  apiKey: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://hatax.local',
      'X-Title': 'HA Tax',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 8192,
      messages,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`OpenRouter request failed (${response.status})`);
    (error as Error & { status?: number; providerBody?: string }).status = response.status;
    (error as Error & { providerBody?: string }).providerBody = detail.slice(0, 300);
    throw error;
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}

export async function openRouterCompletionWithKey(
  apiKey: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: Record<string, unknown>,
  systemPrompt: string,
): Promise<ChatResponse> {
  const referenceData = buildIrsReferenceData({
    filingStatus: context.filingStatus as string | undefined,
    currentSection: context.currentSection as string | undefined,
    incomeDiscovery: context.incomeDiscovery as Record<string, string> | undefined,
    deductionMethod: context.deductionMethod as string | undefined,
    dependentCount: context.dependentCount as number | undefined,
  });
  const raw = await complete(apiKey, model, [
    { role: 'system', content: `${systemPrompt}\n\n${referenceData}\n\nCURRENT CONTEXT:\n${JSON.stringify(context, null, 2)}` },
    ...messages,
  ]);
  return parseResponse(raw);
}

export async function rawOpenRouterCompletionWithKey(
  apiKey: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
): Promise<string> {
  return complete(apiKey, model, [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]);
}
