/**
 * Game route DOM mount.
 *
 * Wires the interactive board, the game synchronization client, the game
 * metadata/clock/status indicators, and player action controls (draw, resign,
 * abort, claim flag) for `/game/:id` routes.
 */
import type { App } from './composition.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { GameController } from './game-controller.js';
import { formatClock, formatTimeControl } from './render-helpers.js';
import type { AuthSession } from './auth-controller.js';

/** Dependencies required to mount the game route. */
interface GameMountDependencies {
  readonly doc: Document;
  readonly boardEl: HTMLElement;
  readonly gameId: string;
  readonly createGameSync: App['createGameSync'];
  readonly createGameOracle: App['createGameOracle'];
  readonly getAccessToken: () => string | undefined;
  readonly token?: string;
  readonly restorePromise: Promise<AuthSession | null>;
}

/** The result of mounting the game route. */
interface MountedGame {
  readonly board: MountedBoard;
  readonly controller: GameController;
  readonly connectivity: { dispose: () => void };
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

  const gameSync = createGameSync({ gameId, ...(token !== undefined ? { token } : {}) });
  const oracle = createGameOracle(gameSync);

  let controller: GameController;

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
      onPosition: (fen: string) => board.setPosition(fen),
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
      })
      .catch(() => undefined)
      .finally(() => {
        if (gameRouteActive) gameSync.start();
      });
  }

  return { board, controller, connectivity };
}
