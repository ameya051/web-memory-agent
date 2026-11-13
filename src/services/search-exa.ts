import { z } from 'zod';
import type { PageRead, SearchHit, SearchProvider, SearchQuery } from '@/core/ports';

// Exa search and page reads over plain fetch (spec 2, 3). One timeout and one
// retry per call. A caller abort is never retried; a client error other than
// 429 is not either.

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
export const EXA_TIMEOUT_MS = 10_000;
/** A live crawl can be slow, so page reads get longer (spec 10). */
export const EXA_FETCH_TIMEOUT_MS = 20_000;
/** Exa's own crawl limit, kept inside ours so a slow crawl ends as an Exa error. */
const LIVECRAWL_TIMEOUT_MS = 15_000;

const resultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  publishedDate: z.string().nullish(),
  text: z.string().nullish(),
});

const searchResponse = z.object({ results: z.array(resultSchema) });

const contentsResponse = z.object({
  results: z.array(resultSchema),
  statuses: z
    .array(z.object({ id: z.string(), status: z.string(), error: z.object({ tag: z.string().nullish() }).nullish() }))
    .nullish(),
});

export class ExaError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ExaError';
  }
}

type Options = { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; fetchTimeoutMs?: number };

export function createExaSearch({
  apiKey,
  fetch: fetchImpl = fetch,
  timeoutMs = EXA_TIMEOUT_MS,
  fetchTimeoutMs = EXA_FETCH_TIMEOUT_MS,
}: Options): SearchProvider {
  async function post(url: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    const timer = AbortSignal.timeout(timeout);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
    });
    if (res.status === 401 || res.status === 403) throw new ExaError(res.status, 'Exa rejected EXA_API_KEY.');
    if (!res.ok) throw new ExaError(res.status, `Exa request failed with status ${res.status}.`);
    return res.json();
  }

  async function withRetry<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (signal?.aborted || !retryable(error)) throw error;
      return call();
    }
  }

  return {
    search(query, signal) {
      return withRetry(async (): Promise<SearchHit[]> => {
        const body = {
          query: query.query,
          type: 'auto',
          numResults: query.numResults,
          ...(query.publishedAfter && { startPublishedDate: `${query.publishedAfter}T00:00:00.000Z` }),
          ...(query.includeDomains?.length && { includeDomains: query.includeDomains }),
          contents: { text: { maxCharacters: query.maxChars } },
        };
        const { results } = searchResponse.parse(await post(EXA_SEARCH_URL, body, timeoutMs, signal));
        return results.map((r) => ({
          url: r.url,
          title: r.title ?? null,
          publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : null,
          text: r.text ?? '',
        }));
      }, signal);
    },

    fetchPage(url, maxChars, signal) {
      return withRetry(async (): Promise<PageRead> => {
        // maxAgeHours 0 forces a fresh crawl; `livecrawl` is deprecated (spec 13).
        const body = {
          urls: [url],
          text: { maxCharacters: maxChars },
          maxAgeHours: 0,
          livecrawlTimeout: LIVECRAWL_TIMEOUT_MS,
        };
        const { results, statuses } = contentsResponse.parse(await post(EXA_CONTENTS_URL, body, fetchTimeoutMs, signal));
        const failed = statuses?.find((s) => s.status === 'error');
        // A per-page crawl failure is reported in the body, not the HTTP status. Not retried.
        if (failed || results.length === 0) {
          throw new ExaError(422, `Could not read ${url}${failed?.error?.tag ? ` (${failed.error.tag})` : ''}.`);
        }
        const [page] = results;
        return { url: page.url, title: page.title ?? null, text: page.text ?? '' };
      }, signal);
    },
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof ExaError) return error.status === 429 || error.status >= 500;
  return true; // network errors, timeouts and malformed responses
}
