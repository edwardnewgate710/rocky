import type { GambitClient } from '../api/client.js';
import type { TournamentDetail, Variant } from '../api/models.js';
import { LeaderboardController } from './leaderboard-controller.js';
import type { LeaderboardCallbacks } from './leaderboard-controller.js';
import {
  bindVariantSelector,
  renderLeaderboard,
  renderVariantSelector,
} from './leaderboard-view.js';
import { TournamentController } from './tournament-controller.js';
import type { TournamentCallbacks } from './tournament-controller.js';
import {
  renderLiveBoards,
  renderStandings,
  renderTournamentDetail,
  renderTournamentList,
} from './tournament-view.js';

interface LeaderboardMount {
  dispose(): void;
}

interface LeaderboardElements {
  readonly select: HTMLSelectElement | null;
  readonly loading: HTMLElement | null;
  readonly results: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface LeaderboardRenderState {
  resultsRendered: boolean;
}

function setLeaderboardLoading(
  elements: LeaderboardElements,
  state: LeaderboardRenderState,
  loading: boolean,
): void {
  if (!elements.results || !elements.loading) return;
  elements.results.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.resultsRendered = false;
    if (elements.error) elements.error.textContent = '';
    elements.results.hidden = true;
    elements.loading.hidden = false;
    return;
  }
  elements.loading.hidden = true;
  elements.results.hidden = false;
  if (!state.resultsRendered) elements.results.innerHTML = '';
}

function createLeaderboardCallbacks(elements: LeaderboardElements): LeaderboardCallbacks {
  const state: LeaderboardRenderState = { resultsRendered: false };
  return {
    onResults: (entries, names) => {
      state.resultsRendered = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.results) renderLeaderboard(elements.results, entries, names);
    },
    onLoading: (loading) => setLeaderboardLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountLeaderboard(doc: Document, client: GambitClient): LeaderboardMount {
  const elements: LeaderboardElements = {
    select: doc.getElementById('leaderboard-variant-select') as HTMLSelectElement | null,
    loading: doc.getElementById('leaderboard-loading'),
    results: doc.getElementById('leaderboard-results'),
    error: doc.getElementById('leaderboard-error'),
  };
  let activeVariant: Variant = 'standard';
  if (elements.select) renderVariantSelector(elements.select, activeVariant);

  const controller = new LeaderboardController({
    client,
    callbacks: createLeaderboardCallbacks(elements),
  });
  const unbind = elements.select
    ? bindVariantSelector(elements.select, (variant) => {
        activeVariant = variant;
        void controller.loadLeaderboard(activeVariant);
      })
    : () => {};

  void controller.loadLeaderboard(activeVariant);
  return {
    dispose: () => {
      unbind();
      controller.dispose();
    },
  };
}

interface TournamentListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TournamentListRenderState {
  listRendered: boolean;
}

function setTournamentListLoading(
  elements: TournamentListElements,
  state: TournamentListRenderState,
  loading: boolean,
): void {
  if (!elements.list) return;
  elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.listRendered = false;
    elements.list.innerHTML = '<div class="panel-row">Loading…</div>';
    return;
  }
  // A failed request has already populated the error region. Keeping the loading row would
  // contradict that failure and imply that work is still in progress.
  if (!state.listRendered) elements.list.innerHTML = '';
}

function createTournamentListCallbacks(elements: TournamentListElements): TournamentCallbacks {
  const state: TournamentListRenderState = { listRendered: false };
  return {
    onList: (tournaments) => {
      state.listRendered = true;
      if (elements.list) renderTournamentList(elements.list, tournaments);
    },
    onDetail: () => {},
    onStandings: () => {},
    onLiveGames: () => {},
    onLoading: (loading) => setTournamentListLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentList(doc: Document, client: GambitClient): TournamentController {
  const elements: TournamentListElements = {
    list: doc.getElementById('tournament-list'),
    error: doc.getElementById('tournaments-error'),
  };
  const controller = new TournamentController({
    client,
    callbacks: createTournamentListCallbacks(elements),
  });
  void controller.loadList();
  return controller;
}

interface TournamentDetailElements {
  readonly doc: Document;
  readonly meta: HTMLElement | null;
  readonly standings: HTMLElement | null;
  readonly live: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TournamentDetailRenderState {
  currentDetail: TournamentDetail | null;
}

function setTournamentDetailLoading(
  elements: TournamentDetailElements,
  state: TournamentDetailRenderState,
  loading: boolean,
): void {
  if (elements.meta) elements.meta.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.standings) elements.standings.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.live) elements.live.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (!elements.meta) return;
  if (loading && state.currentDetail === null) {
    elements.meta.innerHTML = '<div class="panel-row">Loading…</div>';
    return;
  }
  // A failed initial load has already populated the error region. Clear only its stale placeholder.
  if (!loading && state.currentDetail === null) elements.meta.innerHTML = '';
}

function createTournamentDetailCallbacks(
  elements: TournamentDetailElements,
  startLive: (tournamentId: string) => void,
): TournamentCallbacks {
  const state: TournamentDetailRenderState = { currentDetail: null };
  return {
    onList: () => {},
    onDetail: (detail) => {
      state.currentDetail = detail;
      const nameElement = elements.doc.getElementById('tournament-name');
      if (nameElement) nameElement.textContent = detail.name;
      if (elements.meta) renderTournamentDetail(elements.meta, detail);
      if (detail.state === 'running') startLive(detail.id);
    },
    onStandings: (standings, names) => {
      if (elements.standings) renderStandings(elements.standings, standings, names);
    },
    onLiveGames: (games, names) => {
      if (elements.live) renderLiveBoards(elements.live, games, names);
    },
    onLoading: (loading) => setTournamentDetailLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentDetail(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
): TournamentController {
  const elements: TournamentDetailElements = {
    doc,
    meta: doc.getElementById('tournament-meta'),
    standings: doc.getElementById('tournament-standings'),
    live: doc.getElementById('tournament-live'),
    error: doc.getElementById('tournament-error'),
  };
  let controller: TournamentController;
  controller = new TournamentController({
    client,
    callbacks: createTournamentDetailCallbacks(
      elements,
      (runningTournamentId) => controller.startLive(runningTournamentId),
    ),
  });
  void controller.loadDetail(tournamentId);
  return controller;
}
