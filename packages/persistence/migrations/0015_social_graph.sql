-- Migration 0015 — social_graph tables for follows, blocks, and friend requests (M10 inc 2).
-- See docs/DATABASE.md and docs/adr/0067-social-persistence-api.md.

CREATE TABLE social_follows (
  follower_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT social_follows_not_self CHECK (follower_id <> followee_id)
);

CREATE TABLE social_blocks (
  blocker_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT social_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE TABLE social_friend_requests (
  id           UUID        NOT NULL PRIMARY KEY,
  requester_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  CONSTRAINT social_friend_requests_not_self CHECK (requester_id <> addressee_id),
  CONSTRAINT social_friend_requests_status CHECK (
    status IN ('pending', 'accepted', 'declined', 'cancelled', 'ended')
  )
);

-- Partial unique indexes on the unordered pair:
-- The domain logic rejects a second pending request and a request between existing friends,
-- but does so by reading then writing. Concurrent requests could both read "nothing pending"
-- and insert simultaneously. These partial unique indexes make the race condition impossible
-- at the storage level.
CREATE UNIQUE INDEX social_friend_requests_one_pending_per_pair
  ON social_friend_requests (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
  WHERE status = 'pending';

CREATE UNIQUE INDEX social_friend_requests_one_accepted_per_pair
  ON social_friend_requests (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
  WHERE status = 'accepted';

-- Indexes supporting list ordering (newest first, counterpart ID ASC)
CREATE INDEX social_follows_followee_idx ON social_follows (followee_id, followed_at DESC, follower_id ASC);
CREATE INDEX social_follows_follower_idx ON social_follows (follower_id, followed_at DESC, followee_id ASC);
CREATE INDEX social_blocks_blocker_idx ON social_blocks (blocker_id, blocked_at DESC, blocked_id ASC);

-- social_blocks.blocked_id needs its own index for two reasons, and the primary key
-- (blocker_id, blocked_id) serves neither:
--   1. isBlockedBetween tests BOTH directions, and it runs on every follow and every friend
--      request. The reverse leg would otherwise scan the whole table on the hottest read here.
--   2. Postgres does not index the referencing side of a foreign key automatically, so
--      ON DELETE CASCADE would sequentially scan social_blocks for every account deletion.
CREATE INDEX social_blocks_blocked_idx ON social_blocks (blocked_id);
CREATE INDEX social_friend_requests_incoming_idx ON social_friend_requests (addressee_id, created_at DESC, requester_id ASC) WHERE status = 'pending';
CREATE INDEX social_friend_requests_outgoing_idx ON social_friend_requests (requester_id, created_at DESC, addressee_id ASC) WHERE status = 'pending';
CREATE INDEX social_friend_requests_accepted_requester_idx ON social_friend_requests (requester_id, COALESCE(responded_at, created_at) DESC) WHERE status = 'accepted';
CREATE INDEX social_friend_requests_accepted_addressee_idx ON social_friend_requests (addressee_id, COALESCE(responded_at, created_at) DESC) WHERE status = 'accepted';

-- The four indexes above are all partial (pending / accepted), which is right for the queries but
-- leaves the foreign keys uncovered: a cascading delete has to find rows in EVERY status, so
-- deleting one account would sequentially scan this table twice. These two cover that.
CREATE INDEX social_friend_requests_requester_idx ON social_friend_requests (requester_id);
CREATE INDEX social_friend_requests_addressee_idx ON social_friend_requests (addressee_id);
