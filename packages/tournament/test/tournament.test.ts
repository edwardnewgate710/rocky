import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { Tournament } from '../src/tournament';
import { RoundRobinPairing } from '../src/round-robin';
import type { RoundRobinConfig } from '../src/config';

describe('Tournament Aggregate (round-by-round)', () => {
  const config: RoundRobinConfig = {
    id: 't1',
    name: 'Test Tournament',
    format: 'round_robin',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }
  };

  test('state machine: registration -> running -> finished (round-by-round)', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    
    assert.strictEqual(t.getState(), 'registration');
    t.register('Alice');
    t.register('Bob');
    t.register('Charlie');

    t.start();
    assert.strictEqual(t.getState(), 'running');

    // N=3: 3 rounds total, but only round 0 is generated on start
    assert.throws(() => t.register('Dave'), /Cannot register after tournament has started/);
    assert.throws(() => t.withdraw('Alice'), /Cannot withdraw after tournament has started/);
    assert.throws(() => t.start(), /Tournament already started/);

    // Initially only round 0 is visible
    assert.ok(t.getRounds().length >= 1, 'At least round 0 exists after start');

    // Resolve all rounds one at a time
    let totalGames = 0;
    while (t.getState() === 'running') {
      const rounds = t.getRounds();
      const currentRound = rounds[rounds.length - 1];
      for (let i = 0; i < currentRound.pairings.length; i++) {
        if (currentRound.pairings[i].kind === 'game') {
          t.recordResult(currentRound.roundIndex, i, 'white_win');
          totalGames++;
        }
      }
    }

    assert.strictEqual(t.getState(), 'finished');
    assert.strictEqual(t.getRounds().length, 3, '3 rounds total for 3 players');
    assert.strictEqual(totalGames, 3, '3 games total for 3 players');
  });

  test('rounds appear incrementally', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');

    t.start();

    // After start, only round 0 should exist
    assert.strictEqual(t.getRounds().length, 1);
    assert.strictEqual(t.getRounds()[0].roundIndex, 0);

    // Resolve round 0
    const r0 = t.getRounds()[0];
    for (let i = 0; i < r0.pairings.length; i++) {
      if (r0.pairings[i].kind === 'game') {
        t.recordResult(0, i, 'draw');
      }
    }

    // Round 1 should now be available
    assert.strictEqual(t.getRounds().length, 2);
    assert.strictEqual(t.getRounds()[1].roundIndex, 1);
  });

  test('rejects start with less than 2 players', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    assert.throws(() => t.start(), /Need at least 2 players/);
  });

  test('rejects recording results before start', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    t.register('Bob');
    assert.throws(() => t.recordResult(0, 0, 'draw'), /Cannot record result unless tournament is running/);
  });

  test('rejects recording results for unknown pairing', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    t.register('Bob');
    t.start();
    assert.throws(() => t.recordResult(99, 0, 'white_win'), /Unknown pairing/);
  });

  test('standings work during a running tournament', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    // Before any results, every player starts from zero — no points, games, or byes.
    const s = t.standings();
    assert.strictEqual(s.length, 2);
    assert.ok(
      s.every(entry => entry.points === 0 && entry.gamesPlayed === 0 && entry.byes === 0),
      'all standings should start at zero before any result is recorded'
    );
  });

  test('game linking and lookup', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C'); // A, B, C -> round robin has byes
    t.start();

    const rounds = t.getRounds();
    const r0 = rounds[0];
    
    // Find a game pairing and a bye pairing
    const gameIdx = r0.pairings.findIndex(p => p.kind === 'game');
    const byeIdx = r0.pairings.findIndex(p => p.kind === 'bye');
    
    // Link game
    t.linkGame(0, gameIdx, 'game-123');
    
    // Verify lookups
    assert.strictEqual(t.gameIdFor(0, gameIdx), 'game-123');
    assert.deepStrictEqual(t.pairingForGame('game-123'), { roundIndex: 0, pairingIndex: gameIdx });
    
    // Unknown lookups
    assert.strictEqual(t.gameIdFor(0, 99), undefined);
    assert.strictEqual(t.pairingForGame('game-999'), null);
    
    // Bye linking fails
    assert.throws(() => t.linkGame(0, byeIdx, 'game-bye'), /Cannot link game to a bye/);
    
    // Unknown pairing fails
    assert.throws(() => t.linkGame(99, 0, 'game-unknown'), /Unknown pairing/);
  });

  test('re-linking a match retires the old gameId from the reverse map', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    t.linkGame(0, 0, 'game-old');
    assert.deepStrictEqual(t.pairingForGame('game-old'), { roundIndex: 0, pairingIndex: 0 });

    // Re-link the same match to a new game (e.g. the first launch was abandoned).
    t.linkGame(0, 0, 'game-new');
    assert.strictEqual(t.gameIdFor(0, 0), 'game-new');
    assert.deepStrictEqual(t.pairingForGame('game-new'), { roundIndex: 0, pairingIndex: 0 });

    // The stale id must no longer resolve to a pairing or record a result.
    assert.strictEqual(t.pairingForGame('game-old'), null);
    assert.throws(() => t.recordResultByGame('game-old', 'white_win'), /Unknown game ID/);
  });

  test('recordResultByGame works', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    t.linkGame(0, 0, 'game-1');
    t.recordResultByGame('game-1', 'white_win');
    
    assert.strictEqual(t.getState(), 'finished');
    const snap = t.toSnapshot();
    assert.strictEqual(snap.results[0][1], 'white_win');
  });

  test('recordResultByGame throws for unknown game', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    assert.throws(() => t.recordResultByGame('unknown-game', 'white_win'), /Unknown game ID/);
  });

  test('snapshot backwards compatibility and game links persistence', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();
    t.linkGame(0, 0, 'game-xyz');
    
    const snap = t.toSnapshot();
    assert.ok(snap.gameLinks);
    assert.strictEqual(snap.gameLinks[0][1], 'game-xyz');

    // Restore from snapshot with links
    const t2 = Tournament.restore(snap, new RoundRobinPairing());
    assert.strictEqual(t2.gameIdFor(0, 0), 'game-xyz');
    
    // Restore from snapshot WITHOUT links (simulating old data)
    const oldSnap = { ...snap, gameLinks: undefined };
    const t3 = Tournament.restore(oldSnap, new RoundRobinPairing());
    assert.strictEqual(t3.gameIdFor(0, 0), undefined);
    assert.strictEqual(t3.pairingForGame('game-xyz'), null);
  });
});
