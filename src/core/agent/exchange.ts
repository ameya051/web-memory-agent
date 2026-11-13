// What one request has seen so far: who asked what and when, the sources read
// (by ref), the URLs fetch_page may open, the page versions seen, and the
// per-request tool budgets (spec 4.2, 5.5, 9.2). Built fresh for every
// request, so refs restart at s1.

import { urlKey } from '@/utils/url';
import type { LatestFetch } from '@/core/ports';
import { ToolError } from './errors';
import type { ExchangeContext, SourceRead, ToolCallTime } from '@/types/agent';

export const TOOL_BUDGETS = { web_search: 10, fetch_page: 10, search_memory: 3 } as const;
type BudgetedTool = keyof typeof TOOL_BUDGETS;

export function createExchange(context: ExchangeContext) {
  const sources = new Map<string, SourceRead>();
  // Versions decided in this request, by urlKey, so two reads of one page agree.
  const versions = new Map<string, LatestFetch>();
  const allowedUrls = new Set<string>();
  const used: Record<BudgetedTool, number> = { web_search: 0, fetch_page: 0, search_memory: 0 };
  const toolCalls: ToolCallTime[] = [];
  let nextRef = 1;

  return {
    /** performance.now() when the request arrived; the start of every timing. */
    startedAt: performance.now(),
    context,
    sources,
    versions,
    toolCalls,

    recordTool(call: ToolCallTime) {
      toolCalls.push(call);
    },

    /** Keeps a read under a new ref. Search results join the fetch allow-list; memory reads are saved sources, already on it. */
    addSource(read: Omit<SourceRead, 'ref'>): SourceRead {
      const source = { ref: `s${nextRef++}`, ...read };
      sources.set(source.ref, source);
      if (read.via === 'search') {
        const key = urlKey(read.url);
        if (key) allowedUrls.add(key);
      }
      return source;
    },

    /** Whether a search in this request returned the URL. Saved sources are checked by the tool. */
    isAllowed(url: string): boolean {
      const key = urlKey(url);
      return key !== null && allowedUrls.has(key);
    },

    /** Counts a call; throws once the tool's budget for this request is spent. */
    spend(tool: BudgetedTool) {
      if (used[tool] >= TOOL_BUDGETS[tool]) {
        throw new ToolError(`${tool} budget used up: at most ${TOOL_BUDGETS[tool]} calls per answer. Answer with what you have.`);
      }
      used[tool]++;
    },
  };
}

export type Exchange = ReturnType<typeof createExchange>;
