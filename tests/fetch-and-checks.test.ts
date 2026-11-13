import { readUIMessageStream } from 'ai';
import { describe, expect, it } from 'vitest';
import { createSettableClock } from '@/services/clock';
import { freshStore } from './db';
import { createFixtureSearch, loadFixturePages } from '@/services/search-fixture';
import { chatErrorMessage } from '@/core/agent/errors';
import { runChat } from '@/core/agent/loop';
import { toChatStream, type ChatUIMessage } from '@/core/agent/stream';
import { TOOL_BUDGETS } from '@/core/agent/exchange';
import type { SearchProvider } from '@/core/ports';
import { captureLogs, mockModel, promptText, textStep, toolStep, chatRequest } from './helpers';

const clock = createSettableClock(new Date('2026-11-12T10:00:00Z'));
const fixtureSearch = createFixtureSearch(await loadFixturePages());
const HUBSPOT = 'https://www.hubspot.com/pricing/sales';

function countingFetches(inner: SearchProvider) {
  const fetched: string[] = [];
  const provider: SearchProvider = {
    ...inner,
    fetchPage(url, maxChars, signal) {
      fetched.push(url);
      return inner.fetchPage(url, maxChars, signal);
    },
  };
  return { provider, fetched };
}

async function lastMessage(stream: ReadableStream): Promise<ChatUIMessage> {
  let last: ChatUIMessage | undefined;
  for await (const message of readUIMessageStream<ChatUIMessage>({ stream })) last = message;
  return last!;
}

describe('fetch_page', () => {
  it('reads a page a search returned in this answer, under a new ref', async () => {
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]),
      toolStep([{ name: 'fetch_page', input: { url: `${HUBSPOT}#plans` } }]),
      textStep('Professional is $90 per seat [s3].'),
    ]);
    const { provider, fetched } = countingFetches(fixtureSearch);

    const { result, exchange } = await runChat(
      { model, search: provider, clock, store: await freshStore() },
      chatRequest('HubSpot pricing?', 'UTC'),
    );
    await result.consumeStream();

    expect(fetched).toEqual([`${HUBSPOT}#plans`]);
    const output = (await result.steps)[1].toolResults[0].output;
    expect(output).toMatchObject({ ref: 's3', url: HUBSPOT, fetched_at: '2026-11-12T10:00:00.000Z' });
    expect(exchange.sources.get('s3')?.via).toBe('fetch');
  });

  it('refuses a url no search in this answer returned, without fetching', async () => {
    const model = mockModel([
      toolStep([{ name: 'fetch_page', input: { url: HUBSPOT } }]),
      textStep('I could not read that page.'),
    ]);
    const { provider, fetched } = countingFetches(fixtureSearch);

    const { result } = await runChat(
      { model, search: provider, clock, store: await freshStore() },
      chatRequest(`Read ${HUBSPOT}`, 'UTC'),
    );
    await result.consumeStream();

    expect(fetched).toEqual([]);
    expect((await result.steps)[0].content.some((p) => p.type === 'tool-error')).toBe(true);
    expect(promptText(model, 1)).toContain('fetch_page refused');
  });

  it(`gives an error result once ${TOOL_BUDGETS.web_search} searches are used`, async () => {
    const calls = Array.from({ length: TOOL_BUDGETS.web_search + 1 }, (_, i) => ({
      name: 'web_search',
      input: { query: `HubSpot ${i}` },
    }));
    const model = mockModel([toolStep(calls), textStep('done')]);

    const { result } = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('search a lot', 'UTC'),
    );
    await result.consumeStream();

    const content = (await result.steps)[0].content;
    expect(content.filter((p) => p.type === 'tool-result')).toHaveLength(TOOL_BUDGETS.web_search);
    expect(content.filter((p) => p.type === 'tool-error')).toHaveLength(1);
  });
});

describe('tool call logs', () => {
  it('logs every call with its outcome and duration, never the page text or the query', async () => {
    const logs = captureLogs();
    const model = mockModel([
      toolStep([
        { name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } },
        { name: 'fetch_page', input: { url: 'https://example.com/not-searched' } },
      ]),
      toolStep([{ name: 'fetch_page', input: { url: HUBSPOT } }]),
      textStep('done'),
    ]);

    const { result } = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('HubSpot pricing?', 'UTC'),
    );
    await result.consumeStream();

    logs.restore();
    const lines = logs.lines.filter((l) => / tool\.call /.test(l));
    expect(lines).toHaveLength(3);
    expect(lines).toContainEqual(
      expect.stringMatching(/^\[info\] tool\.call tool=web_search status=ok ms=\d+ input=\{"query":"\[25 chars\]"\} result="2 results \(s1–s2\)"$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^\[warn\] tool\.call tool=fetch_page status=error .*not-searched.* reason="fetch_page refused/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[info\] tool\.call tool=fetch_page status=ok ms=\d+ .* result="s3 v1, \d+ chars"$/));
    expect(logs.lines.join('\n')).not.toContain('Sales Hub Professional costs');
    expect(logs.lines.join('\n')).not.toContain('HubSpot Sales Hub pricing');
  });
});

describe('checks on the response stream', () => {
  it('sends flags for a number absent from its source and a ref never read', async () => {
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]),
      textStep('Professional is $95 per seat [s1]. Starter is $20 [s1]. Enterprise is great [s7].'),
    ]);
    const run = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('HubSpot pricing?', 'UTC'),
    );

    const message = await lastMessage(toChatStream(run, () => 'failed'));

    expect(message.metadata?.flags).toEqual([
      { kind: 'citation', ref: 's7' },
      { kind: 'number', value: '95', refs: ['s1'], sentence: 'Professional is $95 per seat [s1].', index: 17 },
    ]);
  });

  it('shows a tool failure as its own message, not as a model failure', async () => {
    const model = mockModel([
      toolStep([{ name: 'fetch_page', input: { url: HUBSPOT } }]),
      textStep('I could not read that page.'),
    ]);
    const run = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest(`Read ${HUBSPOT}`, 'UTC'),
    );

    const message = await lastMessage(toChatStream(run, chatErrorMessage));
    const step = message.parts.find((p) => p.type === 'tool-fetch_page');
    expect(step).toMatchObject({ state: 'output-error', errorText: expect.stringContaining('fetch_page refused') });
  });

  it('sends no flags when the answer is stopped', async () => {
    const controller = new AbortController();
    const model = mockModel([textStep('Professional is $95 [s1].')]);
    const run = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('HubSpot pricing?', 'UTC'),
      controller.signal,
    );
    controller.abort();

    const logs = captureLogs();
    const message = await lastMessage(toChatStream(run, () => 'failed')).catch(() => undefined);
    logs.restore();
    expect(message?.metadata?.flags).toBeUndefined();
    expect(logs.lines).toContainEqual(expect.stringMatching(/^\[info\] chat\.done outcome=cancelled totalMs=\d+ firstTokenMs=- .* flags=-$/));
  });
});

describe('request and response logs', () => {
  it('logs the request without its text, then one done line with timings', async () => {
    const logs = captureLogs();
    const model = mockModel([
      toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]),
      textStep('Professional is $90 per seat [s1].'),
    ]);
    const run = await runChat(
      { model, search: fixtureSearch, clock, store: await freshStore() },
      chatRequest('What does\nHubSpot cost?', 'Asia/Kolkata'),
    );
    await lastMessage(toChatStream(run, () => 'failed'));
    logs.restore();

    expect(logs.lines[0]).toBe('[info] chat.request tz=Asia/Kolkata history=0 text="[23 chars]"');
    const steps = logs.lines.filter((l) => l.startsWith('[info] agent.step '));
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/^\[info\] agent\.step step=0 model=\S+ finish=tool-calls tools=web_search ms=\d+ .*inputTokens=10 .*outputTokens=5$/);
    expect(steps[1]).toMatch(/^\[info\] agent\.step step=1 model=\S+ finish=stop ms=\d+ /);
    const done = logs.lines.filter((l) => l.startsWith('[info] chat.done'));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatch(
      /^\[info\] chat\.done outcome=ok totalMs=\d+ firstTokenMs=\d+ streamingMs=\d+ modelMs=\d+ toolsWallMs=\d+ toolsSumMs=\d+ toolCount=1 steps=2 flags=0$/,
    );
  });
});
