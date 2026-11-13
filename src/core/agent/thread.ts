import type { ModelMessage } from 'ai';
import type { StoredMessage, StoredPart, ThreadSource } from '@/core/ports';

import type { ChatUIMessage } from './stream';
import type { FetchPageResult, Flag, WebSearchResult } from '@/types/agent';

// A saved thread, turned into what the model and the page each need.

export function partsText(parts: StoredPart[]): string {
  return parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
}

/**
 * Earlier exchanges as question and final answer only, without old tool
 * results (spec 5.7). A question that never got an answer is left out, so the
 * model never sees two user turns in a row.
 */
export function modelHistory(messages: StoredMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i + 1 < messages.length; i++) {
    const [question, answer] = [messages[i], messages[i + 1]];
    if (question.role !== 'user' || answer.role !== 'assistant') continue;
    out.push({ role: 'user', content: partsText(question.parts) });
    out.push({ role: 'assistant', content: partsText(answer.parts) });
    i++;
  }
  return out;
}

/**
 * Saved messages as the chat page renders them. Tool outputs are rebuilt from
 * the saved sources; page text is not sent. Search results that were neither
 * cited nor fetched were not saved, so they come back as placeholders with an
 * empty url, which keeps the result count and is left out of the source list.
 */
export function toUIMessages(messages: StoredMessage[], sources: ThreadSource[]): ChatUIMessage[] {
  const byMessage = new Map<string, Map<string, ThreadSource>>();
  for (const s of sources) {
    const refs = byMessage.get(s.assistantMessageId) ?? new Map<string, ThreadSource>();
    refs.set(s.ref, s);
    byMessage.set(s.assistantMessageId, refs);
  }

  return messages.map((m): ChatUIMessage => {
    const saved = byMessage.get(m.id) ?? new Map<string, ThreadSource>();
    return {
      id: m.id,
      role: m.role,
      metadata: m.role === 'assistant' ? { flags: (m.flags ?? []) as Flag[], saved: true } : undefined,
      parts: m.parts.map((p): ChatUIMessage['parts'][number] => {
        if (p.type === 'text') return { type: 'text', text: p.text, state: 'done' };
        if (p.type === 'reasoning') return { type: 'reasoning', text: p.text, state: 'done' };
        return toolPart(p, saved);
      }),
    };
  });
}

function toolPart(p: Extract<StoredPart, { type: 'tool' }>, saved: Map<string, ThreadSource>): ChatUIMessage['parts'][number] {
  const base = { toolCallId: p.toolCallId, input: p.input as never };
  const type = p.name === 'fetch_page' ? 'tool-fetch_page' : 'tool-web_search';
  if (p.status === 'error') return { ...base, type, state: 'output-error', errorText: 'failed' } as never;

  if (type === 'tool-fetch_page') {
    const s = saved.get(p.refs[0]);
    const output: FetchPageResult = {
      ref: p.refs[0] ?? '',
      url: s?.url ?? '',
      title: s?.title ?? null,
      fetched_at: s?.fetchedAt.toISOString() ?? '',
      version: s?.version ?? 0,
      text: '',
    };
    return { ...base, type, state: 'output-available', output };
  }
  const results = p.refs.map((ref): WebSearchResult => {
    const s = saved.get(ref);
    return { ref, url: s?.url ?? '', title: s?.title ?? null, published_date: s?.publishedAt ?? null, excerpt: '' };
  });
  return { ...base, type, state: 'output-available', output: { results } };
}
