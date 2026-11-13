import { describe, expect, it } from 'vitest';
import { createExaSearch } from '@/services/search-exa';
import type { SearchQuery } from '@/core/ports';

// The Exa service against a fake fetch: request shape, one retry, one timeout.

const query: SearchQuery = {
  query: 'HubSpot pricing',
  numResults: 3,
  maxChars: 2000,
  publishedAfter: '2026-11-01',
  includeDomains: ['hubspot.com'],
};

const okBody = {
  results: [{ url: 'https://hubspot.com/pricing', title: 'Pricing', publishedDate: '2026-10-01T00:00:00.000Z', text: 'Pro $90' }],
};

function fakeFetch(responses: Array<() => Promise<Response>>) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return responses[calls.length - 1]();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe('Exa search service', () => {
  it('maps the query to Exa fields and the response to hits', async () => {
    const { impl, calls } = fakeFetch([json(200, okBody)]);
    const hits = await createExaSearch({ apiKey: 'k', fetch: impl }).search(query);

    expect(JSON.parse(calls[0].body as string)).toEqual({
      query: 'HubSpot pricing',
      type: 'auto',
      numResults: 3,
      startPublishedDate: '2026-11-01T00:00:00.000Z',
      includeDomains: ['hubspot.com'],
      contents: { text: { maxCharacters: 2000 } },
    });
    expect((calls[0].headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(hits).toEqual([{ url: 'https://hubspot.com/pricing', title: 'Pricing', publishedDate: '2026-10-01', text: 'Pro $90' }]);
  });

  it('retries once on a server error', async () => {
    const { impl, calls } = fakeFetch([json(503, {}), json(200, okBody)]);
    const hits = await createExaSearch({ apiKey: 'k', fetch: impl }).search(query);
    expect(calls).toHaveLength(2);
    expect(hits).toHaveLength(1);
  });

  it('gives up after the one retry', async () => {
    const { impl, calls } = fakeFetch([json(500, {}), json(500, {})]);
    await expect(createExaSearch({ apiKey: 'k', fetch: impl }).search(query)).rejects.toThrow('status 500');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a rejected key', async () => {
    const { impl, calls } = fakeFetch([json(401, {})]);
    await expect(createExaSearch({ apiKey: 'bad', fetch: impl }).search(query)).rejects.toThrow('EXA_API_KEY');
    expect(calls).toHaveLength(1);
  });

  it('times out a hanging call, then retries it', async () => {
    const calls: RequestInit[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      if (calls.length === 2) return new Response(JSON.stringify(okBody));
      // First call hangs until the service's timeout aborts it.
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }) as unknown as typeof fetch;

    const hits = await createExaSearch({ apiKey: 'k', fetch: impl, timeoutMs: 20 }).search(query);
    expect(calls).toHaveLength(2);
    expect(hits).toHaveLength(1);
  });

  it('does not retry when the caller cancelled', async () => {
    const controller = new AbortController();
    const calls: RequestInit[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      controller.abort();
      throw init.signal?.reason;
    }) as unknown as typeof fetch;

    await expect(createExaSearch({ apiKey: 'k', fetch: impl }).search(query, controller.signal)).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe('Exa page read', () => {
  const page = { url: 'https://hubspot.com/pricing', title: 'Pricing', text: 'Pro $90' };

  it('asks the contents endpoint for a fresh crawl', async () => {
    const urls: string[] = [];
    const { impl, calls } = fakeFetch([json(200, { results: [page], statuses: [{ id: page.url, status: 'success' }] })]);
    const recording = ((url: string, init: RequestInit) => (urls.push(url), impl(url, init))) as typeof fetch;

    const read = await createExaSearch({ apiKey: 'k', fetch: recording }).fetchPage(page.url, 20_000);

    expect(urls).toEqual(['https://api.exa.ai/contents']);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      urls: [page.url],
      text: { maxCharacters: 20_000 },
      maxAgeHours: 0,
      livecrawlTimeout: 15_000,
    });
    expect(read).toEqual({ url: page.url, title: 'Pricing', text: 'Pro $90' });
  });

  it('turns a per-page crawl error into a failure without retrying', async () => {
    const { impl, calls } = fakeFetch([
      json(200, { results: [], statuses: [{ id: page.url, status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }] }),
    ]);
    await expect(createExaSearch({ apiKey: 'k', fetch: impl }).fetchPage(page.url, 20_000)).rejects.toThrow(
      'Could not read https://hubspot.com/pricing (CRAWL_NOT_FOUND).',
    );
    expect(calls).toHaveLength(1);
  });

  it('retries once on a server error', async () => {
    const { impl, calls } = fakeFetch([json(502, {}), json(200, { results: [page] })]);
    await createExaSearch({ apiKey: 'k', fetch: impl }).fetchPage(page.url, 20_000);
    expect(calls).toHaveLength(2);
  });
});
