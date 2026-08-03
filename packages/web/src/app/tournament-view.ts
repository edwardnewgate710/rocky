/**
 * Tournament view renderers — pure DOM helpers that take a container plus data
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty, formatTimeControl, formatClock } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import type {
  TournamentSummary,
  TournamentDetail,
  TournamentStanding,
  TournamentLiveBoard,
  TournamentFormat,
  TournamentState,
} from '../api/models.js';

export function formatFormat(format: TournamentFormat): string {
  switch (format) {
    case 'round_robin':
      return 'Round robin';
    case 'swiss':
      return 'Swiss';
    case 'arena':
      return 'Arena';
  }
}

export function formatState(state: TournamentState): string {
  switch (state) {
    case 'registration':
      return 'Registration';
    case 'running':
      return 'Running';
    case 'finished':
      return 'Finished';
  }
}

export function renderTournamentList(
  container: HTMLElement,
  items: readonly TournamentSummary[],
): void {
  container.innerHTML = '';
  if (items.length === 0) {
    renderEmpty(container, {
      mark: '🏆',
      title: 'No tournaments available',
      body: 'Check back later for upcoming tournaments.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const item of items) {
    const link = el(
      doc,
      'a',
      { href: `/tournaments/${encodeURIComponent(item.id)}`, class: 'tournament-link' },
      item.name,
    );

    const info = el(
      doc,
      'span',
      { class: 'count' },
      `${formatFormat(item.format)} · ${formatState(item.state)} · ${item.participantCount} players`,
    );

    const row = el(
      doc,
      'div',
      { class: 'panel-row' },
      link,
      info,
    );

    container.appendChild(row);
  }
}

export function renderTournamentDetail(
  container: HTMLElement,
  detail: TournamentDetail,
): void {
  const doc = container.ownerDocument;
  container.innerHTML = '';

  const formatRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, 'Format'),
    el(doc, 'span', {}, formatFormat(detail.format)),
  );

  const stateRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, 'State'),
    el(doc, 'span', {}, formatState(detail.state)),
  );

  const variantRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, 'Variant'),
    el(doc, 'span', {}, detail.variant),
  );

  const tcRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, 'Time Control'),
    el(doc, 'span', {}, formatTimeControl(detail.timeControl)),
  );

  const playersRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, 'Participants'),
    el(doc, 'span', {}, `${detail.participants.length} players`),
  );

  container.append(formatRow, stateRow, variantRow, tcRow, playersRow);

  if (detail.format === 'arena') {
    const durationRow = el(
      doc,
      'div',
      { class: 'panel-row' },
      el(doc, 'strong', {}, 'Duration'),
      el(doc, 'span', {}, `${Math.round(detail.durationMs / 60000)} min`),
    );
    container.appendChild(durationRow);
  } else {
    const roundsText = detail.rounds
      ? `${detail.roundsGenerated} / ${detail.rounds}`
      : `${detail.roundsGenerated}`;
    const roundsRow = el(
      doc,
      'div',
      { class: 'panel-row' },
      el(doc, 'strong', {}, 'Rounds'),
      el(doc, 'span', {}, roundsText),
    );
    container.appendChild(roundsRow);
  }
}

export function renderStandings(
  container: HTMLElement,
  standings: readonly TournamentStanding[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
): void {
  container.innerHTML = '';
  if (standings.length === 0) {
    renderEmpty(container, {
      title: 'No standings yet',
      body: 'Standings will appear when participants join or play.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const s of standings) {
    const handle = names.get(s.playerId)?.handle ?? shortId(s.playerId);
    const playerSpan = el(doc, 'span', {}, `#${s.rank} ${handle}`);

    let statsStr = '';
    if ('wins' in s) {
      // ArenaStanding
      statsStr = `${s.points} pts (${s.wins}W/${s.draws}D/${s.losses}L, ${s.gamesPlayed} games)${s.onFire ? ' 🔥 On fire' : ''}`;
    } else {
      // SwissOrRoundRobinStanding
      statsStr = `${s.points} pts (Tiebreak: ${s.tiebreak}, Buchholz: ${s.buchholz})${s.withdrawn ? ' [Withdrawn]' : ''}`;
    }

    const statsSpan = el(doc, 'span', { class: 'count' }, statsStr);
    const row = el(doc, 'div', { class: 'panel-row' }, playerSpan, statsSpan);
    container.appendChild(row);
  }
}

export function renderLiveBoards(
  container: HTMLElement,
  games: readonly TournamentLiveBoard[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
): void {
  container.innerHTML = '';
  if (games.length === 0) {
    renderEmpty(container, {
      title: 'No live games right now',
      body: 'Active games will appear here when rounds are in progress.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const g of games) {
    const whiteHandle = names.get(g.white)?.handle ?? shortId(g.white);
    const blackHandle = names.get(g.black)?.handle ?? shortId(g.black);

    const matchupLink = el(
      doc,
      'a',
      { href: `/game/${encodeURIComponent(g.gameId)}`, class: 'tournament-link' },
      `${whiteHandle} vs ${blackHandle}`,
    );

    let statusText = '';
    if (g.status.over) {
      statusText = `Over (${g.status.result})`;
    } else {
      const turnStr = g.turn === 'w' ? 'White' : 'Black';
      const clocksStr = `${formatClock(g.clock.w)} - ${formatClock(g.clock.b)}`;
      statusText = `Move ${Math.floor(g.ply / 2) + 1} (${turnStr}) · ${clocksStr}`;
    }

    const infoSpan = el(doc, 'span', { class: 'count' }, statusText);
    const row = el(doc, 'div', { class: 'panel-row' }, matchupLink, infoSpan);
    container.appendChild(row);
  }
}
