# Minimi chat agent

A chat assistant with web search that recalls dated past conversations and re-checks them.

- `spec.md` says what to build. `PLAN.md` says in what order. `DESIGN.md` is the submission doc.
- The owner decides the architecture and reads every diff. Claude Code writes the code.

## Working rules

- One phase of `PLAN.md` per session. Stop when the phase is done so the owner can run the demo and read the diff.
- Commit at the end of a phase, and only after the owner has checked it.
- Before deciding anything `spec.md` does not cover, raise it with the owner. Record the agreed decision and the rejected alternative in spec section 10.

## Build rules (spec section 12)

- Use only the stack in spec section 2. Raise any new dependency with the owner first.
- `src/types/` imports nothing: no packages and no other `src/` folder. It holds hand-written shared types; types derived from code stay beside that code, and `src/core/ports.ts` stays in core.
- `src/utils/` imports only `types`. Every layer may import `types` and `utils`.
- `src/core/` imports only the AI SDK, zod, `types` and `utils`: nothing from Next.js, Exa or Postgres (spec section 3.1).
  - `src/services/` may import `core`, `types` and `utils`.
  - `src/app/` may import `core`, `services`, `types` and `utils`, and stays a thin caller.
  - `scripts/`, `evals/` and `tests/` may import `core`, `services`, `types` and `utils`.
- Keep files small. Add no speculative abstractions. Build nothing on the leave-out list in spec section 1.1, even when it would be quick.
- Check the items in spec section 13 against live documentation, not from memory, in the phase that first needs them.

## Tests

- `vitest` for tests and `tsx` for scripts. Both are dev dependencies only.
- Tests run on the fixture search provider, the Postgres store on a throwaway database at `TEST_DATABASE_URL`, a settable clock and the AI SDK's mock model, so they need no API keys.
