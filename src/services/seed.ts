import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate, zonedTimeToUtc } from '@/utils/dates';
import { urlKey } from '@/utils/url';
import { log } from '@/utils/log';
import { conversationTitle } from '@/core/agent/loop';
import { PAGE_CHARS } from '@/core/agent/tools';
import { contentHash, nextVersion } from '@/core/agent/versions';
import type { LatestFetch, NewSource, Store, StoredPart } from '@/core/ports';
import { loadFixturePages } from './search-fixture';
import type { SeedHistory } from '@/types/fixtures';

// Demo history (spec 8): backdated conversations from evals/fixtures/history.json,
// written through the same store calls a live answer uses. Times are local wall
// times in the user's timezone, so "Monday 10:05" is Monday 10:05 for them.
// Ids are fixed, so loading twice adds nothing: a conversation that already
// has messages is skipped. The caller runs the extraction job over the
// exchanges this returns (spec 6.3, 8).

const FIXTURES = 'evals/fixtures';

export async function loadHistory(dir = FIXTURES): Promise<SeedHistory> {
  return JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')) as SeedHistory;
}

export async function loadDemoHistory(
  store: Store,
  timeZone: string,
  now: Date,
  dir = FIXTURES,
): Promise<{ added: number; skipped: number; exchanges: Array<{ userId: string; id: string }> }> {
  const [history, pages] = await Promise.all([loadHistory(dir), loadFixturePages(join(dir, 'pages'))]);
  const findPage = (url: string) => {
    const page = pages.find((p) => urlKey(p.url) === urlKey(url));
    if (!page) throw new Error(`Seed refers to a missing fixture page: ${url}`);
    return page;
  };

  const user = await store.ensureUser(timeZone, now);
  const fresh = [];
  for (const c of history.conversations) {
    const { messages } = await store.loadThread(user.id, c.id);
    if (messages.length === 0) fresh.push(c);
  }

  // Oldest first across conversations, so a URL read twice is versioned in order.
  const exchanges = fresh
    .flatMap((c) => c.exchanges.map((e) => ({ ...e, conversationId: c.id, askedAt: zonedTimeToUtc(e.askedAt, timeZone) })))
    .sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
  const versions = new Map<string, LatestFetch>();
  const saved: Array<{ userId: string; id: string }> = [];

  for (const e of exchanges) {
    const parts: StoredPart[] = [];
    const sources: NewSource[] = [];
    const fetchedAt = new Date(e.askedAt.getTime() + 5_000);

    for (const [i, t] of e.tools.entries()) {
      const toolCallId = `seed-${i + 1}`;
      if ('search' in t) {
        parts.push({ type: 'tool', name: 'web_search', toolCallId, input: { query: t.search }, status: 'ok', durationMs: null, refs: t.refs });
        continue;
      }
      const page = findPage(t.fetch);
      const url = urlKey(page.url) ?? page.url;
      const text = (t.text ?? page.text).slice(0, PAGE_CHARS);
      const hash = await contentHash(text);
      const seen = nextVersion(hash, versions.get(url) ?? (await store.latestFetch(user.id, url)), fetchedAt);
      versions.set(url, seen);
      parts.push({ type: 'tool', name: 'fetch_page', toolCallId, input: { url }, status: 'ok', durationMs: null, refs: [t.ref] });
      sources.push({
        ref: t.ref,
        url,
        title: page.title,
        publishedAt: null,
        via: 'fetch',
        fetchedAt,
        contentText: text,
        contentHash: hash,
        version: seen.version,
      });
    }
    parts.push({ type: 'text', text: e.answer });

    await store.saveUserMessage({
      id: e.userMessageId,
      conversationId: e.conversationId,
      userId: user.id,
      text: e.question,
      title: conversationTitle(e.question),
      createdAt: e.askedAt,
    });
    const { exchangeId } = await store.saveAnswer({
      userId: user.id,
      conversationId: e.conversationId,
      message: { id: e.assistantMessageId, parts, flags: [], timing: null, createdAt: new Date(e.askedAt.getTime() + 30_000) },
      exchange: {
        userMessageId: e.userMessageId,
        askedAt: e.askedAt,
        userTz: timeZone,
        localDate: localDate(e.askedAt, timeZone),
        question: e.question,
        answer: e.answer,
      },
      sources,
    });
    saved.push({ userId: user.id, id: exchangeId });
  }

  const result = { added: fresh.length, skipped: history.conversations.length - fresh.length };
  log.info('seed.done', { ...result, exchanges: saved.length, tz: timeZone });
  return { ...result, exchanges: saved };
}
