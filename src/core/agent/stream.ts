import { createUIMessageStream, type InferUITools, type UIMessage } from 'ai';
import { log } from '@/utils/log';
import { checkAnswer } from './checks';
import type { ChatRun } from './loop';
import { buildAnswer } from './persist';
import { summarizeTiming } from './timing';
import type { AgentTools } from './tools';
import type { ChatMetadata, Flag, Outcome, Timing } from '@/types/agent';

// The response stream (spec 6, steps 4–5). The answer streams as generated;
// once it ends cleanly, the output checks run on the text the browser
// received, the answer is saved, and the flags and whether the save worked go
// out as message metadata, before the finish chunk. A failed or stopped answer
// gets no checks and is not saved; only its question stays (spec 6.4).

export type ChatUIMessage = UIMessage<ChatMetadata, never, InferUITools<AgentTools>>;

export function toChatStream(run: ChatRun, onError: (error: unknown) => string) {
  return createUIMessageStream<ChatUIMessage>({
    onError,
    execute: async ({ writer }) => {
      // Text blocks in the order the UI creates text parts.
      const blocks: string[] = [];
      const open = new Map<string, number>();
      let outcome: Outcome = 'ok';
      let firstText: number | null = null;
      let lastText: number | null = null;
      let steps = 0;
      let flagCount: number | null = null;
      let timing: Timing | null = null;
      const measure = () =>
        summarizeTiming({
          startedAt: run.exchange.startedAt,
          endedAt: performance.now(),
          firstText,
          lastText,
          toolCalls: run.exchange.toolCalls,
        });

      try {
        for await (const chunk of run.result.toUIMessageStream<ChatUIMessage>({
          sendFinish: false,
          onError,
          generateMessageId: () => run.assistantMessageId,
        })) {
          if (chunk.type === 'start-step') steps++;
          if (chunk.type === 'text-start') open.set(chunk.id, blocks.push('') - 1);
          if (chunk.type === 'text-delta') {
            lastText = performance.now();
            firstText ??= lastText;
            const i = open.get(chunk.id);
            if (i !== undefined) blocks[i] += chunk.delta;
          }
          if (chunk.type === 'error') outcome = 'error';
          if (chunk.type === 'abort') outcome = 'cancelled';
          writer.write(chunk);
        }
        if (outcome !== 'ok') return;

        const flags = checkAnswer(blocks, run.exchange.sources);
        flagCount = flags.length;
        timing = measure();
        // Flags first, so the marks show without waiting on the database.
        writer.write({ type: 'message-metadata', messageMetadata: { flags } });
        const saved = await save(run, flags, timing);
        writer.write({ type: 'message-metadata', messageMetadata: { saved } });
        writer.write({ type: 'finish', finishReason: await run.result.finishReason });
      } catch (error) {
        outcome = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error';
        throw error;
      } finally {
        log.info('chat.done', { outcome, ...(timing ?? measure()), steps, flags: flagCount });
      }
    },
  });
}

/** Saves the answer; a failure leaves the answer on screen with a notice (spec 6.4). */
async function save(run: ChatRun, flags: Flag[], timing: Timing): Promise<boolean> {
  try {
    const answer = await buildAnswer({
      exchange: run.exchange,
      steps: await run.result.steps,
      assistantMessageId: run.assistantMessageId,
      flags,
      timing,
      now: run.deps.clock.now(),
    });
    await run.deps.store.saveAnswer(answer);
    return true;
  } catch (error) {
    log.error('chat.save_failed', { error });
    return false;
  }
}
