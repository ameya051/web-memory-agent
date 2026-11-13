import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

// The models through OpenRouter (spec 2). Reasoning effort for the main model
// starts at medium (spec 10); the provider reads it from model settings, not
// the call options.

export function createMainModel(config: { OPENROUTER_API_KEY: string; MODEL_MAIN: string }): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter(config.MODEL_MAIN, { reasoning: { effort: 'medium' } });
}

export const DEFAULT_MODEL_EXTRACT = 'anthropic/claude-haiku-5.5';

/** The extraction model: no reasoning, since it copies facts and quotes rather than working anything out. */
export function createExtractModel(config: { OPENROUTER_API_KEY: string; MODEL_EXTRACT: string }): LanguageModel {
  return createOpenRouter({ apiKey: config.OPENROUTER_API_KEY })(config.MODEL_EXTRACT);
}
