import { CommunityRuleError } from './errors';
import type {
  ForumPost,
  ForumThread,
  JoinRequest,
  JoinRequestId,
  JoinRequestStatus,
  Membership,
  PlayerId,
  PostId,
  Team,
  TeamId,
  TeamRole,
  TeamVisibility,
  ThreadId,
} from './model';
import {
  assertValidPostBody,
  assertValidSlug,
  assertValidTeamDescription,
  assertValidTeamName,
  assertValidThreadTitle,
  roleRank,
} from './model';
import {
  compareMembers,
  comparePosts,
  compareTeams,
  compareThreads,
} from './ordering';
import type { Page, PageOptions } from './pagination';
import { paginate } from './pagination';

/**
 * Storage-agnostic port for teams/communities, memberships, join requests, and per-team forums.
 *
 * Every implementation owes all of these invariants:
 *
 * 1. A team always has EXACTLY ONE owner. Creating a team makes the creator the owner (`role = 'owner'`).
 *    The owner cannot leave or be removed while they are the owner; ownership must be transferred
 *    to another existing member first, which demotes the old owner to `admin`.
 * 2. Role authority follows a strict hierarchy `owner (3) > admin (2) > member (1)`.
 *    An actor may only change a role strictly below their own rank (`rank(actor) > rank(target)`), and
 *    may only promote someone to a role strictly below their own rank. Only ownership transfer
 *    promotes someone to `owner`. Removing a member requires `rank(actor) > rank(target)` (unless
 *    the member is voluntarily leaving).
 * 3. Slugs are unique, normalized (lowercase, trimmed), non-empty, and constrained to `SLUG_REGEX`.
 *    Inputs failing normalization or character constraints are rejected with `invalid_slug`. Slugs already
 *    taken throw `slug_taken`.
 * 4. `public` teams can be joined directly. `private` teams require a join request; accepting one
 *    creates the membership with role `member`. Accepting/declining a join request requires `admin` or above.
 *    The requester may cancel their own pending request. A second pending request for the same (team, player)
 *    is rejected (`already_requested`). Someone who is already a member cannot open a request (`already_member`).
 * 5. Access control for public vs private teams:
 *    - `private` teams, their memberships, join requests, forum threads, and posts are completely
 *      invisible to non-members and read as `not_found`.
 *    - `public` teams, their memberships, forum threads, and posts are readable by anyone (including non-members),
 *      but creating threads or posting in a public team forum is writable only by members (`not_authorized` for non-members).
 * 6. Thread/post titles and bodies must be non-empty after trimming, bounded by exported constants, and stored trimmed.
 *    Deleting a thread or post is a tombstone (`deletedAt` set, post body cleared to `""`). A tombstoned post cannot
 *    be edited or deleted again (`invalid_transition`). Locking a thread blocks new posts and edits by anyone below `admin`.
 *    Pinning and locking require `admin` or above (`not_authorized` for members).
 * 7. Moderation vs Forgery: Authors may edit or delete their own post. `admin` and `owner` may delete anyone's post
 *    in their team, but may NOT edit anyone else's words (`not_authorized`).
 * 8. `not_found` vs `not_authorized` follows ADR-0068 §5:
 *    - Anything the actor cannot see reads as `not_found` (a private team, its threads, posts, members, or join requests to a non-member).
 *      A join request is visible only to its requester and to the team's admins, so cancelling one you did not
 *      open is `not_found` — a 403 there would confirm the id is live and turn the endpoint into an existence oracle.
 *    - `not_authorized` is reserved for actions the actor can see but may not perform (e.g. a member trying to lock a thread,
 *      a non-author trying to edit someone else's post, or a non-member trying to post in a public team thread).
 * 9. Threads in a team forum are ordered by `pinned` DESC, `lastPostAt` DESC, tie-broken by thread `id` ASC in code-point order.
 *    Posts in a thread are ordered oldest-first by `createdAt` ASC, tie-broken by post `id` ASC.
 *    Members are ordered by `role` authority DESC, `joinedAt` ASC, tie-broken by player `id` ASC.
 *    Teams are ordered by `createdAt` DESC, tie-broken by team `id` ASC.
 */
export interface CommunityRepository {
  createTeam(
    id: TeamId,
    slug: string,
    name: string,
    description: string,
    visibility: TeamVisibility,
    ownerId: PlayerId,
    at: Date
  ): Promise<Team>;

  getTeam(teamId: TeamId, actorId?: PlayerId): Promise<Team>;

  getTeamBySlug(slug: string, actorId?: PlayerId): Promise<Team>;

  updateTeam(
    teamId: TeamId,
    actorId: PlayerId,
    updates: { name?: string; description?: string; visibility?: TeamVisibility },
    at: Date
  ): Promise<Team>;

  listTeams(
    actorId?: PlayerId,
    options?: PageOptions & { search?: string }
  ): Promise<Page<Team>>;

  // Memberships
  joinTeam(teamId: TeamId, playerId: PlayerId, at: Date): Promise<Membership>;

  leaveOrRemoveMember(teamId: TeamId, actorId: PlayerId, targetPlayerId: PlayerId): Promise<void>;

  updateMemberRole(
    teamId: TeamId,
    actorId: PlayerId,
    targetPlayerId: PlayerId,
    newRole: TeamRole
  ): Promise<Membership>;

  transferOwnership(
    teamId: TeamId,
    actorId: PlayerId,
    newOwnerId: PlayerId
  ): Promise<{ oldOwner: Membership; newOwner: Membership }>;

  listMembers(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<Membership>>;

  getMembership(teamId: TeamId, playerId: PlayerId, actorId?: PlayerId): Promise<Membership | null>;

  // Join Requests
  createJoinRequest(
    id: JoinRequestId,
    teamId: TeamId,
    playerId: PlayerId,
    at: Date
  ): Promise<JoinRequest>;

  respondToJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    status: 'accepted' | 'declined',
    at: Date
  ): Promise<JoinRequest>;

  cancelJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    at: Date
  ): Promise<JoinRequest>;

  listJoinRequests(
    teamId: TeamId,
    actorId: PlayerId,
    options?: PageOptions & { status?: JoinRequestStatus }
  ): Promise<Page<JoinRequest>>;

  // Forum Threads & Posts
  createThread(
    id: ThreadId,
    teamId: TeamId,
    authorId: PlayerId,
    title: string,
    initialPostBody: string,
    firstPostId: PostId,
    at: Date
  ): Promise<{ thread: ForumThread; post: ForumPost }>;

  getThread(threadId: ThreadId, actorId?: PlayerId): Promise<ForumThread>;

  updateThread(
    threadId: ThreadId,
    actorId: PlayerId,
    updates: { title?: string; locked?: boolean; pinned?: boolean },
    at: Date
  ): Promise<ForumThread>;

  deleteThread(threadId: ThreadId, actorId: PlayerId, at: Date): Promise<ForumThread>;

  listThreads(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumThread>>;

  createPost(
    id: PostId,
    threadId: ThreadId,
    authorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost>;

  getPost(postId: PostId, actorId?: PlayerId): Promise<ForumPost>;

  editPost(
    postId: PostId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost>;

  deletePost(postId: PostId, actorId: PlayerId, at: Date): Promise<ForumPost>;

  listPosts(
    threadId: ThreadId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumPost>>;
}

export class InMemoryCommunityRepository implements CommunityRepository {
  private readonly teams = new Map<TeamId, Team>();
  private readonly memberships = new Map<string, Membership>(); // key: `${teamId}:${playerId}`
  private readonly joinRequests = new Map<JoinRequestId, JoinRequest>();
  private readonly threads = new Map<ThreadId, ForumThread>();
  private readonly posts = new Map<PostId, ForumPost>();

  async clear(): Promise<void> {
    this.teams.clear();
    this.memberships.clear();
    this.joinRequests.clear();
    this.threads.clear();
    this.posts.clear();
  }

  private memberKey(teamId: TeamId, playerId: PlayerId): string {
    return `${teamId}:${playerId}`;
  }

  private getMembershipInternal(teamId: TeamId, playerId: PlayerId): Membership | null {
    return this.memberships.get(this.memberKey(teamId, playerId)) ?? null;
  }

  /**
   * Enforces visibility rules: if team is private and actor is not a member,
   * returns `not_found` to prevent existence leakage.
   */
  private async findVisibleTeam(teamId: TeamId, actorId?: PlayerId): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
    }
    if (team.visibility === 'private') {
      if (!actorId) {
        throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
      }
      const mem = this.getMembershipInternal(teamId, actorId);
      if (!mem) {
        throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
      }
    }
    return team;
  }

  /**
   * Resolves a visible thread. If team is private and actor is not a member -> `not_found`.
   */
  private async findVisibleThread(threadId: ThreadId, actorId?: PlayerId): Promise<{ thread: ForumThread; team: Team }> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new CommunityRuleError('not_found', `Thread '${threadId}' not found`);
    }
    const team = await this.findVisibleTeam(thread.teamId, actorId);
    return { thread, team };
  }

  /**
   * Resolves a visible post. If team is private and actor is not a member -> `not_found`.
   */
  private async findVisiblePost(postId: PostId, actorId?: PlayerId): Promise<{ post: ForumPost; thread: ForumThread; team: Team }> {
    const post = this.posts.get(postId);
    if (!post) {
      throw new CommunityRuleError('not_found', `Post '${postId}' not found`);
    }
    const { thread, team } = await this.findVisibleThread(post.threadId, actorId);
    return { post, thread, team };
  }

  async createTeam(
    id: TeamId,
    slug: string,
    name: string,
    description: string,
    visibility: TeamVisibility,
    ownerId: PlayerId,
    at: Date
  ): Promise<Team> {
    const normalizedSlug = assertValidSlug(slug);
    const validName = assertValidTeamName(name);
    const validDesc = assertValidTeamDescription(description);

    for (const team of this.teams.values()) {
      if (team.slug === normalizedSlug) {
        throw new CommunityRuleError('slug_taken', `Slug '${normalizedSlug}' is already taken`);
      }
    }

    const team: Team = {
      id,
      slug: normalizedSlug,
      name: validName,
      description: validDesc,
      visibility,
      createdBy: ownerId,
      createdAt: at,
    };
    this.teams.set(id, team);

    const ownerMember: Membership = {
      teamId: id,
      playerId: ownerId,
      role: 'owner',
      joinedAt: at,
    };
    this.memberships.set(this.memberKey(id, ownerId), ownerMember);

    return team;
  }

  async getTeam(teamId: TeamId, actorId?: PlayerId): Promise<Team> {
    return this.findVisibleTeam(teamId, actorId);
  }

  async getTeamBySlug(slug: string, actorId?: PlayerId): Promise<Team> {
    const normalizedSlug = assertValidSlug(slug);
    for (const team of this.teams.values()) {
      if (team.slug === normalizedSlug) {
        return this.findVisibleTeam(team.id, actorId);
      }
    }
    throw new CommunityRuleError('not_found', `Team with slug '${slug}' not found`);
  }

  async updateTeam(
    teamId: TeamId,
    actorId: PlayerId,
    updates: { name?: string; description?: string; visibility?: TeamVisibility },
    _at: Date
  ): Promise<Team> {
    const team = await this.findVisibleTeam(teamId, actorId);
    const mem = this.getMembershipInternal(teamId, actorId);
    if (!mem || (mem.role !== 'admin' && mem.role !== 'owner')) {
      throw new CommunityRuleError('not_authorized', 'Only admins and owners can update team details');
    }

    const updatedName = updates.name !== undefined ? assertValidTeamName(updates.name) : team.name;
    const updatedDesc = updates.description !== undefined ? assertValidTeamDescription(updates.description) : team.description;
    const updatedVis = updates.visibility !== undefined ? updates.visibility : team.visibility;

    const updatedTeam: Team = {
      ...team,
      name: updatedName,
      description: updatedDesc,
      visibility: updatedVis,
    };
    this.teams.set(teamId, updatedTeam);
    return updatedTeam;
  }

  async listTeams(
    actorId?: PlayerId,
    options?: PageOptions & { search?: string }
  ): Promise<Page<Team>> {
    const searchLower = options?.search ? options.search.trim().toLowerCase() : '';
    const matching: Team[] = [];

    for (const team of this.teams.values()) {
      if (team.visibility === 'private') {
        if (!actorId) continue;
        const isMem = this.getMembershipInternal(team.id, actorId);
        if (!isMem) continue;
      }

      if (searchLower) {
        const matchesName = team.name.toLowerCase().includes(searchLower);
        const matchesSlug = team.slug.toLowerCase().includes(searchLower);
        if (!matchesName && !matchesSlug) continue;
      }

      matching.push(team);
    }

    matching.sort(compareTeams);
    return paginate(matching, options);
  }

  async joinTeam(teamId: TeamId, playerId: PlayerId, at: Date): Promise<Membership> {
    const team = await this.findVisibleTeam(teamId, playerId);
    const existing = this.getMembershipInternal(teamId, playerId);
    if (existing) {
      throw new CommunityRuleError('already_member', `Player '${playerId}' is already a member of team '${teamId}'`);
    }

    if (team.visibility === 'private') {
      throw new CommunityRuleError('not_authorized', 'Private teams cannot be joined directly. Submit a join request.');
    }

    const mem: Membership = {
      teamId,
      playerId,
      role: 'member',
      joinedAt: at,
    };
    this.memberships.set(this.memberKey(teamId, playerId), mem);
    return mem;
  }

  async leaveOrRemoveMember(teamId: TeamId, actorId: PlayerId, targetPlayerId: PlayerId): Promise<void> {
    await this.findVisibleTeam(teamId, actorId);
    const targetMem = this.getMembershipInternal(teamId, targetPlayerId);
    if (!targetMem) {
      throw new CommunityRuleError('not_found', `Player '${targetPlayerId}' is not a member of team '${teamId}'`);
    }

    if (targetMem.role === 'owner') {
      throw new CommunityRuleError('cannot_leave_as_owner', 'Owner cannot leave or be removed. Transfer ownership first.');
    }

    if (actorId !== targetPlayerId) {
      const actorMem = this.getMembershipInternal(teamId, actorId);
      if (!actorMem || roleRank(actorMem.role) <= roleRank(targetMem.role)) {
        throw new CommunityRuleError('not_authorized', 'Cannot remove a member with equal or higher role');
      }
    }

    this.memberships.delete(this.memberKey(teamId, targetPlayerId));
  }

  async updateMemberRole(
    teamId: TeamId,
    actorId: PlayerId,
    targetPlayerId: PlayerId,
    newRole: TeamRole
  ): Promise<Membership> {
    await this.findVisibleTeam(teamId, actorId);
    const actorMem = this.getMembershipInternal(teamId, actorId);
    if (!actorMem) {
      throw new CommunityRuleError('not_authorized', 'Actor is not a member of this team');
    }

    const targetMem = this.getMembershipInternal(teamId, targetPlayerId);
    if (!targetMem) {
      throw new CommunityRuleError('not_found', `Player '${targetPlayerId}' is not a member of team '${teamId}'`);
    }

    if (newRole === 'owner') {
      throw new CommunityRuleError('invalid_role_transition', 'Cannot set owner via role update. Use transfer ownership.');
    }

    if (actorId === targetPlayerId) {
      throw new CommunityRuleError('invalid_role_transition', 'Cannot change your own role');
    }

    if (roleRank(actorMem.role) <= roleRank(targetMem.role)) {
      throw new CommunityRuleError('not_authorized', 'Cannot change role of a member with equal or higher role');
    }

    if (roleRank(newRole) >= roleRank(actorMem.role)) {
      throw new CommunityRuleError('not_authorized', 'Cannot promote a member to a role at or above your own');
    }

    const updated: Membership = {
      ...targetMem,
      role: newRole,
    };
    this.memberships.set(this.memberKey(teamId, targetPlayerId), updated);
    return updated;
  }

  async transferOwnership(
    teamId: TeamId,
    actorId: PlayerId,
    newOwnerId: PlayerId
  ): Promise<{ oldOwner: Membership; newOwner: Membership }> {
    await this.findVisibleTeam(teamId, actorId);
    const actorMem = this.getMembershipInternal(teamId, actorId);
    if (!actorMem || actorMem.role !== 'owner') {
      throw new CommunityRuleError('not_authorized', 'Only the current owner can transfer ownership');
    }

    if (actorId === newOwnerId) {
      throw new CommunityRuleError('invalid_role_transition', 'You are already the owner');
    }

    const targetMem = this.getMembershipInternal(teamId, newOwnerId);
    if (!targetMem) {
      throw new CommunityRuleError('not_found', `Player '${newOwnerId}' is not a member of team '${teamId}'`);
    }

    const oldOwnerUpdated: Membership = {
      ...actorMem,
      role: 'admin',
    };
    const newOwnerUpdated: Membership = {
      ...targetMem,
      role: 'owner',
    };

    this.memberships.set(this.memberKey(teamId, actorId), oldOwnerUpdated);
    this.memberships.set(this.memberKey(teamId, newOwnerId), newOwnerUpdated);

    return { oldOwner: oldOwnerUpdated, newOwner: newOwnerUpdated };
  }

  async listMembers(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<Membership>> {
    await this.findVisibleTeam(teamId, actorId);
    const members: Membership[] = [];
    for (const mem of this.memberships.values()) {
      if (mem.teamId === teamId) {
        members.push(mem);
      }
    }

    members.sort(compareMembers);
    return paginate(members, options);
  }

  async getMembership(teamId: TeamId, playerId: PlayerId, actorId?: PlayerId): Promise<Membership | null> {
    await this.findVisibleTeam(teamId, actorId ?? playerId);
    return this.getMembershipInternal(teamId, playerId);
  }

  async createJoinRequest(
    id: JoinRequestId,
    teamId: TeamId,
    playerId: PlayerId,
    at: Date
  ): Promise<JoinRequest> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
    }

    const existingMem = this.getMembershipInternal(teamId, playerId);
    if (existingMem) {
      throw new CommunityRuleError('already_member', `Player '${playerId}' is already a member of team '${teamId}'`);
    }

    for (const req of this.joinRequests.values()) {
      if (req.teamId === teamId && req.playerId === playerId && req.status === 'pending') {
        throw new CommunityRuleError('already_requested', `A pending join request already exists for team '${teamId}'`);
      }
    }

    const request: JoinRequest = {
      id,
      teamId,
      playerId,
      status: 'pending',
      createdAt: at,
    };
    this.joinRequests.set(id, request);
    return request;
  }

  async respondToJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    status: 'accepted' | 'declined',
    at: Date
  ): Promise<JoinRequest> {
    const req = this.joinRequests.get(requestId);
    if (!req) {
      throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
    }

    // Check team visibility and actor role
    const team = await this.findVisibleTeam(req.teamId, actorId);
    const actorMem = this.getMembershipInternal(team.id, actorId);
    if (!actorMem || (actorMem.role !== 'admin' && actorMem.role !== 'owner')) {
      throw new CommunityRuleError('not_authorized', 'Only admins and owners can respond to join requests');
    }

    if (req.status !== 'pending') {
      throw new CommunityRuleError('invalid_transition', `Join request '${requestId}' is not pending`);
    }

    const updatedReq: JoinRequest = {
      ...req,
      status,
      respondedAt: at,
    };
    this.joinRequests.set(requestId, updatedReq);

    if (status === 'accepted') {
      const mem: Membership = {
        teamId: req.teamId,
        playerId: req.playerId,
        role: 'member',
        joinedAt: at,
      };
      this.memberships.set(this.memberKey(req.teamId, req.playerId), mem);
    }

    return updatedReq;
  }

  async cancelJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    at: Date
  ): Promise<JoinRequest> {
    const req = this.joinRequests.get(requestId);
    if (!req) {
      throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
    }

    // `not_found`, not `not_authorized`. A join request is visible to its requester and to the
    // team's admins, who read it through `listJoinRequests` — nobody else can see it at all, so
    // answering 403 to a stranger would confirm the id is live while an invented one answered 404.
    // That pair of responses is an oracle over request ids (invariant 8).
    if (req.playerId !== actorId) {
      throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
    }

    if (req.status !== 'pending') {
      throw new CommunityRuleError('invalid_transition', `Join request '${requestId}' is not pending`);
    }

    const updatedReq: JoinRequest = {
      ...req,
      status: 'cancelled',
      respondedAt: at,
    };
    this.joinRequests.set(requestId, updatedReq);
    return updatedReq;
  }

  async listJoinRequests(
    teamId: TeamId,
    actorId: PlayerId,
    options?: PageOptions & { status?: JoinRequestStatus }
  ): Promise<Page<JoinRequest>> {
    const team = await this.findVisibleTeam(teamId, actorId);
    const actorMem = this.getMembershipInternal(team.id, actorId);
    if (!actorMem || (actorMem.role !== 'admin' && actorMem.role !== 'owner')) {
      throw new CommunityRuleError('not_authorized', 'Only admins and owners can view join requests');
    }

    const requests: JoinRequest[] = [];
    for (const req of this.joinRequests.values()) {
      if (req.teamId === teamId && (!options?.status || req.status === options.status)) {
        requests.push(req);
      }
    }

    requests.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return paginate(requests, options);
  }

  async createThread(
    id: ThreadId,
    teamId: TeamId,
    authorId: PlayerId,
    title: string,
    initialPostBody: string,
    firstPostId: PostId,
    at: Date
  ): Promise<{ thread: ForumThread; post: ForumPost }> {
    await this.findVisibleTeam(teamId, authorId);

    // Rule 5: Non-members cannot create threads in public or private teams
    const mem = this.getMembershipInternal(teamId, authorId);
    if (!mem) {
      throw new CommunityRuleError('not_authorized', 'Only members can create forum threads');
    }

    const validTitle = assertValidThreadTitle(title);
    const validBody = assertValidPostBody(initialPostBody);

    const thread: ForumThread = {
      id,
      teamId,
      authorId,
      title: validTitle,
      createdAt: at,
      lastPostAt: at,
      locked: false,
      pinned: false,
    };

    const post: ForumPost = {
      id: firstPostId,
      threadId: id,
      authorId,
      body: validBody,
      createdAt: at,
    };

    this.threads.set(id, thread);
    this.posts.set(firstPostId, post);

    return { thread, post };
  }

  async getThread(threadId: ThreadId, actorId?: PlayerId): Promise<ForumThread> {
    const { thread } = await this.findVisibleThread(threadId, actorId);
    return thread;
  }

  async updateThread(
    threadId: ThreadId,
    actorId: PlayerId,
    updates: { title?: string; locked?: boolean; pinned?: boolean },
    _at: Date
  ): Promise<ForumThread> {
    const { thread, team } = await this.findVisibleThread(threadId, actorId);
    const mem = this.getMembershipInternal(team.id, actorId);

    if (updates.locked !== undefined || updates.pinned !== undefined) {
      if (!mem || (mem.role !== 'admin' && mem.role !== 'owner')) {
        throw new CommunityRuleError('not_authorized', 'Only admins and owners can lock or pin threads');
      }
    }

    if (updates.title !== undefined) {
      if (thread.authorId !== actorId && (!mem || (mem.role !== 'admin' && mem.role !== 'owner'))) {
        throw new CommunityRuleError('not_authorized', 'Only author, admins, or owners can update thread title');
      }
    }

    const updatedTitle = updates.title !== undefined ? assertValidThreadTitle(updates.title) : thread.title;
    const updatedLocked = updates.locked !== undefined ? updates.locked : thread.locked;
    const updatedPinned = updates.pinned !== undefined ? updates.pinned : thread.pinned;

    const updatedThread: ForumThread = {
      ...thread,
      title: updatedTitle,
      locked: updatedLocked,
      pinned: updatedPinned,
    };
    this.threads.set(threadId, updatedThread);
    return updatedThread;
  }

  async deleteThread(threadId: ThreadId, actorId: PlayerId, at: Date): Promise<ForumThread> {
    const { thread, team } = await this.findVisibleThread(threadId, actorId);
    const mem = this.getMembershipInternal(team.id, actorId);

    if (thread.authorId !== actorId && (!mem || (mem.role !== 'admin' && mem.role !== 'owner'))) {
      throw new CommunityRuleError('not_authorized', 'Only thread author, admins, or owners can delete a thread');
    }

    if (thread.deletedAt !== undefined) {
      throw new CommunityRuleError('invalid_transition', 'Thread is already deleted');
    }

    const tombstoned: ForumThread = {
      ...thread,
      deletedAt: at,
    };
    this.threads.set(threadId, tombstoned);
    return tombstoned;
  }

  async listThreads(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumThread>> {
    await this.findVisibleTeam(teamId, actorId);
    const threads: ForumThread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.teamId === teamId && thread.deletedAt === undefined) {
        threads.push(thread);
      }
    }

    threads.sort(compareThreads);
    return paginate(threads, options);
  }

  async createPost(
    id: PostId,
    threadId: ThreadId,
    authorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost> {
    const { thread, team } = await this.findVisibleThread(threadId, authorId);
    const mem = this.getMembershipInternal(team.id, authorId);

    if (!mem) {
      throw new CommunityRuleError('not_authorized', 'Only team members can post in forum threads');
    }

    if (thread.locked && mem.role === 'member') {
      throw new CommunityRuleError('not_authorized', 'Thread is locked. Only admins and owners can post in locked threads');
    }

    if (thread.deletedAt !== undefined) {
      throw new CommunityRuleError('invalid_transition', 'Cannot post in a deleted thread');
    }

    const validBody = assertValidPostBody(body);

    const post: ForumPost = {
      id,
      threadId,
      authorId,
      body: validBody,
      createdAt: at,
    };
    this.posts.set(id, post);

    // Update lastPostAt on thread
    const updatedThread: ForumThread = {
      ...thread,
      lastPostAt: at,
    };
    this.threads.set(threadId, updatedThread);

    return post;
  }

  async getPost(postId: PostId, actorId?: PlayerId): Promise<ForumPost> {
    const { post } = await this.findVisiblePost(postId, actorId);
    return post;
  }

  async editPost(
    postId: PostId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost> {
    const { post, thread, team } = await this.findVisiblePost(postId, actorId);
    const mem = this.getMembershipInternal(team.id, actorId);

    // Rule 7: Only the author may edit their own post!
    if (post.authorId !== actorId) {
      throw new CommunityRuleError('not_authorized', 'Only the author may edit their post');
    }

    if (post.deletedAt !== undefined) {
      throw new CommunityRuleError('invalid_transition', 'Cannot edit a deleted post');
    }

    // Rule 6: Thread locked blocks edits by members
    if (thread.locked && mem && mem.role === 'member') {
      throw new CommunityRuleError('not_authorized', 'Thread is locked');
    }

    const validBody = assertValidPostBody(body);

    const updated: ForumPost = {
      ...post,
      body: validBody,
      editedAt: at,
    };
    this.posts.set(postId, updated);
    return updated;
  }

  async deletePost(
    postId: PostId,
    actorId: PlayerId,
    at: Date
  ): Promise<ForumPost> {
    const { post, team } = await this.findVisiblePost(postId, actorId);
    const mem = this.getMembershipInternal(team.id, actorId);

    // Rule 7: Author OR admin/owner can delete
    const isAuthor = post.authorId === actorId;
    const isAdminOrOwner = mem && (mem.role === 'admin' || mem.role === 'owner');

    if (!isAuthor && !isAdminOrOwner) {
      throw new CommunityRuleError('not_authorized', 'Only author, admins, or owners can delete a post');
    }

    if (post.deletedAt !== undefined) {
      throw new CommunityRuleError('invalid_transition', 'Post is already deleted');
    }

    const tombstoned: ForumPost = {
      ...post,
      body: '',
      deletedAt: at,
    };
    this.posts.set(postId, tombstoned);
    return tombstoned;
  }

  async listPosts(
    threadId: ThreadId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumPost>> {
    await this.findVisibleThread(threadId, actorId);
    const posts: ForumPost[] = [];
    for (const post of this.posts.values()) {
      if (post.threadId === threadId) {
        posts.push(post);
      }
    }

    posts.sort(comparePosts);
    return paginate(posts, options);
  }
}
