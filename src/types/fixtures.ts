// One page of the fake web in evals/fixtures/pages/ (spec 3.1, R2).

export type FixturePage = {
  url: string;
  title: string;
  published_date?: string;
  text: string;
};

/** One tool call of a seeded answer: a search (results not saved) or a full-page read. */
export type SeedTool =
  | { search: string; refs: string[] }
  | {
      /** The url of a page in evals/fixtures/pages/. */
      fetch: string;
      ref: string;
      /** The text saved for that read, when it differs from today's page. */
      text?: string;
    };

/** evals/fixtures/history.json: backdated conversations for the demo and tests (spec 8). */
export type SeedHistory = {
  /** The local wall time the dev panel's "Jump to demo day" sets. */
  demoDay: string;
  conversations: Array<{
    id: string;
    exchanges: Array<{
      userMessageId: string;
      assistantMessageId: string;
      /** Local wall time in the user's timezone, YYYY-MM-DDTHH:mm. */
      askedAt: string;
      question: string;
      tools: SeedTool[];
      answer: string;
    }>;
  }>;
};
