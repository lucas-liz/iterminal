import type { ResolvedModel } from '../model';
import { AnthropicClient } from './anthropic';
import { OpenAiClient } from './openai';
import type { LlmClient } from './types';

export function createLlmClient(resolved: ResolvedModel): LlmClient {
  return resolved.provider.type === 'ANTHROPIC' ? new AnthropicClient(resolved) : new OpenAiClient(resolved);
}
