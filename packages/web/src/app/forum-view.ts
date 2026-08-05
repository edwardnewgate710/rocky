/**
 * Forum view renderers — pure DOM helpers. Titles and post bodies are user-supplied, so everything
 * goes through the shared `el()` helper, which appends strings as text nodes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { postDisplayBody, sortThreads, threadDisplayTitle } from './forum-helpers.js';
import type { ForumPost, ForumThread, SocialPlayer } from '../api/models.js';

export function renderThreadList(
  container: HTMLElement,
  slug: string,
  threads: readonly ForumThread[],
  names: ReadonlyMap<string, SocialPlayer>,
): void {
  container.replaceChildren();
  if (threads.length === 0) {
    renderEmpty(container, {
      mark: '♞',
      title: 'No threads yet',
      body: 'Start the first conversation in this team.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const thread of sortThreads(threads)) {
    const author = names.get(thread.authorId)?.handle ?? shortId(thread.authorId);
    const link = el(
      doc,
      'a',
      {
        href: `/teams/${encodeURIComponent(slug)}/forum/${encodeURIComponent(thread.id)}`,
        'data-route': 'thread',
        class: 'row-link',
      },
      threadDisplayTitle(thread),
    );

    // `.panel-row` is space-between, so the row takes exactly two children: what identifies the
    // thread leads, and its state trails.
    const leading: (Node | string)[] = [link, el(doc, 'span', { class: 'count' }, author)];
    const row = el(doc, 'div', { class: 'panel-row' }, el(doc, 'span', { class: 'row-main' }, ...leading));

    // Only states that change what you can do earn a tag; "unlocked" and "unpinned" are the norm.
    const tags: string[] = [];
    if (thread.pinned) tags.push('pinned');
    if (thread.locked) tags.push('locked');
    if (tags.length > 0) {
      row.appendChild(el(doc, 'span', { class: 'count' }, tags.join(' · ')));
    }

    container.appendChild(row);
  }
}

export function renderPosts(
  container: HTMLElement,
  posts: readonly ForumPost[],
  names: ReadonlyMap<string, SocialPlayer>,
  viewerId: string | null,
): void {
  container.replaceChildren();
  if (posts.length === 0) {
    renderEmpty(container, { title: 'No posts', body: 'This thread has no posts yet.', inline: true });
    return;
  }

  const doc = container.ownerDocument;
  for (const post of posts) {
    const author = names.get(post.authorId)?.handle ?? shortId(post.authorId);
    const meta: (Node | string)[] = [
      el(doc, 'span', { class: 'message-sender' }, author),
      el(doc, 'span', { class: 'count' }, formatPostTime(post.createdAt)),
    ];
    // An edit is a fact about the post that changes how to read it; it is not an emphasis, so it
    // sits in the same muted meta line rather than getting a treatment of its own.
    if (post.editedAt !== null && post.deletedAt === null) {
      meta.push(el(doc, 'span', { class: 'count' }, 'edited'));
    }

    const isTombstone = post.deletedAt !== null;
    const bodyEl = el(
      doc,
      'div',
      { class: isTombstone ? 'message-body message-tombstone' : 'message-body' },
      postDisplayBody(post),
    );

    const own = viewerId !== null && post.authorId === viewerId;
    container.appendChild(
      el(
        doc,
        'div',
        { class: own ? 'message-item own' : 'message-item' },
        el(doc, 'div', { class: 'message-header' }, ...meta),
        bodyEl,
      ),
    );
  }
}

function formatPostTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
