import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

// The main model through OpenRouter (spec 2). Reasoning effort starts at
// medium (spec 10); the provider reads it from model settings, not the call options.

export function createMainModel(config: { OPENROUTER_API_KEY: string; MODEL_MAIN: string }): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter(config.MODEL_MAIN, { reasoning: { effort: 'medium' } });
}
