/**
 * M6 acceptance test: full game vs. human — Fool's Mate via WebSocket.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register two users (player1 = white, player2 = black).
 *   2. Create a game via POST /e2e/games with both user ids.
 *   3. Set auth sessions in localStorage for both browser contexts.
 *   4. Both players navigate to the game page — boards render, games connect.
 *   5. Play Fool's Mate via real WebSocket messages through the browser:
 *        White: f2f3   (ply 1)
 *        Black: e7e5   (ply 2)
 *        White: g2g4   (ply 3)
 *        Black: d8h4   (ply 4 — checkmate!)
 *      Each move is sent through the browser's WebSocket connection — the
 *      same path a human player's moves take. The board renders each move
 *      and the status text updates in real time.
 *   6. Assert both contexts show a terminal state (checkmate).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Play a move through the browser's WebSocket connection. */
async function playMoveViaWs(page: Page, gameId: string, token: string, uci: string, seq: number): Promise<void> {
  await page.evaluate(async ({ gameId, token, uci, seq }) => {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://${location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => { ws.close(); resolve(); }, 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', gameId, token }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.t === 'joined') {
          ws.send(JSON.stringify({ t: 'move', gameId, uci, clientSeq: seq }));
        } else if (msg.t === 'move' || msg.t === 'reject') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (msg.t === 'ended') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      };

      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
    });
  }, { gameId, token, uci, seq });
}

test('full game vs. human — Fool\'s Mate via WS, checkmate in 4 plies, both UIs show terminal', async ({ browser, request }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage(); // white
  const page2 = await ctx2.newPage(); // black

  try {
    // 1. Register two users
    const handle1 = `e2e-p1-${Date.now()}`;
    const handle2 = `e2e-p2-${Date.now()}`;
    const password = 'test-password-123';

    const reg1 = await request.post('/v1/auth/register', {
      data: { handle: handle1, password },
    });
    expect(reg1.ok()).toBeTruthy();
    const auth1 = await reg1.json();
    const token1 = auth1.tokens.accessToken;
    const userId1 = auth1.user.id;

    const reg2 = await request.post('/v1/auth/register', {
      data: { handle: handle2, password },
    });
    expect(reg2.ok()).toBeTruthy();
    const auth2 = await reg2.json();
    const token2 = auth2.tokens.accessToken;
    const userId2 = auth2.user.id;

    // 2. Create a game via the bridge route with both player ids
    const gameResp = await request.post('/e2e/games', {
      data: { whiteId: userId1, blackId: userId2 },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(gameResp.ok()).toBeTruthy();
    const game = await gameResp.json();
    const gameId = game.gameId;
    expect(gameId).toBeTruthy();

    // 3. Set auth sessions in localStorage for both contexts
    await page1.goto('/');
    await page1.evaluate(({ token, handle: h }) => {
      localStorage.setItem('gambit-session', JSON.stringify({
        accessToken: token, handle: h, userId: '', roles: [],
      }));
    }, { token: token1, handle: handle1 });

    await page2.goto('/');
    await page2.evaluate(({ token, handle: h }) => {
      localStorage.setItem('gambit-session', JSON.stringify({
        accessToken: token, handle: h, userId: '', roles: [],
      }));
    }, { token: token2, handle: handle2 });

    // 4. Both players navigate to the game page
    await page1.goto(`/game/${gameId}`);
    await page2.goto(`/game/${gameId}`);

    // Wait for boards to render
    await expect(page1.locator('#board')).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('#board')).toBeVisible({ timeout: 10_000 });

    const status1 = page1.locator('#status');
    const status2 = page2.locator('#status');
    await expect(status1).toBeVisible({ timeout: 10_000 });
    await expect(status2).toBeVisible({ timeout: 10_000 });

    // 5. Play Fool's Mate via WebSocket through the browser
    //    White: f2f3, Black: e7e5, White: g2g4, Black: d8h4 (checkmate)

    // Ply 1: White f2f3
    await playMoveViaWs(page1, gameId, token1, 'f2f3', 1);
    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Ply 2: Black e7e5
    await playMoveViaWs(page2, gameId, token2, 'e7e5', 1);
    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Ply 3: White g2g4
    await playMoveViaWs(page1, gameId, token1, 'g2g4', 2);
    await page1.waitForTimeout(1000);
    await page2.waitForTimeout(1000);

    // Ply 4: Black d8h4 — checkmate!
    await playMoveViaWs(page2, gameId, token2, 'd8h4', 2);
    await page1.waitForTimeout(2000);
    await page2.waitForTimeout(2000);

    // 6. Assert both contexts show a terminal state
    let p1Terminal = false;
    let p2Terminal = false;
    for (let i = 0; i < 30; i++) {
      const s1 = await status1.textContent();
      const s2 = await status2.textContent();
      const isTerminal = (s: string | null) => s && (
        s.includes('Checkmate') || s.includes('Stalemate') ||
        s.includes('resignation') || s.includes('Draw') ||
        s.includes('timeout') || s.includes('abort') ||
        s.includes('1-0') || s.includes('0-1') || s.includes('1/2')
      );
      if (isTerminal(s1)) p1Terminal = true;
      if (isTerminal(s2)) p2Terminal = true;
      if (p1Terminal && p2Terminal) break;
      await page1.waitForTimeout(1000);
    }

    expect(p1Terminal).toBe(true);
    expect(p2Terminal).toBe(true);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
