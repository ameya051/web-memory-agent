-- Up Migration

-- Every foreign key now cascades, so deleting a user or a conversation removes
-- everything under it (spec 10). Constraint names are Postgres's defaults from
-- 0001. No down migration: it would only restore blocking deletes.

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('conversations', 'user_id',              'users'),
      ('messages',      'conversation_id',      'conversations'),
      ('messages',      'user_id',              'users'),
      ('exchanges',     'conversation_id',      'conversations'),
      ('exchanges',     'user_id',              'users'),
      ('exchanges',     'user_message_id',      'messages'),
      ('exchanges',     'assistant_message_id', 'messages'),
      ('sources',       'user_id',              'users'),
      ('claims',        'user_id',              'users'),
      ('claims',        'source_id',            'sources')
    ) AS t(tbl, col, ref)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.tbl, fk.tbl || '_' || fk.col || '_fkey');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE CASCADE',
                   fk.tbl, fk.tbl || '_' || fk.col || '_fkey', fk.col, fk.ref);
  END LOOP;
END $$;
