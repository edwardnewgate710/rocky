/**
 * @packageDocumentation
 * PostgreSQL implementation of SocialGraphRepository from @chess-platform/social.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  BlockEdge,
  FollowEdge,
  FriendRequest,
  FriendRequestAction,
  FriendRequestStatus,
  Page,
  PageOptions,
  PlayerId,
  SocialGraphRepository,
} from '@chess-platform/social';
import {
  applyFriendRequestAction,
  assertDistinct,
  SocialRuleError,
  terminateFriendship,
} from '@chess-platform/social';
import { lockPlayerPair } from './pair-lock';
import { isForeignKeyViolation, isUniqueViolation } from './sqlstate';

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

/**
 * Serializes every write concerning one unordered pair of players, for the rest of the transaction.
 *
 * A transaction alone does not make `block` safe. At READ COMMITTED — the default — `follow` can
 * read "no block exists", `block` can then commit its teardown, and `follow` can then insert: the
 * blocked player is left following the person who blocked them, which is precisely the outcome
 * blocking exists to prevent. Row locks cannot fix it because the row `follow` needs to lock is the
 * block row that does not exist yet, and a phantom cannot be locked.
 *
 * The lock is keyed on the pair rather than on a player so unrelated blocks never queue behind each
 * other. A hash collision costs two unrelated pairs a little serialization and nothing else.
 */
async function lockPair(client: PoolClient, a: PlayerId, b: PlayerId): Promise<void> {
  await lockPlayerPair(client, a, b);
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || Number.isNaN(offset)) {
    return 0;
  }
  // `Array.slice` accepts an infinite start and yields nothing; `OFFSET 'Infinity'` is a bigint
  // parse error from Postgres. The largest offset the driver can send expresses the same "past
  // the end" the in-memory adapter gives, and no table can hold that many rows anyway.
  if (offset === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.trunc(offset));
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (Number.isNaN(limit)) {
    return 0;
  }
  // An infinite page size means "all remaining", which in SQL is the absence of a LIMIT clause
  // rather than a LIMIT the driver cannot serialize.
  if (limit === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Math.max(0, Math.trunc(limit));
}

/**
 * Turns "that player row is not there" into `not_found` instead of letting the driver error escape
 * as a 500. Every one of these ids arrives from a request path where `parseUuid` proved the shape
 * and nothing proved the player exists.
 */
function rethrowMissingPlayer(err: unknown): never {
  if (isForeignKeyViolation(err)) {
    throw new SocialRuleError('not_found', 'One of the players does not exist');
  }
  throw err;
}

/**
 * Builds the `LIMIT/OFFSET` tail shared by every list query, appending its parameters to `params`.
 *
 * The clamping rules are the ones in `packages/social/src/pagination.ts`, applied here in
 * TypeScript rather than in SQL: neither `NaN` nor `Infinity` may reach `pg` — both are values
 * `Array.slice` absorbs quietly and `LIMIT`/`OFFSET` reject as malformed bigints — and the
 * in-memory and Postgres adapters have to agree on what a negative or fractional page means or
 * pagination drifts between them.
 */
function paginationClause(params: unknown[], options?: PageOptions): string {
  const offset = normalizeOffset(options?.offset);
  const limit = normalizeLimit(options?.limit);

  let clause = `OFFSET $${params.push(offset)}`;
  if (limit !== undefined) {
    clause = `LIMIT $${params.push(limit)} ${clause}`;
  }
  return clause;
}

const VALID_STATUSES = new Set<FriendRequestStatus>([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'ended',
]);

function parseStatus(status: string): FriendRequestStatus {
  if (VALID_STATUSES.has(status as FriendRequestStatus)) {
    return status as FriendRequestStatus;
  }
  throw new Error(`Invalid friend request status in database: '${status}'`);
}

interface FriendRequestRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  created_at: Date;
  responded_at: Date | null;
}

function rowToFriendRequest(row: FriendRequestRow): FriendRequest {
  return {
    id: row.id,
    requesterId: row.requester_id,
    addresseeId: row.addressee_id,
    status: parseStatus(row.status),
    createdAt: new Date(row.created_at),
    ...(row.responded_at ? { respondedAt: new Date(row.responded_at) } : {}),
  };
}

export class PgSocialGraphRepository implements SocialGraphRepository {
  constructor(private readonly pool: Pool) {}

  // --- Follow ---

  async follow(followerId: PlayerId, followeeId: PlayerId, at: Date): Promise<FollowEdge> {
    assertDistinct(followerId, followeeId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPair(client, followerId, followeeId);

      const blockRes = await client.query(
        `SELECT 1 FROM social_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [followerId, followeeId]
      );
      if (blockRes.rowCount && blockRes.rowCount > 0) {
        throw new SocialRuleError(
          'blocked',
          `Cannot follow player ${followeeId} because a block exists between the players`
        );
      }

      // Idempotency in ONE statement, deliberately. `DO NOTHING` returns no row on conflict, so
      // the previous shape had to follow it with a SELECT to recover the existing timestamp — and
      // `DO NOTHING` takes no lock on the conflicting row, so a concurrent `unfollow` could delete
      // it in between and leave that SELECT empty. `DO UPDATE` locks the row it conflicts with and
      // always RETURNINGs one, which removes the window instead of narrowing it. Assigning the
      // column to itself is what keeps the original `followed_at`: re-following must not reset it.
      const upsertRes = await client.query<{ followed_at: Date }>(
        `INSERT INTO social_follows (follower_id, followee_id, followed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (follower_id, followee_id)
         DO UPDATE SET followed_at = social_follows.followed_at
         RETURNING followed_at`,
        [followerId, followeeId, at]
      ).catch(rethrowMissingPlayer);

      await client.query('COMMIT');
      return { followerId, followeeId, followedAt: new Date(upsertRes.rows[0].followed_at) };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async unfollow(followerId: PlayerId, followeeId: PlayerId): Promise<boolean> {
    assertDistinct(followerId, followeeId);

    const res = await this.pool.query(
      `DELETE FROM social_follows WHERE follower_id = $1 AND followee_id = $2`,
      [followerId, followeeId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listFollowers(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_follows WHERE followee_id = $1`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<{ follower_id: string; followee_id: string; followed_at: Date }>(
      `SELECT follower_id, followee_id, followed_at
       FROM social_follows
       WHERE followee_id = $1
       ORDER BY followed_at DESC, follower_id ASC
       ${pagination}`,
      params
    );

    const items: FollowEdge[] = res.rows.map((r) => ({
      followerId: r.follower_id,
      followeeId: r.followee_id,
      followedAt: new Date(r.followed_at),
    }));

    return { total, items };
  }

  async listFollowing(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_follows WHERE follower_id = $1`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<{ follower_id: string; followee_id: string; followed_at: Date }>(
      `SELECT follower_id, followee_id, followed_at
       FROM social_follows
       WHERE follower_id = $1
       ORDER BY followed_at DESC, followee_id ASC
       ${pagination}`,
      params
    );

    const items: FollowEdge[] = res.rows.map((r) => ({
      followerId: r.follower_id,
      followeeId: r.followee_id,
      followedAt: new Date(r.followed_at),
    }));

    return { total, items };
  }

  async isFollowing(followerId: PlayerId, followeeId: PlayerId): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM social_follows WHERE follower_id = $1 AND followee_id = $2`,
      [followerId, followeeId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // --- Friend Requests & Friendship ---

  async sendFriendRequest(
    id: string,
    requesterId: PlayerId,
    addresseeId: PlayerId,
    at: Date
  ): Promise<FriendRequest> {
    assertDistinct(requesterId, addresseeId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPair(client, requesterId, addresseeId);

      const blockRes = await client.query(
        `SELECT 1 FROM social_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [requesterId, addresseeId]
      );
      if (blockRes.rowCount && blockRes.rowCount > 0) {
        throw new SocialRuleError(
          'blocked',
          `Cannot send friend request to ${addresseeId} because a block exists between the players`
        );
      }

      const existingIdRes = await client.query(
        `SELECT 1 FROM social_friend_requests WHERE id = $1`,
        [id]
      );
      if (existingIdRes.rowCount && existingIdRes.rowCount > 0) {
        throw new SocialRuleError(
          'already_exists',
          `Friend request with ID '${id}' already exists`
        );
      }

      const friendsRes = await client.query(
        `SELECT 1 FROM social_friend_requests
         WHERE status = 'accepted' AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [requesterId, addresseeId]
      );
      if (friendsRes.rowCount && friendsRes.rowCount > 0) {
        throw new SocialRuleError('already_exists', 'Players are already friends');
      }

      const openRes = await client.query<{ requester_id: string }>(
        `SELECT requester_id FROM social_friend_requests
         WHERE status = 'pending' AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [requesterId, addresseeId]
      );
      if (openRes.rows.length > 0) {
        const openReq = openRes.rows[0];
        throw new SocialRuleError(
          'already_exists',
          openReq.requester_id === requesterId
            ? 'A pending friend request already exists in this direction'
            : 'A pending friend request already exists in the opposite direction; respond to it instead'
        );
      }

      await client.query(
        `INSERT INTO social_friend_requests (id, requester_id, addressee_id, status, created_at)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [id, requesterId, addresseeId, at]
      );

      await client.query('COMMIT');
      return {
        id,
        requesterId,
        addresseeId,
        status: 'pending',
        createdAt: at,
      };
    } catch (err) {
      await rollback(client);
      if (err instanceof SocialRuleError) {
        throw err;
      }
      // The checks above already reject a duplicate; this is the partial unique indexes catching a
      // pair that raced past them, and it must surface as the same domain error, not a 500.
      if (isUniqueViolation(err)) {
        throw new SocialRuleError(
          'already_exists',
          'A friend request or friendship already exists for these players'
        );
      }
      rethrowMissingPlayer(err);
    } finally {
      client.release();
    }
  }

  /**
   * Reads the request and writes the transition in ONE transaction, with the row locked.
   *
   * Reading on the pool and then updating on the pool is a lost update: two concurrent responses
   * both see `pending`, both compute a legal transition, and the second `UPDATE` silently
   * overwrites the first — so an accepted friendship can be turned into a cancellation by a
   * request that was never valid. `FOR UPDATE` serializes the pair, and the state machine then
   * rejects the second caller with `invalid_transition`, which is the answer they should get.
   */
  async respondToFriendRequest(
    id: string,
    action: FriendRequestAction,
    actorId: PlayerId,
    at: Date
  ): Promise<FriendRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query<FriendRequestRow>(
        `SELECT id, requester_id, addressee_id, status, created_at, responded_at
         FROM social_friend_requests
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (res.rows.length === 0) {
        throw new SocialRuleError('not_found', `Friend request with ID '${id}' not found`);
      }

      const updated = applyFriendRequestAction(rowToFriendRequest(res.rows[0]), action, actorId, at);

      await client.query(
        `UPDATE social_friend_requests SET status = $1, responded_at = $2 WHERE id = $3`,
        [updated.status, at, id]
      );

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async findFriendRequest(id: string): Promise<FriendRequest | undefined> {
    const res = await this.pool.query<FriendRequestRow>(
      `SELECT id, requester_id, addressee_id, status, created_at, responded_at
       FROM social_friend_requests
       WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return rowToFriendRequest(res.rows[0]);
  }

  async listIncomingRequests(
    playerId: PlayerId,
    options?: PageOptions
  ): Promise<Page<FriendRequest>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_friend_requests WHERE addressee_id = $1 AND status = 'pending'`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<FriendRequestRow>(
      `SELECT id, requester_id, addressee_id, status, created_at, responded_at
       FROM social_friend_requests
       WHERE addressee_id = $1 AND status = 'pending'
       ORDER BY created_at DESC, requester_id ASC
       ${pagination}`,
      params
    );

    const items = res.rows.map(rowToFriendRequest);
    return { total, items };
  }

  async listOutgoingRequests(
    playerId: PlayerId,
    options?: PageOptions
  ): Promise<Page<FriendRequest>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_friend_requests WHERE requester_id = $1 AND status = 'pending'`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<FriendRequestRow>(
      `SELECT id, requester_id, addressee_id, status, created_at, responded_at
       FROM social_friend_requests
       WHERE requester_id = $1 AND status = 'pending'
       ORDER BY created_at DESC, addressee_id ASC
       ${pagination}`,
      params
    );

    const items = res.rows.map(rowToFriendRequest);
    return { total, items };
  }

  async listFriends(playerId: PlayerId, options?: PageOptions): Promise<Page<PlayerId>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_friend_requests
       WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<{ counterpart_id: string }>(
      `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS counterpart_id
       FROM social_friend_requests
       WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
       ORDER BY COALESCE(responded_at, created_at) DESC, counterpart_id ASC
       ${pagination}`,
      params
    );

    const items = res.rows.map((r) => r.counterpart_id);
    return { total, items };
  }

  async areFriends(a: PlayerId, b: PlayerId): Promise<boolean> {
    if (a === b) {
      return false;
    }
    const res = await this.pool.query(
      `SELECT 1 FROM social_friend_requests
       WHERE status = 'accepted' AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [a, b]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // --- Block ---

  async block(blockerId: PlayerId, blockedId: PlayerId, at: Date): Promise<BlockEdge> {
    assertDistinct(blockerId, blockedId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPair(client, blockerId, blockedId);

      await client.query(
        `DELETE FROM social_follows
         WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)`,
        [blockerId, blockedId]
      );

      const reqsRes = await client.query<FriendRequestRow>(
        `SELECT id, requester_id, addressee_id, status, created_at, responded_at
         FROM social_friend_requests
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
         FOR UPDATE`,
        [blockerId, blockedId]
      );

      for (const row of reqsRes.rows) {
        const req = rowToFriendRequest(row);
        if (req.status === 'accepted') {
          const updated = terminateFriendship(req, at);
          await client.query(
            `UPDATE social_friend_requests SET status = $1, responded_at = $2 WHERE id = $3`,
            [updated.status, at, req.id]
          );
        } else if (req.status === 'pending') {
          const action: FriendRequestAction = req.requesterId === blockerId ? 'cancel' : 'decline';
          const updated = applyFriendRequestAction(req, action, blockerId, at);
          await client.query(
            `UPDATE social_friend_requests SET status = $1, responded_at = $2 WHERE id = $3`,
            [updated.status, at, req.id]
          );
        }
      }

      // Same single-statement upsert as `follow`, and here the two-statement version failed
      // silently rather than loudly: SELECT-then-INSERT saw the still-visible old row version
      // while a concurrent `unblock` held an uncommitted DELETE on it, skipped the INSERT, and
      // returned a BlockEdge for a block that ceased to exist a moment later. A block that
      // reports success without existing is the one outcome this table must never produce.
      const upsertRes = await client.query<{ blocked_at: Date }>(
        `INSERT INTO social_blocks (blocker_id, blocked_id, blocked_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (blocker_id, blocked_id)
         DO UPDATE SET blocked_at = social_blocks.blocked_at
         RETURNING blocked_at`,
        [blockerId, blockedId, at]
      ).catch(rethrowMissingPlayer);

      await client.query('COMMIT');
      return { blockerId, blockedId, blockedAt: new Date(upsertRes.rows[0].blocked_at) };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async unblock(blockerId: PlayerId, blockedId: PlayerId): Promise<boolean> {
    assertDistinct(blockerId, blockedId);

    const res = await this.pool.query(
      `DELETE FROM social_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, blockedId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listBlocked(playerId: PlayerId, options?: PageOptions): Promise<Page<BlockEdge>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM social_blocks WHERE blocker_id = $1`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<{ blocker_id: string; blocked_id: string; blocked_at: Date }>(
      `SELECT blocker_id, blocked_id, blocked_at
       FROM social_blocks
       WHERE blocker_id = $1
       ORDER BY blocked_at DESC, blocked_id ASC
       ${pagination}`,
      params
    );

    const items: BlockEdge[] = res.rows.map((r) => ({
      blockerId: r.blocker_id,
      blockedId: r.blocked_id,
      blockedAt: new Date(r.blocked_at),
    }));

    return { total, items };
  }

  async isBlockedBetween(a: PlayerId, b: PlayerId): Promise<boolean> {
    if (a === b) {
      return false;
    }
    const res = await this.pool.query(
      `SELECT 1 FROM social_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [a, b]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
