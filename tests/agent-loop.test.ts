import { describe, expect, it } from 'vitest';
import { createSettableClock } from '@/services/clock';
import { freshStore } from './db';
import { createFixtureSearch } from '@/services/search-fixture';
import { MAX_STEPS, runChat } from '@/core/agent/loop';
import type { SearchProvider, SearchQuery } from '@/core/ports';
import { mockModel, promptText, textStep, toolStep, chatRequest, crmPages } from './helpers';

// 20:00 UTC on Thu 12 Nov 2026 is 01:30 on Fri 13 Nov in Kolkata.
const clock = createSettableClock(new Date('2026-11-12T20:00:00Z'));
const pages = await crmPages();
const fixtureSearch = createFixtureSearch(pages);

function recording(inner: SearchProvider) {
  const calls: Array<{ query: SearchQuery; signal?: AbortSignal }> = [];
  const provider: SearchProvider = {
    ...inner,
    search(query, signal) {
      calls.push({ query, signal });
      return inner.search(query, signal);
    },
  };
  return { provider, calls };
}

describe('agent loop', () => {
  it('searches, then answers using the cited results', async () => {
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]),
      textStep('Sales Hub Professional is $90 per seat per month [s1].'),
    ]);
    const { provider, calls } = recording(fixtureSearch);

    const { result } = await runChat(
      { model, search: provider, clock, store: await freshStore() },
      chatRequest('What does HubSpot Sales Hub cost?', 'Asia/Kolkata'),
    );

    expect(await result.text).toContain('$90');
    expect(model.doStreamCalls).toHaveLength(2);
    expect(calls[0].query).toMatchObject({ query: 'HubSpot Sales Hub pricing', numResults: 5, maxChars: 2000 });

    const [toolResult] = (await result.steps)[0].toolResults;
    const output = toolResult.output as { results: Array<{ ref: string; url: string }> };
    expect(output.results[0]).toMatchObject({ ref: 's1', url: 'https://www.hubspot.com/pricing/sales' });
    // The second model call sees the search result.
    expect(promptText(model, 1)).toContain('hubspot.com/pricing/sales');
  });

  it('answers small talk with one model call and no tools', async () => {
    const model = mockModel([textStep('You are welcome!')]);
    const { provider, calls } = recording(fixtureSearch);

    const { result } = await runChat(
      { model, search: provider, clock, store: await freshStore() },
      chatRequest('Thanks, that helps', 'UTC'),
    );

    expect(await result.text).toBe('You are welcome!');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('puts the local date, weekday and timezone in the prompt, after the stable part', async () => {
    const model = mockModel([textStep('ok')]);
    const { result } = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('hi', 'Asia/Kolkata'),
    );
    await result.consumeStream();

    const system = model.doStreamCalls[0].prompt.filter((m) => m.role === 'system');
    expect(system).toHaveLength(2);
    expect(system[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(system[1].content).toContain('Friday, 13 November 2026, 01:30');
    expect(system[1].content).toContain('(2026-11-13)');
    expect(system[1].content).toContain('Asia/Kolkata');
  });

  it('runs tool calls from one step in parallel with unique refs', async () => {
    const model = mockModel([
      toolStep([
        { name: 'web_search', input: { query: 'HubSpot pricing' } },
        { name: 'web_search', input: { query: 'Pipedrive pricing' } },
      ]),
      textStep('Both found.'),
    ]);
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: SearchProvider = {
      ...fixtureSearch,
      async search(query, signal) {
        if (++started === 2) release();
        await gate; // resolves only once both calls have started
        return fixtureSearch.search(query, signal);
      },
    };

    const { result } = await runChat(
      { model, search: gated, clock, store: await freshStore() },
      chatRequest('Compare HubSpot and Pipedrive pricing', 'UTC'),
    );
    await result.consumeStream();

    expect(started).toBe(2);
    const refs = (await result.steps)[0].toolResults.flatMap(
      (r) => (r.output as { results: Array<{ ref: string }> }).results.map((x) => x.ref),
    );
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('returns a search failure to the model as an error result', async () => {
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot pricing' } }]),
      textStep('I could not search just now.'),
    ]);
    const failing: SearchProvider = {
      ...fixtureSearch,
      async search() {
        throw new Error('Exa search failed with status 503.');
      },
    };

    const { result } = await runChat(
      { model, search: failing, clock, store: await freshStore() },
      chatRequest('HubSpot pricing?', 'UTC'),
    );

    expect(await result.text).toBe('I could not search just now.');
    const content = (await result.steps)[0].content;
    expect(content.some((p) => p.type === 'tool-error')).toBe(true);
    expect(promptText(model, 1)).toContain('Exa search failed with status 503.');
  });

  it(`stops after ${MAX_STEPS} steps`, async () => {
    const steps = Array.from({ length: MAX_STEPS + 2 }, () =>
      toolStep([{ name: 'web_search', input: { query: 'HubSpot' } }]),
    );
    const model = mockModel(steps);

    const { result } = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('loop forever', 'UTC'),
    );
    await result.consumeStream();

    expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
  });

  it('passes cancellation through to the search call', async () => {
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot' } }]),
      textStep('never reached'),
    ]);
    const controller = new AbortController();
    let searchSignal: AbortSignal | undefined;
    const hanging: SearchProvider = {
      ...fixtureSearch,
      search(_query, signal) {
        searchSignal = signal;
        controller.abort(); // the user presses stop while the search runs
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      },
    };

    const { result } = await runChat(
      { model, search: hanging, clock, store: await freshStore() },
      chatRequest('HubSpot?', 'UTC'),
      controller.signal,
    );
    await result.consumeStream({ onError: () => {} });

    expect(searchSignal?.aborted).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
