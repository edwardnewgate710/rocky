/**
 * Pure helpers for the Teams UI.
 *
 * The only interesting decision this feature makes is which action to offer on a team page, and
 * every wrong answer produces a button the server rejects. The rules come from the route
 * definitions in `packages/api/src/routes.ts`:
 *
 * - joining a private team answers 403 (join requests are a separate, unbuilt feature)
 * - joining twice answers 409
 * - the owner leaving answers 409 until ownership is transferred
 *
 * Ownership is read from the viewer's own membership row, never from `team.createdBy` — ownership
 * transfers, and the creator is not necessarily the current owner.
 */
import type { TeamMembership, TeamView } from '../api/models.js';

/**
 * What the team page offers the viewer.
 *
 * `none` carries a reason so the page can explain itself instead of silently showing nothing —
 * "joining is by request" and "sign in to join" are very different dead ends for a user.
 */
export type TeamAction =
  | { readonly kind: 'join' }
  | { readonly kind: 'leave' }
  | { readonly kind: 'none'; readonly reason: 'signed-out' | 'by-request' | 'owner' };

/** Find the viewer's membership row, or null when they are not a member. */
export function membershipOf(
  members: readonly TeamMembership[],
  viewerId: string | null,
): TeamMembership | null {
  if (viewerId === null) return null;
  return members.find((m) => m.playerId === viewerId) ?? null;
}

/**
 * Decide which action to offer. Order matters: membership is checked before visibility, because a
 * member of a private team can still leave it.
 */
export function teamAction(
  team: TeamView,
  members: readonly TeamMembership[],
  viewerId: string | null,
): TeamAction {
  if (viewerId === null) return { kind: 'none', reason: 'signed-out' };

  const membership = membershipOf(members, viewerId);
  if (membership !== null) {
    // The owner cannot leave without transferring ownership first, and transfer is not built yet.
    return membership.role === 'owner'
      ? { kind: 'none', reason: 'owner' }
      : { kind: 'leave' };
  }

  // Not a member. Only public teams can be joined directly.
  return team.visibility === 'public' ? { kind: 'join' } : { kind: 'none', reason: 'by-request' };
}

/** The sentence shown in place of an action, so a dead end always explains itself. */
export function actionExplanation(reason: 'signed-out' | 'by-request' | 'owner'): string {
  switch (reason) {
    case 'signed-out':
      return 'Sign in to join this team.';
    case 'by-request':
      return 'This team is private. Joining is by request, which is not available yet.';
    case 'owner':
      return 'You own this team. Transfer ownership before leaving.';
  }
}
