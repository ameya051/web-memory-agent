'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { citedRefs } from '@/core/agent/checks';
import { urlKey } from '@/utils/url';
import type { ChatUIMessage as ChatMessage } from '@/core/agent/stream';
import { markFlaggedNumbers } from './citations';
import { DevPanel, type DevProps } from './dev-panel';
import { Markdown } from './markdown';
import type { Cite } from '@/types/citations';
import type { Timing } from '@/types/agent';

type Part = ChatMessage['parts'][number];
type SearchPart = Extract<Part, { type: 'tool-web_search' }>;
type FetchPart = Extract<Part, { type: 'tool-fetch_page' }>;
type MemoryPart = Extract<Part, { type: 'tool-search_memory' }>;
type ToolPart = SearchPart | FetchPart | MemoryPart;
/** savedOn: memory reads only, the local date of the earlier read. */
type Source = { ref: string; url: string; title: string | null; via: 'search' | 'fetch' | 'memory'; savedOn?: string };

const MAX_CHARS = 4000;

// The server holds the thread, so only the new message goes up, under the
// ids the browser made (spec 5.3).
const transport = new DefaultChatTransport<ChatMessage>({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ id, messages }) => {
    const last = messages[messages.length - 1];
    return {
      body: {
        conversationId: id,
        message: { id: last.id, text: last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };
  },
});

type Props = {
  /** From /c/<id>; null on `/`, where the browser makes the id. */
  conversationId: string | null;
  initialMessages: ChatMessage[];
  conversations: Array<{ id: string; title: string | null }>;
  /** null in production. */
  dev: DevProps | null;
};

export function Chat({ conversationId, initialMessages, conversations, dev }: Props) {
  const router = useRouter();
  const [fallbackId] = useState(() => crypto.randomUUID());
  const id = conversationId ?? fallbackId;
  // A new id makes useChat start a new chat from initialMessages.
  const { messages, sendMessage, status, stop, error } = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    transport,
    generateId: () => crypto.randomUUID(),
    // Refreshes the conversation list; the open thread is kept because its id is unchanged.
    onFinish: () => router.refresh(),
  });
  const [input, setInput] = useState('');
  const [showTimings, setShowTimings] = useState(false);
  const busy = status === 'submitted' || status === 'streaming';
  const pending = pendingLabel(status, messages);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    if (conversationId === null) window.history.replaceState(null, '', `/c/${id}`);
    sendMessage({ text });
    setInput('');
  }

  function newChat() {
    if (busy) stop();
    router.push('/');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  }

  return (
    <div className="layout">
      <nav className="sidebar">
        <button type="button" onClick={newChat}>
          New chat
        </button>
        <ul>
          {conversations.map((c) => (
            <li key={c.id} className={c.id === id ? 'current' : undefined}>
              <a
                href={`/c/${c.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  router.push(`/c/${c.id}`);
                }}
              >
                {c.title || 'Untitled'}
              </a>
            </li>
          ))}
        </ul>
        {dev && <DevPanel dev={dev} showTimings={showTimings} onShowTimings={setShowTimings} />}
      </nav>
      <main className="chat">
        <div className="messages">
          {messages.length === 0 && <p className="empty">Ask anything. Current facts are searched on the web.</p>}
          {messages.map((m) => (
            <Message key={m.id} message={m} showTimings={showTimings} />
          ))}
          {pending && <p className="thinking">{pending}</p>}
          {error && <p className="error">{errorText(error)}</p>}
        </div>
        <form className="composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_CHARS}
            rows={2}
            placeholder="Message"
            autoFocus
          />
          {busy ? (
            <button type="button" onClick={() => stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </main>
    </div>
  );
}

function Message({ message, showTimings }: { message: ChatMessage; showTimings: boolean }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return <div className="msg user">{text}</div>;
  }

  const steps = message.parts.filter(isToolPart);
  const sources = steps.flatMap((p): Source[] => {
    if (p.state !== 'output-available') return [];
    if (p.type === 'tool-fetch_page') return [{ ...p.output, via: 'fetch' }];
    if (p.type === 'tool-search_memory') {
      return p.output.exchanges.flatMap((e) => e.sources.map((r): Source => ({ ...r, via: 'memory', savedOn: r.fetched_on })));
    }
    // A reloaded search keeps placeholders (empty url) for results that were not saved.
    return p.output.results.flatMap((r): Source[] => (r.url ? [{ ...r, via: 'search' }] : []));
  });
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const texts = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));

  // Numbered in order of first citation (spec 6, step 3).
  const cites = new Map<string, Cite>();
  for (const ref of citedRefs(texts.join('\n'))) {
    const source = byRef.get(ref);
    if (source) cites.set(ref, { n: cites.size + 1, url: source.url, title: source.title });
  }
  const allowedUrls = new Set(sources.flatMap((s) => urlKey(s.url) ?? []));
  const flags = message.metadata?.flags ?? [];
  const flaggedNumbers = flags.filter((f) => f.kind === 'number').length;

  return (
    <div className="msg assistant">
      {steps.length > 0 && (
        <ul className="steps">
          {steps.map((p) => (
            <ToolStep key={p.toolCallId} part={p} />
          ))}
        </ul>
      )}
      {message.parts.map((p, i) => {
        if (p.type === 'reasoning') return p.text.trim() ? <Reasoning key={i} text={p.text} done={p.state !== 'streaming'} /> : null;
        if (p.type === 'text') {
          return <Markdown key={i} text={markFlaggedNumbers(p.text, flags)} cites={cites} allowedUrls={allowedUrls} />;
        }
        return null;
      })}
      {message.metadata?.saved === false && (
        <p className="check-note">This answer was not saved, so it will be gone after a reload.</p>
      )}
      {flaggedNumbers > 0 && (
        <p className="check-note">
          {flaggedNumbers === 1 ? '1 figure was' : `${flaggedNumbers} figures were`} not found in the cited source and{' '}
          {flaggedNumbers === 1 ? 'is' : 'are'} marked unverified.
        </p>
      )}
      {sources.length > 0 && <Sources sources={sources} cites={cites} />}
      {showTimings && message.metadata?.timing && <TimingLine timing={message.metadata.timing} />}
    </div>
  );
}

/** Plain text, never markdown: reasoning renders no links or citations. */
function Reasoning({ text, done }: { text: string; done: boolean }) {
  return (
    <details className="reasoning">
      <summary>{done ? 'Reasoning' : 'Reasoning…'}</summary>
      <p>{text}</p>
    </details>
  );
}

function isToolPart(p: Part): p is ToolPart {
  return p.type === 'tool-web_search' || p.type === 'tool-fetch_page' || p.type === 'tool-search_memory';
}

/** Dev panel timings for one answer (spec 6.4). */
function TimingLine({ timing: t }: { timing: Timing }) {
  const s = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
  return (
    <p className="timing">
      first token {s(t.firstTokenMs)} · total {s(t.totalMs)} · model {s(t.modelMs)} · tools {s(t.toolsWallMs)} ({t.toolCount}{' '}
      {t.toolCount === 1 ? 'call' : 'calls'})
    </p>
  );
}

/**
 * What to show while an answer is on its way. OpenRouter delivers the text
 * after a tool result in one burst (SPEC section 13), so the wait between the
 * last tool step and the text is labelled.
 */
function pendingLabel(status: string, messages: ChatMessage[]): string | null {
  if (status === 'submitted') return 'Thinking…';
  if (status !== 'streaming') return null;
  const last = messages.at(-1);
  const parts = last?.role === 'assistant' ? last.parts.filter((p) => p.type !== 'step-start') : [];
  const tail = parts.at(-1);
  if (!tail) return 'Thinking…';
  if (tail.type === 'reasoning') return tail.state === 'streaming' ? 'Thinking…' : 'Writing the answer…';
  if (isToolPart(tail)) {
    const running = parts.some((p) => isToolPart(p) && (p.state === 'input-streaming' || p.state === 'input-available'));
    return running ? null : 'Writing the answer…';
  }
  return null;
}

function ToolStep({ part }: { part: ToolPart }) {
  if (part.type === 'tool-search_memory') return <MemoryStep part={part} />;
  if (part.type === 'tool-fetch_page') {
    const url = part.input?.url ?? '';
    switch (part.state) {
      case 'input-streaming':
      case 'input-available':
        return <li className="step running">Reading {shortUrl(url)}…</li>;
      case 'output-available':
        return (
          <li className="step done">
            Read {part.output.title || shortUrl(url)} · version {part.output.version}
          </li>
        );
      case 'output-error':
        return <li className="step failed">Could not read {shortUrl(url)}</li>;
      default:
        return null;
    }
  }
  const query = part.input?.query ?? '';
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return <li className="step running">Searching “{query}”…</li>;
    case 'output-available':
      return (
        <li className="step done">
          Searched “{query}”: {part.output.results.length} results
        </li>
      );
    case 'output-error':
      return <li className="step failed">Search failed for “{query}”</li>;
    default:
      return null;
  }
}

function MemoryStep({ part }: { part: MemoryPart }) {
  const input = part.input ?? {};
  const dates = input.date_from ? (input.date_to && input.date_to !== input.date_from ? `${input.date_from} to ${input.date_to}` : input.date_from) : '';
  const what = [dates, input.query && `“${input.query}”`].filter(Boolean).join(' · ');
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return <li className="step running">Searching memory {what}…</li>;
    case 'output-available': {
      const n = part.output.exchanges.length;
      return (
        <li className="step done">
          Searched memory {what}: {n === 0 ? 'no record' : `${n} ${n === 1 ? 'exchange' : 'exchanges'}`}
        </li>
      );
    }
    case 'output-error':
      return <li className="step failed">Memory search failed {what}</li>;
    default:
      return null;
  }
}

function Sources({ sources, cites }: { sources: Source[]; cites: ReadonlyMap<string, Cite> }) {
  const cited = sources.filter((s) => cites.has(s.ref)).sort((a, b) => cites.get(a.ref)!.n - cites.get(b.ref)!.n);
  const others = sources.filter((s) => !cites.has(s.ref));
  return (
    <details className="sources">
      <summary>
        Sources ({cited.length} cited, {sources.length} read)
      </summary>
      <ol>
        {cited.map((s) => (
          <SourceItem key={s.ref} source={s} label={String(cites.get(s.ref)!.n)} />
        ))}
        {others.map((s) => (
          <SourceItem key={s.ref} source={s} label="·" />
        ))}
      </ol>
    </details>
  );
}

function SourceItem({ source, label }: { source: Source; label: string }) {
  return (
    <li>
      <span className="ref">{label}</span>{' '}
      <a href={source.url} target="_blank" rel="noopener noreferrer">
        {source.title || source.url}
      </a>{' '}
      <span className="host">
        {host(source.url)}
        {source.via === 'fetch' && ' · full page'}
        {source.via === 'memory' && ` · saved read · ${source.savedOn}`}
      </span>
    </li>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// A non-stream error (e.g. 400/500 JSON) arrives as the raw body text.
function errorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {}
  return error.message || 'Something went wrong.';
}
