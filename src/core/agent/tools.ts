import { tool } from 'ai';
import { z } from 'zod';
import { localDate } from '@/utils/dates';
import type { Clock, SearchProvider, Store } from '@/core/ports';
import { ToolError } from './errors';
import { type Exchange } from './exchange';
import { urlKey } from '@/utils/url';
import { runTool } from './run-tool';

import { contentHash, nextVersion } from './versions';
import type { FetchPageResult, ToolCallTime, WebSearchResult } from '@/types/agent';

// Tool definitions (spec 4). Built once per request around that request's
// exchange, so refs (s1, s2, ...) are unique within the answer. fetch_page
// opens only URLs this request's searches returned or the user's saved sources.

export const EXCERPT_CHARS = 2000;
export const PAGE_CHARS = 20_000;
const DEFAULT_RESULTS = 5;

const webSearchInput = z.object({
  query: z.string().min(1).max(400).describe('Search query'),
  published_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .describe('YYYY-MM-DD; only return pages published on or after this date'),
  include_domains: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe('Up to 5 domains to restrict results to, e.g. ["hubspot.com"]'),
  num_results: z.number().int().min(1).max(10).optional().describe('1 to 10, default 5'),
});

const fetchPageInput = z.object({
  url: z.string().min(1).max(2048).describe('A url from a web_search result in this answer, or a page the user read before'),
});

export function createTools(deps: { search: SearchProvider; clock: Clock; store: Store }, exchange: Exchange) {
  const { userId, timeZone } = exchange.context;
  const record = (toolCallId: string) => (call: ToolCallTime) => exchange.recordTool({ ...call, toolCallId });

  const web_search = tool({
    description:
      'Search the web. Each result has a ref (cite it as [s1]), url, title, published_date and a text excerpt. Issue several calls in parallel for several entities.',
    inputSchema: webSearchInput,
    execute: (input, { abortSignal, toolCallId }): Promise<{ results: WebSearchResult[] }> =>
      runTool('web_search', input, async () => {
        exchange.spend('web_search');
        const hits = await deps.search.search(
          {
            query: input.query,
            numResults: input.num_results ?? DEFAULT_RESULTS,
            maxChars: EXCERPT_CHARS,
            publishedAfter: input.published_after,
            includeDomains: input.include_domains,
          },
          abortSignal,
        );
        const fetchedAt = deps.clock.now();
        return {
          results: hits.map((hit) => {
            const excerpt = hit.text.slice(0, EXCERPT_CHARS);
            const { ref } = exchange.addSource({
              url: hit.url,
              title: hit.title,
              via: 'search',
              publishedDate: hit.publishedDate,
              fetchedAt,
              text: excerpt,
              version: null,
              hash: null,
            });
            return { ref, url: hit.url, title: hit.title, published_date: hit.publishedDate, excerpt };
          }),
        };
      }, searchSummary, record(toolCallId)),
  });

  const fetch_page = tool({
    description:
      'Read one page in full, freshly crawled. Only accepts a url returned by a web_search call in an earlier step of this answer, or a page the user read before; never a url you know or guess, and never in the same step as the search that returns it. The page gets its own ref: cite that ref for facts taken from the full page. Returns the page version; the same version as an earlier read means identical content.',
    inputSchema: fetchPageInput,
    execute: ({ url }, { abortSignal, toolCallId }): Promise<FetchPageResult> =>
      runTool('fetch_page', { url }, async () => {
        // Refused before any budget is spent or any request is made (spec 4.2).
        const key = urlKey(url);
        if (!key || !(exchange.isAllowed(url) || (await deps.store.hasSource(userId, key)))) {
          throw new ToolError(
            'fetch_page refused: the url must come from a web_search result in this answer or a page the user read before.',
          );
        }
        exchange.spend('fetch_page');
        const page = await deps.search.fetchPage(url, PAGE_CHARS, abortSignal);
        const text = page.text.slice(0, PAGE_CHARS);
        const fetchedAt = deps.clock.now();

        // Version against this request's earlier read of the page, else the latest saved read.
        const pageKey = urlKey(page.url) ?? key;
        const hash = await contentHash(text);
        const latest = exchange.versions.get(pageKey) ?? (await deps.store.latestFetch(userId, pageKey));
        const seen = nextVersion(hash, latest, fetchedAt);
        exchange.versions.set(pageKey, seen);

        const { ref } = exchange.addSource({
          url: page.url,
          title: page.title,
          via: 'fetch',
          publishedDate: null,
          fetchedAt,
          text,
          version: seen.version,
          hash,
        });
        return {
          ref,
          url: page.url,
          title: page.title,
          fetched_at: fetchedAt.toISOString(),
          version: seen.version,
          ...(latest && { version_first_seen: localDate(seen.firstSeenAt, timeZone) }),
          text,
        };
      }, (page) => `${page.ref} v${page.version}, ${page.text.length} chars`, record(toolCallId)),
  });

  return { web_search, fetch_page };
}

function searchSummary({ results }: { results: WebSearchResult[] }): string {
  if (results.length === 0) return '0 results';
  return `${results.length} results (${results[0].ref}–${results[results.length - 1].ref})`;
}

export type AgentTools = ReturnType<typeof createTools>;
