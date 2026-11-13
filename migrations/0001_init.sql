-- Up Migration

-- The six tables of spec 5. Statements use IF NOT EXISTS so a database made
-- by the old startup schema.sql takes this migration without error.
-- Timestamps have no defaults: they come from the clock module (spec 5.7).
-- No down migration: undoing this would drop every table.

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timezone   text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  title      text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  parts           jsonb NOT NULL,
  flags           jsonb,
  timing          jsonb,
  created_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_seq ON messages (conversation_id, seq);

CREATE TABLE IF NOT EXISTS exchanges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  asked_at             timestamptz NOT NULL,
  user_tz              text NOT NULL,
  local_date           date NOT NULL,
  user_message_id      uuid NOT NULL REFERENCES messages(id),
  assistant_message_id uuid NOT NULL REFERENCES messages(id),
  question             text NOT NULL,
  answer               text NOT NULL,
  extraction_status    text NOT NULL DEFAULT 'pending'
                       CHECK (extraction_status IN ('pending', 'done', 'failed', 'skipped')),
  extraction_attempts  integer NOT NULL DEFAULT 0,
  topic                text,
  answer_summary       text,
  entities             text[] NOT NULL DEFAULT '{}',
  search               tsvector GENERATED ALWAYS AS (
                         setweight(to_tsvector('english', coalesce(topic, '')), 'A') ||
                         setweight(to_tsvector('english', question), 'B') ||
                         setweight(to_tsvector('english', answer), 'C')
                       ) STORED
);
CREATE INDEX IF NOT EXISTS exchanges_user_local_date ON exchanges (user_id, local_date);
CREATE INDEX IF NOT EXISTS exchanges_conversation_asked_at ON exchanges (conversation_id, asked_at);
CREATE INDEX IF NOT EXISTS exchanges_search ON exchanges USING gin (search);

CREATE TABLE IF NOT EXISTS sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id  uuid NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  ref          text NOT NULL,
  url          text NOT NULL,
  title        text,
  published_at date,
  via          text NOT NULL CHECK (via IN ('search', 'fetch')),
  fetched_at   timestamptz NOT NULL,
  content_text text NOT NULL,
  content_hash text NOT NULL,
  version      integer
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_exchange_ref ON sources (exchange_id, ref);
CREATE INDEX IF NOT EXISTS sources_user_url_fetched_at ON sources (user_id, url, fetched_at);

CREATE TABLE IF NOT EXISTS claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  entity      text NOT NULL,
  attribute   text NOT NULL,
  value       text NOT NULL,
  source_id   uuid NOT NULL REFERENCES sources(id),
  quote       text NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_exchange ON claims (exchange_id);
CREATE INDEX IF NOT EXISTS claims_source ON claims (source_id);
