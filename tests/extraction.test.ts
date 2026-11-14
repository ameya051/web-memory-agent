import { readUIMessageStream } from 'ai';
import { describe, expect, it } from 'vitest';
import { createSettableClock } from '@/services/clock';
import { createFixtureSearch, loadFixturePages } from '@/services/search-fixture';
import { loadDemoHistory } from '@/services/seed';
import { chatErrorMessage } from '@/core/agent/errors';
import { runChat } from '@/core/agent/loop';
import { toChatStream, type ChatUIMessage } from '@/core/agent/stream';
import { quoteFound } from '@/core/extract/quotes';
import { createExtractionJobs, MAX_ATTEMPTS } from '@/core/extract/jobs';
import type { Store } from '@/core/ports';
import { freshStore, sql } from './db';
import { chatRequest, CRM_OUTPUT, extractModel, mockModel, textStep, toolStep, type ExtractOutput } from './helpers';

// Phase 5: the extraction job and its recovery (spec 6.3).

const DEMO_DAY = new Date('2026-11-13T10:00:00Z');
const pages = await loadFixturePages();

async function seeded() {
  const store = await freshStore();
  const { exchanges } = await loadDemoHistory(store, 'UTC', DEMO_DAY);
  // In time order: Node.js, pasta, Kubernetes, CRM, Postgres, book.
  const [node, pasta, , crm, postgres] = exchanges;
  return { store, exchanges, node, pasta, crm, postgres, userId: crm.userId };
}

async function row(id: string) {
  const [r] = await sql<{ status: string; attempts: number; topic: string | null; entities: string[] }>(
    `SELECT extraction_status AS status, extraction_attempts AS attempts, topic, entities FROM exchanges WHERE id = $1`,
    [id],
  );
  return r;
}

async function claimsOn(store: Store, userId: string, date: string) {
  const { exchanges } = await store.searchMemory(userId, {
    dateFrom: date,
    dateTo: date,
    excludeUserMessageId: crypto.randomUUID(),
    limit: 10,
  });
  return exchanges[0];
}

describe('quoteFound', () => {
  it('ignores case and whitespace, and never matches an empty quote', () => {
    expect(quoteFound('ESSENTIAL   costs $14', 'Pipedrive pricing. Essential costs\n$14 per seat')).toBe(true);
    expect(quoteFound('costs $15', 'Essential costs $14')).toBe(false);
    expect(quoteFound('  ', 'anything')).toBe(false);
  });
});

describe('extraction job', () => {
  it('writes topic, summary, entities and the claims whose ref and quote check out', async () => {
    const { store, crm, userId } = await seeded();
    const model = extractModel([CRM_OUTPUT]);
    await createExtractionJobs({ model, store }).run(userId, crm.id);

    expect(await row(crm.id)).toEqual({
      status: 'done',
      attempts: 1,
      topic: 'CRM shortlist for a 20-person sales team',
      entities: ['HubSpot', 'Pipedrive', 'Salesforce'],
    });
    const e = await claimsOn(store, userId, '2026-11-09');
    expect(e.summary).toContain('five CRMs');
    expect(e.claims.map((c) => [c.entity, c.attribute])).toEqual([
      ['HubSpot', 'Sales Hub Professional price'],
      ['Pipedrive', 'Advanced price'],
    ]);
    // Each claim points to the read it was checked against.
    const pipedrive = e.sources.find((s) => s.url.includes('pipedrive'))!;
    expect(e.claims[1].sourceId).toBe(pipedrive.id);
    // The extractor saw only the exchange's own sources, as JSON data.
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('Advanced costs $24 per seat per month');
  });

  it('gives the same result when run again', async () => {
    const { store, crm, userId } = await seeded();
    const jobs = createExtractionJobs({ model: extractModel([CRM_OUTPUT]), store });
    await jobs.run(userId, crm.id);
    await sql(`UPDATE exchanges SET extraction_status = 'pending' WHERE id = $1`, [crm.id]);
    await jobs.run(userId, crm.id);
    expect((await claimsOn(store, userId, '2026-11-09')).claims).toHaveLength(2);
    expect((await row(crm.id)).status).toBe('done');
  });

  it('skips an exchange with no sources without calling the model', async () => {
    const { store, pasta, userId } = await seeded();
    const model = extractModel([CRM_OUTPUT]);
    await createExtractionJobs({ model, store }).run(userId, pasta.id);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await row(pasta.id)).toMatchObject({ status: 'skipped', attempts: 1, topic: null });
  });

  it(`stops after ${MAX_ATTEMPTS} failed attempts and marks the exchange failed`, async () => {
    const { store, crm, userId } = await seeded();
    const model = extractModel([CRM_OUTPUT]);
    model.doGenerate = async () => {
      throw new Error('upstream down');
    };
    await createExtractionJobs({ model, store, retryDelaysMs: [0] }).run(userId, crm.id);
    expect(await row(crm.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    // Starting it again does nothing.
    await createExtractionJobs({ model, store, retryDelaysMs: [0] }).run(userId, crm.id);
    expect((await row(crm.id)).attempts).toBe(MAX_ATTEMPTS);
  });

  it('retries after a failure and succeeds on a later attempt', async () => {
    const { store, crm, userId } = await seeded();
    const good = extractModel([CRM_OUTPUT]);
    let calls = 0;
    const model = extractModel([CRM_OUTPUT]);
    model.doGenerate = async (options) => {
      if (calls++ === 0) throw new Error('rate limited');
      return good.doGenerate(options);
    };
    await createExtractionJobs({ model, store, retryDelaysMs: [0] }).run(userId, crm.id);
    expect(await row(crm.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('never runs the same exchange twice at once', async () => {
    const { store, crm, userId } = await seeded();
    const model = extractModel([CRM_OUTPUT]);
    const jobs = createExtractionJobs({ model, store });
    await Promise.all([jobs.run(userId, crm.id), jobs.run(userId, crm.id)]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe('startup sweep', () => {
  it('extracts every pending exchange oldest first, and fails one stuck at the attempt limit', async () => {
    const { store, exchanges, node, crm, postgres } = await seeded();
    // The process stopped during the last attempt on the Postgres exchange.
    await sql(`UPDATE exchanges SET extraction_attempts = $2 WHERE id = $1`, [postgres.id, MAX_ATTEMPTS]);
    const model = extractModel([CRM_OUTPUT]);
    await createExtractionJobs({ model, store }).sweep();

    expect(await store.pendingExtractions()).toEqual([]);
    expect((await row(postgres.id)).status).toBe('failed');
    // Only exchanges with sources reach the model: Node.js, then CRM.
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Node.js LTS');
    expect(prompts[1]).toContain('20-person sales team');
    expect((await row(node.id)).status).toBe('done');
    expect((await row(crm.id)).status).toBe('done');
    const statuses = await Promise.all(exchanges.map((e) => row(e.id).then((r) => r.status)));
    expect(statuses.filter((s) => s === 'skipped')).toHaveLength(3);
  });

  it('reports whether the job list could be read, so a failed sweep can run again', async () => {
    const { store } = await seeded();
    const model = extractModel([CRM_OUTPUT]);
    const down: Store = { ...store, pendingExtractions: () => Promise.reject(new Error('database is down')) };
    expect(await createExtractionJobs({ model, store: down }).sweep()).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await createExtractionJobs({ model, store }).sweep()).toBe(true);
  });
});

describe('extraction trigger', () => {
  it('hears the saved exchange id when the stream ends, and the job then extracts it', async () => {
    const store = await freshStore();
    const pipedrive = 'https://www.pipedrive.com/en/pricing';
    const run = await runChat(
      {
        model: mockModel([
          toolStep([{ name: 'web_search', input: { query: 'Pipedrive pricing', include_domains: ['pipedrive.com'] } }]),
          toolStep([{ name: 'fetch_page', input: { url: pipedrive } }]),
          textStep('Pipedrive Advanced costs $29 per seat per month [s2].'),
        ]),
        search: createFixtureSearch(pages),
        clock: createSettableClock(DEMO_DAY),
        store,
      },
      chatRequest('Pipedrive price?'),
    );
    const done: Array<string | null> = [];
    for await (const _ of readUIMessageStream<ChatUIMessage>({ stream: toChatStream(run, chatErrorMessage, (id) => done.push(id)) }));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatch(/^[0-9a-f-]{36}$/);

    const output: ExtractOutput = {
      topic: 'Pipedrive pricing',
      summary: 'Pipedrive Advanced price.',
      entities: ['Pipedrive'],
      claims: [{ entity: 'Pipedrive', attribute: 'Advanced price', value: '$29', source_ref: 's2', quote: 'Advanced costs $29 per seat per month' }],
    };
    await createExtractionJobs({ model: extractModel([output]), store }).run(run.exchange.context.userId, done[0]!);
    expect(await row(done[0]!)).toMatchObject({ status: 'done', topic: 'Pipedrive pricing' });
  });
});
