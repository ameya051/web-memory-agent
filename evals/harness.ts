import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import type { LanguageModel } from 'ai';
import { runChat } from '@/core/agent/loop';
import { toChatStream } from '@/core/agent/stream';
import { chatErrorMessage } from '@/core/agent/errors';
import { quoteFound } from '@/core/extract/quotes';
import { createSettableClock } from '@/services/clock';
import { createFixtureSearch, loadFixturePages } from '@/services/search-fixture';
import { loadDemoHistory, loadHistory } from '@/services/seed';
import { createPostgresStore } from '@/services/store-postgres';
import { zonedTimeToUtc } from '@/utils/dates';
import type { NewClaim, SearchProvider, Store } from '@/core/ports';
import type { FixturePage } from '@/types/fixtures';
import type { Flag } from '@/types/agent';

// Runs one eval case through the core (spec 11): empty the database, load the
// demo history with pinned claims, set the clock to demo day in the case's
// timezone, then stream one answer and record what happened. The database is
// TEST_DATABASE_URL, truncated before every case like the tests do.

export const DEFAULT_TZ = 'Europe/London';

export type Web = 'fixture' | 'search-down' | { fetchFails: string };

export type ToolCall = { step: number; name: string; input: any; output?: any; error?: string };

export type CaseRun = {
  answer: string;
  /** Model calls: one per step. */
  steps: number;
  calls: ToolCall[];
  flags: Flag[];
  /** A stream error, shown to the user in place of an answer. */
  error: string | null;
  /** From the start of the request, including the question's save. */
  firstTokenMs: number | null;
  totalMs: number;
};

type PinnedExtraction = {
  question: string;
  topic: string;
  summary: string;
  entities: string[];
  claims: Array<{ entity: string; attribute: string; value: string; source_ref: string; quote: string }>;
};

export async function openHarness(databaseUrl: string) {
  await runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const store = createPostgresStore(databaseUrl);
  const [history, pages, evalPages, pinned] = await Promise.all([
    loadHistory(),
    loadFixturePages(),
    loadFixturePages('evals/fixtures/eval-pages'),
    readFile('evals/fixtures/claims.json', 'utf8').then((t) => JSON.parse(t) as PinnedExtraction[]),
  ]);
  const fixturePages = [...pages, ...evalPages];

  return {
    store: store as Store,
    /** The demo day's local wall time in this timezone, as an instant. */
    demoDay: (timeZone: string) => zonedTimeToUtc(history.demoDay, timeZone),

    async reset(seeded: boolean, timeZone: string, now: Date) {
      await admin.query('TRUNCATE claims, sources, exchanges, messages, conversations, users');
      if (seeded) await seed(store, timeZone, now, pinned);
    },

    web(web: Web): SearchProvider {
      return fixtureWeb(web, fixturePages);
    },

    async close() {
      await Promise.all([store.end(), admin.end()]);
    },
  };
}

export type Harness = Awaited<ReturnType<typeof openHarness>>;

/**
 * The demo history, then the pinned extraction for each exchange, written
 * through the same store calls the extraction job uses. A pinned quote that is
 * not in its source fails the run: the fixture is wrong, not the agent.
 */
async function seed(store: Store, timeZone: string, now: Date, pinned: PinnedExtraction[]) {
  const { exchanges } = await loadDemoHistory(store, timeZone, now);
  for (const e of exchanges) {
    const job = await store.startExtraction(e.userId, e.id, 3);
    if (!job) throw new Error(`Seeded exchange ${e.id} is not pending.`);
    const pin = pinned.find((p) => p.question === job.question);
    if (!pin) {
      await store.saveExtraction(e.userId, e.id, { status: 'skipped', topic: null, summary: null, entities: [], claims: [] });
      continue;
    }
    const claims: NewClaim[] = pin.claims.map((c) => {
      const source = job.sources.find((s) => s.ref === c.source_ref);
      if (!source || !quoteFound(c.quote, source.text)) throw new Error(`claims.json: "${c.quote}" is not in ${c.source_ref} of "${pin.question}".`);
      return { entity: c.entity, attribute: c.attribute, value: c.value, sourceId: source.id, quote: c.quote };
    });
    await store.saveExtraction(e.userId, e.id, { status: 'done', topic: pin.topic, summary: pin.summary, entities: pin.entities, claims });
  }
}

/** The fixture web, or one with search down, or one page that cannot be read. */
function fixtureWeb(web: Web, pages: FixturePage[]): SearchProvider {
  const base = createFixtureSearch(pages);
  if (web === 'fixture') return base;
  if (web === 'search-down') {
    const down = async (): Promise<never> => {
      throw new Error('Search is unavailable (HTTP 503).');
    };
    return { search: down, fetchPage: down };
  }
  return {
    search: base.search,
    async fetchPage(url, maxChars, signal) {
      if (url.includes(web.fetchFails)) throw new Error(`Could not read ${url} (HTTP 503).`);
      return base.fetchPage(url, maxChars, signal);
    },
  };
}

/** Streams one answer through the core, as the chat route does, and records it. */
export async function runOne(
  deps: { model: LanguageModel; search: SearchProvider; store: Store; now: Date },
  question: string,
  timeZone: string,
): Promise<CaseRun> {
  const started = performance.now();
  const clock = createSettableClock(deps.now);
  const request = { conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(), text: question, timeZone };
  const run = await runChat({ model: deps.model, search: deps.search, store: deps.store, clock }, request);

  let firstTokenMs: number | null = null;
  let flags: Flag[] = [];
  let error: string | null = null;
  for await (const chunk of toChatStream(run, chatErrorMessage)) {
    if (chunk.type === 'text-delta' && firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
    if (chunk.type === 'message-metadata' && chunk.messageMetadata?.flags) flags = chunk.messageMetadata.flags;
    if (chunk.type === 'error') error = chunk.errorText;
  }
  const totalMs = Math.round(performance.now() - started);

  // A failed answer may have no steps to report.
  const steps = await Promise.resolve(run.result.steps).catch(() => []);
  const calls: ToolCall[] = [];
  for (const [step, s] of steps.entries()) {
    for (const part of s.content) {
      if (part.type === 'tool-result') calls.push({ step, name: part.toolName, input: part.input, output: part.output });
      if (part.type === 'tool-error') {
        const message = part.error instanceof Error ? part.error.message : String(part.error);
        calls.push({ step, name: part.toolName, input: part.input, error: message });
      }
    }
  }
  const answer = steps.map((s) => s.text).filter(Boolean).join('\n\n');
  return { answer, steps: steps.length, calls, flags, error, firstTokenMs, totalMs };
}
