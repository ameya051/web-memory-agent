import type { StepResult, ToolSet } from 'ai';
import { localDate } from '@/utils/dates';
import type { NewAnswer, NewSource, StoredPart } from '@/core/ports';
import { citedRefs } from './checks';
import { type Exchange } from './exchange';
import { urlKey } from '@/utils/url';
import { partsText } from './thread';

import { contentHash } from './versions';
import type { Flag, Timing } from '@/types/agent';

// What is saved when an answer completes (spec 5.3–5.5, 6 step 5): the
// assistant message as ordered parts, the exchange, and the sources read.

export async function buildAnswer(args: {
  exchange: Exchange;
  steps: ReadonlyArray<StepResult<ToolSet>>;
  assistantMessageId: string;
  flags: Flag[];
  timing: Timing;
  now: Date;
}): Promise<NewAnswer> {
  const { exchange, steps } = args;
  const { context } = exchange;
  const parts = assistantParts(steps, exchange);
  const answer = partsText(parts);

  // Saved when the answer cites it or fetch_page read it (spec 5.5).
  const cited = new Set(citedRefs(answer));
  const reads = [...exchange.sources.values()].filter((s) => s.via === 'fetch' || cited.has(s.ref));
  const sources = await Promise.all(
    reads.map(async (s): Promise<NewSource> => ({
      ref: s.ref,
      // Saved without its #fragment, the form the allow-list and versioning look up.
      url: urlKey(s.url) ?? s.url,
      title: s.title,
      publishedAt: s.publishedDate,
      via: s.via,
      fetchedAt: s.fetchedAt,
      contentText: s.text,
      contentHash: s.hash ?? (await contentHash(s.text)),
      version: s.version,
    })),
  );

  return {
    userId: context.userId,
    conversationId: context.conversationId,
    message: { id: args.assistantMessageId, parts, flags: args.flags, timing: args.timing, createdAt: args.now },
    exchange: {
      userMessageId: context.userMessageId,
      askedAt: context.askedAt,
      userTz: context.timeZone,
      localDate: localDate(context.askedAt, context.timeZone),
      question: context.question,
      answer,
    },
    sources,
  };
}

/** Steps in order; each tool call becomes one part carrying what it returned by ref. */
export function assistantParts(steps: ReadonlyArray<StepResult<ToolSet>>, exchange: Exchange): StoredPart[] {
  const durations = new Map(exchange.toolCalls.map((c) => [c.toolCallId, Math.round(c.end - c.start)]));
  const parts: StoredPart[] = [];
  for (const step of steps) {
    for (const c of step.content) {
      if ((c.type === 'text' || c.type === 'reasoning') && c.text.trim() !== '') parts.push({ type: c.type, text: c.text });
      if (c.type !== 'tool-call') continue;
      const result = step.content.find(
        (r) => (r.type === 'tool-result' || r.type === 'tool-error') && r.toolCallId === c.toolCallId,
      );
      parts.push({
        type: 'tool',
        name: c.toolName,
        toolCallId: c.toolCallId,
        input: c.input,
        status: result?.type === 'tool-result' ? 'ok' : 'error',
        durationMs: durations.get(c.toolCallId) ?? null,
        refs: result?.type === 'tool-result' ? outputRefs(result.output) : [],
      });
    }
  }
  return parts;
}

function outputRefs(output: unknown): string[] {
  if (typeof output !== 'object' || output === null) return [];
  if ('results' in output && Array.isArray(output.results)) return output.results.map((r: { ref: string }) => r.ref);
  if ('ref' in output && typeof output.ref === 'string') return [output.ref];
  return [];
}
