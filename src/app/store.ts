import { createPostgresStore } from '@/services/store-postgres';
import type { Store } from '@/core/ports';
import { configResult } from './config';

// One store per server process. Next.js dev re-evaluates modules on hot
// reload, so the instance is kept on globalThis to avoid a new pool each time.
// Server-only: never import from chat.tsx.

const cache = globalThis as { store?: Store };

export function getStore(): Store {
  if (!configResult.ok) throw new Error('getStore called without a valid config.');
  return (cache.store ??= createPostgresStore(configResult.config.DATABASE_URL));
}
