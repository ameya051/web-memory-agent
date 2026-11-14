import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import pg from 'pg';
import { elapsedMs, log } from '@/utils/log';
import type {
  CitedSavedSource,
  ExchangeHeader,
  ExtractionJob,
  LatestFetch,
  MemoryExchange,
  SavedClaim,
  Store,
  StoredMessage,
  ThreadSource,
} from '@/core/ports';

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

  async function loadMessages(userId: string, conversationId: string): Promise<StoredMessage[]> {
    const { rows } = await query<StoredMessage>(
      'loadMessages',
      `SELECT id, seq, role, parts, flags, timing FROM messages
       WHERE user_id = $1 AND conversation_id = $2 ORDER BY seq`,
      [userId, conversationId],
    );
    return rows;
  }

  return {
    end: () => pool.end(),

    async ensureUser(timezone, now) {
      // Not cached, so a database reset under a running server cannot leave a
      // deleted user's id behind. The usual case is this one statement.
      const updateSql = `UPDATE users SET timezone = $1 WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1) RETURNING id`;
      const { rows } = await query<{ id: string }>('ensureUser', updateSql, [timezone]);
      if (rows[0]) return rows[0];
      // No user yet: one local user (spec 1.1). The table lock stops two first requests creating two.
      return transaction('ensureUser.create', async (client) => {
        await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const updated = await client.query<{ id: string }>(updateSql, [timezone]);
        if (updated.rows[0]) return updated.rows[0];
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO users (timezone, created_at) VALUES ($1, $2) RETURNING id',
          [timezone, now],
        );
        return inserted.rows[0];
      });
    },

    async findUser() {
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
        query<{ exchangeId: string }>(
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
           SELECT id AS "exchangeId" FROM exchange`,
          [
            a.message.id,
            a.conversationId,
            a.userId,
            JSON.stringify(a.message.parts),
            JSON.stringify(a.message.flags),
            a.message.timing && JSON.stringify(a.message.timing),
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
      if (!rows[0]) throw new Error('Unknown conversation.');
      return { exchangeId: rows[0].exchangeId };
    },

    loadMessages,

    async loadThread(userId, conversationId) {
      const [messages, sources, citedSaved] = await Promise.all([
        loadMessages(userId, conversationId),
        query<ThreadSource>(
          'loadThread.sources',
          `SELECT s.ref, s.url, s.title, s.published_at::text AS "publishedAt", s.via,
                  s.fetched_at AS "fetchedAt", s.version, e.assistant_message_id AS "assistantMessageId"
           FROM sources s JOIN exchanges e ON e.id = s.exchange_id
           WHERE s.user_id = $1 AND e.conversation_id = $2`,
          [userId, conversationId],
        ),
        // Earlier reads the thread's search_memory calls gave refs to, by the
        // row ids saved in those tool parts.
        query<CitedSavedSource>(
          'loadThread.citedSaved',
          `SELECT s.id, s.url, s.title, s.published_at::text AS "publishedAt", s.via, s.fetched_at AS "fetchedAt",
                  s.version, s.exchange_id AS "exchangeId", e.user_tz AS "userTz"
           FROM sources s JOIN exchanges e ON e.id = s.exchange_id
           WHERE s.user_id = $1 AND s.id IN (
             SELECT saved.value::uuid
             FROM messages m
             CROSS JOIN LATERAL jsonb_array_elements(m.parts) AS part
             CROSS JOIN LATERAL jsonb_each_text(coalesce(part -> 'savedSources', '{}'::jsonb)) AS saved
             WHERE m.user_id = $1 AND m.conversation_id = $2 AND part ->> 'name' = 'search_memory'
           )`,
          [userId, conversationId],
        ),
      ]);
      return { messages, sources: sources.rows, citedSaved: citedSaved.rows };
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

    async searchMemory(userId, q) {
      // Topic words match as OR, so one missing word does not hide an
      // exchange; ts_rank_cd puts the best match first. Date filters use
      // local_date, the asker's calendar date written at insert.
      type Row = Omit<MemoryExchange, 'sources'> & { total: number; sources: Array<Omit<MemoryExchange['sources'][number], 'fetchedAt'> & { fetchedAt: string }> };
      const { rows } = await query<Row>(
        'searchMemory',
        `WITH q AS (
           SELECT CASE WHEN $4::text IS NULL THEN NULL
                       ELSE replace(plainto_tsquery('english', $4::text)::text, ' & ', ' | ')::tsquery END AS tsq
         ), matched AS (
           SELECT e.id, e.conversation_id, e.asked_at, e.user_tz, e.question, e.answer,
                  e.answer_summary, e.entities,
                  count(*) OVER () AS total,
                  coalesce(ts_rank_cd(e.search, q.tsq), 0) AS rank
           FROM exchanges e, q
           WHERE e.user_id = $1 AND e.user_message_id <> $5::uuid
             AND ($2::date IS NULL OR e.local_date BETWEEN $2::date AND $3::date)
             AND (q.tsq IS NULL OR e.search @@ q.tsq)
           ORDER BY rank DESC, e.asked_at
           LIMIT $6
         )
         SELECT m.id, m.conversation_id AS "conversationId", m.asked_at AS "askedAt", m.user_tz AS "userTz",
                m.question, m.answer, m.answer_summary AS summary, m.entities, m.total::int AS total,
                coalesce((
                  SELECT json_agg(json_build_object(
                           'entity', c.entity, 'attribute', c.attribute, 'value', c.value,
                           'quote', c.quote, 'sourceId', c.source_id) ORDER BY c.entity, c.attribute)
                  FROM claims c WHERE c.exchange_id = m.id AND c.user_id = $1
                ), '[]'::json) AS claims,
                coalesce((
                  SELECT json_agg(json_build_object(
                           'id', s.id, 'url', s.url, 'title', s.title, 'via', s.via, 'fetchedAt', s.fetched_at,
                           'version', s.version, 'contentText', s.content_text, 'contentHash', s.content_hash)
                         ORDER BY s.fetched_at, length(s.ref), s.ref)
                  FROM sources s WHERE s.exchange_id = m.id AND s.user_id = $1
                ), '[]'::json) AS sources
         FROM matched m
         ORDER BY m.rank DESC, m.asked_at`,
        [userId, q.dateFrom ?? null, q.dateTo ?? q.dateFrom ?? null, q.query ?? null, q.excludeUserMessageId, q.limit],
      );
      return {
        total: rows[0]?.total ?? 0,
        exchanges: rows.map(({ total: _total, sources, ...e }) => ({
          ...e,
          sources: sources.map((src) => ({ ...src, fetchedAt: new Date(src.fetchedAt) })),
        })),
      };
    },

    async nearestExchanges(userId, q) {
      const columns = `id, asked_at AS "askedAt", user_tz AS "userTz", local_date::text AS "localDate", topic, question`;
      const { rows } = await query<ExchangeHeader>(
        'nearestExchanges',
        `(SELECT ${columns} FROM exchanges
          WHERE user_id = $1 AND user_message_id <> $4::uuid AND local_date < $2::date
          ORDER BY asked_at DESC LIMIT $5)
         UNION ALL
         (SELECT ${columns} FROM exchanges
          WHERE user_id = $1 AND user_message_id <> $4::uuid AND local_date > $3::date
          ORDER BY asked_at LIMIT $5)`,
        [userId, q.dateFrom, q.dateTo, q.excludeUserMessageId, q.perSide],
      );
      return rows;
    },

    async recentExchanges(userId, limit) {
      const { rows } = await query<ExchangeHeader>(
        'recentExchanges',
        `SELECT id, asked_at AS "askedAt", user_tz AS "userTz", local_date::text AS "localDate", topic, question
         FROM exchanges WHERE user_id = $1
         ORDER BY local_date DESC, asked_at DESC LIMIT $2`,
        [userId, limit],
      );
      return rows;
    },

    async savedClaimsForUrl(userId, url, limit) {
      const { rows } = await query<SavedClaim>(
        'savedClaimsForUrl',
        `SELECT c.entity, c.attribute, c.value, c.quote, e.asked_at AS "askedAt", e.user_tz AS "userTz", s.version
         FROM sources s
         JOIN claims c ON c.source_id = s.id
         JOIN exchanges e ON e.id = c.exchange_id
         WHERE s.user_id = $1 AND s.url = $2
         ORDER BY e.asked_at DESC, c.entity, c.attribute
         LIMIT $3`,
        [userId, url, limit],
      );
      return rows;
    },

    async pendingExtractions() {
      const { rows } = await query<{ id: string; userId: string }>(
        'pendingExtractions',
        `SELECT id, user_id AS "userId" FROM exchanges WHERE extraction_status = 'pending' ORDER BY asked_at`,
      );
      return rows;
    },

    async startExtraction(userId, exchangeId, maxAttempts) {
      // One statement: a row stuck at the limit is failed, any other pending
      // row gets one more attempt and is returned with its own sources.
      const { rows } = await query<ExtractionJob>(
        'startExtraction',
        `WITH stuck AS (
           UPDATE exchanges SET extraction_status = 'failed'
           WHERE id = $2 AND user_id = $1 AND extraction_status = 'pending' AND extraction_attempts >= $3
         ), started AS (
           UPDATE exchanges SET extraction_attempts = extraction_attempts + 1
           WHERE id = $2 AND user_id = $1 AND extraction_status = 'pending' AND extraction_attempts < $3
           RETURNING id, question, answer
         )
         SELECT st.question, st.answer,
                coalesce((
                  SELECT json_agg(json_build_object('id', s.id, 'ref', s.ref, 'url', s.url, 'text', s.content_text)
                                  ORDER BY length(s.ref), s.ref)
                  FROM sources s WHERE s.exchange_id = st.id AND s.user_id = $1
                ), '[]'::json) AS sources
         FROM started st`,
        [userId, exchangeId, maxAttempts],
      );
      return rows[0] ?? null;
    },

    async saveExtraction(userId, exchangeId, r) {
      await transaction('saveExtraction', async (client) => {
        await client.query('DELETE FROM claims WHERE exchange_id = $1 AND user_id = $2', [exchangeId, userId]);
        if (r.claims.length > 0) {
          await client.query(
            `INSERT INTO claims (exchange_id, user_id, entity, attribute, value, source_id, quote)
             SELECT $1::uuid, $2::uuid, c.entity, c.attribute, c.value, c."sourceId", c.quote
             FROM jsonb_to_recordset($3::jsonb) AS c(entity text, attribute text, value text, "sourceId" uuid, quote text)`,
            [exchangeId, userId, JSON.stringify(r.claims)],
          );
        }
        await client.query(
          `UPDATE exchanges SET extraction_status = $3, topic = $4, answer_summary = $5, entities = $6
           WHERE id = $1 AND user_id = $2`,
          [exchangeId, userId, r.status, r.topic, r.summary, r.entities],
        );
      });
    },

    async failExtraction(userId, exchangeId, maxAttempts) {
      const { rows } = await query<{ status: 'pending' | 'failed' }>(
        'failExtraction',
        `UPDATE exchanges
         SET extraction_status = CASE WHEN extraction_attempts >= $3 THEN 'failed' ELSE extraction_status END
         WHERE id = $2 AND user_id = $1 AND extraction_status = 'pending'
         RETURNING extraction_status AS status`,
        [userId, exchangeId, maxAttempts],
      );
      // A row no longer pending was finished elsewhere: nothing left to retry.
      return rows[0]?.status ?? 'failed';
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
