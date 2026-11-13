// Hand-written agent types shared by core, services, app and tests (spec 3.1).
// Types derived from code (Exchange, ChatRun, AgentTools, ChatUIMessage) stay beside it.

export type Flag =
  | { kind: 'citation'; ref: string }
  | {
      kind: 'number';
      /** The number as written in the answer. */
      value: string;
      /** Valid refs the sentence cites; empty when none of them was read. */
      refs: string[];
      /** The sentence as written, so the UI can find it in the text part. */
      sentence: string;
      /** Where `value` starts within `sentence`. */
      index: number;
    };

export type SourceRead = {
  ref: string;
  url: string;
  title: string | null;
  via: 'search' | 'fetch';
  /** YYYY-MM-DD as reported by the provider; search results only. */
  publishedDate: string | null;
  fetchedAt: Date;
  /** The exact text the model saw for this ref; the number check reads it. */
  text: string;
  /** Fetch reads only (spec 5.5). */
  version: number | null;
  hash: string | null;
};

/** Who is asking and when; fixed for the whole request. */
export type ExchangeContext = {
  userId: string;
  conversationId: string;
  userMessageId: string;
  question: string;
  askedAt: Date;
  timeZone: string;
};

export type WebSearchResult = {
  ref: string;
  url: string;
  title: string | null;
  published_date: string | null;
  excerpt: string;
};

export type FetchPageResult = {
  ref: string;
  url: string;
  title: string | null;
  fetched_at: string;
  /** This URL's content version for the user (spec 5.5). */
  version: number;
  /** Local YYYY-MM-DD when this version was first seen; only when the user read the URL before. */
  version_first_seen?: string;
  text: string;
};

export type ToolCallTime = { name: string; start: number; end: number; ok: boolean; toolCallId?: string };

export type Timing = {
  totalMs: number;
  firstTokenMs: number | null;
  streamingMs: number | null;
  modelMs: number;
  toolsWallMs: number;
  toolsSumMs: number;
  toolCount: number;
};

export type Outcome = 'ok' | 'error' | 'cancelled';

export type ChatRequest = { conversationId: string; messageId: string; text: string; timeZone: string };

export type ChatMetadata = { flags?: Flag[]; saved?: boolean };
