import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { setLogSink } from '@/utils/log';
import type { ChatRequest } from '@/types/agent';

// Builders for the AI SDK mock model: each step is one scripted model response.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Chunk = Record<string, unknown> & { type: string };

function step(chunks: Chunk[], finish: 'stop' | 'tool-calls') {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        ...chunks,
        { type: 'finish', finishReason: { unified: finish, raw: undefined }, usage },
      ] as never[],
    }),
  };
}

export function textStep(text: string) {
  return step(
    [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: text },
      { type: 'text-end', id: 't1' },
    ],
    'stop',
  );
}

export function toolStep(calls: Array<{ name: string; input: unknown }>) {
  return step(
    calls.map((c, i) => ({
      type: 'tool-call',
      toolCallId: `call-${i + 1}`,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
    'tool-calls',
  );
}

export function mockModel(steps: Array<ReturnType<typeof step>>) {
  return new MockLanguageModelV4({ doStream: steps });
}

/** A chat request with fresh browser ids; pass conversationId to continue a thread. */
export function chatRequest(text: string, timeZone = 'UTC', conversationId: string = crypto.randomUUID()): ChatRequest {
  return { conversationId, messageId: crypto.randomUUID(), text, timeZone };
}

/** Everything the model was sent on one call, as text, for loose assertions. */
export function promptText(model: MockLanguageModelV4, call: number): string {
  return JSON.stringify(model.doStreamCalls[call].prompt);
}

/** Captures log lines until restore() puts the console sink back. */
export function captureLogs() {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  return { lines, restore: () => setLogSink() };
}
