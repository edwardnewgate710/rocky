-- Migration 0021: Seed engine bot user accounts (M14 inc 13, ADR-0080)

-- `users.handle` is globally UNIQUE, so a human who already registered one of these handles would
-- turn this INSERT into a unique violation that aborts the migration and blocks the deploy — with
-- an error naming a constraint rather than the problem. Skipping the row instead would be worse:
-- the bot account would silently not exist, and the first `POST /v1/games/bot` would fail on a
-- foreign key at runtime. So detect it here and say exactly what to do about it.
DO $$
DECLARE
  conflicting TEXT;
BEGIN
  SELECT string_agg(handle::text, ', ')
    INTO conflicting
    FROM users
   WHERE handle IN ('gambit-novice', 'gambit-club', 'gambit-master')
     AND id NOT IN (
       '00000000-0000-7000-8000-000000000001',
       '00000000-0000-7000-8000-000000000002',
       '00000000-0000-7000-8000-000000000003'
     );

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot seed engine bot accounts: handle(s) % are already held by other users. Rename those accounts, then re-run migrations.',
      conflicting;
  END IF;
END $$;

INSERT INTO users (id, handle, flags) VALUES
  ('00000000-0000-7000-8000-000000000001', 'gambit-novice', '{"bot": true}'::jsonb),
  ('00000000-0000-7000-8000-000000000002', 'gambit-club',   '{"bot": true}'::jsonb),
  ('00000000-0000-7000-8000-000000000003', 'gambit-master', '{"bot": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;
