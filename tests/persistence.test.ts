import { readUIMessageStream } from 'ai';
import { describe, expect, it } from 'vitest';
import { createSettableClock } from '@/services/clock';
import { createFixtureSearch } from '@/services/search-fixture';
import { freshStore } from './db';
import { chatErrorMessage } from '@/core/agent/errors';
import { runChat } from '@/core/agent/loop';

import { toChatStream, type ChatUIMessage } from '@/core/agent/stream';
import { toUIMessages } from '@/core/agent/thread';
import type { Store } from '@/core/ports';
import { chatRequest, mockModel, promptText, textStep, toolStep, crmPages } from './helpers';
import type { FixturePage } from '@/types/fixtures';
import type { ChatRequest } from '@/types/agent';

// Phase 3: the thread lives in the store, answers are saved with their
// evidence, and full-page reads are versioned (spec 5.3–5.5).

const HUBSPOT = 'https://www.hubspot.com/pricing/sales';
const fixtures = await crmPages();

type Step = Parameters<typeof mockModel>[0][number];

/** Runs one request to the end of its stream, as the route does. */
async function send(deps: { store: Store; pages?: FixturePage[]; clock?: ReturnType<typeof createSettableClock> }, steps: Step[], request: ChatRequest) {
  const model = mockModel(steps);
  const run = await runChat(
    {
      model,
      search: createFixtureSearch(deps.pages ?? fixtures),
      clock: deps.clock ?? createSettableClock(new Date('2026-11-10T09:00:00Z')),
      store: deps.store,
    },
    request,
  );
  let last: ChatUIMessage | undefined;
  for await (const m of readUIMessageStream<ChatUIMessage>({ stream: toChatStream(run, chatErrorMessage) })) last = m;
  return { run, model, message: last! };
}

/** A search for the HubSpot page, a full read of it, then an answer citing the read. */
const readHubspot = () => [
  toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]),
  toolStep([{ name: 'fetch_page', input: { url: HUBSPOT } }]),
  textStep('Professional is $90 per seat [s3].'),
];

async function fetchOutput(run: Awaited<ReturnType<typeof send>>['run']) {
  const steps = await run.result.steps;
  return steps.flatMap((s) => s.toolResults).find((r) => r.toolName === 'fetch_page')!.output as {
    version: number;
    version_first_seen?: string;
  };
}

describe('saving an answer', () => {
  it('saves the question, the answer with its parts, the exchange and its sources', async () => {
    const store = await freshStore();
    const request = chatRequest('HubSpot pricing?', 'Asia/Kolkata');
    const { run, message } = await send({ store }, readHubspot(), request);

    expect(message.id).toBe(run.assistantMessageId);
    expect(message.metadata).toMatchObject({ flags: [], saved: true });

    const user = (await store.findUser())!;
    const { messages, sources } = await store.loadThread(user.id, request.conversationId);
    expect(messages.map((m) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
    ]);
    const parts = messages[1].parts;
    expect(parts.map((p) => p.type)).toEqual(['tool', 'tool', 'text']);
    expect(parts[0]).toMatchObject({ name: 'web_search', status: 'ok', refs: ['s1', 's2'] });
    expect(parts[1]).toMatchObject({ name: 'fetch_page', status: 'ok', refs: ['s3'], input: { url: HUBSPOT } });
    expect(typeof (parts[1] as { durationMs: unknown }).durationMs).toBe('number');
    expect(JSON.stringify(parts)).not.toContain('per seat per month'); // no page text in parts
    expect(messages[1].timing).toMatchObject({ toolCount: 2 });

    // The fetch is saved; search results that were neither cited nor fetched are not.
    expect(sources.map((s) => [s.ref, s.via, s.version])).toEqual([['s3', 'fetch', 1]]);

    // A reload shows the same steps, with placeholders keeping the search's result count.
    const [, reloaded] = toUIMessages(messages, sources);
    expect(reloaded.parts.map((p) => p.type)).toEqual(['tool-web_search', 'tool-fetch_page', 'text']);
    const search = reloaded.parts[0] as Extract<ChatUIMessage['parts'][number], { type: 'tool-web_search' }>;
    expect(search.state === 'output-available' && search.output.results.map((r) => r.url)).toEqual(['', '']);
  });

  it('saves a cited search result but not an uncited one', async () => {
    const store = await freshStore();
    const request = chatRequest('HubSpot pricing?');
    await send(
      { store },
      [toolStep([{ name: 'web_search', input: { query: 'HubSpot Sales Hub pricing' } }]), textStep('It is $90 [s1].')],
      request,
    );
    const user = (await store.findUser())!;
    const { sources } = await store.loadThread(user.id, request.conversationId);
    expect(sources.map((s) => [s.ref, s.via, s.version])).toEqual([['s1', 'search', null]]);
  });

  it('keeps the answer on screen and says so when the save fails', async () => {
    const store = await freshStore();
    store.saveAnswer = async () => {
      throw new Error('connection lost');
    };
    const { message } = await send({ store }, [textStep('Hello!')], chatRequest('hi'));
    expect(message.parts.some((p) => p.type === 'text' && p.text === 'Hello!')).toBe(true);
    expect(message.metadata).toMatchObject({ saved: false });
  });

  it('keeps only the question when the answer fails', async () => {
    const store = await freshStore();
    const request = chatRequest('hi');
    const model = mockModel([]);
    model.doStream = async () => {
      throw new Error('upstream down');
    };
    const run = await runChat(
      { model, search: createFixtureSearch(fixtures), clock: createSettableClock(new Date()), store },
      request,
    );
    for await (const _ of readUIMessageStream<ChatUIMessage>({ stream: toChatStream(run, chatErrorMessage), onError: () => {} }));
    const user = (await store.findUser())!;
    const { messages } = await store.loadThread(user.id, request.conversationId);
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps only the question when the user presses stop', async () => {
    const store = await freshStore();
    const request = chatRequest('HubSpot?');
    const controller = new AbortController();
    const search = createFixtureSearch(fixtures);
    const run = await runChat(
      {
        model: mockModel([toolStep([{ name: 'web_search', input: { query: 'HubSpot' } }]), textStep('never reached')]),
        search: {
          ...search,
          search(_query, signal) {
            controller.abort();
            return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
          },
        },
        clock: createSettableClock(new Date()),
        store,
      },
      request,
      controller.signal,
    );
    const done: Array<string | null> = [];
    const stream = toChatStream(run, chatErrorMessage, (id) => done.push(id));
    for await (const _ of readUIMessageStream<ChatUIMessage>({ stream, onError: () => {} }));
    const user = (await store.findUser())!;
    const { messages } = await store.loadThread(user.id, request.conversationId);
    expect(messages.map((m) => m.role)).toEqual(['user']);
    // Nothing saved, so no extraction job.
    expect(done).toEqual([null]);
  });

  it('saves a repeated send once', async () => {
    const store = await freshStore();
    const request = chatRequest('hi');
    await send({ store }, [textStep('Hello!')], request);
    const user = (await store.findUser())!;
    await store.saveUserMessage({
      id: request.messageId,
      conversationId: request.conversationId,
      userId: user.id,
      text: request.text,
      title: request.text,
      createdAt: new Date(),
    });
    const { messages } = await store.loadThread(user.id, request.conversationId);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('thread history', () => {
  it('sends earlier turns as question and final answer only', async () => {
    const store = await freshStore();
    const first = chatRequest('HubSpot pricing?');
    await send({ store }, readHubspot(), first);

    const { model } = await send({ store }, [textStep('You are welcome.')], chatRequest('Thanks!', 'UTC', first.conversationId));
    const prompt = model.doStreamCalls[0].prompt;
    expect(prompt.filter((m) => m.role !== 'system').map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const sent = promptText(model, 0);
    expect(sent).toContain('HubSpot pricing?');
    expect(sent).toContain('Professional is $90 per seat [s3].');
    expect(sent).not.toContain('tool-result');
    expect(sent).not.toContain('per seat per month'); // old page text stays out
  });

  it('leaves out a question that never got an answer', async () => {
    const store = await freshStore();
    const first = chatRequest('lost question');
    const user = await store.ensureUser('UTC', new Date());
    await store.saveUserMessage({
      id: first.messageId,
      conversationId: first.conversationId,
      userId: user.id,
      text: first.text,
      title: first.text,
      createdAt: new Date(),
    });
    const { model } = await send({ store }, [textStep('ok')], chatRequest('hello again', 'UTC', first.conversationId));
    expect(promptText(model, 0)).not.toContain('lost question');
  });
});

describe('source versions', () => {
  it('keeps the version of an unchanged page across chats and dates the version', async () => {
    const store = await freshStore();
    const clock = createSettableClock(new Date('2026-11-09T20:00:00Z')); // 10 Nov in Kolkata
    const one = await send({ store, clock }, readHubspot(), chatRequest('HubSpot pricing?', 'Asia/Kolkata'));
    expect(await fetchOutput(one.run)).toEqual(expect.not.objectContaining({ version_first_seen: expect.anything() }));
    expect((await fetchOutput(one.run)).version).toBe(1);

    clock.set(new Date('2026-11-12T09:00:00Z'));
    const two = await send({ store, clock }, readHubspot(), chatRequest('HubSpot again?', 'Asia/Kolkata'));
    expect(await fetchOutput(two.run)).toMatchObject({ version: 1, version_first_seen: '2026-11-10' });
  });

  it('gives a changed page the next version', async () => {
    const store = await freshStore();
    const clock = createSettableClock(new Date('2026-11-09T09:00:00Z'));
    await send({ store, clock }, readHubspot(), chatRequest('HubSpot pricing?'));

    const changed = fixtures.map((p) => (p.url === HUBSPOT ? { ...p, text: p.text.replace('$90', '$100') } : p));
    clock.set(new Date('2026-11-12T09:00:00Z'));
    const run = (await send({ store, clock, pages: changed }, readHubspot(), chatRequest('HubSpot now?'))).run;
    expect(await fetchOutput(run)).toMatchObject({ version: 2, version_first_seen: '2026-11-12' });

    // Whitespace alone is not a change: the version and its first-seen date stay.
    const respaced = changed.map((p) => (p.url === HUBSPOT ? { ...p, text: `  ${p.text.replace(/ /g, '  ')}\n` } : p));
    clock.set(new Date('2026-11-13T09:00:00Z'));
    const same = (await send({ store, clock, pages: respaced }, readHubspot(), chatRequest('And now?'))).run;
    expect(await fetchOutput(same)).toMatchObject({ version: 2, version_first_seen: '2026-11-12' });
  });
});

describe('fetch_page allow-list', () => {
  it('opens a page the user read before, in a new chat, without a search', async () => {
    const store = await freshStore();
    await send({ store }, readHubspot(), chatRequest('HubSpot pricing?'));

    const { run } = await send(
      { store },
      [toolStep([{ name: 'fetch_page', input: { url: `${HUBSPOT}#plans` } }]), textStep('Still $90 [s1].')],
      chatRequest('Has it changed?'),
    );
    expect(await fetchOutput(run)).toMatchObject({ version: 1 });
  });

  it('still refuses a URL the user never read', async () => {
    const store = await freshStore();
    await send({ store }, readHubspot(), chatRequest('HubSpot pricing?'));
    const { run } = await send(
      { store },
      [toolStep([{ name: 'fetch_page', input: { url: 'https://www.pipedrive.com/en/pricing' } }]), textStep('No.')],
      chatRequest('Pipedrive?'),
    );
    const content = (await run.result.steps)[0].content;
    expect(content.some((p) => p.type === 'tool-error')).toBe(true);
  });
});
