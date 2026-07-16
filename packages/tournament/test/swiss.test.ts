import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { SwissPairing } from '../src/swiss';
import { createPairingStrategy } from '../src/factory';
import { Tournament } from '../src/tournament';
import type { SwissConfig } from '../src/config';
import type { GamePairing, GameResult } from '../src/index';

/**
 * Helper: run a full Swiss tournament through the Tournament aggregate,
 * resolving each game with the given result function (or 'white_win' by default).
 * Returns the final tournament for inspection.
 */
function runSwissTournament(
  playerIds: string[],
  totalRounds: number,
  resultFn?: (white: string, black: string, roundIndex: number) => GameResult
): Tournament {
  const config: SwissConfig = {
    id: 'swiss-test',
    name: 'Swiss Test',
    format: 'swiss',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rounds: totalRounds
  };

  // Build the strategy from config via the factory — config.rounds is the single
  // source of truth for the round count (no independently supplied value).
  const t = new Tournament(config, createPairingStrategy(config));
  for (const p of playerIds) {
    t.register(p);
  }
  t.start();

  while (t.getState() === 'running') {
    const rounds = t.getRounds();
    const currentRound = rounds[rounds.length - 1];
    for (let i = 0; i < currentRound.pairings.length; i++) {
      const pairing = currentRound.pairings[i];
      if (pairing.kind === 'game') {
        const result = resultFn
          ? resultFn(pairing.white, pairing.black, currentRound.roundIndex)
          : 'white_win';
        t.recordResult(currentRound.roundIndex, i, result);
      }
    }
  }

  return t;
}

describe('SwissPairing', () => {
  test('no two players are ever paired twice (8 players, 4 rounds)', () => {
    const players = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
    const t = runSwissTournament(players, 4);

    const meets = new Map<string, number>();
    for (const round of t.getRounds()) {
      for (const p of round.pairings) {
        if (p.kind === 'game') {
          const pair = [p.white, p.black].sort().join('-');
          meets.set(pair, (meets.get(pair) || 0) + 1);
        }
      }
    }

    for (const [pair, count] of meets.entries()) {
      assert.strictEqual(count, 1, `Rematch detected: ${pair} met ${count} times`);
    }
  });

  test('score-group pairing: after round 1, paired players have equal or adjacent scores', () => {
    const players = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
    const config: SwissConfig = {
      id: 'sg-test',
      name: 'Score Group Test',
      format: 'swiss',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 3
    };

    const t = new Tournament(config, new SwissPairing(3));
    for (const p of players) t.register(p);
    t.start();

    // Resolve round 0 with white wins
    const r0 = t.getRounds()[0];
    for (let i = 0; i < r0.pairings.length; i++) {
      if (r0.pairings[i].kind === 'game') {
        t.recordResult(0, i, 'white_win');
      }
    }

    // Now check round 1 pairings: players should be paired by score group
    const r1 = t.getRounds()[1];
    const standings = t.standings();
    const pointsMap = new Map<string, number>();
    for (const s of standings) {
      pointsMap.set(s.playerId, s.points);
    }

    for (const p of r1.pairings) {
      if (p.kind === 'game') {
        const wPoints = pointsMap.get(p.white) ?? 0;
        const bPoints = pointsMap.get(p.black) ?? 0;
        const diff = Math.abs(wPoints - bPoints);
        assert.ok(diff <= 1, `Score group violation: ${p.white}(${wPoints}) vs ${p.black}(${bPoints}), diff=${diff}`);
      }
    }
  });

  test('byes: assigned to lowest-scored eligible, at most one per player, only when odd', () => {
    // 7 players (odd) → 1 bye per round
    const players = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'];
    const t = runSwissTournament(players, 4);

    const byeCounts = new Map<string, number>();
    players.forEach(p => byeCounts.set(p, 0));
    let totalByes = 0;

    for (const round of t.getRounds()) {
      let roundByes = 0;
      for (const p of round.pairings) {
        if (p.kind === 'bye') {
          byeCounts.set(p.player, (byeCounts.get(p.player) || 0) + 1);
          roundByes++;
          totalByes++;
        }
      }
      // Exactly one bye per round when odd
      assert.strictEqual(roundByes, 1, `Expected 1 bye in round ${round.roundIndex}`);
    }

    // At most one bye per player
    for (const [player, count] of byeCounts.entries()) {
      assert.ok(count <= 1, `Player ${player} got ${count} byes (max 1 allowed)`);
    }

    // Total byes = number of rounds (4)
    assert.strictEqual(totalByes, 4);
  });

  test('byes: no byes for even player count', () => {
    const players = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
    const t = runSwissTournament(players, 3);

    for (const round of t.getRounds()) {
      for (const p of round.pairings) {
        assert.notStrictEqual(p.kind, 'bye', `Unexpected bye in round ${round.roundIndex}`);
      }
    }
  });

  test('color balance: |white - black| <= 1 per player', () => {
    const players = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
    const t = runSwissTournament(players, 5);

    const whiteCount = new Map<string, number>();
    const blackCount = new Map<string, number>();
    players.forEach(p => { whiteCount.set(p, 0); blackCount.set(p, 0); });

    for (const round of t.getRounds()) {
      for (const p of round.pairings) {
        if (p.kind === 'game') {
          whiteCount.set(p.white, (whiteCount.get(p.white) || 0) + 1);
          blackCount.set(p.black, (blackCount.get(p.black) || 0) + 1);
        }
      }
    }

    for (const player of players) {
      const w = whiteCount.get(player) || 0;
      const b = blackCount.get(player) || 0;
      assert.ok(
        Math.abs(w - b) <= 1,
        `Color imbalance for ${player}: white=${w}, black=${b}, diff=${Math.abs(w - b)}`
      );
    }
  });

  test('runs exactly the configured number of rounds, then finishes', () => {
    const players = ['R1', 'R2', 'R3', 'R4'];
    const t = runSwissTournament(players, 3);

    assert.strictEqual(t.getState(), 'finished');
    assert.strictEqual(t.getRounds().length, 3, 'Should have exactly 3 rounds');
  });

  test('standings are valid after a full Swiss tournament', () => {
    const players = ['ST1', 'ST2', 'ST3', 'ST4'];
    // Alternate white/black wins to create non-trivial standings
    const t = runSwissTournament(players, 2, (_w, _b, roundIndex) =>
      roundIndex % 2 === 0 ? 'white_win' : 'black_win'
    );

    const standings = t.standings();
    assert.strictEqual(standings.length, 4);

    // Points should be non-negative and sum correctly
    let totalPoints = 0;
    for (const s of standings) {
      assert.ok(s.points >= 0, `Negative points for ${s.playerId}`);
      totalPoints += s.points;
    }
    // In 2 rounds with 4 players: 2 games per round × 1 point each = 4 total points
    assert.strictEqual(totalPoints, 4, 'Total points should equal number of games played');
  });

  test('determinism: same seeds + same results produce identical pairings', () => {
    const players = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
    const resultFn = (w: string, _b: string, _r: number): GameResult =>
      w.endsWith('1') || w.endsWith('3') ? 'white_win' : 'draw';

    const t1 = runSwissTournament(players, 3, resultFn);
    const t2 = runSwissTournament(players, 3, resultFn);

    assert.strictEqual(t1.getRounds().length, t2.getRounds().length);

    for (let r = 0; r < t1.getRounds().length; r++) {
      const r1 = t1.getRounds()[r];
      const r2 = t2.getRounds()[r];
      assert.strictEqual(r1.pairings.length, r2.pairings.length, `Round ${r} pairing count differs`);

      for (let p = 0; p < r1.pairings.length; p++) {
        const p1 = r1.pairings[p];
        const p2 = r2.pairings[p];
        assert.strictEqual(p1.kind, p2.kind, `Round ${r} pairing ${p} kind differs`);
        if (p1.kind === 'game' && p2.kind === 'game') {
          assert.strictEqual(p1.white, p2.white, `Round ${r} pairing ${p} white differs`);
          assert.strictEqual(p1.black, p2.black, `Round ${r} pairing ${p} black differs`);
        } else if (p1.kind === 'bye' && p2.kind === 'bye') {
          assert.strictEqual(p1.player, p2.player, `Round ${r} pairing ${p} bye player differs`);
        }
      }
    }
  });

  test('no rematches with mixed results (10 players, 5 rounds)', () => {
    const players = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
    // Alternate results to exercise different score groups
    const t = runSwissTournament(players, 5, (_w, _b, roundIndex) => {
      if (roundIndex % 3 === 0) return 'white_win';
      if (roundIndex % 3 === 1) return 'black_win';
      return 'draw';
    });

    const meets = new Map<string, number>();
    for (const round of t.getRounds()) {
      for (const p of round.pairings) {
        if (p.kind === 'game') {
          const pair = [p.white, p.black].sort().join('-');
          meets.set(pair, (meets.get(pair) || 0) + 1);
        }
      }
    }

    for (const [pair, count] of meets.entries()) {
      assert.strictEqual(count, 1, `Rematch: ${pair} met ${count} times`);
    }

    assert.strictEqual(t.getState(), 'finished');
    assert.strictEqual(t.getRounds().length, 5);
  });

  test('Swiss via Tournament aggregate: full lifecycle', () => {
    const config: SwissConfig = {
      id: 'agg-test',
      name: 'Aggregate Test',
      format: 'swiss',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 3
    };

    const t = new Tournament(config, new SwissPairing(3));
    assert.strictEqual(t.getState(), 'registration');

    t.register('Alice');
    t.register('Bob');
    t.register('Carol');
    t.register('Dave');
    t.start();

    assert.strictEqual(t.getState(), 'running');
    assert.strictEqual(t.getRounds().length, 1, 'Only round 0 after start');

    // Resolve round by round
    let roundsPlayed = 0;
    while (t.getState() === 'running') {
      const currentRound = t.getRounds()[t.getRounds().length - 1];
      for (let i = 0; i < currentRound.pairings.length; i++) {
        if (currentRound.pairings[i].kind === 'game') {
          t.recordResult(currentRound.roundIndex, i, 'draw');
        }
      }
      roundsPlayed++;
    }

    assert.strictEqual(t.getState(), 'finished');
    assert.strictEqual(roundsPlayed, 3);
    assert.strictEqual(t.getRounds().length, 3);

    // All players should have equal points (all draws)
    const standings = t.standings();
    const firstPoints = standings[0].points;
    for (const s of standings) {
      assert.strictEqual(s.points, firstPoints, `All-draw tournament should give equal points`);
    }
  });

  test('every generated round pairs every player exactly once (regression: no silent drops)', () => {
    // Minimal reproduction of the greedy dead-end: with 5 players, round 1
    // results [white_win, draw] leaves two players that have only ever faced
    // each other, so a naive top-down greedy pairing drops both. A complete
    // matching pairs them with the other score group instead.
    const config: SwissConfig = {
      id: 'drop', name: 'Drop', format: 'swiss', variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 3
    };
    const t = new Tournament(config, new SwissPairing(3));
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) t.register(p);
    t.start();

    // Round 0: P1 vs P3 (white_win), P2 vs P4 (draw), P5 bye.
    const r0 = t.getRounds()[0];
    const r0results: GameResult[] = ['white_win', 'draw'];
    let g = 0;
    for (let i = 0; i < r0.pairings.length; i++) {
      if (r0.pairings[i].kind === 'game') t.recordResult(0, i, r0results[g++]);
    }

    const r1 = t.getRounds()[1];
    const covered = new Set<string>();
    for (const p of r1.pairings) {
      if (p.kind === 'game') { covered.add(p.white); covered.add(p.black); }
      else covered.add(p.player);
    }
    assert.strictEqual(covered.size, 5, `Round 1 must cover all 5 players, dropped: ${['P1','P2','P3','P4','P5'].filter(p => !covered.has(p))}`);
  });

  test('fuzz: every round covers all players, no rematches, at most one bye (randomized results)', () => {
    // Deterministic PRNG (mulberry32) so this test is reproducible.
    const mkRng = (seed: number) => () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const RESULTS: GameResult[] = ['white_win', 'black_win', 'draw'];

    for (let n = 2; n <= 14; n++) {
      for (let rounds = 2; rounds <= n - 1; rounds++) {
        for (let seed = 1; seed <= 25; seed++) {
          const rand = mkRng(seed * 7919 + n * 131 + rounds);
          const players = Array.from({ length: n }, (_, i) => `Q${i + 1}`);
          const t = runSwissTournament(players, rounds, () => RESULTS[Math.floor(rand() * 3)]);

          const byeCount = new Map<string, number>();
          const meets = new Map<string, number>();
          for (const round of t.getRounds()) {
            const covered = new Set<string>();
            for (const p of round.pairings) {
              if (p.kind === 'game') {
                assert.ok(!covered.has(p.white) && !covered.has(p.black), `dup in round ${round.roundIndex}`);
                covered.add(p.white); covered.add(p.black);
                const key = [p.white, p.black].sort().join('-');
                meets.set(key, (meets.get(key) ?? 0) + 1);
              } else {
                covered.add(p.player);
                byeCount.set(p.player, (byeCount.get(p.player) ?? 0) + 1);
              }
            }
            assert.strictEqual(covered.size, n,
              `n=${n} rounds=${rounds} seed=${seed}: round ${round.roundIndex} covered ${covered.size}/${n}`);
          }
          for (const [pair, c] of meets) {
            assert.strictEqual(c, 1, `n=${n} rounds=${rounds} seed=${seed}: rematch ${pair}`);
          }
          for (const [player, c] of byeCount) {
            assert.ok(c <= 1, `n=${n} rounds=${rounds} seed=${seed}: ${player} got ${c} byes`);
          }
        }
      }
    }
  });

  test('createPairingStrategy: config.rounds is the single source of the Swiss round count', () => {
    const config: SwissConfig = {
      id: 'ssot', name: 'SSOT', format: 'swiss', variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 2
    };
    // No independently supplied round count — the strategy is derived from config.
    const t = new Tournament(config, createPairingStrategy(config));
    for (const p of ['F1', 'F2', 'F3', 'F4']) t.register(p);
    t.start();
    while (t.getState() === 'running') {
      const cur = t.getRounds()[t.getRounds().length - 1];
      for (let i = 0; i < cur.pairings.length; i++) {
        if (cur.pairings[i].kind === 'game') t.recordResult(cur.roundIndex, i, 'white_win');
      }
    }
    assert.strictEqual(t.getRounds().length, config.rounds, 'must run exactly config.rounds rounds');
  });

  test('over-configured tournaments finish gracefully instead of emitting malformed rounds', () => {
    // 4 players support at most 3 rematch-free rounds; asking for 20 must not
    // produce rounds that drop players or repeat opponents.
    const players = ['O1', 'O2', 'O3', 'O4'];
    const t = runSwissTournament(players, 20);

    assert.strictEqual(t.getState(), 'finished');
    assert.ok(t.getRounds().length <= 3, `expected <= 3 rounds, got ${t.getRounds().length}`);

    const meets = new Map<string, number>();
    for (const round of t.getRounds()) {
      const covered = new Set<string>();
      for (const p of round.pairings) {
        if (p.kind === 'game') {
          covered.add(p.white); covered.add(p.black);
          const key = [p.white, p.black].sort().join('-');
          meets.set(key, (meets.get(key) ?? 0) + 1);
        } else {
          covered.add(p.player);
        }
      }
      assert.strictEqual(covered.size, players.length, `round ${round.roundIndex} must cover everyone`);
    }
    for (const [pair, c] of meets) {
      assert.strictEqual(c, 1, `rematch ${pair}`);
    }
  });
});
