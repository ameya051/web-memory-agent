import { createDevClock, type DevClock } from '@/services/clock';
import { createExaSearch } from '@/services/search-exa';
import { createFixtureSearch, loadFixturePages } from '@/services/search-fixture';
import type { SearchProvider } from '@/core/ports';
import { configResult, type Config } from './config';

// Dev state for this server process (spec 8): the clock override and which web
// the agent searches. Kept on globalThis so a hot reload keeps them. Fixture
// mode serves evals/fixtures/pages, so re-checks against seeded history give
// known verdicts. Server-only: never import from chat.tsx.

export const devEnabled = process.env.NODE_ENV !== 'production';

export type WebMode = 'live' | 'fixture';

type DevState = { clock: DevClock; web: WebMode; fixture?: Promise<SearchProvider> };

const cache = globalThis as { dev?: DevState };

export function devState(config: Pick<Config, 'DEV_CLOCK'>): DevState {
  return (cache.dev ??= {
    clock: createDevClock(devEnabled && config.DEV_CLOCK ? new Date(config.DEV_CLOCK) : undefined),
    web: 'live',
  });
}

/** The search provider for this request: Exa, or the fixture web when switched on. */
export async function searchFor(config: Config): Promise<SearchProvider> {
  const state = devState(config);
  if (!devEnabled || state.web === 'live') return createExaSearch({ apiKey: config.EXA_API_KEY });
  // A failed load is not cached, so the next request reads the pages again.
  state.fixture ??= loadFixturePages()
    .then(createFixtureSearch)
    .catch((error) => {
      state.fixture = undefined;
      throw error;
    });
  return state.fixture;
}

/** The dev routes' gate: 404 in production, the setup error without a config. */
export function devConfig(): { ok: true; config: Config } | { ok: false; response: Response } {
  if (!devEnabled) return { ok: false, response: new Response(null, { status: 404 }) };
  if (!configResult.ok) {
    return { ok: false, response: Response.json({ error: `Missing ${configResult.missing.join(', ')} in .env.` }, { status: 500 }) };
  }
  return { ok: true, config: configResult.config };
}

/** What the dev panel shows. */
export function devView(config: Config) {
  const { clock, web } = devState(config);
  return { now: clock.now().toISOString(), overridden: clock.overridden(), web };
}

export type DevView = ReturnType<typeof devView>;
