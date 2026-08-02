/**
 * The social-graph REST surface: follows, friend requests, and blocks.
 *
 * Split into its own module rather than added to `client.ts` because it is the
 * first of several M10 feature families (teams, messaging, studies) and folding
 * each one into the single client file would turn it into a directory's worth of
 * code in one place.
 *
 * Two shapes to know before reading:
 *
 * - **Four of these endpoints are caller-scoped.** `friends`, `incomingRequests`,
 *   `outgoingRequests` and `blocks` take no player id — they answer for whoever
 *   holds the token. They belong to the viewer's own profile and cannot be asked
 *   about anyone else.
 * - **Every list returns ids, never handles.** Turning those into display names
 *   needs `player(id:)`, which exists only in the GraphQL read layer; see
 *   `graphql.ts`. That is a property of the API, not an oversight here.
 */

import type { Execute } from './client.js';
import type {
  BlockEdge,
  FollowEdge,
  FriendRequest,
  FriendRequestAction,
  SocialPage,
} from './models.js';

/** Paging accepted by the list endpoints. */
export interface SocialPageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

function pageQuery(opts: SocialPageOptions): { query?: Record<string, number> } {
  const query: Record<string, number> = {};
  if (opts.limit !== undefined) query['limit'] = opts.limit;
  if (opts.offset !== undefined) query['offset'] = opts.offset;
  return Object.keys(query).length > 0 ? { query } : {};
}

export class SocialApi {
  private readonly execute: Execute;

  constructor(execute: Execute) {
    this.execute = execute;
  }

  // --- Follows ---------------------------------------------------------------

  follow(playerId: string): Promise<FollowEdge> {
    return this.execute<FollowEdge>({
      method: 'POST',
      path: `/v1/social/follows/${encodeURIComponent(playerId)}`,
      auth: true,
    });
  }

  unfollow(playerId: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/social/follows/${encodeURIComponent(playerId)}`,
      auth: true,
    });
  }

  /**
   * Public: a player's followers are visible without a token, matching the REST
   * route's auth policy. Passing the token anyway would make signed-out and
   * signed-in views diverge for no reason.
   */
  followers(playerId: string, opts: SocialPageOptions = {}): Promise<SocialPage<FollowEdge>> {
    return this.execute<SocialPage<FollowEdge>>({
      method: 'GET',
      path: `/v1/social/players/${encodeURIComponent(playerId)}/followers`,
      ...pageQuery(opts),
    });
  }

  following(playerId: string, opts: SocialPageOptions = {}): Promise<SocialPage<FollowEdge>> {
    return this.execute<SocialPage<FollowEdge>>({
      method: 'GET',
      path: `/v1/social/players/${encodeURIComponent(playerId)}/following`,
      ...pageQuery(opts),
    });
  }

  // --- Friend requests -------------------------------------------------------

  sendFriendRequest(addresseeId: string): Promise<FriendRequest> {
    return this.execute<FriendRequest>({
      method: 'POST',
      path: '/v1/social/friend-requests',
      body: { addresseeId },
      auth: true,
    });
  }

  /**
   * `accept` and `decline` are the addressee's moves; `cancel` is the
   * requester's. The server enforces which one the caller may make, so the UI
   * offers the pair that matches the direction it is showing rather than
   * duplicating that rule.
   */
  respondToFriendRequest(id: string, action: FriendRequestAction): Promise<FriendRequest> {
    return this.execute<FriendRequest>({
      method: 'POST',
      path: `/v1/social/friend-requests/${encodeURIComponent(id)}/respond`,
      body: { action },
      auth: true,
    });
  }

  incomingRequests(opts: SocialPageOptions = {}): Promise<SocialPage<FriendRequest>> {
    return this.execute<SocialPage<FriendRequest>>({
      method: 'GET',
      path: '/v1/social/friend-requests/incoming',
      auth: true,
      ...pageQuery(opts),
    });
  }

  outgoingRequests(opts: SocialPageOptions = {}): Promise<SocialPage<FriendRequest>> {
    return this.execute<SocialPage<FriendRequest>>({
      method: 'GET',
      path: '/v1/social/friend-requests/outgoing',
      auth: true,
      ...pageQuery(opts),
    });
  }

  /** Accepted friendships, as bare player ids. */
  friends(opts: SocialPageOptions = {}): Promise<SocialPage<string>> {
    return this.execute<SocialPage<string>>({
      method: 'GET',
      path: '/v1/social/friends',
      auth: true,
      ...pageQuery(opts),
    });
  }

  // --- Blocks ----------------------------------------------------------------

  block(playerId: string): Promise<BlockEdge> {
    return this.execute<BlockEdge>({
      method: 'POST',
      path: `/v1/social/blocks/${encodeURIComponent(playerId)}`,
      auth: true,
    });
  }

  unblock(playerId: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/social/blocks/${encodeURIComponent(playerId)}`,
      auth: true,
    });
  }

  blocks(opts: SocialPageOptions = {}): Promise<SocialPage<BlockEdge>> {
    return this.execute<SocialPage<BlockEdge>>({
      method: 'GET',
      path: '/v1/social/blocks',
      auth: true,
      ...pageQuery(opts),
    });
  }
}
