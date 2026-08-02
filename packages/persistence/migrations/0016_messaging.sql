-- Migration 0016 — direct 1:1 messaging tables for conversations, messages, and read markers (M10 inc 3).
-- See docs/DATABASE.md and docs/adr/0068-direct-messaging.md.

CREATE TABLE messaging_conversations (
  id              UUID        NOT NULL PRIMARY KEY,
  participant_a   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT messaging_conversations_not_self CHECK (participant_a <> participant_b)
);

-- Partial-free unique index on the normalized pair:
-- Guarantees that (LEAST(a, b), GREATEST(a, b)) is unique across the entire table so one pair can never get two conversations.
CREATE UNIQUE INDEX messaging_conversations_pair_idx
  ON messaging_conversations (LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b));

CREATE TABLE messaging_messages (
  id              UUID        NOT NULL PRIMARY KEY,
  conversation_id UUID        NOT NULL REFERENCES messaging_conversations(id) ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE messaging_reads (
  conversation_id UUID        NOT NULL REFERENCES messaging_conversations(id) ON DELETE CASCADE,
  participant_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (conversation_id, participant_id)
);

-- Postgres does not index the referencing side of a foreign key, so every ON DELETE CASCADE above
-- needs one deliberately or account deletion sequentially scans these tables.
--
-- Three of them are already paid for. An index on (a, b, c) serves any query that leads with `a`,
-- so the list indexes below double as the FK indexes for participant_a, participant_b and
-- conversation_id. Adding narrow duplicates would cost a write on every insert and buy nothing —
-- and this is the only moment the choice can be made, because the migration runner records a
-- checksum and refuses to re-run an edited migration.
CREATE INDEX messaging_conversations_participant_a_idx ON messaging_conversations (participant_a, last_message_at DESC, id ASC);
CREATE INDEX messaging_conversations_participant_b_idx ON messaging_conversations (participant_b, last_message_at DESC, id ASC);
CREATE INDEX messaging_messages_thread_idx ON messaging_messages (conversation_id, sent_at ASC, id ASC);

-- These two have no wider index to hide behind: `sender_id` and `participant_id` never lead one.
CREATE INDEX messaging_messages_sender_idx ON messaging_messages (sender_id);
CREATE INDEX messaging_reads_participant_idx ON messaging_reads (participant_id);
