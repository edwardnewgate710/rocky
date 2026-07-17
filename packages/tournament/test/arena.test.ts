import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { ArenaTournament, ArenaConfig, ArenaPairing } from '../src/arena';

describe('ArenaTournament', () => {
  const config: ArenaConfig = {
    id: 'a1',
    name: 'Test Arena',
    format: 'arena',
    variant: 'standard',
    timeControl: { initialMs: 180000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    durationMs: 3600000 // 1 hour
  };

  test('lifecycle and late joins', () => {
    const t = new ArenaTournament(config);
    assert.strictEqual(t.getState(), 'registration');
    
    t.register('Alice');
    t.register('Bob');
    
    // Not started yet
    assert.deepStrictEqual(t.pairAvailable(0), []);

    t.start(100);
    assert.strictEqual(t.getState(), 'running');
    
    // Late join
    t.register('Charlie');
    
    const p1 = t.pairAvailable(100);
    assert.strictEqual(p1.length, 1);
    const g1 = p1[0];
    
    // Alice, Bob, Charlie. Colors assigned deterministically for the first round,
    // so one gets left out (waiting).
    assert.ok(g1.white === 'Alice' || g1.white === 'Bob' || g1.white === 'Charlie');
    assert.ok(g1.black === 'Alice' || g1.black === 'Bob' || g1.black === 'Charlie');
    
    // The pool now has one available player.
    const p2 = t.pairAvailable(100);
    assert.strictEqual(p2.length, 0); // Need at least 2 available to pair
  });

  test('streak scoring: W, W, W, D', () => {
    const t = new ArenaTournament(config);
    t.register('A');
    t.register('B');
    t.start(0);

    // A wins game 1 (2 points)
    const p1 = t.pairAvailable(0)[0];
    const isAWhite = p1.white === 'A';
    t.recordResult(p1.pairingId, isAWhite ? 'white_win' : 'black_win', 0);
    
    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.points, 2);
    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.onFire, false); // 1 win so far

    // A wins game 2 (2 points) -> onFire becomes true at the end
    const p2 = t.pairAvailable(0)[0];
    const isAWhite2 = p2.white === 'A';
    t.recordResult(p2.pairingId, isAWhite2 ? 'white_win' : 'black_win', 0);

    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.points, 4);
    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.onFire, true); // 2 wins

    // A wins game 3 (4 points) -> total 8
    const p3 = t.pairAvailable(0)[0];
    const isAWhite3 = p3.white === 'A';
    t.recordResult(p3.pairingId, isAWhite3 ? 'white_win' : 'black_win', 0);

    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.points, 8);
    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.onFire, true);

    // A draws game 4 (2 points because of streak) -> total 10. streak ends.
    const p4 = t.pairAvailable(0)[0];
    t.recordResult(p4.pairingId, 'draw', 0);

    const standings = t.standings();
    const stA = standings.find(s => s.playerId === 'A')!;
    assert.strictEqual(stA.points, 10);
    assert.strictEqual(stA.onFire, false); // Streak ended by draw
  });

  test('streak scoring: loss ends streak', () => {
    const t = new ArenaTournament(config);
    t.register('A');
    t.register('B');
    t.start(0);

    // Win
    const p1 = t.pairAvailable(0)[0];
    t.recordResult(p1.pairingId, p1.white === 'A' ? 'white_win' : 'black_win', 0);

    // Win
    const p2 = t.pairAvailable(0)[0];
    t.recordResult(p2.pairingId, p2.white === 'A' ? 'white_win' : 'black_win', 0);

    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.onFire, true);
    assert.strictEqual(t.standings().find(s => s.playerId === 'A')!.points, 4);

    // Loss
    const p3 = t.pairAvailable(0)[0];
    t.recordResult(p3.pairingId, p3.white === 'B' ? 'white_win' : 'black_win', 0); // B wins

    const stA = t.standings().find(s => s.playerId === 'A')!;
    assert.strictEqual(stA.points, 4); // Added 0
    assert.strictEqual(stA.onFire, false); // Streak ended
  });

  test('pairing colors balance and rematch avoided if possible', () => {
    const t = new ArenaTournament(config);
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start(0);

    // Round 1
    const r1 = t.pairAvailable(0);
    assert.strictEqual(r1.length, 2);
    // Let's resolve these matches
    t.recordResult(r1[0].pairingId, 'white_win', 0);
    t.recordResult(r1[1].pairingId, 'black_win', 0);

    // Players are returned to the pool.
    // In round 2, the pairing logic will try to avoid rematches.
    const r2 = t.pairAvailable(0);
    assert.strictEqual(r2.length, 2);
    
    // Check that r2 does not contain the same pairings as r1
    const hasSamePairing = (p1: ArenaPairing, p2: ArenaPairing) => {
      return (p1.white === p2.white && p1.black === p2.black) ||
             (p1.white === p2.black && p1.black === p2.white);
    };

    const isRematch = hasSamePairing(r1[0], r2[0]) || hasSamePairing(r1[0], r2[1]) ||
                      hasSamePairing(r1[1], r2[0]) || hasSamePairing(r1[1], r2[1]);
    
    assert.strictEqual(isRematch, false, 'Should avoid rematches if alternative partners exist');
  });

  test('withdraw: player never paired again', () => {
    const t = new ArenaTournament(config);
    t.register('A');
    t.register('B');
    t.register('C');
    t.start(0);

    t.withdraw('A');

    const p = t.pairAvailable(0);
    // B and C pair. A is excluded.
    assert.strictEqual(p.length, 1);
    assert.ok(p[0].white === 'B' || p[0].black === 'B');
    assert.ok(p[0].white === 'C' || p[0].black === 'C');
  });

  test('time constraints: expires and settles properly', () => {
    const t = new ArenaTournament(config); // 1 hour duration
    t.register('A');
    t.register('B');
    
    t.start(100);
    
    const p1 = t.pairAvailable(100);
    assert.strictEqual(p1.length, 1);
    
    // Jump time to expired
    const expiredTime = 100 + 3600000;
    
    // pairAvailable returns empty because expired
    const p2 = t.pairAvailable(expiredTime);
    assert.strictEqual(p2.length, 0);

    // State is still running because active game exists
    assert.strictEqual(t.getState(), 'running');
    
    // Resolve the active game
    t.recordResult(p1[0].pairingId, 'draw', expiredTime);
    
    // Now it should be finished
    assert.strictEqual(t.getState(), 'finished');
  });

  test('idle arena finishes via pairAvailable once expired', () => {
    const t = new ArenaTournament(config);
    t.register('A'); // a lone player can never be paired
    t.start(100);

    // Before the deadline, an unpairable arena simply stays running.
    assert.deepStrictEqual(t.pairAvailable(200), []);
    assert.strictEqual(t.getState(), 'running');

    // Polling after the deadline (no active games) settles it to finished.
    const expired = 100 + config.durationMs;
    assert.deepStrictEqual(t.pairAvailable(expired), []);
    assert.strictEqual(t.getState(), 'finished');
  });

  test('snapshot round-trips and is an independent copy', () => {
    const t = new ArenaTournament(config);
    t.register('A');
    t.register('B');
    t.register('C');
    t.start(0);

    // Take a snapshot while there is an active game.
    const p = t.pairAvailable(0);
    const snap = t.toSnapshot();

    // Restore is a faithful, independent rebuild.
    const restored = ArenaTournament.restore(snap);
    assert.strictEqual(restored.getState(), 'running');
    assert.strictEqual(restored.standings().length, 3);
    restored.recordResult(p[0].pairingId, 'white_win', 0);
    assert.strictEqual(restored.standings()[0].points, 2);

    // Mutating the ORIGINAL after snapshotting must not leak into the snapshot.
    const winner = p[0].white;
    const capturedPoints = snap.playerStates[winner].points;
    t.recordResult(p[0].pairingId, 'white_win', 0);
    assert.strictEqual(
      snap.playerStates[winner].points,
      capturedPoints,
      'toSnapshot must deep-copy mutable player state',
    );
  });
});
