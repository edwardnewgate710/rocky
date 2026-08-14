import type { GambitClient } from '../api/client.js';
import type {
  JoinRequestView,
  SocialPlayer,
  TeamDetailView,
  TeamMembership,
} from '../api/models.js';
import { TeamsController } from './teams-controller.js';
import type { TeamsCallbacks } from './teams-controller.js';
import {
  actionExplanation,
  createJoinRequestQueue,
  membershipOf,
  teamAction,
} from './teams-helpers.js';
import type { TeamAction } from './teams-helpers.js';
import { renderJoinRequests, renderTeamList, renderTeamMembers } from './teams-view.js';

interface TeamDetailMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly slug: string;
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
}

interface TeamListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly form: HTMLFormElement | null;
  readonly input: HTMLInputElement | null;
}

interface TeamDetailElements {
  readonly name: HTMLElement | null;
  readonly description: HTMLElement | null;
  readonly actionNote: HTMLElement | null;
  readonly actions: HTMLElement | null;
  readonly members: HTMLElement | null;
  readonly joinRequestsHeading: HTMLElement | null;
  readonly joinRequests: HTMLElement | null;
  readonly forumLink: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TeamRenderDependencies {
  readonly doc: Document;
  readonly elements: TeamDetailElements;
  readonly controller: TeamsController;
  readonly slug: string;
  readonly viewerId: () => string | null;
}

interface TeamActionRequest {
  readonly controller: TeamsController;
  readonly team: TeamDetailView;
  readonly members: readonly TeamMembership[];
  readonly viewerId: string | null;
  readonly slug: string;
  readonly action: Exclude<TeamAction, { readonly kind: 'none' }>;
}

function teamListElements(doc: Document): TeamListElements {
  return {
    list: doc.getElementById('team-list'),
    error: doc.getElementById('teams-error'),
    form: doc.getElementById('team-search-form') as HTMLFormElement | null,
    input: doc.getElementById('team-search-input') as HTMLInputElement | null,
  };
}

function createTeamListCallbacks(
  elements: TeamListElements,
  searched: () => boolean,
): TeamsCallbacks {
  return {
    onList: (teams) => {
      if (elements.error) elements.error.textContent = '';
      if (elements.list) renderTeamList(elements.list, teams, searched());
    },
    onTeam: () => {},
    onLoading: (loading) => {
      if (elements.list) elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onNotFound: () => {},
  };
}

export function mountTeamList(doc: Document, client: GambitClient): TeamsController {
  const elements = teamListElements(doc);
  let searched = false;
  const controller = new TeamsController({
    client,
    callbacks: createTeamListCallbacks(elements, () => searched),
  });
  if (elements.form && elements.input) {
    const input = elements.input;
    elements.form.onsubmit = (event) => {
      event.preventDefault();
      const term = input.value.trim();
      searched = term.length > 0;
      void controller.loadList(term || undefined);
    };
  }
  void controller.loadList();
  return controller;
}

function teamDetailElements(doc: Document): TeamDetailElements {
  return {
    name: doc.getElementById('team-name'),
    description: doc.getElementById('team-description'),
    actionNote: doc.getElementById('team-action-note'),
    actions: doc.getElementById('team-actions'),
    members: doc.getElementById('team-members'),
    joinRequestsHeading: doc.getElementById('join-requests-heading'),
    joinRequests: doc.getElementById('join-requests'),
    forumLink: doc.getElementById('team-forum-link'),
    error: doc.getElementById('team-error'),
  };
}

function renderTeamIdentity(
  elements: TeamDetailElements,
  team: TeamDetailView,
  members: readonly TeamMembership[],
  names: ReadonlyMap<string, SocialPlayer>,
): void {
  if (elements.error) elements.error.textContent = '';
  if (elements.name) elements.name.textContent = team.name;
  if (elements.description) elements.description.textContent = team.description;
  if (elements.members) renderTeamMembers(elements.members, members, names);
  if (elements.forumLink instanceof HTMLAnchorElement) {
    elements.forumLink.href = `/teams/${encodeURIComponent(team.slug)}/forum`;
  }
}

function renderModerationQueue(
  dependencies: TeamRenderDependencies,
  team: TeamDetailView,
  names: ReadonlyMap<string, SocialPlayer>,
  joinRequests: readonly JoinRequestView[] | undefined,
): void {
  const { elements, controller, slug } = dependencies;
  if (elements.joinRequestsHeading) elements.joinRequestsHeading.hidden = joinRequests === undefined;
  if (elements.joinRequests) elements.joinRequests.hidden = joinRequests === undefined;
  if (!elements.joinRequests || joinRequests === undefined) return;
  const joinRequestsElement = elements.joinRequests;

  const queue = createJoinRequestQueue({
    renderQueue: (busy) => {
      renderJoinRequests(joinRequestsElement, joinRequests, names, busy, {
        onAccept: (request) => void queue.respond(request.id, 'accepted'),
        onDecline: (request) => void queue.respond(request.id, 'declined'),
      });
    },
    respond: (requestId, status) =>
      controller.respondToJoinRequest(team.id, requestId, status, slug),
  });
  queue.render();
}

function runTeamAction(request: TeamActionRequest): Promise<boolean> {
  if (request.action.kind === 'join') {
    return request.controller.join(request.team.id, request.slug);
  }
  const membership = membershipOf(request.members, request.viewerId);
  return membership === null
    ? Promise.resolve(false)
    : request.controller.leave(request.team.id, membership.playerId, request.slug);
}

function renderTeamAction(
  dependencies: TeamRenderDependencies,
  team: TeamDetailView,
  members: readonly TeamMembership[],
): void {
  const { actions, actionNote } = dependencies.elements;
  if (!actions || !actionNote) return;
  actions.replaceChildren();
  actionNote.textContent = '';

  const viewerId = dependencies.viewerId();
  const action = teamAction(team, team.viewerRole, viewerId);
  if (action.kind === 'none') {
    actionNote.textContent = actionExplanation(action.reason);
    return;
  }

  const button = dependencies.doc.createElement('button');
  button.type = 'button';
  button.textContent = action.kind === 'join' ? 'Join team' : 'Leave team';
  button.addEventListener('click', () => {
    button.disabled = true;
    void runTeamAction({
      controller: dependencies.controller,
      team,
      members,
      viewerId,
      slug: dependencies.slug,
      action,
    }).then(() => {
      button.disabled = false;
    });
  });
  actions.appendChild(button);
}

function renderTeamNotFound(elements: TeamDetailElements): void {
  if (elements.name) elements.name.textContent = 'Team not found';
  if (elements.description) elements.description.textContent = 'No such team, or it is private.';
  if (elements.members) elements.members.replaceChildren();
  if (elements.actions) elements.actions.replaceChildren();
  if (elements.actionNote) elements.actionNote.textContent = '';
  if (elements.joinRequestsHeading) elements.joinRequestsHeading.hidden = true;
  if (elements.joinRequests) elements.joinRequests.hidden = true;
}

function createTeamDetailCallbacks(dependencies: TeamRenderDependencies): TeamsCallbacks {
  return {
    onList: () => {},
    onTeam: (team, members, names, joinRequests) => {
      renderTeamIdentity(dependencies.elements, team, members, names);
      renderModerationQueue(dependencies, team, names, joinRequests);
      renderTeamAction(dependencies, team, members);
    },
    onLoading: (loading) => {
      const { members, joinRequests } = dependencies.elements;
      if (members) members.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (joinRequests) joinRequests.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (dependencies.elements.error) dependencies.elements.error.textContent = message;
    },
    // Missing and private teams deliberately share one state so this UI cannot confirm existence.
    onNotFound: () => renderTeamNotFound(dependencies.elements),
  };
}

function loadAfterSessionRestore(
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  load: () => void,
): void {
  if (sessionPresent) load();
  else void restorePromise.then(() => load()).catch(() => undefined);
}

export function mountTeamDetail({
  doc,
  client,
  slug,
  sessionPresent,
  restorePromise,
}: TeamDetailMountDependencies): TeamsController {
  const elements = teamDetailElements(doc);
  let controller: TeamsController;
  const dependencies: TeamRenderDependencies = {
    doc,
    elements,
    get controller() {
      return controller;
    },
    slug,
    viewerId: () => client.session.current?.user.id ?? null,
  };
  controller = new TeamsController({
    client,
    callbacks: createTeamDetailCallbacks(dependencies),
  });
  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadTeam(slug));
  return controller;
}
