import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsController } from '../src/app/teams-controller.js';
import type { JoinRequestView, TeamMembership, TeamView } from '../src/api/models.js';

function makeTeam(id = 't1', slug = 'team-1', visibility: 'public' | 'private' = 'private'): TeamView {
  return {
    id,
    slug,
    name: 'Team 1',
    description: 'A team',
    visibility,
    createdBy: 'u-owner',
    createdAt: '2026-08-01T00:00:00Z',
  };
}

function makeMember(playerId: string, role: 'owner' | 'admin' | 'member'): TeamMembership {
  return { teamId: 't1', playerId, role, joinedAt: '2026-08-01T00:00:00Z' };
}

function makeJoinRequest(id = 'req-1', playerId = 'u-requester'): JoinRequestView {
  return {
    id,
    teamId: 't1',
    playerId,
    status: 'pending',
    createdAt: '2026-08-02T00:00:00Z',
    respondedAt: null,
  };
}

function createFakeClient(viewerId: string | null, members: TeamMembership[], joinReqs: JoinRequestView[] = []) {
  let joinRequestsCount = 0;
  let respondCalledWith: { teamId: string; requestId: string; status: 'accepted' | 'declined' } | null = null;

  const client = {
    session: {
      current: viewerId ? { user: { id: viewerId } } : null,
    },
    teams: {
      // Mirrors the server: `viewerRole` is resolved from the viewer's own membership, not from the
      // page of members the client happens to read.
      byId: async (idOrSlug: string) => ({
        ...makeTeam('t1', idOrSlug),
        viewerRole: (viewerId ? members.find((m) => m.playerId === viewerId)?.role : undefined) ?? null,
      }),
      members: async (_id: string) => ({ total: members.length, items: members }),
      joinRequests: async (_id: string, _opts?: { status?: string }) => {
        joinRequestsCount++;
        return { total: joinReqs.length, items: joinReqs };
      },
      respondToJoinRequest: async (teamId: string, requestId: string, status: 'accepted' | 'declined') => {
        respondCalledWith = { teamId, requestId, status };
        return makeJoinRequest(requestId);
      },
      list: async () => ({ total: 1, items: [makeTeam()] }),
      join: async () => makeMember('u-viewer', 'member'),
      leave: async () => {},
    },
    graphql: {
      resolvePlayers: async (ids: readonly string[]) => {
        const map = new Map();
        for (const id of ids) {
          map.set(id, { id, handle: `handle-${id}` });
        }
        return map;
      },
    },
  };

  return {
    client,
    get joinRequestsCount() {
      return joinRequestsCount;
    },
    get respondCalledWith() {
      return respondCalledWith;
    },
  };
}

test('non-admin viewer causes zero join-requests fetch', async () => {
  const members = [makeMember('u-owner', 'owner'), makeMember('u-member', 'member')];
  const fake = createFakeClient('u-member', members, [makeJoinRequest()]);

  let receivedRequests: readonly JoinRequestView[] | undefined;
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: (_team, _mems, _names, reqs) => {
        receivedRequests = reqs;
      },
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  await ctrl.loadTeam('team-1');
  assert.equal(fake.joinRequestsCount, 0, 'non-admin viewer must trigger NO join-requests fetch');
  assert.equal(receivedRequests, undefined, 'joinRequests callback param must be undefined for non-admin');
});

test('signed-out viewer causes zero join-requests fetch', async () => {
  const members = [makeMember('u-owner', 'owner')];
  const fake = createFakeClient(null, members, [makeJoinRequest()]);

  let receivedRequests: readonly JoinRequestView[] | undefined;
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: (_team, _mems, _names, reqs) => {
        receivedRequests = reqs;
      },
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  await ctrl.loadTeam('team-1');
  assert.equal(fake.joinRequestsCount, 0, 'signed-out viewer must trigger NO join-requests fetch');
  assert.equal(receivedRequests, undefined);
});

test('owner viewer fetches join-requests and receives them in callback', async () => {
  const members = [makeMember('u-owner', 'owner'), makeMember('u-member', 'member')];
  const req = makeJoinRequest('r1', 'u-req');
  const fake = createFakeClient('u-owner', members, [req]);

  let receivedRequests: readonly JoinRequestView[] | undefined;
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: (_team, _mems, _names, reqs) => {
        receivedRequests = reqs;
      },
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  await ctrl.loadTeam('team-1');
  assert.equal(fake.joinRequestsCount, 1, 'owner viewer must fetch join-requests');
  assert.equal(receivedRequests?.length, 1);
  assert.equal(receivedRequests?.[0]?.id, 'r1');
});

test('admin viewer fetches join-requests', async () => {
  const members = [makeMember('u-owner', 'owner'), makeMember('u-admin', 'admin')];
  const req = makeJoinRequest('r1', 'u-req');
  const fake = createFakeClient('u-admin', members, [req]);

  let receivedRequests: readonly JoinRequestView[] | undefined;
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: (_team, _mems, _names, reqs) => {
        receivedRequests = reqs;
      },
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  await ctrl.loadTeam('team-1');
  assert.equal(fake.joinRequestsCount, 1, 'admin viewer must fetch join-requests');
  assert.equal(receivedRequests?.length, 1);
});

test('respondToJoinRequest calls client and reloads team', async () => {
  const members = [makeMember('u-owner', 'owner')];
  const fake = createFakeClient('u-owner', members, [makeJoinRequest('r1')]);
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: () => {},
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  const res = await ctrl.respondToJoinRequest('t1', 'r1', 'accepted', 'team-1');
  assert.equal(res, true);
  assert.deepEqual(fake.respondCalledWith, { teamId: 't1', requestId: 'r1', status: 'accepted' });
});

test('respondToJoinRequest returns false and calls onError on failure', async () => {
  const members = [makeMember('u-owner', 'owner')];
  const req = makeJoinRequest('r1', 'u-req');
  const fake = createFakeClient('u-owner', members, [req]);
  fake.client.teams.respondToJoinRequest = async () => {
    throw new Error('409 Conflict: request no longer pending');
  };

  let teamError = '';
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: () => {},
      onLoading: () => {},
      onError: (msg) => {
        teamError = msg;
      },
      onNotFound: () => {},
    },
  });

  const ok = await ctrl.respondToJoinRequest('t1', 'r1', 'accepted', 'team-1');
  assert.equal(ok, false, 'respondToJoinRequest must return false on failure');
  assert.match(teamError, /409 Conflict/);
});

/**
 * The regression from the PR #93 review. `canModerate` was decided by searching `memberPage.items`,
 * which the server caps at 50 and sorts owner → admin → member. An admin sitting behind 50 other
 * admins is simply not on that page, so the moderation queue never loaded and the panel stayed
 * hidden — with no error and nothing to retry.
 *
 * The role now comes from the team detail response. The fake below reproduces the exact shape that
 * broke it: a members page that does **not** contain the viewer, while the server reports them as an
 * admin.
 */
test('an admin missing from the returned members page still gets the moderation queue', async () => {
  const otherAdmins = Array.from({ length: 50 }, (_, i) => makeMember(`u-admin-${i}`, 'admin'));
  const fake = createFakeClient('u-me', otherAdmins, [makeJoinRequest('r1', 'u-req')]);
  // The server says the viewer is an admin; the page of members it returned does not mention them.
  fake.client.teams.byId = async (idOrSlug: string) => ({
    ...makeTeam('t1', idOrSlug),
    viewerRole: 'admin' as const,
  });

  let receivedRequests: readonly JoinRequestView[] | undefined;
  const ctrl = new TeamsController({
    client: fake.client as any,
    callbacks: {
      onList: () => {},
      onTeam: (_team, _mems, _names, reqs) => {
        receivedRequests = reqs;
      },
      onLoading: () => {},
      onError: () => {},
      onNotFound: () => {},
    },
  });

  await ctrl.loadTeam('team-1');
  assert.equal(fake.joinRequestsCount, 1, 'an admin absent from the members page must still load the queue');
  assert.equal(receivedRequests?.length, 1);
});
