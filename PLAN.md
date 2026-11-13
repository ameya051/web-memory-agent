# Minimi chat agent: phased build plan

## Context

The design is settled in `spec.md` (build input) and `DESIGN.md` (submission doc). No code exists yet. The owner decides architecture and reads every diff; Claude Code writes the code.

The build runs in six phases after a short setup phase. Phase 1 produces an app that can be demoed. Each later phase adds one capability and ends in something new that can be shown. Nothing from the leave-out list in spec section 1.1 is built in any phase.

## How each phase runs

- One phase per session. Stop at the end of the phase for the owner to run the demo and read the diff.
- Anything the spec does not settle is raised with the owner, then recorded in spec section 10.
- Items in spec section 13 are checked against live docs in the phase that first needs them.
- Commit at the end of each phase, after the owner's check.

## Architecture refinements

These are specified in `spec.md`. This table shows the phase where each first applies.

| # | Refinement | Spec | Phase |
|---|---|---|---|
| R1 | Framework-free core behind three interfaces (search, store, clock) | 3.1 | 1 |
| R2 | A fake web for tests and the eval | 3.1, 11 | 1 (tests), 6 (eval) |
| R3 | Saved quotes checked in code when a page is re-read | 4.2 | 5 |
| R4 | Every column has a reader | 5.7 | 3 |
| R5 | Explicit failure, cancellation and timing | 6.4 | 1, 2, 3, 4 |
| R6 | Idempotent sends: the browser generates message ids | 5.3 | 3 |
| R7 | One typed config check at startup | 3.1 | 1 |

## Phase 0: Repo setup (short)

- `git init`, `.gitignore` (`.data/`, `.env`, `node_modules`, `.next`), and a `CLAUDE.md` holding the build rules from spec section 12.
- Confirm the two dev dependencies in spec section 2: `vitest` for tests and `tsx` for scripts.

## Phase 1: Demoable chat with web search

Goal: a working chat agent that searches the web and streams cited answers. No database yet; the thread lives in the browser.

Builds:
- `src/core/ports.ts`, `src/core/config.ts`, `src/core/agent/` (loop, prompt, tools): streaming loop with an 8-step cap and parallel tool calls; system prompt with the depth rules, evidence rules and the current date, weekday and timezone (spec section 7). (R1, R7)
- `web_search` (spec 4.1) with short `ref` ids.
- `src/services/` (originally `src/adapters/`, renamed after phase 3): Exa search provider with one timeout and one retry; the OpenRouter model (Sonnet 5.5); the clock; a fixture search provider for tests. (R2)
- `src/app/`: one chat page (message list, input, streamed text, live tool-step strip, source links, stop button) and `api/chat/route.ts` as a thin caller of the core.
- Cancellation passed from the request through to the model and search calls; the missing-key, model and `web_search` rows of the failure table (spec 6.4). (R5)
- Sanitized markdown rendering: no raw HTML, no images.
- `.env.example` with `OPENROUTER_API_KEY`, `EXA_API_KEY`, `MODEL_MAIN`.

Demo: ask a current question and watch the search step, then a streamed answer with sources. "Thanks" replies with no tool call. A follow-up uses the earlier context. Pressing stop ends the answer at once. Tests run the loop against the fixture provider with no network.

## Phase 2: Full-page reads and answer checks

Goal: answers that can be trusted. This completes the web-search agent before memory is added.

Builds:
- `fetch_page` (spec 4.2) through Exa's contents endpoint with live crawl; allow-list of URLs returned by `web_search` in this request; the `fetch_page` row of the failure table.
- Numbered citations tied to `ref` ids.
- `src/core/agent/checks.ts`: the citation check and number check (spec 9.2), run after the stream ends; failed figures marked unverified in the UI.
- Per-request tool budgets; links rendered only for URLs in the exchange's sources.

Demo: ask the price of a named product and get cited figures from the official pricing page. Tests show a URL outside the allow-list is refused, a number absent from its source is flagged, and an image link is not rendered.

## Phase 3: Persistence and threads

Goal: conversations survive a reload, and every exchange is recorded with its evidence.

Builds:
- `src/services/store-postgres/` and `migrations/0001_init.sql` (originally `schema.sql`, moved to `node-pg-migrate` after phase 3): hosted Postgres (Neon or Supabase) through `pg` and `DATABASE_URL`, the six-table schema from spec section 5, one shared Pool across hot reloads. (R4)
- Local user created on first visit with the browser's timezone.
- User message saved on arrival under a browser-generated id (R6); assistant message (tool-call parts with durations, `flags`, `timing`), exchange and sources saved in one transaction when the answer completes; the save-failure row of the failure table. (R5)
- Conversation list, new-chat button, loading a thread from `messages`.
- Earlier exchanges sent to the model as question and final answer only.
- `fetch_page` allow-list extended to the user's saved sources.
- Source versioning (spec 5.5): each full-page read is hashed on normalised text and given a version number for its URL, the same number as the latest saved read when the hashes match and the next number when they differ. Search excerpts are not versioned. `fetch_page` returns the version and, for a URL read before, the date that version was first seen.

Demo: reload the page and the thread is still there with its tool steps and unverified marks. Several chats appear in the list, ordered by latest activity. Fetch the same page in two chats and both reads show the same version. Tests show an unchanged page keeps its version, a changed page gets the next one, and a repeated send saves one message.

## Phase 4: Dated memory

Goal: the agent recalls past conversations by date and topic. The three sample queries work end to end, using the full-answer fallback because claims do not exist yet.

Builds:
- `search_memory` (spec 4.3): local-date conversion, full-text match, 10-exchange cap with `total_matches`, `nearest` on an empty result, exclusion of the exchange being answered, `answer_text` when an exchange has no claims, and the version of each source read for the exchange.
- Memory index in every request (spec 6.2), using the start of the question as the topic.
- Clock override (`DEV_CLOCK` and a dev endpoint), `scripts/seed.ts` with backdated conversations (CRM shortlist, Postgres hosting, distractors), and a dev panel with "load demo history", the clock control and per-answer timings. (R5)
- System prompt rules for past references and the no-record path.

Demo: load the demo history, move the clock forward, and run the three sample queries; each returns a verdict per item with citations. A page whose version matches the seeded read is reported as unchanged; the seed includes one page with a different saved version so a "changed" verdict can be shown. On an empty database the same queries get a plain "no record" answer that mentions the nearest conversations. A test shows an exchange at 23:30 local time is found under the local date.

## Phase 5: Claim extraction and recovery

Goal: memory returns compact, evidence-backed claims instead of full answers, re-checks are decided in code where possible, and unfinished jobs resume after a restart.

Builds:
- `src/core/extract/` on Haiku 5.5 (`MODEL_EXTRACT`): topic, summary, entities, claims; claims whose quote is not in the source text are dropped; idempotent write (spec 6.3).
- Trigger after each response, over seeded exchanges, and in the startup sweep; 3-attempt limit; in-process guard against double starts.
- `search_memory` returns claims and summary when extraction is done; the memory index shows extracted topics.
- The quote check in `fetch_page` and its three outcomes (spec 4.2). (R3)

Demo: after an answer, the exchange gains a topic and claims, each with a quote found in its source. Stop the app before an extraction finishes, restart, and the claims appear without a new message. The three sample queries now run on claims. With fixture pages, a re-check shows both outcomes decided in code: a claim is unchanged when the page version matches or its quote is still there, and needs checking when its quote is gone (Pipedrive's $24, reported as changed). A test shows a repeatedly failing exchange stops at 3 attempts.

## Phase 6: Eval, tuning and submission

Goal: measured behaviour and a repo ready to submit.

Builds:
- `evals/`: one command runs every case in spec section 11 through the core against seeded history and the fixture provider, and prints pass or fail per case. Expected verdicts are known because the fixture pages are controlled. (R2)
- A second mode runs the same queries against live Exa and reports time to first token and total time only.
- Prompt, reasoning-effort and model tuning against the eval; decide Sonnet 5.5 versus Opus 5.5 with the owner.
- Embedding search only if the dateless paraphrased cases miss, and only after raising it with the owner.
- Short `README.md` (keys, run, seed, eval); final `.env.example`; `DESIGN.md` reviewed against the built system, including model names and model-call counts.

Demo: the fixture eval passes, the live run prints latency, and a fresh clone works with `npm install` then `npm run dev`.

## Verification

- Each phase ends with its demo, run by the owner in the browser, plus that phase's tests under `vitest`. Tests use the fixture search provider and a throwaway Postgres at `TEST_DATABASE_URL`, so they need no API keys.
- Phase 6 adds the full eval and a fresh-clone run with only the three keys set.
- The injection case (a fixture page containing instructions is not obeyed) and the empty-history case are part of the eval, not manual checks.
