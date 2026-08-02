import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SocialController } from '../src/app/social-controller.js';
import type { Connections, Relationship, SelfSocial } from '../src/app/social-controller.js';
import type { BlockEdge, FollowEdge, FriendRequest, SocialPlayer } from '../src/api/models.js';

const VIEWER = 'viewer-id';
const SUBJECT: SocialPlayer = { id: 'subject-id', handle: 'subject' };

function followEdge(followerId: string, followeeId: string): FollowEdge {
  return { followerId, followeeId, followedAt: '2026-01-01T00:00:00Z' };
}

function request(overrides: Partial<FriendRequest> = {}): FriendRequest {
  return {
    id: 'req-1',
    requesterId: 'other',
    addresseeId: VIEWER,
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    respondedAt: null,
    ...overrides,
  };
}

function blockEdge(blockedId: string): BlockEdge {
  return { blockerId: VIEWER, blockedId, blockedAt: '2026-01-01T00:00:00Z' };
}

interface FakeState {
  followers?: FollowEdge[];
  following?: FollowEdge[];
  viewerFollowing?: FollowEdge[];
  incoming?: FriendRequest[];
  outgoing?: FriendRequest[];
  friends?: string[];
  blocks?: BlockEdge[];
  /** null models the read layer being switched off. */
  names?: Map<string, SocialPlayer> | null;
}

interface FakeCalls {
  readonly writes: string[];
  readonly loads: number;
}

function makeClient(state: FakeState = {}) {
  const writes: string[] = [];
  let loads = 0;
  let reachable: boolean | null = null;
  const client = {
    social: {
      followers: async (playerId: string) => {
        loads += 1;
        const items = state.followers ?? [];
        return { total: items.length, items };
      },
      following: async (playerId: string) => {
        // The viewer's own following list is what the relationship is derived
        // from, so it must be distinguishable from the subject's.
        const items = playerId === VIEWER ? (state.viewerFollowing ?? []) : (state.following ?? []);
        return { total: items.length, items };
      },
      incomingRequests: async () => {
        const items = state.incoming ?? [];
        return { total: items.length, items };
      },
      outgoingRequests: async () => {
        const items = state.outgoing ?? [];
        return { total: items.length, items };
      },
      friends: async () => {
        const items = state.friends ?? [];
        return { total: items.length, items };
      },
      blocks: async () => {
        const items = state.blocks ?? [];
        return { total: items.length, items };
      },
      follow: async (id: string) => { writes.push(`follow:${id}`); return followEdge(VIEWER, id); },
      unfollow: async (id: string) => { writes.push(`unfollow:${id}`); },
      sendFriendRequest: async (id: string) => { writes.push(`request:${id}`); return request(); },
      respondToFriendRequest: async (id: string, action: string) => {
        writes.push(`respond:${id}:${action}`);
        return request({ id });
      },
      block: async (id: string) => { writes.push(`block:${id}`); return blockEdge(id); },
      unblock: async (id: string) => { writes.push(`unblock:${id}`); },
    },
    // Mirrors GraphQLApi's latching: `available` starts undecided and is only
    // settled by a request that actually runs. An empty id list issues no
    // query, so it must leave the answer null — a fake that hard-codes `true`
    // here cannot tell "untried" from "reachable" and silently passes the test
    // for the empty-profile note.
    graphql: {
      get available(): boolean | null {
        return reachable;
      },
      resolvePlayers: async (ids: readonly string[]) => {
        const out = new Map<string, SocialPlayer>();
        if (ids.length === 0) return out;
        if (state.names === null) {
          reachable = false;
          return out;
        }
        reachable = true;
        for (const id of ids) {
          out.set(id, state.names?.get(id) ?? { id, handle: `name-${id}` });
        }
        return out;
      },
    },
  };
  const calls: FakeCalls = {
    get writes() { return writes; },
    get loads() { return loads; },
  } as FakeCalls;
  return { client, calls };
}

interface Captured {
  connections: Connections | null;
  relationship: Relationship | null;
  relationshipCalls: number;
  self: SelfSocial | null;
  selfCalls: number;
  busy: boolean[];
  errors: string[];
}

function makeController(state: FakeState = {}) {
  const { client, calls } = makeClient(state);
  const captured: Captured = {
    connections: null,
    relationship: null,
    relationshipCalls: 0,
    self: null,
    selfCalls: 0,
    busy: [],
    errors: [],
  };
  const controller = new SocialController({
    client: client as never,
    callbacks: {
      onConnections: (c) => { captured.connections = c; },
      onRelationship: (r) => { captured.relationship = r; captured.relationshipCalls += 1; },
      onSelfSocial: (s) => { captured.self = s; captured.selfCalls += 1; },
      onBusy: (b) => { captured.busy.push(b); },
      onError: (m) => { captured.errors.push(m); },
    },
  });
  return { controller, captured, calls };
}

test('resolves follower and following ids to handles', async () => {
  const { controller, captured } = makeController({
    followers: [followEdge('f1', SUBJECT.id), followEdge('f2', SUBJECT.id)],
    following: [followEdge(SUBJECT.id, 'g1')],
  });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.connections?.followerCount, 2);
  assert.equal(captured.connections?.followingCount, 1);
  assert.deepEqual(captured.connections?.followers.map((p) => p.handle), ['name-f1', 'name-f2']);
  assert.deepEqual(captured.connections?.following.map((p) => p.handle), ['name-g1']);
  assert.equal(captured.connections?.named, true);
  assert.deepEqual(captured.errors, []);
});

test('falls back to truncated ids when the read layer is unavailable', async () => {
  const longId = '01890000-0000-7000-8000-000000000000';
  const { controller, captured } = makeController({
    followers: [followEdge(longId, SUBJECT.id)],
    names: null,
  });

  await controller.load(SUBJECT, VIEWER);

  // The page must still render: a disabled feature flag degrades the names, not
  // the view. `named: false` is what drives the explanatory note in the UI.
  assert.equal(captured.connections?.named, false);
  assert.equal(captured.connections?.followers[0]?.handle, '01890000…');
  assert.deepEqual(captured.errors, []);
});

test('derives following state from the viewer own following list', async () => {
  const { controller, captured } = makeController({
    viewerFollowing: [followEdge(VIEWER, SUBJECT.id)],
  });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.relationship?.following, true);
});

test('reports not following when the viewer follows someone else', async () => {
  const { controller, captured } = makeController({
    viewerFollowing: [followEdge(VIEWER, 'unrelated')],
  });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.relationship?.following, false);
});

test('surfaces a pending incoming request from the subject', async () => {
  const { controller, captured } = makeController({
    incoming: [request({ id: 'in-1', requesterId: SUBJECT.id, addresseeId: VIEWER })],
  });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.relationship?.incomingRequestId, 'in-1');
  assert.equal(captured.relationship?.outgoingRequestId, null);
});

test('ignores requests that are no longer pending', async () => {
  const { controller, captured } = makeController({
    incoming: [request({ id: 'in-1', requesterId: SUBJECT.id, status: 'declined' })],
    outgoing: [request({ id: 'out-1', addresseeId: SUBJECT.id, requesterId: VIEWER, status: 'cancelled' })],
  });

  await controller.load(SUBJECT, VIEWER);

  // A declined or cancelled request must not offer Accept/Cancel controls that
  // the server would refuse.
  assert.equal(captured.relationship?.incomingRequestId, null);
  assert.equal(captured.relationship?.outgoingRequestId, null);
});

test('reports a block on the subject', async () => {
  const { controller, captured } = makeController({ blocks: [blockEdge(SUBJECT.id)] });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.relationship?.blocked, true);
});

test('withholds actions from a signed-out visitor but still loads the lists', async () => {
  const { controller, captured } = makeController({
    followers: [followEdge('f1', SUBJECT.id)],
  });

  await controller.load(SUBJECT, null);

  assert.equal(captured.connections?.followerCount, 1);
  // null relationship is what empties the action bar; an empty object would
  // render a full row of controls that cannot work.
  assert.equal(captured.relationship, null);
  assert.equal(captured.self, null);
});

test('shows the viewer own pending requests, friends and blocks on their own profile', async () => {
  const self: SocialPlayer = { id: VIEWER, handle: 'viewer' };
  const { controller, captured } = makeController({
    incoming: [request({ id: 'in-1', requesterId: 'a', addresseeId: VIEWER })],
    outgoing: [request({ id: 'out-1', requesterId: VIEWER, addresseeId: 'b' })],
    friends: ['c', VIEWER],
    blocks: [blockEdge('d')],
  });

  await controller.load(self, VIEWER);

  assert.equal(captured.relationship, null, 'own profile offers no relationship controls');
  assert.equal(captured.self?.incoming.length, 1);
  assert.equal(captured.self?.incoming[0]?.player.handle, 'name-a');
  assert.equal(captured.self?.outgoing.length, 1);
  assert.equal(captured.self?.outgoing[0]?.player.handle, 'name-b');
  assert.equal(captured.self?.blocked[0]?.handle, 'name-d');
  // The viewer must never appear in their own friends list.
  assert.deepEqual(captured.self?.friends.map((p) => p.id), ['c']);
});

test('a write reloads from the server rather than patching local state', async () => {
  const { controller, calls } = makeController({});
  await controller.load(SUBJECT, VIEWER);
  const loadsAfterInitial = calls.loads;

  await controller.follow();

  assert.deepEqual(calls.writes, [`follow:${SUBJECT.id}`]);
  // Reloading is what makes a refused follow (an unseen block, a race) visible.
  assert.ok(calls.loads > loadsAfterInitial, 'follow did not reload the view');
});

test('unblockSubject unblocks the profile on screen, not an empty id', async () => {
  const { controller, calls } = makeController({ blocks: [blockEdge(SUBJECT.id)] });
  await controller.load(SUBJECT, VIEWER);

  await controller.unblockSubject();

  assert.deepEqual(calls.writes, [`unblock:${SUBJECT.id}`]);
});

test('reports busy around a write so controls can disable', async () => {
  const { controller, captured } = makeController({});
  await controller.load(SUBJECT, VIEWER);
  captured.busy.length = 0;

  await controller.follow();

  assert.deepEqual(captured.busy, [true, false]);
});

test('a stale load cannot overwrite a newer one', async () => {
  const { client } = makeClient({});
  // The first request hangs until released, so the second one finishes first —
  // the ordering that makes a missing generation guard visible. Each subject
  // answers with a different count so the two results are distinguishable; with
  // identical fixtures this test would pass with or without the guard.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let call = 0;
  client.social.followers = async (playerId: string) => {
    call += 1;
    if (call === 1) await gate;
    const items = playerId === SUBJECT.id ? [followEdge('f1', SUBJECT.id)] : [];
    return { total: items.length, items };
  };

  let connections: Connections | null = null;
  const controller = new SocialController({
    client: client as never,
    callbacks: {
      onConnections: (c) => { connections = c; },
      onRelationship: () => {},
      onSelfSocial: () => {},
      onBusy: () => {},
      onError: () => {},
    },
  });

  const stale = controller.load(SUBJECT, VIEWER);
  const fresh = controller.load({ id: 'other-id', handle: 'other' }, VIEWER);
  await fresh;
  release();
  await stale;

  // The abandoned profile's response arrives last and must be discarded.
  // Without the guard it repaints the page for a profile the user already left.
  assert.equal((connections as Connections | null)?.followerCount, 0);
});

test('reports an error without throwing when a list fails', async () => {
  const { client } = makeClient({});
  client.social.followers = async () => {
    throw new Error('network down');
  };
  const errors: string[] = [];
  const controller = new SocialController({
    client: client as never,
    callbacks: {
      onConnections: () => {},
      onRelationship: () => {},
      onSelfSocial: () => {},
      onBusy: () => {},
      onError: (m) => { errors.push(m); },
    },
  });

  await controller.load(SUBJECT, VIEWER);

  assert.deepEqual(errors, ['network down']);
});

test('does nothing after dispose', async () => {
  const { controller, captured, calls } = makeController({});
  controller.dispose();

  await controller.load(SUBJECT, VIEWER);
  await controller.follow();

  assert.equal(captured.connections, null);
  assert.deepEqual(calls.writes, []);
});

test('a write after reset does not repaint the cleared region', async () => {
  const { controller, captured, calls } = makeController({
    followers: [followEdge('f1', SUBJECT.id)],
  });
  await controller.load(SUBJECT, VIEWER);
  captured.connections = null;

  // reset() is what sign-out calls. A write already in flight must not put the
  // previous account's relationships back on screen once it lands.
  const write = controller.follow();
  controller.reset();
  await write;

  assert.deepEqual(calls.writes, [`follow:${SUBJECT.id}`]);
  assert.equal(captured.connections, null, 'the cleared region was repainted after reset');
});

test('an empty profile does not claim the read layer is disabled', async () => {
  // Nothing to resolve means no query runs, so availability stays undecided.
  // Reading that as "disabled" would show the explanatory note on a profile
  // that simply has no followers — the common case on a new account.
  const { controller, captured } = makeController({ followers: [], following: [] });

  await controller.load(SUBJECT, VIEWER);

  assert.equal(captured.connections?.followerCount, 0);
  assert.equal(captured.connections?.named, true);
});
