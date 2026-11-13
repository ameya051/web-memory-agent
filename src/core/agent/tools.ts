import { tool } from 'ai';
import { z } from 'zod';
import { isCalendarDate, localDate, localDateTime } from '@/utils/dates';
import type { Clock, MemoryExchange, SavedClaim, SearchProvider, Store } from '@/core/ports';
import { quoteFound } from '@/core/extract/quotes';
import { ToolError } from './errors';
import { type Exchange } from './exchange';
import { log } from '@/utils/log';
import { urlKey } from '@/utils/url';

import { contentHash, nextVersion } from './versions';
import type {
  FetchPageResult,
  MemoryExchangeResult,
  SavedClaimCheck,
  SearchMemoryResult,
  ToolCallTime,
  WebSearchResult,
} from '@/types/agent';

// Tool definitions (spec 4). Built once per request around that request's
// exchange, so refs (s1, s2, ...) are unique within the answer. fetch_page
// opens only URLs this request's searches returned or the user's saved sources.
// search_memory (spec 4.3) is a plain database read over the user's past
// exchanges, by local date, by topic, or both: no model call, no web access.
// Every saved read of a returned exchange gets a ref from this answer's
// counter, so a past figure can be cited and checked against the text it came
// from; that read is cited in place, never saved again.

export const EXCERPT_CHARS = 2000;
export const PAGE_CHARS = 20_000;
const DEFAULT_RESULTS = 5;
export const MEMORY_LIMIT = 10;
const NEAREST_PER_SIDE = 2;
export const ANSWER_CHARS = 4000;
/** Saved claims fetch_page checks against today's text (spec 4.2). */
export const SAVED_CLAIMS_LIMIT = 10;

const DATE_FORMAT = 'YYYY-MM-DD';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `Use ${DATE_FORMAT}`);

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

const searchMemoryInput = z
  .object({
    date_from: date.optional().describe(`The user's local calendar date, ${DATE_FORMAT}, inclusive`),
    date_to: date.optional().describe(`${DATE_FORMAT}, inclusive; defaults to date_from`),
    query: z.string().min(1).max(200).optional().describe('Topic words, such as "Postgres hosting"'),
  })
  .refine((i) => i.date_from !== undefined || i.query !== undefined, {
    message: `Give date_from (${DATE_FORMAT}), query, or both.`,
  });

export function createTools(deps: { search: SearchProvider; clock: Clock; store: Store }, exchange: Exchange) {
  const { userId, userMessageId, timeZone } = exchange.context;
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
      'Read one page in full, freshly crawled. Only accepts a url returned by a web_search call in an earlier step of this answer, or a page the user read before; never a url you know or guess, and never in the same step as the search that returns it. The page gets its own ref: cite that ref for facts taken from the full page. Returns the page version; the same version as an earlier read means identical content. When the user has saved claims from this page, saved_claims says for each whether it is unchanged or needs checking against today\'s text.',
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

        // Version against this request's earlier read of the page, else the
        // latest saved read; the saved claims for the quote check load alongside.
        const pageKey = urlKey(page.url) ?? key;
        const [hash, latest, claims] = await Promise.all([
          contentHash(text),
          exchange.versions.get(pageKey) ?? deps.store.latestFetch(userId, pageKey),
          deps.store.savedClaimsForUrl(userId, pageKey, SAVED_CLAIMS_LIMIT),
        ]);
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
          ...(claims.length > 0 && { saved_claims: claims.map((c) => claimCheck(c, seen.version, text)) }),
          text,
        };
      }, fetchSummary, record(toolCallId)),
  });

  const search_memory = tool({
    description:
      "Search the user's past conversations by their local date, by topic words, or both. Returns each matching exchange with its question, a summary, the claims it made (each with the ref of its supporting page) or else the answer text, and the pages read for it, each with a ref you can cite for figures from that earlier answer. Call it first whenever the user refers to an earlier conversation.",
    inputSchema: searchMemoryInput,
    execute: (input, { toolCallId }): Promise<SearchMemoryResult> =>
      runTool('search_memory', input, async () => {
        const dateFrom = input.date_from;
        const dateTo = input.date_to ?? dateFrom;
        for (const d of [dateFrom, dateTo]) {
          if (d !== undefined && !isCalendarDate(d)) throw new ToolError(`search_memory: ${d} is not a calendar date. Use ${DATE_FORMAT}.`);
        }
        if (dateFrom === undefined && dateTo !== undefined) throw new ToolError(`search_memory: give date_from (${DATE_FORMAT}) with date_to.`);
        if (dateFrom && dateTo && dateTo < dateFrom) throw new ToolError('search_memory: date_to is before date_from.');
        exchange.spend('search_memory');

        const query = input.query?.trim() || undefined;
        const found = await deps.store.searchMemory(userId, {
          dateFrom,
          dateTo,
          query,
          excludeUserMessageId: userMessageId,
          limit: MEMORY_LIMIT,
        });
        const result: SearchMemoryResult = {
          exchanges: found.exchanges.map((e) => memoryResult(e, exchange)),
          total_matches: found.total,
        };
        if (found.exchanges.length === 0 && dateFrom && dateTo) {
          const nearest = await deps.store.nearestExchanges(userId, {
            dateFrom,
            dateTo,
            excludeUserMessageId: userMessageId,
            perSide: NEAREST_PER_SIDE,
          });
          result.nearest = nearest.map((n) => ({
            exchange_id: n.id,
            asked_at: localDateTime(n.askedAt, n.userTz),
            question: n.question,
          }));
        }
        return result;
      }, memorySummary, record(toolCallId)),
  });

  return { web_search, fetch_page, search_memory };
}

// Runs one tool call: logs it with its duration and outcome, records its
// timing for the response total, and turns any failure into a ToolError so it
// stays apart from model errors in the stream. A cancelled call is rethrown as
// is. Page text is never logged; the logger redacts the search query.
async function runTool<T>(
  name: string,
  input: unknown,
  body: () => Promise<T>,
  summarize: (output: T) => string,
  record: (call: ToolCallTime) => void,
): Promise<T> {
  const started = performance.now();
  /** Records the call's timing and returns the fields every log line shares. */
  const finish = (status: 'ok' | 'error' | 'cancelled') => {
    const ended = performance.now();
    record({ name, start: started, end: ended, ok: status === 'ok' });
    return { tool: name, status, ms: Math.round(ended - started), input };
  };

  try {
    const output = await body();
    log.info('tool.call', { ...finish('ok'), result: summarize(output) });
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.info('tool.call', finish('cancelled'));
      throw error;
    }
    const failure = error instanceof ToolError ? error : new ToolError(error instanceof Error ? error.message : String(error));
    log.warn('tool.call', { ...finish('error'), reason: failure.message });
    throw failure;
  }
}

function searchSummary({ results }: { results: WebSearchResult[] }): string {
  if (results.length === 0) return '0 results';
  return `${results.length} results (${results[0].ref}–${results[results.length - 1].ref})`;
}

function fetchSummary(page: FetchPageResult): string {
  const claims = page.saved_claims ?? [];
  const check = claims.filter((c) => c.outcome === 'check').length;
  const quote = claims.length > 0 ? `, claims ${claims.length - check} unchanged ${check} check` : '';
  return `${page.ref} v${page.version}, ${page.text.length} chars${quote}`;
}

/**
 * The quote check (spec 4.2): a saved claim is unchanged when today's read is
 * the same version as the read it came from, or when its quote is still in
 * today's text, even if something else on the page changed (spec 10).
 */
function claimCheck(c: SavedClaim, version: number, text: string): SavedClaimCheck {
  const unchanged = c.version === version || quoteFound(c.quote, text);
  return {
    entity: c.entity,
    attribute: c.attribute,
    value: c.value,
    said_on: localDate(c.askedAt, c.userTz),
    outcome: unchanged ? 'unchanged' : 'check',
    ...(!unchanged && { quote: c.quote }),
  };
}

function memoryResult(e: MemoryExchange, exchange: Exchange): MemoryExchangeResult {
  // Each saved read gets a ref from this answer's counter; claims cite it by that ref.
  const refs = new Map<string, string>();
  const sources = e.sources.map((s) => {
    const { ref } = exchange.addSource({
      url: s.url,
      title: s.title,
      via: 'memory',
      sourceId: s.id,
      publishedDate: null,
      fetchedAt: s.fetchedAt,
      text: s.contentText,
      version: s.version,
      hash: s.contentHash,
    });
    refs.set(s.id, ref);
    return {
      ref,
      url: s.url,
      title: s.title,
      fetched_on: localDate(s.fetchedAt, e.userTz),
      version: s.version,
      full_page: s.via === 'fetch',
    };
  });
  const claims = e.claims.flatMap((c) => {
    const ref = refs.get(c.sourceId);
    return ref ? [{ entity: c.entity, attribute: c.attribute, value: c.value, quote: c.quote, source_ref: ref }] : [];
  });

  return {
    exchange_id: e.id,
    conversation_id: e.conversationId,
    asked_at: localDateTime(e.askedAt, e.userTz),
    question: e.question,
    ...(e.summary && { summary: e.summary }),
    entities: e.entities,
    claims,
    // Without claims (extraction pending, failed or skipped) the answer itself is the record.
    ...(claims.length === 0 && {
      answer_text: e.answer.length > ANSWER_CHARS ? `${e.answer.slice(0, ANSWER_CHARS)}…` : e.answer,
    }),
    sources,
  };
}

function memorySummary(r: SearchMemoryResult): string {
  const nearest = r.nearest ? `, ${r.nearest.length} nearest` : '';
  return `${r.exchanges.length} of ${r.total_matches} exchanges${nearest}`;
}

export type AgentTools = ReturnType<typeof createTools>;
