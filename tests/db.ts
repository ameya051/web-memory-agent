import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll } from 'vitest';
import { createPostgresStore } from '@/services/store-postgres';
import type { Store } from '@/core/ports';

// Tests run on a real Postgres at TEST_DATABASE_URL (spec 10). Every
// freshStore() call TRUNCATEs all tables, so point it at a throwaway database.
// Files run one at a time (see the test script) so they don't clear each other.

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. Tests need a throwaway Postgres database.');
const TEST_DB: string = url;

let ready: Promise<void> | undefined;
let admin: pg.Pool | undefined;
let shared: ReturnType<typeof createPostgresStore> | undefined;

/** Empty tables and a store over them. A copy, so a test may replace a method. */
export async function freshStore(): Promise<Store> {
  ready ??= runner({ databaseUrl: TEST_DB, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} }).then(() => {});
  await ready;
  admin ??= new pg.Pool({ connectionString: TEST_DB, max: 1 });
  shared ??= createPostgresStore(TEST_DB);
  await admin.query('TRUNCATE claims, sources, exchanges, messages, conversations, users');
  const { end: _end, ...store } = shared;
  return store;
}

afterAll(async () => {
  await Promise.all([shared?.end(), admin?.end()]);
  shared = admin = undefined;
});
