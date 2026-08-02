/**
 * The GraphQL read path (ADR-0073).
 *
 * This exists for one reason the REST surface cannot cover: **the social lists
 * return bare player ids, and REST has no id-to-handle lookup.** `/v1/users/:handle`
 * goes the other way. So `player(id:)` here is the only route from a follower id
 * to a name a human can read, which is also why `connections` fetches followers,
 * following, and their handles in a single round trip rather than one request
 * per row.
 *
 * The endpoint is opt-in (`GRAPHQL_ENABLED=1`) and answers 503 when it is off.
 * A feature flag being unset must not blank the profile page, so every method
 * here returns `null` — never throws — when the layer is unreachable, and the
 * caller renders what it still has. `available` latches that answer so one
 * request settles it for the page rather than every list retrying a dead route.
 */

import type { Execute } from './client.js';
import type { SocialConnections, SocialPage, SocialPlayer } from './models.js';

/**
 * Aliases per request. The server rejects a query using more than 50 aliases
 * before it resolves anything, and each `player` field also costs 10 against a
 * complexity budget of 1000. Twenty keeps both bounds comfortable and still
 * turns a page of ids into one request.
 */
const MAX_ALIASES_PER_REQUEST = 20;

/** The GraphQL response envelope; `errors` are per-field and may accompany data. */
interface GraphQLResponse<T> {
  readonly data?: T | null;
  readonly errors?: readonly { readonly message: string }[];
}

interface ConnectionsData {
  readonly player: {
    readonly followers: readonly { readonly follower: SocialPlayer | null }[];
    readonly following: readonly { readonly followee: SocialPlayer | null }[];
  } | null;
}

const CONNECTIONS_QUERY = `query Connections($id: ID!, $limit: Int) {
  player(id: $id) {
    followers(limit: $limit) { follower { id handle } }
    following(limit: $limit) { followee { id handle } }
  }
}`;

export class GraphQLApi {
  private readonly execute: Execute;
  /** `null` until the first call settles whether the endpoint is reachable. */
  private reachable: boolean | null = null;

  constructor(execute: Execute) {
    this.execute = execute;
  }

  /** Whether the layer answered at least once; `null` before anything was tried. */
  get available(): boolean | null {
    return this.reachable;
  }

  /**
   * Followers and following with display names, in one request.
   *
   * Returns `null` when the read layer is unavailable. The counts in the UI come
   * from REST regardless, so a `null` here degrades the *names*, not the page.
   */
  async connections(playerId: string, limit: number): Promise<SocialConnections | null> {
    const data = await this.query<ConnectionsData>(CONNECTIONS_QUERY, { id: playerId, limit });
    if (data?.player == null) return null;

    const followers = data.player.followers.map((e) => e.follower).filter(isPlayer);
    const following = data.player.following.map((e) => e.followee).filter(isPlayer);
    return {
      followers: { total: followers.length, items: followers },
      following: { total: following.length, items: following },
    };
  }

  /**
   * Resolve player ids to handles, batched under the alias limit.
   *
   * Ids that name nobody — or that the read layer refuses — are simply absent
   * from the map. That is the same answer the repository gives, and it lets the
   * caller fall back to showing the id for exactly the rows it could not name,
   * rather than failing the whole list.
   */
  async resolvePlayers(ids: readonly string[]): Promise<ReadonlyMap<string, SocialPlayer>> {
    const resolved = new Map<string, SocialPlayer>();
    const distinct = [...new Set(ids)];

    for (let i = 0; i < distinct.length; i += MAX_ALIASES_PER_REQUEST) {
      const chunk = distinct.slice(i, i + MAX_ALIASES_PER_REQUEST);
      const fields = chunk
        .map((_, index) => `p${index}: player(id: $id${index}) { id handle }`)
        .join('\n  ');
      const declarations = chunk.map((_, index) => `$id${index}: ID!`).join(', ');
      const variables: Record<string, unknown> = {};
      chunk.forEach((id, index) => {
        variables[`id${index}`] = id;
      });

      const data = await this.query<Record<string, SocialPlayer | null>>(
        `query Players(${declarations}) {\n  ${fields}\n}`,
        variables,
      );
      if (data === null) return resolved;
      for (const value of Object.values(data)) {
        if (isPlayer(value)) resolved.set(value.id, value);
      }
    }

    return resolved;
  }

  /**
   * Run a query, converting every failure into `null`.
   *
   * A 503 means the flag is off; a 400 means this client and the server disagree
   * about the schema. Neither is something a profile page can act on, and both
   * should leave the rest of the page working — so they are recorded as
   * "unavailable" rather than propagated.
   */
  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    if (this.reachable === false) return null;
    try {
      const response = await this.execute<GraphQLResponse<T>>({
        method: 'POST',
        path: '/v1/graphql',
        body: { query, variables },
        auth: 'optional',
      });
      this.reachable = true;
      return response.data ?? null;
    } catch {
      this.reachable = false;
      return null;
    }
  }
}

function isPlayer(value: SocialPlayer | null | undefined): value is SocialPlayer {
  return value != null && typeof value.id === 'string' && typeof value.handle === 'string';
}

/** Page a resolved-name list the same way the REST lists report themselves. */
export function namedPage(
  total: number,
  ids: readonly string[],
  names: ReadonlyMap<string, SocialPlayer>,
): SocialPage<SocialPlayer> {
  return {
    total,
    items: ids.map((id) => names.get(id) ?? { id, handle: shortId(id) }),
  };
}

/**
 * The stand-in shown when a name could not be resolved. A truncated id is not a
 * good label, but it is honest and stable — and it only appears when the read
 * layer is off, which is a deployment state, not a user error.
 */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
