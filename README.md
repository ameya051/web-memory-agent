# Web memory agent

A chat agent with web search that remembers dated past conversations and re-checks them. Ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it finds that exchange, re-reads the pages it used, and answers per item: changed, unchanged or couldn't verify, with citations.

How it works and why it is built this way: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22 or later and a hosted Postgres database (Neon or Supabase both work).

```sh
npm install
cp .env.example .env    # fill in the keys below
npm run migrate up      # create the tables
npm run dev             # http://localhost:3000
```

| Variable | Required | What for |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | The chat model and the claim extractor |
| `EXA_API_KEY` | yes | Web search and page reads |
| `DATABASE_URL` | yes | Postgres connection string (`sslmode=verify-full`) |
| `MODEL_MAIN` | no | OpenRouter model id, default `anthropic/claude-sonnet-5.5` |
| `MODEL_EXTRACT` | no | OpenRouter model id, default `anthropic/claude-haiku-5.5` |
| `DEV_CLOCK` | no | What "now" is when the server starts, e.g. `2026-11-13T10:00:00+05:30` |
| `TEST_DATABASE_URL` | tests only | A throwaway database; tests truncate its tables |

## Try the memory questions

A fresh database has no history, so the app ships a demo one. In dev mode the page has a **Dev** panel:

1. **Load demo history** saves six past conversations in your timezone, including a CRM shortlist on Monday 9 November 2026 and a Neon vs Supabase price comparison on Tuesday 10 November. `npm run seed` does the same from the command line.
2. **Jump to demo day** sets the clock to Friday 13 November 2026, so "Monday" and "last Tuesday" point at those conversations.
3. **Web: fixture** serves saved pages from `evals/fixtures/pages` instead of the live web, so the re-checks have known answers. Switch back to **live** to search the real web.

Then ask, for example:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "What did I ask you on 3 November? Is your answer still correct today?"

**Show timings** shows how long each answer and tool call took.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app |
| `npm run migrate up` | Applies the SQL migrations in `migrations/` |
| `npm run seed [-- --tz Area/City]` | Loads the demo history and extracts its claims |
| `npm test` | Runs the tests; they use fixture pages, a mock model and `TEST_DATABASE_URL`, so they need no API keys |
| `npm run typecheck` | Type-checks the project |

## Layout

```
src/core/      agent loop, tools, output checks, claim extraction (no Next.js, Exa or Postgres)
src/services/  Exa search, fixture search, Postgres store, OpenRouter models, clock
src/app/       Next.js UI and API routes, a thin caller of core
src/types/     shared types        src/utils/  dates, URLs, logging
migrations/    SQL schema          evals/fixtures/  demo history and fixture pages
tests/         vitest suites
```
