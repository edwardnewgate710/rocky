/**
 * Pure helpers for the team forum UI.
 *
 * As with the Teams action bar, the only decision worth isolating is which control a viewer is
 * offered, because every wrong answer renders a control the server refuses. The rules come from the
 * route definitions in `packages/api/src/routes.ts`:
 *
 * - `POST .../forum/threads` answers 403 "Only team members can create threads"
 * - `POST .../forum/threads/:id/posts` answers 403 "Only members can post or thread is locked"
 *
 * Membership is decided by `membershipOf` from `./teams-helpers.js` rather than a second check, so
 * the two surfaces cannot drift apart on who counts as a member.
 */
import { membershipOf } from './teams-helpers.js';
import type { ForumPost, ForumThread, TeamMembership } from '../api/models.js';

/** Whether a viewer may start a thread, and why not when they may not. */
export type ThreadStartAbility =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly reason: 'signed-out' | 'not-member' };

/** Whether a viewer may reply to a thread, and why not when they may not. */
export type ReplyAbility =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly reason: 'signed-out' | 'not-member' | 'locked' };

export function canStartThread(
  members: readonly TeamMembership[],
  viewerId: string | null,
): ThreadStartAbility {
  if (viewerId === null) return { kind: 'denied', reason: 'signed-out' };
  if (membershipOf(members, viewerId) === null) return { kind: 'denied', reason: 'not-member' };
  return { kind: 'allowed' };
}

export function canReply(
  thread: ForumThread,
  members: readonly TeamMembership[],
  viewerId: string | null,
): ReplyAbility {
  if (viewerId === null) return { kind: 'denied', reason: 'signed-out' };
  if (membershipOf(members, viewerId) === null) return { kind: 'denied', reason: 'not-member' };
  // Checked last so a member sees "locked" — the actionable reason — rather than a membership
  // message that is true but not why they are stuck.
  if (thread.locked) return { kind: 'denied', reason: 'locked' };
  return { kind: 'allowed' };
}

/** The sentence shown in place of a composer, so a dead end always explains itself. */
export function abilityExplanation(reason: 'signed-out' | 'not-member' | 'locked'): string {
  switch (reason) {
    case 'signed-out':
      return 'Sign in to take part in this forum.';
    case 'not-member':
      return 'Only team members can post here.';
    case 'locked':
      return 'This thread is locked. No new replies can be added.';
  }
}

/**
 * Thread order: pinned first, then most recently active.
 *
 * The API returns a page in its own order; pinning is a display promise the UI has to keep, and
 * sorting a page rather than the whole set is the honest limit of doing it client-side.
 */
export function sortThreads(threads: readonly ForumThread[]): readonly ForumThread[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastPostAt.localeCompare(a.lastPostAt);
  });
}

/**
 * What to render as a post's body. A tombstoned post keeps its row — the conversation still
 * happened — but never shows what it said.
 */
export function postDisplayBody(post: ForumPost): string {
  return post.deletedAt !== null ? '[Post deleted]' : post.body;
}

/** A tombstoned thread is still listed, but must not read as an ordinary title. */
export function threadDisplayTitle(thread: ForumThread): string {
  return thread.deletedAt !== null ? '[Thread deleted]' : thread.title;
}
