import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import pg from 'pg';
import { elapsedMs, log } from '@/utils/log';
import type { LatestFetch, Store, StoredMessage, ThreadSource } from '@/core/ports';

// The store on a hosted Postgres (Neon or Supabase) through one pg Pool
// (spec 2, 5). The schema comes from migrations/ via `npm run migrate`; before
// the first query the store checks that none are pending. Writes are single statements, or one transaction on one client from
// the pool; both work through Neon's and Supabase's transaction poolers, and
// nothing here uses session state.

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
/** node-pg-migrate's default table: one row per applied migration, by file name without extension. */
const MIGRATIONS_TABLE = 'pgmigrations';
const MAX_CONVERSATIONS = 100;

export function createPostgresStore(connectionString: string): Store & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // A hosted database closes idle connections; without a listener that crashes the process.
  pool.on('error', (error) => log.warn('db.idle_connection_error', { error }));

  let ready: Promise<void> | null = null;
  // The local user, cached so a request with an unchanged timezone costs no round trip.
  let user: { id: string; timezone: string } | null = null;
  // A failed check is not cached, so the next request checks again after a migrate.
  const init = () =>
    (ready ??= checkMigrations(pool).catch((error) => {
      ready = null;
      throw error;
    }));

  // Every call logs its name and duration (including the wait for a pooled
  // connection). Never SQL values or error messages, which can carry user
  // text: a failure logs only the Postgres error code.

  async function query<R extends pg.QueryResultRow>(op: string, text: string, values: unknown[] = []) {
    await init();
    const start = performance.now();
    try {
      const result = await pool.query<R>(text, values);
      log.info('db.query', { op, ms: elapsedMs(start), rows: result.rowCount ?? undefined });
      return result;
    } catch (error) {
      log.warn('db.query_failed', { op, ms: elapsedMs(start), code: pgCode(error) });
      throw error;
    }
  }

  async function transaction<T>(op: string, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    await init();
    const start = performance.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      log.info('db.transaction', { op, ms: elapsedMs(start) });
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      log.warn('db.transaction_failed', { op, ms: elapsedMs(start), code: pgCode(error) });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Seq is max + 1 inside one statement. Two concurrent saves to one thread
   * can pick the same seq; the unique index rejects the second, which then
   * retries once.
   */
  async function withSeqRetry<T>(save: () => Promise<T>): Promise<T> {
    try {
      return await save();
    } catch (error) {
      if ((error as { constraint?: string }).constraint !== 'messages_conversation_seq') throw error;
      return save();
    }
  }

  return {
    end: () => pool.end(),

    async ensureUser(timezone, now) {
      if (user?.timezone === timezone) return { id: user.id };
      // One local user (spec 1.1). The table lock stops two first requests creating two.
      const row = await transaction('ensureUser', async (client) => {
        await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const updated = await client.query<{ id: string }>(
          `UPDATE users SET timezone = $1 WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1) RETURNING id`,
          [timezone],
        );
        if (updated.rows[0]) return updated.rows[0];
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO users (timezone, created_at) VALUES ($1, $2) RETURNING id',
          [timezone, now],
        );
        return inserted.rows[0];
      });
      user = { id: row.id, timezone };
      return row;
    },

    async findUser() {
      if (user) return { id: user.id };
      const { rows } = await query<{ id: string }>('findUser', 'SELECT id FROM users ORDER BY created_at LIMIT 1');
      return rows[0] ?? null;
    },

    // Each save below is one statement, so it is atomic without BEGIN and
    // COMMIT and costs one round trip to a hosted database.

    async saveUserMessage(m) {
      // Creates the conversation if new; a repeated browser id saves nothing and
      // returns the first save's seq (spec 5.3, R6).
      const { rows } = await withSeqRetry(() =>
        query<{ seq: number }>(
          'saveUserMessage',
          `WITH conversation AS (
             INSERT INTO conversations (id, user_id, title, created_at)
             VALUES ($2::uuid, $3::uuid, $5::text, $6::timestamptz)
             ON CONFLICT (id) DO NOTHING
           ), existing AS (
             SELECT seq FROM messages WHERE id = $1::uuid AND conversation_id = $2::uuid AND user_id = $3::uuid
           ), inserted AS (
             INSERT INTO messages (id, conversation_id, user_id, seq, role, parts, created_at)
             SELECT $1::uuid, $2::uuid, $3::uuid,
                    (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = $2::uuid),
                    'user', $4::jsonb, $6::timestamptz
             WHERE NOT EXISTS (SELECT 1 FROM existing)
               AND NOT EXISTS (SELECT 1 FROM conversations WHERE id = $2::uuid AND user_id <> $3::uuid)
             RETURNING seq
           )
           SELECT seq FROM inserted UNION ALL SELECT seq FROM existing`,
          [m.id, m.conversationId, m.userId, JSON.stringify([{ type: 'text', text: m.text }]), m.title, m.createdAt],
        ),
      );
      if (!rows[0]) throw new Error('Conversation belongs to another user.');
      return rows[0];
    },

    async saveAnswer(a) {
      const e = a.exchange;
      const sources = a.sources.map((s) => ({
        ref: s.ref,
        url: s.url,
        title: s.title,
        published_at: s.publishedAt,
        via: s.via,
        fetched_at: s.fetchedAt.toISOString(),
        content_text: s.contentText,
        content_hash: s.contentHash,
        version: s.version,
      }));
      // jsonb values go as JSON text: pg would send a JS array as a Postgres array.
      const { rows } = await withSeqRetry(() =>
        query<{ saved: number }>(
          'saveAnswer',
          `WITH message AS (
             INSERT INTO messages (id, conversation_id, user_id, seq, role, parts, flags, timing, created_at)
             SELECT $1::uuid, $2::uuid, $3::uuid,
                    (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = $2::uuid),
                    'assistant', $4::jsonb, $5::jsonb, $6::jsonb, $7::timestamptz
             WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $2::uuid AND user_id = $3::uuid)
             RETURNING id
           ), exchange AS (
             INSERT INTO exchanges (conversation_id, user_id, asked_at, user_tz, local_date, user_message_id,
                                    assistant_message_id, question, answer)
             SELECT $2::uuid, $3::uuid, $8::timestamptz, $9::text, $10::date, $11::uuid, message.id, $12::text, $13::text
             FROM message
             RETURNING id
           ), saved_sources AS (
             INSERT INTO sources (exchange_id, user_id, ref, url, title, published_at, via, fetched_at,
                                  content_text, content_hash, version)
             SELECT exchange.id, $3::uuid, s.ref, s.url, s.title, s.published_at, s.via, s.fetched_at,
                    s.content_text, s.content_hash, s.version
             FROM exchange, jsonb_to_recordset($14::jsonb) AS s(
               ref text, url text, title text, published_at date, via text, fetched_at timestamptz,
               content_text text, content_hash text, version integer)
           )
           SELECT count(*)::int AS saved FROM exchange`,
          [
            a.message.id,
            a.conversationId,
            a.userId,
            JSON.stringify(a.message.parts),
            JSON.stringify(a.message.flags),
            JSON.stringify(a.message.timing),
            a.message.createdAt,
            e.askedAt,
            e.userTz,
            e.localDate,
            e.userMessageId,
            e.question,
            e.answer,
            JSON.stringify(sources),
          ],
        ),
      );
      if (rows[0].saved !== 1) throw new Error('Unknown conversation.');
    },

    async loadThread(userId, conversationId) {
      const [messages, sources] = await Promise.all([
        query<StoredMessage>(
          'loadThread.messages',
          `SELECT id, seq, role, parts, flags, timing FROM messages
           WHERE user_id = $1 AND conversation_id = $2 ORDER BY seq`,
          [userId, conversationId],
        ),
        query<ThreadSource>(
          'loadThread.sources',
          `SELECT s.ref, s.url, s.title, s.published_at::text AS "publishedAt", s.via,
                  s.fetched_at AS "fetchedAt", s.version, e.assistant_message_id AS "assistantMessageId"
           FROM sources s JOIN exchanges e ON e.id = s.exchange_id
           WHERE s.user_id = $1 AND e.conversation_id = $2`,
          [userId, conversationId],
        ),
      ]);
      return { messages: messages.rows, sources: sources.rows };
    },

    async listConversations(userId) {
      // Latest exchange first; a conversation with none yet sorts by when it was made (spec 5.2).
      const { rows } = await query<{ id: string; title: string | null }>(
        'listConversations',
        `SELECT c.id, c.title FROM conversations c
         LEFT JOIN exchanges e ON e.conversation_id = c.id
         WHERE c.user_id = $1
         GROUP BY c.id
         ORDER BY coalesce(max(e.asked_at), c.created_at) DESC
         LIMIT ${MAX_CONVERSATIONS}`,
        [userId],
      );
      return rows;
    },

    async latestFetch(userId, url): Promise<LatestFetch | null> {
      const { rows } = await query<LatestFetch>(
        'latestFetch',
        `WITH latest AS (
           SELECT version, content_hash FROM sources
           WHERE user_id = $1 AND url = $2 AND via = 'fetch'
           ORDER BY fetched_at DESC, version DESC LIMIT 1
         )
         SELECT l.version, l.content_hash AS hash,
                (SELECT min(fetched_at) FROM sources
                 WHERE user_id = $1 AND url = $2 AND via = 'fetch' AND version = l.version) AS "firstSeenAt"
         FROM latest l`,
        [userId, url],
      );
      return rows[0] ?? null;
    },

    async hasSource(userId, url) {
      const { rows } = await query<{ found: boolean }>(
        'hasSource',
        'SELECT EXISTS (SELECT 1 FROM sources WHERE user_id = $1 AND url = $2) AS found',
        [userId, url],
      );
      return rows[0].found;
    },
  };
}

/** Thrown when migrations/ has files the database has not applied. */
export class PendingMigrationsError extends Error {
  constructor(readonly pending: string[]) {
    super(`Database schema is behind: run \`npm run migrate up\` (pending: ${pending.join(', ')}).`);
    this.name = 'PendingMigrationsError';
  }
}

async function checkMigrations(pool: pg.Pool): Promise<void> {
  const start = performance.now();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => basename(f, '.sql'));
  let applied: Set<string>;
  try {
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
    applied = new Set(rows.map((r) => r.name));
  } catch (error) {
    // 42P01: the table does not exist, so nothing has been migrated yet.
    if ((error as { code?: string }).code !== '42P01') throw error;
    applied = new Set();
  }
  const pending = files.filter((f) => !applied.has(f)).sort();
  log.info('db.migration_check', { ms: elapsedMs(start), applied: applied.size, pending: pending.length });
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}

function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
