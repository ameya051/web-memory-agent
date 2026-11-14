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
      /** search_memory only: each ref it gave a saved read, mapped to that sources row id. */
      savedSources?: Record<string, string>;
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

/** A saved read cited by a later answer through search_memory, looked up by its row id. */
export type CitedSavedSource = Omit<ThreadSource, 'ref' | 'assistantMessageId'> & { id: string; exchangeId: string; userTz: string };

export type NewAnswer = {
  userId: string;
  conversationId: string;
  /** timing is null for seeded answers, which were never streamed. */
  message: { id: string; parts: StoredPart[]; flags: unknown[]; timing: Record<string, unknown> | null; createdAt: Date };
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

/** A checkable fact from an answer, tied to the saved read that supports it (spec 5.6). */
export type NewClaim = {
  entity: string;
  attribute: string;
  value: string;
  sourceId: string;
  quote: string;
};

/** What the extractor reads for one exchange: its own saved sources only. */
export type ExtractionJob = {
  question: string;
  answer: string;
  sources: Array<{ id: string; ref: string; url: string; text: string }>;
};

export type ExtractionResult = {
  /** skipped: nothing to extract (no saved sources). */
  status: 'done' | 'skipped';
  topic: string | null;
  summary: string | null;
  entities: string[];
  claims: NewClaim[];
};

/** A saved claim on a URL, for the quote check in fetch_page (spec 4.2). */
export type SavedClaim = {
  entity: string;
  attribute: string;
  value: string;
  quote: string;
  askedAt: Date;
  userTz: string;
  /** The version of the read the claim came from; null for a search excerpt. */
  version: number | null;
};

/** A past exchange as search_memory reads it (spec 4.3). */
export type MemoryExchange = {
  id: string;
  conversationId: string;
  askedAt: Date;
  userTz: string;
  question: string;
  answer: string;
  /** Written by the extractor; null and empty until it has run. */
  summary: string | null;
  entities: string[];
  claims: NewClaim[];
  /** In ref order. contentText feeds the number check and never goes to the model. */
  sources: Array<{
    id: string;
    url: string;
    title: string | null;
    via: 'search' | 'fetch';
    fetchedAt: Date;
    version: number | null;
    contentText: string;
    contentHash: string;
  }>;
};

export type MemoryQuery = {
  /** The user's local dates, YYYY-MM-DD, inclusive; both or neither. */
  dateFrom?: string;
  dateTo?: string;
  query?: string;
  /** The question being answered, so a repeated send never finds itself. */
  excludeUserMessageId: string;
  limit: number;
};

/** A line of the memory index, or a nearest exchange: no answer or sources. */
export type ExchangeHeader = {
  id: string;
  askedAt: Date;
  userTz: string;
  localDate: string;
  topic: string | null;
  question: string;
};

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
  saveAnswer(answer: NewAnswer): Promise<{ exchangeId: string }>;
  /** A thread's messages in seq order: all the model's history needs. */
  loadMessages(userId: string, conversationId: string): Promise<StoredMessage[]>;
  /**
   * A thread as the page shows it: its messages in seq order, with the sources
   * its answers read and the earlier reads its answers cited through search_memory.
   */
  loadThread(
    userId: string,
    conversationId: string,
  ): Promise<{ messages: StoredMessage[]; sources: ThreadSource[]; citedSaved: CitedSavedSource[] }>;
  /** Newest activity first. */
  listConversations(userId: string): Promise<Array<{ id: string; title: string | null }>>;
  /** The user's full-page read of a URL with the highest version, for versioning. */
  latestFetch(userId: string, url: string): Promise<LatestFetch | null>;
  /** Whether the user has a saved source with this URL (the fetch_page allow-list). */
  hasSource(userId: string, url: string): Promise<boolean>;
  /**
   * Exchanges on the local dates and/or matching the topic words: by relevance
   * with a query, else oldest first. A query with no topic words is ignored
   * beside dates and matches nothing alone. total counts every match, not only those returned.
   */
  searchMemory(userId: string, q: MemoryQuery): Promise<{ exchanges: MemoryExchange[]; total: number }>;
  /** Up to perSide exchanges before dateFrom and after dateTo, nearest first on each side. */
  nearestExchanges(
    userId: string,
    q: { dateFrom: string; dateTo: string; excludeUserMessageId: string; perSide: number },
  ): Promise<ExchangeHeader[]>;
  /** The latest exchanges, newest first, for the memory index (spec 6.2). */
  recentExchanges(userId: string, limit: number): Promise<ExchangeHeader[]>;
  /** The newest claims whose source is a read of this URL, each claim once, for the quote check (spec 4.2). */
  savedClaimsForUrl(userId: string, url: string, limit: number): Promise<SavedClaim[]>;

  // Extraction jobs (spec 6.3). The exchanges table is the job list.

  /** Every pending exchange, oldest first: the startup sweep's work. */
  pendingExtractions(): Promise<Array<{ id: string; userId: string }>>;
  /**
   * Counts one attempt and returns what to extract, or null when the exchange
   * is not pending. A pending row already at maxAttempts (the process stopped
   * during its last attempt) is marked failed instead.
   */
  startExtraction(userId: string, exchangeId: string, maxAttempts: number): Promise<ExtractionJob | null>;
  /** Replaces the exchange's claims and writes topic, summary and entities, in one transaction. */
  saveExtraction(userId: string, exchangeId: string, result: ExtractionResult): Promise<void>;
  /** After an error: failed once maxAttempts have been made, else still pending. */
  failExtraction(userId: string, exchangeId: string, maxAttempts: number): Promise<'pending' | 'failed'>;
}
