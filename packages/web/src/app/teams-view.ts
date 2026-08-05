/**
 * Teams view renderers — pure DOM helpers that take a container plus data and write DOM using the
 * shared `el()` helper, which appends strings as text nodes. Team names and descriptions are
 * user-supplied, so nothing here goes near `innerHTML`.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import type { SocialPlayer, TeamMembership, TeamView } from '../api/models.js';

export function renderTeamList(
  container: HTMLElement,
  teams: readonly TeamView[],
  searched: boolean,
): void {
  container.replaceChildren();
  if (teams.length === 0) {
    renderEmpty(container, {
      mark: '♜',
      title: searched ? 'No teams match that search' : 'No teams yet',
      body: searched ? 'Try a different term.' : 'Teams created by players will appear here.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const team of teams) {
    const link = el(
      doc,
      'a',
      { href: `/teams/${encodeURIComponent(team.slug)}`, 'data-route': 'team', class: 'tournament-link' },
      team.name,
    );
    // The row is `space-between`, so it holds exactly two children: everything identifying the
    // team leads, and the status tag trails. Three loose children would fling the description to
    // the far edge, detached from the name it describes.
    const leading: (Node | string)[] = [link];
    if (team.description) {
      leading.push(el(doc, 'span', { class: 'count' }, team.description));
    }
    const row = el(doc, 'div', { class: 'panel-row' }, el(doc, 'span', { class: 'row-main' }, ...leading));

    // Only say "private" when it is; a "public" tag on every other row is noise.
    if (team.visibility === 'private') {
      row.appendChild(el(doc, 'span', { class: 'count' }, 'private'));
    }

    container.appendChild(row);
  }
}

export function renderTeamMembers(
  container: HTMLElement,
  members: readonly TeamMembership[],
  names: ReadonlyMap<string, SocialPlayer>,
): void {
  container.replaceChildren();
  if (members.length === 0) {
    renderEmpty(container, { title: 'No members', body: 'This team has no members yet.', inline: true });
    return;
  }

  const doc = container.ownerDocument;
  for (const member of members) {
    const handle = names.get(member.playerId)?.handle ?? shortId(member.playerId);
    const name = el(
      doc,
      'a',
      { href: `/profile/${encodeURIComponent(handle)}`, 'data-route': 'profile', class: 'tournament-link' },
      handle,
    );
    // Every member has a role, so showing "member" on most rows would be filler; only the two
    // roles that carry authority are worth the ink.
    const children: (Node | string)[] = [name];
    if (member.role !== 'member') {
      children.push(el(doc, 'span', { class: 'count' }, member.role));
    }
    container.appendChild(el(doc, 'div', { class: 'panel-row' }, ...children));
  }
}
