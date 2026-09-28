import type { ChatResponse } from '@hatax/engine';
import { anthropicCompletionWithKey, rawAnthropicCompletionWithKey } from './anthropicClient.js';
import { openRouterCompletionWithKey, rawOpenRouterCompletionWithKey } from './openRouterClient.js';

export type LlmProvider = 'anthropic' | 'openrouter';

export function apiKeyError(provider: LlmProvider, apiKey: string): string | null {
  if (provider === 'openrouter') {
    return apiKey.startsWith('sk-or-') ? null : 'Invalid OpenRouter API key format. Keys start with "sk-or-".';
  }
  return apiKey.startsWith('sk-ant-') ? null : 'Invalid Anthropic API key format. Keys start with "sk-ant-".';
}

export async function completionWithUserKey(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: Record<string, unknown>,
  systemPrompt: string,
): Promise<ChatResponse> {
  if (provider === 'openrouter') {
    return openRouterCompletionWithKey(apiKey, model, messages, context, systemPrompt);
  }
  return anthropicCompletionWithKey(apiKey, model, messages, context, systemPrompt);
}

export async function rawCompletionWithUserKey(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
): Promise<string> {
  if (provider === 'openrouter') {
    return rawOpenRouterCompletionWithKey(apiKey, model, messages, systemPrompt);
  }
  return rawAnthropicCompletionWithKey(apiKey, model, messages, systemPrompt);
}
