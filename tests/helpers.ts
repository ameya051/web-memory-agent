import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { loadFixturePages } from '@/services/search-fixture';
import { setLogSink } from '@/utils/log';
import type { ChatRequest } from '@/types/agent';

// Builders for the AI SDK mock model: each step is one scripted model response.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Chunk = Record<string, unknown> & { type: string };

function step(chunks: Chunk[], finish: 'stop' | 'tool-calls') {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        ...chunks,
        { type: 'finish', finishReason: { unified: finish, raw: undefined }, usage },
      ] as never[],
    }),
  };
}

export function textStep(text: string) {
  return step(
    [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: text },
      { type: 'text-end', id: 't1' },
    ],
    'stop',
  );
}

export function toolStep(calls: Array<{ name: string; input: unknown }>) {
  return step(
    calls.map((c, i) => ({
      type: 'tool-call',
      toolCallId: `call-${i + 1}`,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
    'tool-calls',
  );
}

export function mockModel(steps: Array<ReturnType<typeof step>>) {
  return new MockLanguageModelV4({ doStream: steps });
}

export type ExtractOutput = {
  topic: string;
  summary: string;
  entities: string[];
  claims: Array<{ entity: string; attribute: string; value: string; source_ref: string; quote: string }>;
};

/** Extraction output for the seeded CRM shortlist: two good claims, one with a quote not in its source, one with an unknown ref. */
export const CRM_OUTPUT: ExtractOutput = {
  topic: 'CRM shortlist for a 20-person sales team',
  summary: 'The user asked for five CRMs with pricing. The answer compared HubSpot, Pipedrive, Salesforce, Zoho and Freshsales.',
  entities: ['HubSpot', 'Pipedrive', 'HubSpot', 'Salesforce'],
  claims: [
    {
      entity: 'HubSpot',
      attribute: 'Sales Hub Professional price',
      value: '$90 per seat per month, billed annually',
      source_ref: 's6',
      quote: 'Sales Hub Professional costs $90 per seat per month, billed annually',
    },
    // Case and spacing differ from the page; still found.
    { entity: 'Pipedrive', attribute: 'Advanced price', value: '$24 per seat per month', source_ref: 's7', quote: 'advanced  costs $24\nper seat per month' },
    { entity: 'Salesforce', attribute: 'Pro Suite price', value: '$95 per user per month', source_ref: 's8', quote: 'Pro Suite costs $95 per user per month' },
    { entity: 'Zoho CRM', attribute: 'Standard price', value: '$14 per user per month', source_ref: 's99', quote: 'Standard costs $14 per user per month' },
  ],
};

/** An extraction model that answers every call with the output for that call (the last one repeats). */
export function extractModel(outputs: ExtractOutput[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(outputs[Math.min(call++, outputs.length - 1)]) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

/** A chat request with fresh browser ids; pass conversationId to continue a thread. */
export function chatRequest(text: string, timeZone = 'UTC', conversationId: string = crypto.randomUUID()): ChatRequest {
  return { conversationId, messageId: crypto.randomUUID(), text, timeZone };
}

/** Everything the model was sent on one call, as text, for loose assertions. */
export function promptText(model: MockLanguageModelV4, call: number): string {
  return JSON.stringify(model.doStreamCalls[call].prompt);
}

/** Captures log lines until restore() puts the console sink back. */
export function captureLogs() {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  return { lines, restore: () => setLogSink() };
}

/** The two CRM pricing pages the phase 1–3 tests were written against, so their refs stay put. */
export async function crmPages() {
  const pages = await loadFixturePages();
  return pages.filter((p) => p.url.includes('hubspot.com') || p.url.includes('pipedrive.com'));
}
