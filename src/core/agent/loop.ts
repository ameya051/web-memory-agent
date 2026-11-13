import { isStepCount, streamText, type LanguageModel, type StepResult, type ToolSet } from 'ai';
import { log } from '@/utils/log';
import type { Clock, SearchProvider, Store } from '@/core/ports';
import { createExchange } from './exchange';
import { buildInstructions } from './prompt';

import { modelHistory } from './thread';
import { createTools } from './tools';
import type { ChatRequest } from '@/types/agent';

// The agent loop (spec 3, 6): save the question, rebuild the thread from the
// store, then one streaming model call per step. Tool calls in a step run in
// parallel (the SDK default), at most 8 steps.

export const MAX_STEPS = 8;
/** Abort a model step that produces no output for this long (spec 6.4). */
export const MODEL_STALL_MS = 20_000;
const TITLE_CHARS = 80;

export type AgentDeps = {
  model: LanguageModel;
  search: SearchProvider;
  clock: Clock;
  store: Store;
};

export async function runChat(deps: AgentDeps, request: ChatRequest, abortSignal?: AbortSignal) {
  const { conversationId, messageId, text, timeZone } = request;
  const askedAt = deps.clock.now();
  const query = text.replace(/\s+/g, ' ').trim();

  // Saved on arrival, so the question survives a failed answer (spec 5.3).
  // The save and the thread load run in parallel: one round trip, not two.
  const user = await deps.store.ensureUser(timeZone, askedAt);
  const [, thread] = await Promise.all([
    deps.store.saveUserMessage({
      id: messageId,
      conversationId,
      userId: user.id,
      text,
      title: query.length > TITLE_CHARS ? `${query.slice(0, TITLE_CHARS)}…` : query,
      createdAt: askedAt,
    }),
    deps.store.loadThread(user.id, conversationId),
  ]);
  // Everything before this question. The load may or may not see the question
  // itself, and on a repeated send it is already there.
  const at = thread.messages.findIndex((m) => m.id === messageId);
  const history = modelHistory(at === -1 ? thread.messages : thread.messages.slice(0, at));
  log.info('chat.request', { tz: timeZone, history: history.length, text: query });

  const exchange = createExchange({ userId: user.id, conversationId, userMessageId: messageId, question: text, askedAt, timeZone });
  const tools = createTools(deps, exchange);

  const result = streamText({
    model: deps.model,
    instructions: buildInstructions(askedAt, timeZone),
    messages: [...history, { role: 'user', content: text }],
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    maxRetries: 1,
    timeout: { firstChunkMs: MODEL_STALL_MS, chunkMs: MODEL_STALL_MS },
    abortSignal,
    onStepEnd: logStep,
    onStepError: ({ stepNumber, modelId, error }) => log.warn('agent.step_failed', { step: stepNumber, model: modelId, error }),
  });

  // Made here so the stream's start chunk and the saved row share one id.
  return { result, exchange, assistantMessageId: crypto.randomUUID(), deps };
}

export type ChatRun = Awaited<ReturnType<typeof runChat>>;

/** One line per model call: what it decided, how long it took, what it cost in tokens. */
function logStep(step: StepResult<ToolSet>) {
  const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));
  log.info('agent.step', {
    step: step.stepNumber,
    model: step.model.modelId,
    finish: step.finishReason,
    tools: step.toolCalls.map((c) => c.toolName).join(',') || undefined,
    ms: round(step.performance.stepTimeMs),
    firstOutputMs: round(step.performance.timeToFirstOutputMs),
    inputTokens: step.usage.inputTokens,
    cachedTokens: step.usage.inputTokenDetails.cacheReadTokens,
    outputTokens: step.usage.outputTokens,
  });
}
