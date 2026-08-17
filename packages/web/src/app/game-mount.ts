/**
 * Game route DOM mount.
 *
 * Wires the interactive board, the game synchronization client, the game
 * metadata/clock/status indicators, and player action controls (draw, resign,
 * abort, claim flag) for `/game/:id` routes.
 */
import type { App } from './composition.js';
import type { GambitClient } from '../api/client.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { GameController } from './game-controller.js';
import { AnalysisController } from './analysis-controller.js';
import {
  ANALYSIS_MESSAGES,
  clearLines,
  renderError,
  renderLimits,
  renderLines,
  renderNote,
  renderReached,
  setBusy,
} from './analysis-view.js';
import { analysisEnabled, analysisSupportsVariant, loadCapabilities } from './capabilities-nav.js';
import { formatClock, formatTimeControl } from './render-helpers.js';
import type { AuthSession } from './auth-controller.js';

/**
 * The line counts the panel offers. Every one is at or below the server's published MultiPV
 * maximum, so no selection this UI can produce is outside the contract.
 */
const ANALYSIS_LINE_CHOICES: readonly number[] = [1, 3, 5];
const DEFAULT_ANALYSIS_LINES = 3;

/** Dependencies required to mount the game route. */
interface GameMountDependencies {
  readonly doc: Document;
  readonly boardEl: HTMLElement;
  readonly gameId: string;
  readonly createGameSync: App['createGameSync'];
  readonly createGameOracle: App['createGameOracle'];
  readonly getAccessToken: () => string | undefined;
  readonly client: GambitClient;
  readonly token?: string;
  readonly restorePromise: Promise<AuthSession | null>;
}

/** The result of mounting the game route. */
interface MountedGame {
  readonly board: MountedBoard;
  readonly controller: GameController;
  readonly connectivity: { dispose: () => void };
  readonly analysis: { dispose: () => void };
  /**
   * Called by bootstrap when the signed-in session changes while this route is mounted.
   *
   * Without it, signing in on an open game left Analyse disabled under a stale "Sign in to analyse"
   * note until something incidental — a move, a failed request — happened to refresh it, and signing
   * out left it enabled. The lobby and the profile are notified through the same slot; the game route
   * simply was not.
   */
  readonly onSessionChange: (session: AuthSession | null) => void;
}

/**
 * Mount the game route against the given DOM document.
 */
export function mountGame(deps: GameMountDependencies): MountedGame {
  const {
    doc,
    boardEl,
    gameId,
    createGameSync,
    createGameOracle,
    getAccessToken,
    token,
    restorePromise,
  } = deps;

  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const clockEl = doc.getElementById('clock');
  const whiteClockEl = doc.getElementById('clock-white');
  const blackClockEl = doc.getElementById('clock-black');

  // Game metadata
  const metaConnectionEl = doc.getElementById('meta-connection');
  const metaRoleEl = doc.getElementById('meta-role');
  const metaWhiteEl = doc.getElementById('meta-white');
  const metaWhiteNameEl = doc.getElementById('meta-white-name');
  const metaBlackEl = doc.getElementById('meta-black');
  const metaBlackNameEl = doc.getElementById('meta-black-name');
  const metaSpectatorsEl = doc.getElementById('meta-spectators');
  const metaVariantEl = doc.getElementById('meta-variant');
  const metaTimeEl = doc.getElementById('meta-time');
  const metaLiveStatusEl = doc.getElementById('meta-live-status');

  // Game action controls
  const actionsPanelEl = doc.getElementById('game-actions');
  const actionErrorEl = doc.getElementById('action-error');
  const btnOfferDraw = doc.getElementById('action-offer-draw') as HTMLButtonElement | null;
  const btnClaimFlag = doc.getElementById('action-claim-flag') as HTMLButtonElement | null;
  const btnResign = doc.getElementById('action-resign') as HTMLButtonElement | null;
  const btnAbort = doc.getElementById('action-abort') as HTMLButtonElement | null;
  const confirmResignEl = doc.getElementById('confirm-resign');
  const confirmResignYes = doc.getElementById('confirm-resign-yes');
  const confirmResignNo = doc.getElementById('confirm-resign-no');
  const confirmAbortEl = doc.getElementById('confirm-abort');
  const confirmAbortYes = doc.getElementById('confirm-abort-yes');
  const confirmAbortNo = doc.getElementById('confirm-abort-no');
  const drawOfferReceivedEl = doc.getElementById('draw-offer-received');
  const btnAcceptDraw = doc.getElementById('action-accept-draw');
  const btnDeclineDraw = doc.getElementById('action-decline-draw');

  // Engine analysis panel (M15 inc 2)
  const analysisSectionEl = doc.getElementById('analysis');
  const analysisRunBtn = doc.getElementById('analysis-run') as HTMLButtonElement | null;
  const analysisLinesSelect = doc.getElementById('analysis-lines') as HTMLSelectElement | null;
  const analysisNoteEl = doc.getElementById('analysis-note');
  const analysisErrorEl = doc.getElementById('analysis-error');
  const analysisResultsEl = doc.getElementById('analysis-results');
  const analysisReachedEl = doc.getElementById('analysis-reached');
  const analysisLimitsEl = doc.getElementById('analysis-limits');

  let currentVariant: string | null = null;
  let analysisDisposed = false;
  let analysisAvailable = false;
  /**
   * Set when this game's variant has no engine here — either advertised up front by
   * `analysisVariants`, or learned from a 422 if the advertisement was unavailable. Permanent for
   * the mount, because a game's variant does not change.
   */
  let analysisUnsupported = false;
  /** The capability payload, once it answers. Held so the variant gate can re-run when the variant lands. */
  let analysisCapabilities: unknown = null;

  /**
   * Return the panel to its initial state.
   *
   * Called at mount, because the panel's DOM lives in `index.html` and outlives any single mount —
   * so the rows rendered for the last game are still there when the next one mounts. A fresh
   * controller cannot detect that: it has never analysed anything, so `positionChanged` correctly
   * stays quiet, and the previous game's evaluation would sit beside a new board with nothing to
   * mark it stale. Nothing in the request lifecycle catches it, because no request is involved.
   */
  const resetAnalysisPanel = (): void => {
    if (analysisResultsEl) {
      clearLines(analysisResultsEl);
      setBusy(analysisResultsEl, false);
    }
    for (const el of [analysisReachedEl, analysisLimitsEl]) {
      if (el) {
        el.textContent = '';
        el.hidden = true;
      }
    }
    if (analysisErrorEl) renderError(analysisErrorEl, null);
    if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.idle);
  };

  resetAnalysisPanel();

  const isUserAuthenticated = (): boolean => {
    return Boolean(getAccessToken() ?? deps.client.session.current?.tokens.accessToken);
  };

  /** Whether there is actually something on the board to analyse yet. */
  const hasPosition = (): boolean => Boolean(currentVariant) && Boolean(controller?.fen);

  /**
   * The single place the run control's enabled state is decided.
   *
   * Three conditions have to hold, and the third is the one that is easy to miss: **there has to be
   * a position**. The panel is revealed as soon as capabilities answer, which happens well before
   * the first game snapshot arrives over the socket — so for a moment the button is present,
   * enabled, and backed by nothing. Clicking it in that window did exactly nothing: `getPosition`
   * returned `null`, `analyse` returned early, and the user got no request and no message. Caught by
   * the e2e spec, whose first test only passed because it happened to change the line selector first
   * and that delay let the snapshot land.
   *
   * Keeping it in one function matters as much as the fix: this was previously decided in two places
   * with two different conditions, which is how they came to disagree.
   */
  const refreshAnalysisControls = (): void => {
    if (analysisDisposed || !analysisAvailable) return;

    // The variant arrives on a game snapshot, which can land either side of the capability answer,
    // so the gate is evaluated here rather than at either arrival point.
    if (
      !analysisUnsupported &&
      currentVariant !== null &&
      !analysisSupportsVariant(analysisCapabilities, currentVariant)
    ) {
      analysisUnsupported = true;
      if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.unsupportedVariant);
    }

    const authed = isUserAuthenticated();
    if (analysisRunBtn) {
      analysisRunBtn.disabled = !authed || analysisUnsupported || analysisController.isPending || !hasPosition();
    }
    // The note is owned by whatever last had something to say — a result, a failure, an
    // invalidation. This function only handles the one message that is a property of the *control*
    // rather than of a request, and only transitions in and out of exactly that message. An earlier
    // version also restored the idle text whenever the note was empty, which meant a failure that
    // had deliberately cleared it got "Analyse the position on the board." printed back underneath
    // its own error.
    if (!analysisNoteEl) return;
    if (!authed) {
      renderNote(analysisNoteEl, ANALYSIS_MESSAGES.signedOut);
    } else if (analysisNoteEl.textContent === ANALYSIS_MESSAGES.signedOut) {
      renderNote(analysisNoteEl, ANALYSIS_MESSAGES.idle);
    }
  };

  let controller: GameController;

  const analysisController = new AnalysisController({
    client: deps.client,
    getPosition: () => {
      const fen = controller.fen;
      if (!fen || !currentVariant) return null;
      return { fen, variant: currentVariant };
    },
    callbacks: {
      onPhase: (phase) => {
        if (analysisResultsEl) {
          setBusy(analysisResultsEl, phase === 'loading');
        }
        refreshAnalysisControls();
        if (phase === 'loading') {
          if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.loading);
          if (analysisErrorEl) renderError(analysisErrorEl, null);
        }
      },
      onResult: (result) => {
        if (analysisResultsEl) renderLines(analysisResultsEl, result);
        if (analysisReachedEl) renderReached(analysisReachedEl, result);
        if (analysisLimitsEl) renderLimits(analysisLimitsEl, result);
        if (analysisNoteEl) renderNote(analysisNoteEl, null);
        if (analysisErrorEl) renderError(analysisErrorEl, null);
      },
      onFailure: (failure) => {
        if (analysisResultsEl) clearLines(analysisResultsEl);
        if (analysisReachedEl) {
          analysisReachedEl.hidden = true;
          analysisReachedEl.textContent = '';
        }
        if (analysisLimitsEl) {
          analysisLimitsEl.hidden = true;
          analysisLimitsEl.textContent = '';
        }
        if (failure === 'rate-limited') {
          if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.rateLimited);
          if (analysisErrorEl) renderError(analysisErrorEl, null);
        } else if (failure === 'unavailable') {
          if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.unavailable);
          if (analysisErrorEl) renderError(analysisErrorEl, null);
        } else if (failure === 'unsupported-variant') {
          // Permanent for this game, so stop offering the control rather than let it fail the same
          // way on every click. DESIGN.md's rule for a composer that cannot succeed: hide the
          // control and name the actual obstacle.
          analysisUnsupported = true;
          if (analysisRunBtn) analysisRunBtn.disabled = true;
          if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.unsupportedVariant);
          if (analysisErrorEl) renderError(analysisErrorEl, null);
        } else if (failure === 'unauthenticated') {
          if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.unauthenticated);
          if (analysisErrorEl) renderError(analysisErrorEl, null);
        } else if (failure === 'rejected') {
          if (analysisNoteEl) renderNote(analysisNoteEl, null);
          if (analysisErrorEl) renderError(analysisErrorEl, ANALYSIS_MESSAGES.rejected);
        } else {
          if (analysisNoteEl) renderNote(analysisNoteEl, null);
          if (analysisErrorEl) renderError(analysisErrorEl, ANALYSIS_MESSAGES.failed);
        }
      },
      onInvalidated: () => {
        if (analysisResultsEl) clearLines(analysisResultsEl);
        if (analysisReachedEl) {
          analysisReachedEl.hidden = true;
          analysisReachedEl.textContent = '';
        }
        if (analysisLimitsEl) {
          analysisLimitsEl.hidden = true;
          analysisLimitsEl.textContent = '';
        }
        if (analysisErrorEl) renderError(analysisErrorEl, null);
        if (analysisNoteEl) renderNote(analysisNoteEl, ANALYSIS_MESSAGES.positionChanged);
      },
    },
  });

  const gameSync = createGameSync({ gameId, ...(token !== undefined ? { token } : {}) });
  const oracle = createGameOracle(gameSync);

  const board = mountBoard(
    { boardEl, statusEl, flipEl },
    {
      oracle,
      onMove: (uci: string) => {
        controller.submitMove(uci);
      },
    },
  );

  controller = new GameController({
    gameSync,
    callbacks: {
      onPosition: (fen: string) => {
        board.setPosition(fen);
        analysisController.positionChanged(fen);
        refreshAnalysisControls();
      },
      onTurn: (myTurn: boolean) => board.setTurn(myTurn),
      onClock: (whiteMs: number, blackMs: number) => {
        if (whiteClockEl) whiteClockEl.textContent = formatClock(whiteMs);
        if (blackClockEl) blackClockEl.textContent = formatClock(blackMs);
        if (clockEl) {
          clockEl.textContent = `${formatClock(whiteMs)} – ${formatClock(blackMs)}`;
        }
      },
      onStatus: (text: string) => {
        if (statusEl) statusEl.textContent = text;
      },
      onLastMove: (from: string | null, to: string | null) => {
        if (from && to) board.setLastMove(from, to);
      },
      onColor: (color) => {
        if (color === 'b') board.setOrientation('black');
      },
      onMetadata: (state) => {
        if (state.variant) {
          currentVariant = state.variant;
          refreshAnalysisControls();
        }

        let liveAnnouncement = '';

        if (metaConnectionEl) {
          const connText = state.connected
            ? 'Connected'
            : state.role !== null
              ? 'Reconnecting…'
              : 'Connecting…';
          if (metaConnectionEl.textContent !== connText) {
            metaConnectionEl.textContent = connText;
            liveAnnouncement += `Connection: ${connText}. `;
          }
        }

        if (metaRoleEl) {
          const roleText = state.role === 'white' ? 'Playing as White'
            : state.role === 'black' ? 'Playing as Black'
            : state.role === 'spectator' ? 'Spectating'
            : 'Waiting…';
          metaRoleEl.textContent = roleText;
        }

        const unknownPresence = !state.connected || !state.presence;

        if (metaWhiteEl && metaWhiteNameEl) {
          const isMe = state.myColor === 'w';
          metaWhiteNameEl.textContent = 'White' + (isMe ? ' (You)' : '');

          const dot = metaWhiteEl.querySelector('.presence-dot');
          const txt = metaWhiteEl.querySelector('.presence-text');
          if (dot && txt) {
            if (unknownPresence) {
              dot.className = 'presence-dot offline';
              txt.textContent = 'Unknown';
            } else {
              const online = state.presence!.white;
              dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
              const newTxt = online ? 'Online' : 'Offline';
              if (txt.textContent !== newTxt) {
                txt.textContent = newTxt;
                liveAnnouncement += `White is ${newTxt}. `;
              }
            }
          }
        }

        if (metaBlackEl && metaBlackNameEl) {
          const isMe = state.myColor === 'b';
          metaBlackNameEl.textContent = 'Black' + (isMe ? ' (You)' : '');

          const dot = metaBlackEl.querySelector('.presence-dot');
          const txt = metaBlackEl.querySelector('.presence-text');
          if (dot && txt) {
            if (unknownPresence) {
              dot.className = 'presence-dot offline';
              txt.textContent = 'Unknown';
            } else {
              const online = state.presence!.black;
              dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
              const newTxt = online ? 'Online' : 'Offline';
              if (txt.textContent !== newTxt) {
                txt.textContent = newTxt;
                liveAnnouncement += `Black is ${newTxt}. `;
              }
            }
          }
        }

        if (metaSpectatorsEl) {
          metaSpectatorsEl.textContent = unknownPresence ? '—' : String(state.presence!.spectators);
        }

        if (metaVariantEl && state.variant) {
          metaVariantEl.textContent = state.variant.charAt(0).toUpperCase() + state.variant.slice(1);
        }
        if (metaTimeEl && state.timeControl) {
          metaTimeEl.textContent = formatTimeControl(state.timeControl);
        }

        if (metaLiveStatusEl && liveAnnouncement) {
          metaLiveStatusEl.textContent = liveAnnouncement.trim();
        }
      },
      onActionState: (state) => {
        if (actionsPanelEl) actionsPanelEl.hidden = !state.isPlayer;
        if (!state.isPlayer) return;

        const disabled = !state.connected || state.isOver || state.pendingAction !== null;

        if (btnOfferDraw) {
          if (state.drawOffer === 'sent') {
            btnOfferDraw.textContent = 'Draw offered';
            btnOfferDraw.disabled = true;
          } else {
            btnOfferDraw.textContent = 'Offer draw';
            btnOfferDraw.disabled = disabled || state.drawOffer !== 'none';
          }
        }
        if (btnClaimFlag) btnClaimFlag.disabled = disabled;

        if (btnResign) {
          btnResign.disabled = disabled;
          if (disabled && confirmResignEl && !confirmResignEl.hidden) {
            confirmResignEl.hidden = true;
            if (confirmResignYes instanceof HTMLButtonElement) confirmResignYes.disabled = true;
            if (confirmResignNo instanceof HTMLButtonElement) confirmResignNo.disabled = true;
            btnResign.hidden = false;
            statusEl?.focus();
          }
        }

        if (btnAbort) {
          btnAbort.hidden = !state.canAbort;
          btnAbort.disabled = disabled;
          if ((disabled || !state.canAbort) && confirmAbortEl && !confirmAbortEl.hidden) {
            confirmAbortEl.hidden = true;
            if (confirmAbortYes instanceof HTMLButtonElement) confirmAbortYes.disabled = true;
            if (confirmAbortNo instanceof HTMLButtonElement) confirmAbortNo.disabled = true;
            btnAbort.hidden = !state.canAbort;
            statusEl?.focus();
          }
        }

        if (drawOfferReceivedEl) {
          drawOfferReceivedEl.hidden = state.drawOffer !== 'received' || state.isOver;
        }
        if (btnAcceptDraw) {
          (btnAcceptDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
        }
        if (btnDeclineDraw) {
          (btnDeclineDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
        }

        if (actionErrorEl) {
          actionErrorEl.hidden = state.lastReject === null;
          actionErrorEl.textContent = state.lastReject ?? '';
        }
      },
    },
  });

  // Wire action buttons and inline confirmations with route-scoped lifecycle ownership
  const unbinds: (() => void)[] = [];
  const bindClick = (el: HTMLElement | null, listener: () => void): void => {
    if (!el) return;
    el.addEventListener('click', listener);
    unbinds.push(() => el.removeEventListener('click', listener));
  };

  bindClick(btnOfferDraw, () => controller.offerDraw());
  bindClick(btnClaimFlag, () => controller.claimFlag());
  bindClick(btnAcceptDraw, () => controller.acceptDraw());
  bindClick(btnDeclineDraw, () => controller.declineDraw());
  bindClick(analysisRunBtn, () => {
    // Read the selector, but trust only the values this UI offers. The `<select>` cannot produce
    // anything else, so this is not about the user interface — it is about the request never
    // carrying a `multiPv` outside the published contract even if the option list is edited in the
    // page. The server clamps and rejects independently; this keeps the client honest at its own
    // boundary rather than relying on the far side to catch it.
    const requested = Number.parseInt(analysisLinesSelect?.value ?? '', 10);
    const lines = ANALYSIS_LINE_CHOICES.includes(requested) ? requested : DEFAULT_ANALYSIS_LINES;
    void analysisController.analyse(lines);
  });

  if (btnResign && confirmResignEl && confirmResignYes && confirmResignNo) {
    bindClick(btnResign, () => {
      btnResign.hidden = true;
      confirmResignEl.hidden = false;
      (confirmResignYes as HTMLButtonElement).disabled = false;
      (confirmResignNo as HTMLButtonElement).disabled = false;
      confirmResignYes.focus();
    });
    bindClick(confirmResignNo, () => {
      confirmResignEl.hidden = true;
      btnResign.hidden = false;
      btnResign.focus();
    });
    bindClick(confirmResignYes, () => {
      if (controller.resign()) {
        // Immediately disable to prevent double clicks before GameSync patches state
        (confirmResignYes as HTMLButtonElement).disabled = true;
        (confirmResignNo as HTMLButtonElement).disabled = true;
        statusEl?.focus();
      }
    });
  }

  if (btnAbort && confirmAbortEl && confirmAbortYes && confirmAbortNo) {
    bindClick(btnAbort, () => {
      btnAbort.hidden = true;
      confirmAbortEl.hidden = false;
      (confirmAbortYes as HTMLButtonElement).disabled = false;
      (confirmAbortNo as HTMLButtonElement).disabled = false;
      confirmAbortYes.focus();
    });
    bindClick(confirmAbortNo, () => {
      confirmAbortEl.hidden = true;
      btnAbort.hidden = false;
      btnAbort.focus();
    });
    bindClick(confirmAbortYes, () => {
      if (controller.abort()) {
        // Immediately disable to prevent double clicks before GameSync patches state
        (confirmAbortYes as HTMLButtonElement).disabled = true;
        (confirmAbortNo as HTMLButtonElement).disabled = true;
        statusEl?.focus();
      }
    });
  }

  controller.start();

  // Capability and auth gating for the analysis panel.
  //
  // `loadCapabilities` is the memoised shared read, not a fresh `client.capabilities()`. This mount
  // runs on every SPA navigation to a game, so an unmemoised call here would ask the same question
  // on every in-app click — the refetch `capabilities-nav.ts` already documents avoiding.
  void loadCapabilities(deps.client)
    .then((flags) => {
      if (analysisDisposed || !analysisEnabled(flags)) return;
      analysisCapabilities = flags;
      analysisAvailable = true;
      if (analysisSectionEl) {
        analysisSectionEl.hidden = false;
      }
      refreshAnalysisControls();
    })
    .catch(() => {
      // Fail quiet: leave section hidden
    });

  // React to real browser connectivity changes: on `offline`, drop into the
  // reconnect flow immediately (a browser going offline should show
  // "Reconnecting…" now, not after a full heartbeat interval); on `online`,
  // retry at once instead of waiting out the backoff.
  let gameRouteActive = true;
  let disposed = false;
  const connectivityTarget = typeof window !== 'undefined' ? window : null;
  const onOffline = (): void => gameSync.networkOffline();
  const onOnline = (): void => gameSync.networkOnline();
  if (connectivityTarget) {
    connectivityTarget.addEventListener('offline', onOffline);
    connectivityTarget.addEventListener('online', onOnline);
  }
  const connectivity = {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      gameRouteActive = false;
      connectivityTarget?.removeEventListener('offline', onOffline);
      connectivityTarget?.removeEventListener('online', onOnline);
      for (const unbind of unbinds) {
        unbind();
      }
      unbinds.length = 0;
    },
  };

  const analysis = {
    dispose: (): void => {
      if (analysisDisposed) return;
      analysisDisposed = true;
      analysisController.dispose();
    },
  };

  if (token !== undefined) {
    gameSync.start();
  } else {
    // M12 inc 2: the access token arrives asynchronously via the httpOnly
    // refresh cookie (restore → refresh). Open the authenticated socket once
    // it resolves; fall back to a spectator connection if restore fails.
    void restorePromise
      .then(() => {
        const t = getAccessToken();
        if (t !== undefined) gameSync.setToken(t);
        if (!analysisDisposed) refreshAnalysisControls();
      })
      .catch(() => {
        if (!analysisDisposed) refreshAnalysisControls();
      })
      .finally(() => {
        if (gameRouteActive) gameSync.start();
      });
  }

  return {
    board,
    controller,
    connectivity,
    analysis,
    onSessionChange: () => {
      if (!analysisDisposed) refreshAnalysisControls();
    },
  };
}
