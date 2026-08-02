/**
 * Social controller — a DOM-free orchestrator for the social region of the
 * profile page. Like {@link ProfileController} it drives the UI through
 * callbacks and never touches the DOM.
 *
 * Two API facts shape everything here:
 *
 * **There is no "do I follow this player" endpoint.** The twelve social routes
 * expose follows, requests and blocks, but no relationship lookup. So the
 * viewer's own following/blocks/requests are read once and the relationship is
 * derived from them. That read is bounded ({@link RELATIONSHIP_SCAN_LIMIT}), so
 * a viewer who follows more accounts than the bound can see a stale "Follow" on
 * someone they already follow. That is safe rather than merely tolerable:
 * `follow` is an idempotent upsert and `unfollow` reports "nothing removed"
 * without failing, so acting on a stale reading cannot corrupt anything.
 *
 * **Every list returns ids, not handles.** Names come from the GraphQL read
 * layer, which is opt-in. When it is off the ids stay unresolved and the UI
 * shows a truncated id — the page keeps working, it just cannot name people.
 */

import type { GambitClient } from '../api/client.js';
import { namedPage, shortId } from '../api/graphql.js';
import type {
  FriendRequest,
  FriendRequestAction,
  SocialPlayer,
} from '../api/models.js';

/**
 * How many of the viewer's own follows/blocks are scanned to derive the
 * relationship shown on someone else's profile. Generous for a real account and
 * cheap enough to fetch on every profile view.
 */
export const RELATIONSHIP_SCAN_LIMIT = 100;

/** How many followers/following rows the profile shows. */
export const CONNECTION_PAGE_LIMIT = 20;

/** The viewer's relationship to the player whose profile is open. */
export interface Relationship {
  readonly following: boolean;
  readonly blocked: boolean;
  /** A pending request they sent the viewer, awaiting accept/decline. */
  readonly incomingRequestId: string | null;
  /** A pending request the viewer sent them, which the viewer may cancel. */
  readonly outgoingRequestId: string | null;
}

/** Followers and following for the profile on screen. */
export interface Connections {
  readonly followerCount: number;
  readonly followingCount: number;
  readonly followers: readonly SocialPlayer[];
  readonly following: readonly SocialPlayer[];
  /** False when the read layer is off, so names are truncated ids. */
  readonly named: boolean;
}

/** A pending request paired with the other party, named where possible. */
export interface PendingRequest {
  readonly request: FriendRequest;
  readonly player: SocialPlayer;
}

/** The viewer's own social state; only ever shown on their own profile. */
export interface SelfSocial {
  readonly incoming: readonly PendingRequest[];
  readonly outgoing: readonly PendingRequest[];
  readonly friends: readonly SocialPlayer[];
  readonly blocked: readonly SocialPlayer[];
}

export interface SocialCallbacks {
  onConnections: (connections: Connections) => void;
  onRelationship: (relationship: Relationship | null) => void;
  onSelfSocial: (self: SelfSocial | null) => void;
  /** True while an action is in flight, so controls can disable themselves. */
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}

export interface SocialControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: SocialCallbacks;
}

const EMPTY_RELATIONSHIP: Relationship = {
  following: false,
  blocked: false,
  incomingRequestId: null,
  outgoingRequestId: null,
};

export class SocialController {
  private readonly client: GambitClient;
  private readonly callbacks: SocialCallbacks;
  private requestGeneration = 0;
  private disposed = false;
  private busy = false;
  /** The profile currently on screen, and who is looking at it. */
  private subject: SocialPlayer | null = null;
  private viewerId: string | null = null;

  constructor(opts: SocialControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
  }

  /**
   * Load the social region for a profile.
   *
   * `viewerId` is null for a signed-out visitor, which is a real state rather
   * than an error: followers are public, so the lists load and only the actions
   * are withheld.
   */
  async load(subject: SocialPlayer, viewerId: string | null): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.subject = subject;
    this.viewerId = viewerId;
    const isSelf = viewerId !== null && viewerId === subject.id;

    try {
      const connections = await this.loadConnections(subject.id);
      if (!this.isCurrent(generation)) return;
      this.callbacks.onConnections(connections);

      if (viewerId === null) {
        this.callbacks.onRelationship(null);
        this.callbacks.onSelfSocial(null);
        return;
      }

      const [incoming, outgoing, blocks, following] = await Promise.all([
        this.client.social.incomingRequests({ limit: RELATIONSHIP_SCAN_LIMIT }),
        this.client.social.outgoingRequests({ limit: RELATIONSHIP_SCAN_LIMIT }),
        this.client.social.blocks({ limit: RELATIONSHIP_SCAN_LIMIT }),
        this.client.social.following(viewerId, { limit: RELATIONSHIP_SCAN_LIMIT }),
      ]);
      if (!this.isCurrent(generation)) return;

      if (isSelf) {
        // Your own profile answers "what is waiting for me", not "what is my
        // relationship to myself" — so the relationship block is withheld
        // entirely rather than rendered as a row of disabled controls.
        this.callbacks.onRelationship(null);
        const friends = await this.client.social.friends({ limit: RELATIONSHIP_SCAN_LIMIT });
        if (!this.isCurrent(generation)) return;
        this.callbacks.onSelfSocial(
          await this.buildSelfSocial(incoming.items, outgoing.items, friends.items, blocks.items, viewerId),
        );
        return;
      }

      this.callbacks.onSelfSocial(null);
      this.callbacks.onRelationship({
        following: following.items.some((edge) => edge.followeeId === subject.id),
        blocked: blocks.items.some((edge) => edge.blockedId === subject.id),
        incomingRequestId:
          incoming.items.find((r) => r.status === 'pending' && r.requesterId === subject.id)?.id ?? null,
        outgoingRequestId:
          outgoing.items.find((r) => r.status === 'pending' && r.addresseeId === subject.id)?.id ?? null,
      });
    } catch (err) {
      if (this.isCurrent(generation)) this.fail(err);
    }
  }

  // --- Actions ---------------------------------------------------------------

  follow(): Promise<void> {
    return this.act((id) => this.client.social.follow(id));
  }

  unfollow(): Promise<void> {
    return this.act((id) => this.client.social.unfollow(id));
  }

  sendFriendRequest(): Promise<void> {
    return this.act((id) => this.client.social.sendFriendRequest(id));
  }

  block(): Promise<void> {
    return this.act((id) => this.client.social.block(id));
  }

  /** Unblock a player named explicitly — used from the viewer's own block list. */
  unblock(playerId: string): Promise<void> {
    return this.act(() => this.client.social.unblock(playerId));
  }

  /** Unblock whoever's profile is open, for the action bar on their page. */
  unblockSubject(): Promise<void> {
    return this.act((subjectId) => this.client.social.unblock(subjectId));
  }

  respond(requestId: string, action: FriendRequestAction): Promise<void> {
    return this.act(() => this.client.social.respondToFriendRequest(requestId, action));
  }

  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
    this.subject = null;
    this.viewerId = null;
  }

  dispose(): void {
    this.disposed = true;
  }

  /**
   * Run a write, then reload so the view reflects what the server actually did.
   *
   * Reloading rather than patching local state is deliberate: a follow can be
   * refused by a block the viewer cannot see, and a request can be accepted from
   * the other side between render and click. The server's answer is the only one
   * worth showing.
   */
  private async act(operation: (subjectId: string) => Promise<unknown>): Promise<void> {
    const subject = this.subject;
    const viewerId = this.viewerId;
    if (this.disposed || subject === null || viewerId === null || this.busy) return;

    const generation = this.requestGeneration;
    this.setBusy(true);
    try {
      await operation(subject.id);
      // `reset()` runs on sign-out and bumps the generation. Reloading anyway
      // would repaint the region the bootstrap just cleared — putting one
      // account's relationships back on screen after they signed out, which is
      // the disclosure that clear exists to prevent.
      if (this.disposed || this.requestGeneration !== generation) return;
      await this.load(subject, viewerId);
    } catch (err) {
      if (!this.disposed && this.requestGeneration === generation) this.fail(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async loadConnections(subjectId: string): Promise<Connections> {
    const [followers, following] = await Promise.all([
      this.client.social.followers(subjectId, { limit: CONNECTION_PAGE_LIMIT }),
      this.client.social.following(subjectId, { limit: CONNECTION_PAGE_LIMIT }),
    ]);

    const followerIds = followers.items.map((edge) => edge.followerId);
    const followingIds = following.items.map((edge) => edge.followeeId);
    const names = await this.client.graphql.resolvePlayers([...followerIds, ...followingIds]);

    return {
      followerCount: followers.total,
      followingCount: following.total,
      followers: namedPage(followers.total, followerIds, names).items,
      following: namedPage(following.total, followingIds, names).items,
      // Only claim names are unavailable when a request actually failed. With
      // no ids to resolve nothing is asked, so `available` stays undecided —
      // reading that as "disabled" would show the explanatory note on an empty
      // profile that has nothing to name in the first place.
      named: this.client.graphql.available !== false,
    };
  }

  private async buildSelfSocial(
    incoming: readonly FriendRequest[],
    outgoing: readonly FriendRequest[],
    friendIds: readonly string[],
    blocks: readonly { readonly blockedId: string }[],
    viewerId: string,
  ): Promise<SelfSocial> {
    const pendingIn = incoming.filter((r) => r.status === 'pending');
    const pendingOut = outgoing.filter((r) => r.status === 'pending');
    const blockedIds = blocks.map((edge) => edge.blockedId);

    const names = await this.client.graphql.resolvePlayers([
      ...pendingIn.map((r) => r.requesterId),
      ...pendingOut.map((r) => r.addresseeId),
      ...friendIds,
      ...blockedIds,
    ]);

    const nameOf = (id: string): SocialPlayer => names.get(id) ?? { id, handle: shortId(id) };

    return {
      incoming: pendingIn.map((request) => ({ request, player: nameOf(request.requesterId) })),
      outgoing: pendingOut.map((request) => ({ request, player: nameOf(request.addresseeId) })),
      // A friendship is a pair; the endpoint answers with the other party, but
      // guard anyway so the viewer never appears in their own friends list.
      friends: friendIds.filter((id) => id !== viewerId).map(nameOf),
      blocked: blockedIds.map(nameOf),
    };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.callbacks.onBusy(busy);
  }

  private fail(err: unknown): void {
    this.callbacks.onError(err instanceof Error ? err.message : String(err));
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}

/** The relationship shown before anything has loaded. */
export { EMPTY_RELATIONSHIP };
