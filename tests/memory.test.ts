import { readUIMessageStream } from 'ai';
import { describe, expect, it } from 'vitest';
import { createSettableClock } from '@/services/clock';
import { createFixtureSearch, loadFixturePages } from '@/services/search-fixture';
import { loadDemoHistory } from '@/services/seed';
import { chatErrorMessage } from '@/core/agent/errors';
import { TOOL_BUDGETS } from '@/core/agent/exchange';
import { runChat } from '@/core/agent/loop';
import { toChatStream, type ChatUIMessage } from '@/core/agent/stream';
import { toUIMessages } from '@/core/agent/thread';
import { createExtractionJobs } from '@/core/extract/jobs';
import { SAVED_CLAIMS_LIMIT } from '@/core/agent/tools';
import type { Store } from '@/core/ports';
import { freshStore } from './db';
import { chatRequest, CRM_OUTPUT, extractModel, mockModel, promptText, textStep, toolStep, type ExtractOutput } from './helpers';
import type { ChatRequest, FetchPageResult, SearchMemoryResult } from '@/types/agent';
import type { FixturePage } from '@/types/fixtures';

// Phase 4: search_memory, the memory index and the demo history (spec 4.3, 6.2, 8).

const pages = await loadFixturePages();
const DEMO_DAY = new Date('2026-11-13T10:00:00Z');
const PIPEDRIVE = 'https://www.pipedrive.com/en/pricing';
const HUBSPOT = 'https://www.hubspot.com/pricing/sales';

type Step = Parameters<typeof mockModel>[0][number];

/** Runs one request to the end of its stream, on the fixture web. */
async function send(store: Store, steps: Step[], request: ChatRequest = chatRequest('Q', 'UTC'), now = DEMO_DAY, web: FixturePage[] = pages) {
  const model = mockModel(steps);
  const run = await runChat({ model, search: createFixtureSearch(web), clock: createSettableClock(now), store }, request);
  let message: ChatUIMessage | undefined;
  for await (const m of readUIMessageStream<ChatUIMessage>({ stream: toChatStream(run, chatErrorMessage) })) message = m;
  const content = (await run.result.steps).flatMap((s) => s.content);
  return { run, model, message: message!, content, request };
}

/** One search_memory call, then a short answer; returns what the tool gave the model. */
async function memory(store: Store, input: unknown, request?: ChatRequest) {
  const { content } = await send(store, [toolStep([{ name: 'search_memory', input }]), textStep('Done.')], request);
  const result = content.find((c) => c.type === 'tool-result' || c.type === 'tool-error')!;
  if (result.type === 'tool-error') return { error: String(result.error) };
  return { output: result.output as SearchMemoryResult };
}

async function seeded(timeZone = 'UTC') {
  const store = await freshStore();
  await loadDemoHistory(store, timeZone, DEMO_DAY);
  return store;
}

/** Demo history with the CRM shortlist extracted (the other exchanges stay pending). */
async function extracted(output: ExtractOutput = CRM_OUTPUT) {
  const store = await freshStore();
  const { exchanges } = await loadDemoHistory(store, 'UTC', DEMO_DAY);
  const crm = exchanges[3];
  await createExtractionJobs({ model: extractModel([output]), store }).run(crm.userId, crm.id);
  return store;
}

/** fetch_page on each url in one step; the results by url. */
async function fetchAll(store: Store, urls: string[], web = pages) {
  const { content } = await send(store, [toolStep(urls.map((url) => ({ name: 'fetch_page', input: { url } }))), textStep('Checked.')], undefined, DEMO_DAY, web);
  const reads = content.flatMap((c) => (c.type === 'tool-result' ? [c.output as FetchPageResult] : []));
  return new Map(reads.map((r) => [r.url, r]));
}

describe('search_memory', () => {
  it('finds an exchange asked at 23:30 local time under the local date, not the UTC date', async () => {
    // 23:30 on 8 November in Los Angeles is 07:30 on 9 November UTC.
    const store = await seeded('America/Los_Angeles');
    const onLocal = await memory(store, { date_from: '2026-11-08' }, chatRequest('Q', 'America/Los_Angeles'));
    expect(onLocal.output!.exchanges.map((e) => e.question)).toEqual(['Explain what Kubernetes does in two sentences.']);
    expect(onLocal.output!.exchanges[0].asked_at).toBe('Sunday, 8 November 2026, 23:30');

    const onUtc = await memory(store, { date_from: '2026-11-09' }, chatRequest('Q', 'America/Los_Angeles'));
    expect(onUtc.output!.exchanges.map((e) => e.question)).toEqual([
      "We're a 20-person sales team. Shortlist 5 CRM tools for us, with pricing.",
    ]);
  });

  it('ranks topic matches by relevance and lists date-only matches oldest first', async () => {
    const store = await seeded();
    const topic = await memory(store, { query: 'Postgres hosting prices' });
    expect(topic.output!.exchanges[0].question).toContain('Postgres hosting');

    const week = await memory(store, { date_from: '2026-11-03', date_to: '2026-11-10' });
    expect(week.output!.exchanges.map((e) => e.asked_at.split(',')[0])).toEqual([
      'Tuesday',
      'Wednesday',
      'Sunday',
      'Monday',
      'Tuesday',
    ]);
    expect(week.output!.total_matches).toBe(5);
    expect(week.output!.nearest).toBeUndefined();
  });

  it('returns at most 10 exchanges with the total count', async () => {
    const store = await freshStore();
    for (let i = 0; i < 12; i++) {
      await send(store, [textStep(`Answer ${i}.`)], chatRequest(`Kubernetes question ${i}`), new Date(Date.UTC(2026, 10, 2, 9, i)));
    }
    const { output } = await memory(store, { date_from: '2026-11-02' });
    expect(output!.exchanges).toHaveLength(10);
    expect(output!.total_matches).toBe(12);
    expect(output!.exchanges[0].question).toBe('Kubernetes question 0');
  });

  it('returns the nearest exchanges when nothing matches the dates', async () => {
    const store = await seeded();
    const { output } = await memory(store, { date_from: '2026-11-06' });
    expect(output!.exchanges).toEqual([]);
    expect(output!.total_matches).toBe(0);
    expect(output!.nearest!.map((n) => n.asked_at.split(',').slice(0, 2).join(','))).toEqual([
      'Wednesday, 4 November 2026',
      'Tuesday, 3 November 2026',
      'Sunday, 8 November 2026',
      'Monday, 9 November 2026',
    ]);
  });

  it('ignores a query with no topic words beside dates, and matches nothing with it alone', async () => {
    const store = await seeded();
    const dated = await memory(store, { date_from: '2026-11-09', query: 'what we did' });
    const dateOnly = await memory(store, { date_from: '2026-11-09' });
    expect(dateOnly.output!.total_matches).toBeGreaterThan(0);
    expect(dated.output!.exchanges.map((e) => e.question)).toEqual(dateOnly.output!.exchanges.map((e) => e.question));
    expect(dated.output!.nearest).toBeUndefined();

    const alone = await memory(store, { query: 'what we did' });
    expect(alone.output).toMatchObject({ exchanges: [], total_matches: 0 });
  });

  it('never returns the exchange being answered, even on a repeated send', async () => {
    const store = await freshStore();
    const request = chatRequest('Tell me about Kubernetes');
    await send(store, [textStep('Kubernetes runs containers.')], request);
    const { output } = await memory(store, { query: 'Kubernetes' }, request);
    expect(output!.exchanges).toEqual([]);
  });

  it('states the expected format for bad input', async () => {
    const store = await seeded();
    expect((await memory(store, { date_from: '3 Nov' })).error).toContain('YYYY-MM-DD');
    expect((await memory(store, {})).error).toContain('YYYY-MM-DD');
    expect((await memory(store, { query: '   ' })).error).toContain('YYYY-MM-DD');
    expect((await memory(store, { date_from: '2026-02-30' })).error).toContain('not a calendar date');
    expect((await memory(store, { date_from: '2026-11-10', date_to: '2026-11-09' })).error).toContain('before date_from');
  });

  it(`refuses calls over the budget of ${TOOL_BUDGETS.search_memory}`, async () => {
    const store = await seeded();
    const calls = Array.from({ length: TOOL_BUDGETS.search_memory + 1 }, () => ({ name: 'search_memory', input: { query: 'CRM' } }));
    const { content } = await send(store, [toolStep(calls), textStep('Done.')]);
    expect(content.filter((c) => c.type === 'tool-result')).toHaveLength(TOOL_BUDGETS.search_memory);
    expect(content.filter((c) => c.type === 'tool-error')).toHaveLength(1);
  });
});

describe('citing an earlier read', () => {
  it('checks a past figure against the saved text and saves no copy of that read', async () => {
    const store = await seeded();
    const memoryStep = () => toolStep([{ name: 'search_memory', input: { date_from: '2026-11-09' } }]);
    const { output } = await memory(store, { date_from: '2026-11-09' });
    const saved = output!.exchanges[0].sources;
    expect(saved.map((s) => [s.ref, s.url, s.version, s.fetched_on, s.full_page])).toContainEqual(['s2', PIPEDRIVE, 1, '2026-11-09', true]);
    expect(JSON.stringify(output)).not.toContain('Power costs $64'); // no page text to the model

    const good = await send(store, [memoryStep(), textStep('On 9 November Pipedrive Advanced was $24 per seat [s2].')]);
    expect(good.message.metadata?.flags).toEqual([]);
    const bad = await send(store, [memoryStep(), textStep('On 9 November Pipedrive Advanced was $29 per seat [s2].')]);
    expect(bad.message.metadata?.flags).toMatchObject([{ kind: 'number', value: '29' }]);

    // No new sources row; the part points to the original one, which a reload resolves.
    const user = (await store.findUser())!;
    const thread = await store.loadThread(user.id, good.request.conversationId);
    expect(thread.sources).toEqual([]);
    const part = thread.messages[1].parts[0];
    expect(part).toMatchObject({ name: 'search_memory', refs: [output!.exchanges[0].exchange_id] });
    expect(thread.citedSaved.map((s) => s.url)).toContain(PIPEDRIVE);

    const [, reloaded] = toUIMessages(thread.messages, thread.sources, thread.citedSaved);
    const step = reloaded.parts[0] as Extract<ChatUIMessage['parts'][number], { type: 'tool-search_memory' }>;
    expect(step.state === 'output-available' && step.output.exchanges[0].sources.find((s) => s.ref === 's2')?.url).toBe(PIPEDRIVE);
  });
});

describe('memory index', () => {
  it('lists recent exchanges by local date in every request', async () => {
    const store = await seeded();
    const { model } = await send(store, [textStep('Hi!')]);
    const prompt = promptText(model, 0);
    expect(prompt).toContain('2026-11-10 (Tuesday): Compare Postgres hosting for a small SaaS');
    expect(prompt).toContain('2026-11-03 (Tuesday): What');
  });

  it('says so when there is no history', async () => {
    const store = await freshStore();
    const { model } = await send(store, [textStep('Hi!')]);
    expect(promptText(model, 0)).toContain('No earlier conversations.');
  });
});

describe('demo history', () => {
  it('loads once, however often it is run', async () => {
    const store = await freshStore();
    expect(await loadDemoHistory(store, 'UTC', DEMO_DAY)).toMatchObject({ added: 6, skipped: 0 });
    expect(await loadDemoHistory(store, 'UTC', DEMO_DAY)).toMatchObject({ added: 0, skipped: 6, exchanges: [] });
    const { output } = await memory(store, { date_from: '2026-11-01', date_to: '2026-11-13' });
    expect(output!.total_matches).toBe(6);
  });

  it('versions a re-read against the seeded read: same page same version, changed page next version', async () => {
    const store = await seeded();
    const { content } = await send(store, [
      toolStep([
        { name: 'fetch_page', input: { url: HUBSPOT } },
        { name: 'fetch_page', input: { url: PIPEDRIVE } },
      ]),
      textStep('Checked.'),
    ]);
    const reads = content.flatMap((c) => (c.type === 'tool-result' ? [c.output as FetchPageResult] : []));
    // Parallel calls finish in any order.
    expect(reads.map((r) => [r.url, r.version, r.version_first_seen]).sort()).toEqual([
      [HUBSPOT, 1, '2026-11-09'],
      [PIPEDRIVE, 2, '2026-11-13'],
    ]);
  });

  it('gives a changed page a new version when the history was loaded after a live read', async () => {
    const store = await freshStore();
    const live = await send(store, [
      toolStep([{ name: 'web_search', input: { query: 'Pipedrive pricing' } }]),
      toolStep([{ name: 'fetch_page', input: { url: PIPEDRIVE } }]),
      textStep('Read.'),
    ]);
    const first = live.content.flatMap((c) => (c.type === 'tool-result' ? [c.output as FetchPageResult] : [])).find((r) => r.url === PIPEDRIVE)!;
    expect(first.version).toBe(1);

    // The seeded read of 9 November has other text, so it is version 2, saved with an earlier time.
    await loadDemoHistory(store, 'UTC', DEMO_DAY);
    const web = pages.map((p) => (p.url === PIPEDRIVE ? { ...p, text: `${p.text} Advanced now costs $39.` } : p));
    const read = (await fetchAll(store, [PIPEDRIVE], web)).get(PIPEDRIVE)!;
    expect(read.version).toBe(3);
  });
});

describe('memory after extraction', () => {
  it('returns claims citing the saved read, with a summary and no answer text', async () => {
    const store = await extracted();
    const { output } = await memory(store, { date_from: '2026-11-09' });
    const e = output!.exchanges[0];
    expect(e.summary).toContain('five CRMs');
    expect(e.answer_text).toBeUndefined();
    const pipedrive = e.claims.find((c) => c.entity === 'Pipedrive')!;
    expect(e.sources.find((s) => s.ref === pipedrive.source_ref)?.url).toBe(PIPEDRIVE);
    expect(pipedrive.value).toBe('$24 per seat per month');
  });

  it('falls back to the answer text for an exchange without claims', async () => {
    const store = await extracted();
    const { output } = await memory(store, { date_from: '2026-11-10' });
    expect(output!.exchanges[0].claims).toEqual([]);
    expect(output!.exchanges[0].answer_text).toContain('Supabase');
  });

  it('shows the extracted topic in the memory index', async () => {
    const store = await extracted();
    const { model } = await send(store, [textStep('Hi!')]);
    expect(promptText(model, 0)).toContain('2026-11-09 (Monday): CRM shortlist for a 20-person sales team');
  });
});

describe('quote check in fetch_page', () => {
  it('settles saved claims in code: same version or quote still there is unchanged, a missing quote needs checking', async () => {
    const store = await extracted();
    const reads = await fetchAll(store, [HUBSPOT, PIPEDRIVE]);

    // Same version as the seeded read.
    expect(reads.get(HUBSPOT)!.saved_claims).toEqual([
      { entity: 'HubSpot', attribute: 'Sales Hub Professional price', value: '$90 per seat per month, billed annually', said_on: '2026-11-09', outcome: 'unchanged' },
    ]);
    // Version 2, and "$24" is gone: the model compares.
    expect(reads.get(PIPEDRIVE)!.version).toBe(2);
    expect(reads.get(PIPEDRIVE)!.saved_claims).toEqual([
      expect.objectContaining({ entity: 'Pipedrive', outcome: 'check', quote: 'advanced  costs $24\nper seat per month' }),
    ]);
  });

  it('reports a claim unchanged when the page changed elsewhere but its quote is still there', async () => {
    const store = await extracted();
    const web = pages.map((p) => (p.url === HUBSPOT ? { ...p, text: `${p.text} New: AI assistant included on every plan.` } : p));
    const read = (await fetchAll(store, [HUBSPOT], web)).get(HUBSPOT)!;
    expect(read.version).toBe(2);
    expect(read.saved_claims!.map((c) => c.outcome)).toEqual(['unchanged']);
  });

  it(`lists at most ${SAVED_CLAIMS_LIMIT} claims`, async () => {
    const hubspot = CRM_OUTPUT.claims[0];
    const many = Array.from({ length: SAVED_CLAIMS_LIMIT + 2 }, (_, i) => ({ ...hubspot, attribute: `Price fact ${String(i).padStart(2, '0')}` }));
    const store = await extracted({ ...CRM_OUTPUT, claims: many });
    const read = (await fetchAll(store, [HUBSPOT])).get(HUBSPOT)!;
    expect(read.saved_claims).toHaveLength(SAVED_CLAIMS_LIMIT);
  });

  it('lists a claim once, as last said, when a re-check saved it again', async () => {
    const store = await extracted();
    await fetchAll(store, [HUBSPOT]);
    // The re-check's own extraction finds the same claim in today's read.
    const recheck = (await store.pendingExtractions()).at(-1)!;
    const again = { ...CRM_OUTPUT, claims: [{ ...CRM_OUTPUT.claims[0], source_ref: 's1' }] };
    await createExtractionJobs({ model: extractModel([again]), store }).run(recheck.userId, recheck.id);

    const read = (await fetchAll(store, [HUBSPOT])).get(HUBSPOT)!;
    expect(read.saved_claims).toEqual([expect.objectContaining({ entity: 'HubSpot', said_on: '2026-11-13', outcome: 'unchanged' })]);
  });

  it('adds nothing for a page with no saved claims', async () => {
    const store = await seeded();
    const read = (await fetchAll(store, [HUBSPOT])).get(HUBSPOT)!;
    expect(read.saved_claims).toBeUndefined();
  });
});
