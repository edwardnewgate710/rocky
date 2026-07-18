import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { createHarness, type Harness } from '../src/index.js';
import { TournamentService, ArenaService } from '@chess-platform/api';

// We can use setTimeout to wait for the reporter to process pubsub messages
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Real-time tournament integration', () => {
  let harness: Harness;
  let service: TournamentService;

  before(async () => {
    // createHarness with ephemeral ports
    harness = await createHarness({ apiPort: 0, wsPort: 0 });
    service = new TournamentService(harness.deps.tournamentRepo, harness.deps.gameLauncher);
  });

  after(async () => {
    await harness.close();
  });

  it('plays a 3-player round-robin through to completion automatically', async () => {
    const tId = 'tourney-1';
    
    // 1. Create a tournament
    let t = await service.create({
      id: tId,
      name: 'Test',
      format: 'round_robin',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    });

    // 2. Register 3 players
    t = await service.register(tId, 'u1');
    t = await service.register(tId, 'u2');
    t = await service.register(tId, 'u3');

    // 3. Start tournament
    t = await service.start(tId);

    // 4. Round 1 should be generated
    let rounds = t.getRounds();
    strictEqual(rounds.length, 1);
    
    let r1 = rounds[0];
    let r1PairingIndex = r1.pairings.findIndex((p: any) => p.kind === 'game');
    let r1ByeIndex = r1.pairings.findIndex((p: any) => p.kind === 'bye');
    
    ok(r1PairingIndex !== -1, 'Round 1 must have a game pairing');
    ok(r1ByeIndex !== -1, 'Round 1 must have a bye pairing');

    let gamePairing1 = r1.pairings[r1PairingIndex];
    ok(gamePairing1.kind === 'game', 'Must be a game');
    let gameId1 = t.gameIdFor(0, r1PairingIndex);
    ok(gameId1, 'Game must be launched');

    // Check authority knows the game
    ok(await harness.authority.knows(gameId1), 'Authority must know game 1');
    let state1 = harness.authority.getState(gameId1);
    strictEqual(state1.players.white, gamePairing1.white);
    strictEqual(state1.players.black, gamePairing1.black);

    let broadcasts: any[] = [];
    harness.pubsub.subscribe(`tournament:${tId}`, (msg) => {
      broadcasts.push(msg);
    });

    // Verify REST API /live endpoint sees the tracked game
    const liveUrl = `http://127.0.0.1:${harness.apiPort}/v1/tournaments/${tId}/live`;
    const liveRes = await fetch(liveUrl);
    strictEqual(liveRes.status, 200, 'Live endpoint should return 200');
    const liveData: any = await liveRes.json();
    ok(Array.isArray(liveData.games));
    ok(Array.isArray(liveData.standings));
    strictEqual(liveData.games.length, 1, 'Should return 1 active game');
    strictEqual(liveData.games[0].gameId, gameId1, 'Live board matches gameId1');

    // Drive game 1 to completion (white win: black resigns)
    await harness.authority.apply(gameId1, state1.players.black, { kind: 'resign' });

    // Wait for reporter to process pubsub message
    await delay(50);

    // Assert broadcaster pushed tournament updates
    ok(broadcasts.length > 0, 'Broadcaster should push tournament updates when game ends');
    const lastUpdate = broadcasts[broadcasts.length - 1];
    strictEqual(lastUpdate.t, 'tournamentUpdate');
    strictEqual(lastUpdate.tournamentId, tId);
    ok(Array.isArray(lastUpdate.games));

    t = await service.load(tId);
    
    // Assert result is recorded
    rounds = t.getRounds();
    let snap = t.toSnapshot();
    let result1 = snap.results.find(([mId]) => mId === `0-${r1PairingIndex}`)?.[1];
    strictEqual(result1, 'white_win', 'Result should be white_win');

    // Round 2 should be automatically launched
    strictEqual(rounds.length, 2, 'Round 2 should be launched');
    let r2 = rounds[1];
    let r2PairingIndex = r2.pairings.findIndex((p: any) => p.kind === 'game');
    let gamePairing2 = r2.pairings[r2PairingIndex];
    ok(gamePairing2.kind === 'game', 'Must be a game');
    let gameId2 = t.gameIdFor(1, r2PairingIndex);
    ok(gameId2, 'Game 2 must be launched');
    ok(await harness.authority.knows(gameId2), 'Authority must know game 2');
    
    // Test aborted ('*') handling: no result is recorded, but the pairing is
    // automatically relaunched with a fresh game so the round can still finish.
    let state2 = harness.authority.getState(gameId2);
    await harness.authority.apply(gameId2, state2.players.white, { kind: 'abort' });

    await delay(50);
    t = await service.load(tId);
    snap = t.toSnapshot();
    let result2 = snap.results.find(([mId]) => mId === `1-${r2PairingIndex}`)?.[1];
    strictEqual(result2, undefined, 'Aborted game should not record a result');

    // The aborted game is unlinked and a fresh game (attempt 1) is launched.
    strictEqual(t.pairingForGame(gameId2), null, 'Aborted game is unlinked');
    let gameId2b = t.gameIdFor(1, r2PairingIndex);
    ok(gameId2b && gameId2b !== gameId2, 'A fresh game is launched after abort');
    ok(await harness.authority.knows(gameId2b), 'Authority must know the replacement game');

    // Drive the replacement game to a black win (white resigns) → round 3 launches.
    let state2b = harness.authority.getState(gameId2b);
    await harness.authority.apply(gameId2b, state2b.players.white, { kind: 'resign' });

    await delay(50);
    t = await service.load(tId);
    rounds = t.getRounds();
    let result2b = t.toSnapshot().results.find(([mId]) => mId === `1-${r2PairingIndex}`)?.[1];
    strictEqual(result2b, 'black_win', 'Replacement game result should be recorded');
    strictEqual(rounds.length, 3, 'Round 3 should be launched');

    let r3 = rounds[2];
    let r3PairingIndex = r3.pairings.findIndex((p: any) => p.kind === 'game');
    let gamePairing3 = r3.pairings[r3PairingIndex];
    ok(gamePairing3.kind === 'game', 'Must be a game');
    let gameId3 = t.gameIdFor(2, r3PairingIndex);
    ok(gameId3, 'Game 3 must be launched');

    // Test 'draw' mapping: Drive game 3 to draw
    let state3 = harness.authority.getState(gameId3);
    await harness.authority.apply(gameId3, state3.players.white, { kind: 'offerDraw' });
    await harness.authority.apply(gameId3, state3.players.black, { kind: 'acceptDraw' });

    await delay(50);
    
    t = await service.load(tId);
    rounds = t.getRounds();
    snap = t.toSnapshot();
    let result3 = snap.results.find(([mId]) => mId === `2-${r3PairingIndex}`)?.[1];
    strictEqual(result3, 'draw', 'Result should be draw');

    // Test idempotency/finished state: recording result for finished tournament throws conflict
    try {
      await service.recordResultByGame(tId, gameId3, 'white_win');
      ok(false, 'Should have thrown');
    } catch (e: any) {
      ok(e.message.includes('unless tournament is running'), 'Should throw unless running');
    }

    // Finally, verify standings are updated
    let standings = t.standings();
    ok(standings.length === 3);
    const totalPoints = standings.reduce((acc: number, s: any) => acc + s.points, 0);
    ok(totalPoints > 0, 'Points should be awarded');
  });

  it('runs an arena tournament to completion', async () => {
    const arenaService = new ArenaService(harness.deps.tournamentRepo, harness.deps.gameLauncher, () => harness.deps.clock.now());
    const tId = 'arena-1';

    let t = await arenaService.create({
      id: tId,
      name: 'Arena Test',
      format: 'arena',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      durationMs: 500, // short duration for test
    });

    // Register players
    await arenaService.register(tId, 'u1');
    await arenaService.register(tId, 'u2');

    // Start
    t = await arenaService.start(tId, harness.deps.clock.now());
    strictEqual(t.getState(), 'running');

    // Get the launched game from snapshot
    let snap = t.toSnapshot();
    const activeGames = Object.entries(snap.activeGames);
    strictEqual(activeGames.length, 1, 'Should launch 1 game immediately');
    const [pairingId] = activeGames[0];
    
    // Check links
    const gameId = t.gameIdFor(pairingId);
    ok(gameId, 'Game should be linked');

    // Abort the game to test returning to pool
    const state = harness.authority.getState(gameId);
    await harness.authority.apply(gameId, state.players.white, { kind: 'abort' });

    await delay(50);
    
    // Load again, should be a new game linked
    t = await arenaService.getTournament(tId);
    snap = t.toSnapshot();
    const activeGames2 = Object.entries(snap.activeGames);
    strictEqual(activeGames2.length, 1, 'Should re-launch a game after abort');
    const [pairingId2] = activeGames2[0];
    ok(pairingId2 !== pairingId, 'Should be a fresh pairing');

    const gameId2 = t.gameIdFor(pairingId2)!;
    ok(gameId2 !== gameId, 'Should have a fresh gameId');

    // Make white win
    const state2 = harness.authority.getState(gameId2);
    await harness.authority.apply(gameId2, state2.players.black, { kind: 'resign' });

    await delay(50);

    // Wait until expiration
    await delay(500);

    // After expiration, no new games should launch, but we must finish the active one
    // to let the arena settle.
    t = await arenaService.getTournament(tId);
    snap = t.toSnapshot();
    const finalActive = Object.entries(snap.activeGames);
    strictEqual(finalActive.length, 1, 'Should have 1 game active at deadline');
    const finalGameId = t.gameIdFor(finalActive[0][0])!;
    
    // Make white win the final game
    const finalState = harness.authority.getState(finalGameId);
    await harness.authority.apply(finalGameId, finalState.players.black, { kind: 'resign' });
    
    await delay(50);

    // Read to settle
    t = await arenaService.getTournament(tId);
    strictEqual(t.getState(), 'finished', 'Arena should settle on read after deadline when all games end');

    const st = t.standings();
    strictEqual(st.length, 2);
    ok(st.find(s => s.points > 0), 'Someone should have points');
  });
});
