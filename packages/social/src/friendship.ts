import { SocialRuleError } from './errors';
import { compareRecentThenId } from './ordering';
import { normalizePair, type PlayerId } from './relation';

/**
 * The lifecycle of a friend request.
 *
 * `declined`, `cancelled` and `ended` are all terminal, but they are kept distinct because they
 * answer different questions after the fact: the addressee said no, the requester withdrew, or the
 * friendship existed and was later torn down by a block. Collapsing the last into `declined` would
 * make the history claim the addressee refused a request they had in fact accepted.
 */
export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'ended';

export interface FriendRequest {
  readonly id: string;
  readonly requesterId: PlayerId;
  readonly addresseeId: PlayerId;
  readonly status: FriendRequestStatus;
  readonly createdAt: Date;
  readonly respondedAt?: Date;
}

export type FriendRequestAction = 'accept' | 'decline' | 'cancel';

interface FriendRequestTransition {
  readonly nextStatus: FriendRequestStatus;
  /** Which side of the request is entitled to take this action. */
  readonly authorizedActor: 'requester' | 'addressee';
}

/**
 * Who may take each action and what it produces, in one table.
 *
 * Keeping the authority rule and the resulting status together is deliberate. When they lived in
 * separate `if`/ternary chains, an action matching neither chain skipped the authority check *and*
 * fell through to `cancelled` — so an unrecognised string cancelled someone else's request with no
 * check at all. A lookup has nowhere to fall through to.
 */
const TRANSITIONS = {
  accept: { nextStatus: 'accepted', authorizedActor: 'addressee' },
  decline: { nextStatus: 'declined', authorizedActor: 'addressee' },
  cancel: { nextStatus: 'cancelled', authorizedActor: 'requester' },
} satisfies Record<FriendRequestAction, FriendRequestTransition>;

/**
 * Applies an action (accept, decline, cancel) to a friend request, returning a new request object
 * and never mutating the input. Rules are enforced in this order:
 *
 * 1. Unrecognised action => `invalid_transition`. TypeScript already excludes this, but the value
 *    arrives from a request body once increment 2 lands a REST route, and a cast or a JavaScript
 *    caller crosses that boundary unchecked. Authorization must not depend on the type system.
 * 2. `request.status !== 'pending'` => `invalid_transition`. All other statuses are terminal;
 *    `terminateFriendship` is the only way out of `accepted`.
 * 3. Actor authority => `not_authorized`.
 * 4. On success, set the new status and `respondedAt: at`.
 */
export function applyFriendRequestAction(
  request: FriendRequest,
  action: FriendRequestAction,
  actorId: PlayerId,
  at: Date
): FriendRequest {
  // `Object.hasOwn`, not a plain lookup: `TRANSITIONS['toString']` returns an inherited function
  // from Object.prototype, which is not undefined, so a bare existence check would wave through
  // 'toString', 'constructor' and '__proto__' with an undefined authorizedActor.
  // The cast is widening on purpose — the declared type says this is always a valid action, and the
  // whole point of the check is that an untrusted caller can make that false.
  const transition: FriendRequestTransition | undefined = Object.hasOwn(TRANSITIONS, action)
    ? (TRANSITIONS as Record<string, FriendRequestTransition>)[action]
    : undefined;

  if (transition === undefined) {
    throw new SocialRuleError(
      'invalid_transition',
      `Unknown friend request action '${String(action)}'`
    );
  }

  if (request.status !== 'pending') {
    throw new SocialRuleError(
      'invalid_transition',
      `Cannot apply action '${action}' to a friend request in '${request.status}' status`
    );
  }

  const authorizedId =
    transition.authorizedActor === 'addressee' ? request.addresseeId : request.requesterId;
  if (actorId !== authorizedId) {
    throw new SocialRuleError(
      'not_authorized',
      `Only the ${transition.authorizedActor} (${authorizedId}) can ${action} this friend request`
    );
  }

  return {
    ...request,
    status: transition.nextStatus,
    respondedAt: at,
  };
}

/**
 * Whether a request concerns this unordered pair of players, in either direction.
 *
 * "The same two people" is asked in three places — checking friendship, rejecting a duplicate
 * request, and tearing relations down on a block — and each of those got its own hand-written
 * pair of `===` comparisons before this existed. One of them only had to be inverted once to make
 * a block silently spare the friendship it was supposed to end.
 */
export function involvesPair(request: FriendRequest, a: PlayerId, b: PlayerId): boolean {
  const [low, high] = normalizePair(a, b);
  const [requestLow, requestHigh] = normalizePair(request.requesterId, request.addresseeId);
  return requestLow === low && requestHigh === high;
}

/**
 * Ends an accepted friendship.
 *
 * Deliberately NOT a `FriendRequestAction`: no party requests it, and it is the only transition out
 * of a state the action state machine treats as terminal. It lives here rather than in the
 * repository so that every status transition this package permits is defined in one file — a
 * repository that assembled the `ended` record itself would be writing around the state machine,
 * and the next such shortcut would not be reviewed against these rules at all.
 */
export function terminateFriendship(request: FriendRequest, at: Date): FriendRequest {
  if (request.status !== 'accepted') {
    throw new SocialRuleError(
      'invalid_transition',
      `Only an accepted friendship can be ended; this request is '${request.status}'`
    );
  }

  return { ...request, status: 'ended', respondedAt: at };
}

/**
 * Returns true iff some request between the pair (in either direction) has status 'accepted'.
 * Uses normalizePair so the answer cannot depend on the order the two ids are asked in.
 */
export function areFriends(
  a: PlayerId,
  b: PlayerId,
  requests: readonly FriendRequest[]
): boolean {
  if (a === b) {
    return false;
  }

  return requests.some((req) => req.status === 'accepted' && involvesPair(req, a, b));
}

/**
 * Returns the counterpart player ID of every accepted request involving the player,
 * newest-accepted first (by respondedAt ?? createdAt DESC), with counterpart ID ASC as tie-break.
 */
export function friendsOf(
  playerId: PlayerId,
  requests: readonly FriendRequest[]
): readonly PlayerId[] {
  const accepted = requests.filter(
    (req) =>
      req.status === 'accepted' &&
      (req.requesterId === playerId || req.addresseeId === playerId)
  );

  const items = accepted.map((req) => {
    const counterpartId = req.requesterId === playerId ? req.addresseeId : req.requesterId;
    const timestamp = req.respondedAt ?? req.createdAt;
    return { counterpartId, timestamp };
  });

  items.sort((a, b) =>
    compareRecentThenId(a.timestamp, a.counterpartId, b.timestamp, b.counterpartId)
  );

  return items.map((item) => item.counterpartId);
}

/**
 * Returns pending incoming friend requests for playerId,
 * newest first by createdAt + requesterId ASC tie-break.
 */
export function pendingIncoming(
  playerId: PlayerId,
  requests: readonly FriendRequest[]
): readonly FriendRequest[] {
  return requests
    .filter((req) => req.addresseeId === playerId && req.status === 'pending')
    .sort((a, b) => compareRecentThenId(a.createdAt, a.requesterId, b.createdAt, b.requesterId));
}

/**
 * Returns pending outgoing friend requests for playerId,
 * newest first by createdAt + addresseeId ASC tie-break.
 */
export function pendingOutgoing(
  playerId: PlayerId,
  requests: readonly FriendRequest[]
): readonly FriendRequest[] {
  return requests
    .filter((req) => req.requesterId === playerId && req.status === 'pending')
    .sort((a, b) => compareRecentThenId(a.createdAt, a.addresseeId, b.createdAt, b.addresseeId));
}
