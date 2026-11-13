import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Tests run on a hosted Postgres at about 150 ms per round trip; a seeded
  // test makes dozens, so vitest's 5 s default is too short.
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
