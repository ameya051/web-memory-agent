import type { StepResult, ToolSet } from 'ai';
import { localDate } from '@/utils/dates';
import type { NewAnswer, NewSource, StoredPart } from '@/core/ports';
import { citedRefs } from './checks';
import { type Exchange } from './exchange';
import { urlKey } from '@/utils/url';
import { partsText } from './thread';

import { contentHash } from './versions';
import type { Flag, SearchMemoryResult, SourceRead, Timing } from '@/types/agent';

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

  // Saved when the answer cites it or fetch_page read it (spec 5.5). A read
  // search_memory returned is already saved with its own exchange; the
  // search_memory part points to that row instead.
  const cited = new Set(citedRefs(answer));
  const reads = [...exchange.sources.values()].filter(
    (s): s is SourceRead & { via: 'search' | 'fetch' } => s.via === 'fetch' || (s.via === 'search' && cited.has(s.ref)),
  );
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
      const output = result?.type === 'tool-result' ? result.output : undefined;
      const saved = c.toolName === 'search_memory' ? savedSources(output, exchange) : undefined;
      parts.push({
        type: 'tool',
        name: c.toolName,
        toolCallId: c.toolCallId,
        input: c.input,
        status: result?.type === 'tool-result' ? 'ok' : 'error',
        durationMs: durations.get(c.toolCallId) ?? null,
        refs: output === undefined ? [] : outputRefs(output),
        ...(saved && { savedSources: saved }),
      });
    }
  }
  return parts;
}

function outputRefs(output: unknown): string[] {
  if (typeof output !== 'object' || output === null) return [];
  if ('exchanges' in output) return (output as SearchMemoryResult).exchanges.map((e) => e.exchange_id);
  if ('results' in output && Array.isArray(output.results)) return output.results.map((r: { ref: string }) => r.ref);
  if ('ref' in output && typeof output.ref === 'string') return [output.ref];
  return [];
}

/** Each ref search_memory gave a saved read, mapped to that read's sources row. */
function savedSources(output: unknown, exchange: Exchange): Record<string, string> | undefined {
  if (typeof output !== 'object' || output === null || !('exchanges' in output)) return undefined;
  const map: Record<string, string> = {};
  for (const e of (output as SearchMemoryResult).exchanges) {
    for (const { ref } of e.sources) {
      const id = exchange.sources.get(ref)?.sourceId;
      if (id) map[ref] = id;
    }
  }
  return map;
}
