import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamAction, membershipOf, actionExplanation } from '../src/app/teams-helpers.js';
import type { TeamMembership, TeamView } from '../src/api/models.js';

function team(visibility: 'public' | 'private'): TeamView {
  return {
    id: 't1',
    slug: 'city-chess',
    name: 'City Chess',
    description: 'A club',
    visibility,
    // Deliberately someone who is NOT in the member list below: the creator is not necessarily the
    // current owner, and nothing may key off this field.
    createdBy: 'u-founder',
    createdAt: '2026-08-04T00:00:00Z',
  };
}

function member(playerId: string, role: 'owner' | 'admin' | 'member'): TeamMembership {
  return { teamId: 't1', playerId, role, joinedAt: '2026-08-04T00:00:00Z' };
}

test('a signed-out viewer is offered nothing and told why', () => {
  const action = teamAction(team('public'), [], null);
  assert.deepEqual(action, { kind: 'none', reason: 'signed-out' });
  assert.match(actionExplanation('signed-out'), /sign in/i);
});

test('a non-member can join a public team', () => {
  assert.deepEqual(teamAction(team('public'), [member('u-other', 'owner')], 'u-me'), { kind: 'join' });
});

test('a non-member is not offered join on a private team', () => {
  // POST /v1/teams/:id/members answers 403 for a private team, so a Join button here would
  // always fail. Join requests are a separate feature that does not exist yet.
  const action = teamAction(team('private'), [member('u-other', 'owner')], 'u-me');
  assert.deepEqual(action, { kind: 'none', reason: 'by-request' });
  assert.match(actionExplanation('by-request'), /request/i);
});

test('an ordinary member can leave, on a public or a private team', () => {
  const members = [member('u-other', 'owner'), member('u-me', 'member')];
  assert.deepEqual(teamAction(team('public'), members, 'u-me'), { kind: 'leave' });
  // Membership is checked before visibility: being in a private team still lets you out of it.
  assert.deepEqual(teamAction(team('private'), members, 'u-me'), { kind: 'leave' });
});

test('an admin can leave like any other member', () => {
  const members = [member('u-other', 'owner'), member('u-me', 'admin')];
  assert.deepEqual(teamAction(team('public'), members, 'u-me'), { kind: 'leave' });
});

test('the owner is not offered leave, and ownership is read from the membership not createdBy', () => {
  // DELETE answers 409 for the owner until ownership is transferred. `createdBy` is 'u-founder'
  // here while the actual owner is 'u-me', so a check against createdBy would offer Leave to the
  // one person the server refuses.
  const members = [member('u-me', 'owner'), member('u-founder', 'member')];
  assert.deepEqual(teamAction(team('public'), members, 'u-me'), { kind: 'none', reason: 'owner' });
  assert.match(actionExplanation('owner'), /transfer/i);

  // And the founder, now a plain member, can leave.
  assert.deepEqual(teamAction(team('public'), members, 'u-founder'), { kind: 'leave' });
});

test('membershipOf finds the viewer and returns null when absent or signed out', () => {
  const members = [member('u-a', 'owner'), member('u-b', 'member')];
  assert.equal(membershipOf(members, 'u-b')?.role, 'member');
  assert.equal(membershipOf(members, 'u-c'), null);
  assert.equal(membershipOf(members, null), null);
});
