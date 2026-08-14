import type { GambitClient } from '../api/client.js';
import type {
  ForumPost,
  ForumThread,
  SocialPlayer,
  TeamMembership,
} from '../api/models.js';
import { ForumController } from './forum-controller.js';
import type { ForumCallbacks } from './forum-controller.js';
import {
  abilityExplanation,
  canReply,
  canStartThread,
  threadDisplayTitle,
} from './forum-helpers.js';
import { renderPosts, renderThreadList } from './forum-view.js';

interface ForumMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly slug: string;
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
}

interface ThreadMountDependencies extends ForumMountDependencies {
  readonly threadId: string;
}

interface ForumElements {
  readonly title: HTMLElement | null;
  readonly list: HTMLElement | null;
  readonly note: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly form: HTMLFormElement | null;
  readonly titleInput: HTMLInputElement | null;
  readonly bodyInput: HTMLInputElement | null;
}

interface ThreadElements {
  readonly title: HTMLElement | null;
  readonly posts: HTMLElement | null;
  readonly note: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly form: HTMLFormElement | null;
  readonly input: HTMLInputElement | null;
}

interface ForumRenderDependencies {
  readonly elements: ForumElements;
  readonly slug: string;
  readonly viewerId: () => string | null;
  readonly setTeamId: (teamId: string) => void;
}

interface ThreadRenderDependencies {
  readonly elements: ThreadElements;
  readonly viewerId: () => string | null;
  readonly setTeamId: (teamId: string) => void;
}

interface ThreadRenderData {
  readonly thread: ForumThread;
  readonly posts: readonly ForumPost[];
  readonly members: readonly TeamMembership[];
  readonly names: ReadonlyMap<string, SocialPlayer>;
}

interface ThreadComposerDependencies {
  readonly elements: ForumElements;
  readonly controller: ForumController;
  readonly slug: string;
  readonly teamId: () => string | null;
}

interface ReplyComposerDependencies {
  readonly elements: ThreadElements;
  readonly controller: ForumController;
  readonly slug: string;
  readonly threadId: string;
  readonly teamId: () => string | null;
}

function forumElements(doc: Document): ForumElements {
  return {
    title: doc.getElementById('forum-title'),
    list: doc.getElementById('thread-list'),
    note: doc.getElementById('forum-note'),
    error: doc.getElementById('forum-error'),
    form: doc.getElementById('thread-form') as HTMLFormElement | null,
    titleInput: doc.getElementById('thread-title-input') as HTMLInputElement | null,
    bodyInput: doc.getElementById('thread-body-input') as HTMLInputElement | null,
  };
}

function createForumCallbacks(dependencies: ForumRenderDependencies): ForumCallbacks {
  const { elements, slug, viewerId, setTeamId } = dependencies;
  return {
    onThreads: (team, threads, members, names) => {
      setTeamId(team.id);
      if (elements.error) elements.error.textContent = '';
      if (elements.title) elements.title.textContent = `${team.name} forum`;
      if (elements.list) renderThreadList(elements.list, slug, threads, names);

      const ability = canStartThread(members, viewerId());
      if (elements.form) elements.form.hidden = ability.kind !== 'allowed';
      if (elements.note) {
        elements.note.textContent =
          ability.kind === 'allowed' ? '' : abilityExplanation(ability.reason);
      }
    },
    onThread: () => {},
    onLoading: (loading) => {
      if (elements.list) elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onNotFound: () => {
      if (elements.title) elements.title.textContent = 'Team not found';
      if (elements.list) elements.list.replaceChildren();
      if (elements.form) elements.form.hidden = true;
      if (elements.note) elements.note.textContent = 'No such team, or it is private.';
    },
  };
}

function bindNewThreadComposer(dependencies: ThreadComposerDependencies): void {
  const { elements, controller, slug, teamId } = dependencies;
  if (!elements.form || !elements.titleInput || !elements.bodyInput) return;
  const titleInput = elements.titleInput;
  const bodyInput = elements.bodyInput;
  elements.form.onsubmit = (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    const currentTeamId = teamId();
    if (!title || !body || currentTeamId === null) return;
    titleInput.disabled = true;
    bodyInput.disabled = true;
    void controller.createThread(currentTeamId, slug, title, body).then((created) => {
      titleInput.disabled = false;
      bodyInput.disabled = false;
      // A failed create must not discard what the author typed.
      if (created) {
        titleInput.value = '';
        bodyInput.value = '';
      }
      titleInput.focus();
    });
  };
}

function threadElements(doc: Document): ThreadElements {
  return {
    title: doc.getElementById('thread-title'),
    posts: doc.getElementById('thread-posts'),
    note: doc.getElementById('thread-note'),
    error: doc.getElementById('thread-error'),
    form: doc.getElementById('reply-form') as HTMLFormElement | null,
    input: doc.getElementById('reply-input') as HTMLInputElement | null,
  };
}

function renderThreadDetail(
  elements: ThreadElements,
  data: ThreadRenderData,
  viewerId: string | null,
): void {
  const { thread, posts, members, names } = data;
  if (elements.error) elements.error.textContent = '';
  if (elements.title) elements.title.textContent = threadDisplayTitle(thread);
  if (elements.posts) renderPosts(elements.posts, posts, names, viewerId);

  const ability = canReply(thread, members, viewerId);
  if (elements.form) elements.form.hidden = ability.kind !== 'allowed';
  if (elements.note) {
    elements.note.textContent = ability.kind === 'allowed' ? '' : abilityExplanation(ability.reason);
  }
}

function createThreadCallbacks(dependencies: ThreadRenderDependencies): ForumCallbacks {
  const { elements, viewerId, setTeamId } = dependencies;
  return {
    onThreads: () => {},
    onThread: (team, thread, posts, members, names) => {
      setTeamId(team.id);
      renderThreadDetail(elements, { thread, posts, members, names }, viewerId());
    },
    onLoading: (loading) => {
      if (elements.posts) elements.posts.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onNotFound: () => {
      if (elements.title) elements.title.textContent = 'Thread not found';
      if (elements.posts) elements.posts.replaceChildren();
      if (elements.form) elements.form.hidden = true;
      if (elements.note) elements.note.textContent = 'No such thread, or the team is private.';
    },
  };
}

function bindReplyComposer(dependencies: ReplyComposerDependencies): void {
  const { elements, controller, slug, threadId, teamId } = dependencies;
  if (!elements.form || !elements.input) return;
  const input = elements.input;
  elements.form.onsubmit = (event) => {
    event.preventDefault();
    const body = input.value.trim();
    const currentTeamId = teamId();
    if (!body || currentTeamId === null) return;
    input.disabled = true;
    void controller.createPost(currentTeamId, slug, threadId, body).then((sent) => {
      input.disabled = false;
      if (sent) input.value = '';
      input.focus();
    });
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

export function mountForum({
  doc,
  client,
  slug,
  sessionPresent,
  restorePromise,
}: ForumMountDependencies): ForumController {
  const elements = forumElements(doc);
  let teamId: string | null = null;
  const controller = new ForumController({
    client,
    callbacks: createForumCallbacks({
      elements,
      slug,
      viewerId: () => client.session.current?.user.id ?? null,
      setTeamId: (id) => {
        teamId = id;
      },
    }),
  });
  bindNewThreadComposer({ elements, controller, slug, teamId: () => teamId });
  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadThreads(slug));
  return controller;
}

export function mountForumThread({
  doc,
  client,
  slug,
  threadId,
  sessionPresent,
  restorePromise,
}: ThreadMountDependencies): ForumController {
  const elements = threadElements(doc);
  let teamId: string | null = null;
  const controller = new ForumController({
    client,
    callbacks: createThreadCallbacks({
      elements,
      viewerId: () => client.session.current?.user.id ?? null,
      setTeamId: (id) => {
        teamId = id;
      },
    }),
  });
  bindReplyComposer({ elements, controller, slug, threadId, teamId: () => teamId });
  loadAfterSessionRestore(sessionPresent, restorePromise, () =>
    void controller.loadThread(slug, threadId),
  );
  return controller;
}
