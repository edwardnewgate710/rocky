import { SocialRuleError } from './errors';
import type { Page, PageOptions } from './pagination';
import { paginate } from './pagination';
import { assertDistinct, type PlayerId } from './relation';
import type { FollowEdge } from './follow';
import { followersOf, followingOf, isFollowing } from './follow';
import type { FriendRequest, FriendRequestAction } from './friendship';
import {
  applyFriendRequestAction,
  areFriends,
  friendsOf,
  involvesPair,
  pendingIncoming,
  pendingOutgoing,
  terminateFriendship,
} from './friendship';
import type { BlockEdge } from './block';
import { blocksBy, isBlockedBetween } from './block';

/**
 * Storage-agnostic port for the social graph.
 *
 * The pure modules in this package decide *what* each relation means; an adapter only decides where
 * the rows live. But several rules are enforced by the adapter rather than by a pure function,
 * because they span more than one collection — and those are exactly the rules a second adapter can
 * silently fail to reproduce. Every implementation owes all of them:
 *
 * 1. `follow`, `sendFriendRequest`, `block`, `unfollow` and `unblock` reject a player acting on
 *    themselves with `self_relation`.
 * 2. `follow` and `sendFriendRequest` reject with `blocked` when a block exists in *either*
 *    direction — the blocker is barred too.
 * 3. `follow` is idempotent: re-following returns the existing edge with its original timestamp.
 *    `unfollow` returns false when there was nothing to remove.
 * 4. `block` is a single atomic step that removes both follow edges between the pair, cancels or
 *    declines any pending request (whichever the blocker is entitled to do), and ends an accepted
 *    friendship as `ended`. No row is deleted; the history stays readable.
 * 5. `unblock` restores none of that.
 * 6. `sendFriendRequest` rejects a duplicate id, an existing friendship, and a pending request in
 *    either direction. `declined`, `cancelled` and `ended` requests do not bar a new one.
 * 7. Every list is ordered newest-first with a code-point id tie-break (see `src/ordering.ts`) and
 *    paginated by the clamping rules in `src/pagination.ts`. In SQL that tie-break needs an
 *    explicit `COLLATE "C"`.
 */
export interface SocialGraphRepository {
  follow(followerId: PlayerId, followeeId: PlayerId, at: Date): Promise<FollowEdge>;
  unfollow(followerId: PlayerId, followeeId: PlayerId): Promise<boolean>;
  listFollowers(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>>;
  listFollowing(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>>;
  isFollowing(followerId: PlayerId, followeeId: PlayerId): Promise<boolean>;

  sendFriendRequest(
    id: string,
    requesterId: PlayerId,
    addresseeId: PlayerId,
    at: Date
  ): Promise<FriendRequest>;
  respondToFriendRequest(
    id: string,
    action: FriendRequestAction,
    actorId: PlayerId,
    at: Date
  ): Promise<FriendRequest>;
  findFriendRequest(id: string): Promise<FriendRequest | undefined>;
  listIncomingRequests(playerId: PlayerId, options?: PageOptions): Promise<Page<FriendRequest>>;
  listOutgoingRequests(playerId: PlayerId, options?: PageOptions): Promise<Page<FriendRequest>>;
  listFriends(playerId: PlayerId, options?: PageOptions): Promise<Page<PlayerId>>;
  areFriends(a: PlayerId, b: PlayerId): Promise<boolean>;

  block(blockerId: PlayerId, blockedId: PlayerId, at: Date): Promise<BlockEdge>;
  unblock(blockerId: PlayerId, blockedId: PlayerId): Promise<boolean>;
  listBlocked(playerId: PlayerId, options?: PageOptions): Promise<Page<BlockEdge>>;
  isBlockedBetween(a: PlayerId, b: PlayerId): Promise<boolean>;
}

export class InMemorySocialGraphRepository implements SocialGraphRepository {
  private follows: FollowEdge[] = [];
  private readonly friendRequests = new Map<string, FriendRequest>();
  private blocks: BlockEdge[] = [];

  async clear(): Promise<void> {
    this.follows = [];
    this.friendRequests.clear();
    this.blocks = [];
  }

  // --- Follow ---

  async follow(followerId: PlayerId, followeeId: PlayerId, at: Date): Promise<FollowEdge> {
    assertDistinct(followerId, followeeId);

    if (isBlockedBetween(followerId, followeeId, this.blocks)) {
      throw new SocialRuleError(
        'blocked',
        `Cannot follow player ${followeeId} because a block exists between the players`
      );
    }

    const existing = this.follows.find(
      (e) => e.followerId === followerId && e.followeeId === followeeId
    );
    if (existing) {
      // Idempotent: return existing edge with original timestamp
      return existing;
    }

    const newEdge: FollowEdge = { followerId, followeeId, followedAt: at };
    this.follows.push(newEdge);
    return newEdge;
  }

  async unfollow(followerId: PlayerId, followeeId: PlayerId): Promise<boolean> {
    assertDistinct(followerId, followeeId);

    const index = this.follows.findIndex(
      (e) => e.followerId === followerId && e.followeeId === followeeId
    );
    if (index === -1) {
      return false;
    }
    this.follows.splice(index, 1);
    return true;
  }

  async listFollowers(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>> {
    const list = followersOf(playerId, this.follows);
    return paginate(list, options);
  }

  async listFollowing(playerId: PlayerId, options?: PageOptions): Promise<Page<FollowEdge>> {
    const list = followingOf(playerId, this.follows);
    return paginate(list, options);
  }

  async isFollowing(followerId: PlayerId, followeeId: PlayerId): Promise<boolean> {
    return isFollowing(followerId, followeeId, this.follows);
  }

  // --- Friend Requests & Friendships ---

  async sendFriendRequest(
    id: string,
    requesterId: PlayerId,
    addresseeId: PlayerId,
    at: Date
  ): Promise<FriendRequest> {
    assertDistinct(requesterId, addresseeId);

    if (isBlockedBetween(requesterId, addresseeId, this.blocks)) {
      throw new SocialRuleError(
        'blocked',
        `Cannot send friend request to ${addresseeId} because a block exists between the players`
      );
    }

    if (this.friendRequests.has(id)) {
      throw new SocialRuleError(
        'already_exists',
        `Friend request with ID '${id}' already exists`
      );
    }

    const requests = Array.from(this.friendRequests.values());

    if (areFriends(requesterId, addresseeId, requests)) {
      throw new SocialRuleError('already_exists', 'Players are already friends');
    }

    const openRequest = requests.find(
      (r) => r.status === 'pending' && involvesPair(r, requesterId, addresseeId)
    );
    if (openRequest) {
      throw new SocialRuleError(
        'already_exists',
        openRequest.requesterId === requesterId
          ? 'A pending friend request already exists in this direction'
          : 'A pending friend request already exists in the opposite direction; respond to it instead'
      );
    }

    const request: FriendRequest = {
      id,
      requesterId,
      addresseeId,
      status: 'pending',
      createdAt: at,
    };
    this.friendRequests.set(id, request);
    return request;
  }

  async respondToFriendRequest(
    id: string,
    action: FriendRequestAction,
    actorId: PlayerId,
    at: Date
  ): Promise<FriendRequest> {
    const req = this.friendRequests.get(id);
    if (!req) {
      throw new SocialRuleError('not_found', `Friend request with ID '${id}' not found`);
    }

    const updated = applyFriendRequestAction(req, action, actorId, at);
    this.friendRequests.set(id, updated);
    return updated;
  }

  async findFriendRequest(id: string): Promise<FriendRequest | undefined> {
    return this.friendRequests.get(id);
  }

  async listIncomingRequests(
    playerId: PlayerId,
    options?: PageOptions
  ): Promise<Page<FriendRequest>> {
    const list = pendingIncoming(playerId, Array.from(this.friendRequests.values()));
    return paginate(list, options);
  }

  async listOutgoingRequests(
    playerId: PlayerId,
    options?: PageOptions
  ): Promise<Page<FriendRequest>> {
    const list = pendingOutgoing(playerId, Array.from(this.friendRequests.values()));
    return paginate(list, options);
  }

  async listFriends(playerId: PlayerId, options?: PageOptions): Promise<Page<PlayerId>> {
    const list = friendsOf(playerId, Array.from(this.friendRequests.values()));
    return paginate(list, options);
  }

  async areFriends(a: PlayerId, b: PlayerId): Promise<boolean> {
    return areFriends(a, b, Array.from(this.friendRequests.values()));
  }

  // --- Block ---

  async block(blockerId: PlayerId, blockedId: PlayerId, at: Date): Promise<BlockEdge> {
    assertDistinct(blockerId, blockedId);

    this.removeFollowsBetween(blockerId, blockedId);
    this.tearDownFriendship(blockerId, blockedId, at);

    const existing = this.blocks.find(
      (b) => b.blockerId === blockerId && b.blockedId === blockedId
    );
    if (existing) {
      return existing;
    }

    const blockEdge: BlockEdge = { blockerId, blockedId, blockedAt: at };
    this.blocks.push(blockEdge);
    return blockEdge;
  }

  private removeFollowsBetween(a: PlayerId, b: PlayerId): void {
    this.follows = this.follows.filter(
      (e) =>
        !(
          (e.followerId === a && e.followeeId === b) ||
          (e.followerId === b && e.followeeId === a)
        )
    );
  }

  /**
   * Retires every friend request between the pair on the blocker's behalf.
   *
   * The action taken is the one the blocker is actually entitled to take, so the teardown goes
   * through the same authority checks as a user-initiated response rather than around them: cancel
   * what they sent, decline what they received, and end a friendship they had.
   */
  private tearDownFriendship(blockerId: PlayerId, blockedId: PlayerId, at: Date): void {
    for (const [id, req] of this.friendRequests.entries()) {
      if (!involvesPair(req, blockerId, blockedId)) {
        continue;
      }

      if (req.status === 'accepted') {
        this.friendRequests.set(id, terminateFriendship(req, at));
      } else if (req.status === 'pending') {
        const action = req.requesterId === blockerId ? 'cancel' : 'decline';
        this.friendRequests.set(id, applyFriendRequestAction(req, action, blockerId, at));
      }
    }
  }

  async unblock(blockerId: PlayerId, blockedId: PlayerId): Promise<boolean> {
    assertDistinct(blockerId, blockedId);

    const index = this.blocks.findIndex(
      (b) => b.blockerId === blockerId && b.blockedId === blockedId
    );
    if (index === -1) {
      return false;
    }
    this.blocks.splice(index, 1);
    return true;
  }

  async listBlocked(playerId: PlayerId, options?: PageOptions): Promise<Page<BlockEdge>> {
    const list = blocksBy(playerId, this.blocks);
    return paginate(list, options);
  }

  async isBlockedBetween(a: PlayerId, b: PlayerId): Promise<boolean> {
    return isBlockedBetween(a, b, this.blocks);
  }
}
