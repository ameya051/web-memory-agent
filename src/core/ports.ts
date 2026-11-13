// The interfaces the core depends on (spec 3.1). Real implementations and
// fakes live in src/services/.

export type SearchQuery = {
  query: string;
  numResults: number;
  /** Characters of page text to return per result. */
  maxChars: number;
  /** YYYY-MM-DD; only pages published on or after this date. */
  publishedAfter?: string;
  includeDomains?: string[];
};

export type SearchHit = {
  url: string;
  title: string | null;
  /** YYYY-MM-DD when the provider knows it. */
  publishedDate: string | null;
  text: string;
};

export type PageRead = {
  url: string;
  title: string | null;
  text: string;
};

export interface SearchProvider {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
  /** Reads one page in full, freshly crawled, up to maxChars of text. */
  fetchPage(url: string, maxChars: number, signal?: AbortSignal): Promise<PageRead>;
}

export interface Clock {
  now(): Date;
}

// Store (spec 5). Every call takes the user id from the session, never from
// the model, and every query filters on it. Timestamps come from the clock.

/** One part of a saved message (spec 5.3). Page text never goes in a part. */
export type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      name: string;
      toolCallId: string;
      input: unknown;
      status: 'ok' | 'error';
      durationMs: number | null;
      /** What the call returned, by reference: source refs (exchange ids for search_memory). */
      refs: string[];
    };

export type StoredMessage = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: StoredPart[];
  /** Assistant only: the checks' flags (spec 9.2). */
  flags: unknown[] | null;
  /** Assistant only: response timing in ms (spec 6.4). */
  timing: Record<string, unknown> | null;
};

/** A page read saved with an exchange (spec 5.5). */
export type NewSource = {
  ref: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  via: 'search' | 'fetch';
  fetchedAt: Date;
  contentText: string;
  contentHash: string;
  /** Fetch reads only. */
  version: number | null;
};

/** A saved source as the thread view needs it: no page text. */
export type ThreadSource = Omit<NewSource, 'contentText' | 'contentHash'> & { assistantMessageId: string };

export type NewAnswer = {
  userId: string;
  conversationId: string;
  message: { id: string; parts: StoredPart[]; flags: unknown[]; timing: Record<string, unknown>; createdAt: Date };
  exchange: {
    userMessageId: string;
    askedAt: Date;
    userTz: string;
    /** The user's calendar date for askedAt, YYYY-MM-DD. */
    localDate: string;
    question: string;
    answer: string;
  };
  sources: NewSource[];
};

export type LatestFetch = { version: number; hash: string; firstSeenAt: Date };

export interface Store {
  /** The one local user, created on first use; its timezone follows the browser. */
  ensureUser(timezone: string, now: Date): Promise<{ id: string }>;
  /** The local user if one exists yet; the page reads it before any message. */
  findUser(): Promise<{ id: string } | null>;
  /**
   * Saves a user message under its browser id, creating the conversation if it
   * is new. A repeated id saves nothing and returns the first save's seq.
   */
  saveUserMessage(m: {
    id: string;
    conversationId: string;
    userId: string;
    text: string;
    title: string;
    createdAt: Date;
  }): Promise<{ seq: number }>;
  /** The assistant message, its exchange and its sources, in one transaction. */
  saveAnswer(answer: NewAnswer): Promise<void>;
  /** A thread's messages in seq order, with the sources its answers read. */
  loadThread(userId: string, conversationId: string): Promise<{ messages: StoredMessage[]; sources: ThreadSource[] }>;
  /** Newest activity first. */
  listConversations(userId: string): Promise<Array<{ id: string; title: string | null }>>;
  /** The user's latest full-page read of a URL, for versioning. */
  latestFetch(userId: string, url: string): Promise<LatestFetch | null>;
  /** Whether the user has a saved source with this URL (the fetch_page allow-list). */
  hasSource(userId: string, url: string): Promise<boolean>;
}
