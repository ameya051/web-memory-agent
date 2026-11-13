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
  /** memory: a read saved with an earlier exchange, returned by search_memory. */
  via: 'search' | 'fetch' | 'memory';
  /** Memory reads only: the saved sources row, which is cited in place and not saved again. */
  sourceId?: string;
  /** YYYY-MM-DD as reported by the provider; search results only. */
  publishedDate: string | null;
  fetchedAt: Date;
  /** The exact text the model saw for this ref; the number check reads it. */
  text: string;
  /** Fetch reads, and memory reads of a fetch (spec 5.5). */
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
  /** The quote check (spec 4.2): the user's newest saved claims from earlier reads of this URL. */
  saved_claims?: SavedClaimCheck[];
  text: string;
};

/**
 * unchanged: the page is the same version as the claim's read, or the claim's
 * quote is still in today's text. check: the quote is gone; compare the value
 * with today's page.
 */
export type SavedClaimCheck = {
  entity: string;
  attribute: string;
  value: string;
  /** The user's local date of the exchange the claim came from. */
  said_on: string;
  outcome: 'unchanged' | 'check';
  /** Only for check: the saved supporting text that is no longer on the page. */
  quote?: string;
};

export type MemoryClaimResult = {
  entity: string;
  attribute: string;
  value: string;
  quote: string;
  /** The ref this answer gave the saved read that supports the claim. */
  source_ref: string;
};

/** A saved read as search_memory returns it: no page text, dates local. */
export type MemorySourceResult = {
  ref: string;
  url: string;
  title: string | null;
  /** The user's local date of the read, YYYY-MM-DD. */
  fetched_on: string;
  /** null for a search excerpt. */
  version: number | null;
  full_page: boolean;
};

export type MemoryExchangeResult = {
  exchange_id: string;
  conversation_id: string;
  /** The user's local date, weekday and time, such as "Monday, 9 November 2026, 10:05". */
  asked_at: string;
  question: string;
  /** Written by the extractor; absent until it has run. */
  summary?: string;
  entities: string[];
  claims: MemoryClaimResult[];
  /** The answer as given; only when the exchange has no claims (spec 4.3). */
  answer_text?: string;
  sources: MemorySourceResult[];
};

export type SearchMemoryResult = {
  exchanges: MemoryExchangeResult[];
  total_matches: number;
  /** Only when exchanges is empty and dates were given. */
  nearest?: Array<{ exchange_id: string; asked_at: string; question: string }>;
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

export type ChatMetadata = { flags?: Flag[]; saved?: boolean; timing?: Timing };
