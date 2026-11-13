// The one logger for the whole app. Core, services and app import it and pass
// an event name plus fields; it formats one `key=value` line, redacts, and
// writes it. It imports only types, so it lives in utils and every layer may use it (spec 3.1).
//
// Redaction, applied to top-level and nested fields alike:
// - user text (text, query, question, answer, content, prompt) is logged as
//   its length only;
// - secrets (api keys, tokens, passwords, connection strings) as [redacted];
// - credentials inside any URL (scheme://user:pass@host) are masked;
// - long values are clipped.

import type { LogFields, LogLevel, LogSink } from '@/types/log';

const USER_TEXT = new Set(['text', 'query', 'question', 'answer', 'content', 'prompt']);
const SECRET = /^(api_?key|\w+_key|token|access_?token|secret|password|authorization|connection_?string|database_?url)$/i;
const URL_CREDENTIALS = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;
const MAX_VALUE = 300;

const consoleSink: LogSink = (level, line) => console[level](line);
let sink: LogSink = consoleSink;

/** Tests swap the sink to capture or silence logs; no argument restores console. */
export function setLogSink(next?: LogSink): void {
  sink = next ?? consoleSink;
}

export const log = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};

/** Whole milliseconds since a performance.now() start. */
export function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const parts = [`[${level}]`, event];
  let stack: string | undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      parts.push(`${key}=${value.name}`, `message=${quote(mask(value.message))}`);
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') parts.push(`code=${code}`);
      if (level === 'error' && value.stack) stack = mask(value.stack);
      continue;
    }
    parts.push(`${key}=${format(key, value)}`);
  }
  sink(level, stack ? `${parts.join(' ')}\n${stack}` : parts.join(' '));
}

function format(key: string, value: unknown): string {
  const safe = redact(key, value);
  if (safe === null) return '-';
  if (typeof safe === 'string') return quote(mask(safe));
  if (typeof safe === 'object') return clip(mask(JSON.stringify(safe, redact)));
  return String(safe);
}

/** Also the JSON.stringify replacer, so nested fields follow the same rules. */
function redact(key: string, value: unknown): unknown {
  if (USER_TEXT.has(key) && typeof value === 'string') return `[${value.length} chars]`;
  if (SECRET.test(key)) return '[redacted]';
  return value;
}

function mask(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1***@');
}

/** Bare when safe to read as one token, else JSON-quoted. */
function quote(text: string): string {
  const clipped = clip(text);
  return /^[^\s="]+$/.test(clipped) ? clipped : JSON.stringify(clipped);
}

function clip(text: string): string {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}
