import { beforeEach, describe, expect, it } from 'vitest';
import type { NewAnswer, NewSource, Store } from '@/core/ports';
import { freshStore } from './db';

// The store suite, on the Postgres at TEST_DATABASE_URL (tests/db.ts).

const at = (iso: string) => new Date(`2026-11-${iso}Z`);
const HUBSPOT = 'https://www.hubspot.com/pricing/sales';

function source(overrides: Partial<NewSource> = {}): NewSource {
  return {
    ref: 's1',
    url: HUBSPOT,
    title: 'HubSpot pricing',
    publishedAt: null,
    via: 'fetch',
    fetchedAt: at('10T09:00:00'),
    contentText: 'Professional $90',
    contentHash: 'h1',
    version: 1,
    ...overrides,
  };
}

async function ask(store: Store, userId: string, conversationId: string, text: string, when: Date) {
  const id = crypto.randomUUID();
  const { seq } = await store.saveUserMessage({ id, conversationId, userId, text, title: text, createdAt: when });
  return { id, seq };
}

function answer(userId: string, conversationId: string, userMessageId: string, when: Date, sources: NewSource[] = []): NewAnswer {
  return {
    userId,
    conversationId,
    message: { id: crypto.randomUUID(), parts: [{ type: 'text', text: 'ok [s1]' }], flags: [], timing: { totalMs: 1 }, createdAt: when },
    exchange: { userMessageId, askedAt: when, userTz: 'UTC', localDate: '2026-11-10', question: 'q', answer: 'ok [s1]' },
    sources,
  };
}

// A hosted database can be ~150 ms a round trip away, so the suite gets more time.
describe('store: postgres', { timeout: 30_000 }, () => {
  let store: Store;
  let userId: string;
  beforeEach(async () => {
    store = await freshStore();
    userId = (await store.ensureUser('Asia/Kolkata', at('01T00:00:00'))).id;
  });

  it('keeps one local user', async () => {
    const again = await store.ensureUser('Europe/London', at('02T00:00:00'));
    expect(again.id).toBe(userId);
    expect(await store.findUser()).toEqual({ id: userId });
  });

  it('saves a repeated user message once, under its first seq', async () => {
    const c = crypto.randomUUID();
    const m = { id: crypto.randomUUID(), conversationId: c, userId, text: 'hi', title: 'hi', createdAt: at('10T09:00:00') };
    expect(await store.saveUserMessage(m)).toEqual({ seq: 1 });
    expect(await store.saveUserMessage(m)).toEqual({ seq: 1 });
    const { messages } = await store.loadThread(userId, c);
    expect(messages.map((x) => x.id)).toEqual([m.id]);
  });

  it('orders a thread by seq and returns its sources by answer', async () => {
    const c = crypto.randomUUID();
    const q1 = await ask(store, userId, c, 'first', at('10T09:00:00'));
    const a1 = answer(userId, c, q1.id, at('10T09:00:05'), [source()]);
    await store.saveAnswer(a1);
    const q2 = await ask(store, userId, c, 'second', at('10T09:01:00'));

    const { messages, sources } = await store.loadThread(userId, c);
    expect(messages.map((m) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'user'],
    ]);
    expect(messages[1]).toMatchObject({ parts: a1.message.parts, flags: [], timing: { totalMs: 1 } });
    expect(q2.seq).toBe(3);
    expect(sources).toEqual([
      {
        ref: 's1',
        url: HUBSPOT,
        title: 'HubSpot pricing',
        publishedAt: null,
        via: 'fetch',
        fetchedAt: at('10T09:00:00'),
        version: 1,
        assistantMessageId: a1.message.id,
      },
    ]);
  });

  it('lists conversations by latest exchange, then by creation', async () => {
    const [a, b, empty] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const qa = await ask(store, userId, a, 'a', at('09T09:00:00'));
    const qb = await ask(store, userId, b, 'b', at('10T09:00:00'));
    await ask(store, userId, empty, 'unanswered', at('08T09:00:00'));
    await store.saveAnswer(answer(userId, b, qb.id, at('10T09:00:05')));
    await store.saveAnswer(answer(userId, a, qa.id, at('11T09:00:05')));
    expect((await store.listConversations(userId)).map((c) => c.id)).toEqual([a, b, empty]);
  });

  it('saves an answer all or nothing', async () => {
    const c = crypto.randomUUID();
    const q = await ask(store, userId, c, 'q', at('10T09:00:00'));
    const bad = answer(userId, c, q.id, at('10T09:00:05'), [source(), source()]); // two rows with ref s1
    await expect(store.saveAnswer(bad)).rejects.toThrow();
    const { messages, sources } = await store.loadThread(userId, c);
    expect(messages.map((m) => m.role)).toEqual(['user']);
    expect(sources).toEqual([]);
    expect(await store.hasSource(userId, HUBSPOT)).toBe(false);
  });

  it('finds the latest read of a URL and when its version was first seen', async () => {
    expect(await store.latestFetch(userId, HUBSPOT)).toBeNull();
    const reads = [
      { when: at('09T09:00:00'), version: 1, hash: 'h1' },
      { when: at('10T09:00:00'), version: 1, hash: 'h1' },
      { when: at('11T09:00:00'), version: 2, hash: 'h2' },
    ];
    for (const r of reads.slice(0, 2)) {
      const c = crypto.randomUUID();
      const q = await ask(store, userId, c, 'q', r.when);
      await store.saveAnswer(answer(userId, c, q.id, r.when, [source({ fetchedAt: r.when, version: r.version, contentHash: r.hash })]));
    }
    expect(await store.latestFetch(userId, HUBSPOT)).toEqual({ version: 1, hash: 'h1', firstSeenAt: reads[0].when });

    const c = crypto.randomUUID();
    const q = await ask(store, userId, c, 'q', reads[2].when);
    await store.saveAnswer(
      answer(userId, c, q.id, reads[2].when, [source({ fetchedAt: reads[2].when, version: 2, contentHash: 'h2' })]),
    );
    expect(await store.latestFetch(userId, HUBSPOT)).toEqual({ version: 2, hash: 'h2', firstSeenAt: reads[2].when });
    expect(await store.hasSource(userId, HUBSPOT)).toBe(true);
    expect(await store.hasSource(userId, 'https://example.com/')).toBe(false);
  });
});
