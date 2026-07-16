import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { RoundRobinPairing } from '../src/round-robin';
import type { GamePairing, PairingContext, PlayerHistory, Round } from '../src/pairing';

/**
 * Helper: drive a RoundRobinPairing to completion, collecting all rounds.
 * Simulates the Tournament aggregate's round-by-round flow.
 */
function collectAllRounds(participants: string[]): Round[] {
  const strategy = new RoundRobinPairing();
  const rounds: Round[] = [];
  const playerHistory = new Map<string, PlayerHistory>();
  for (const p of participants) {
    playerHistory.set(p, { opponents: [], whiteCount: 0, blackCount: 0, byeCount: 0, points: 0 });
  }

  for (let roundNumber = 0; ; roundNumber++) {
    const context: PairingContext = {
      participants,
      roundNumber,
      completedRounds: [],
      playerHistory
    };

    const round = strategy.pairNextRound(context);
    if (round === null) break;
    rounds.push(round);
  }

  return rounds;
}

describe('RoundRobinPairing (round-by-round interface)', () => {
  test('N = 4: correct round count, pairs meet exactly once, color balance <= 1', () => {
    const participants = ['A', 'B', 'C', 'D'];
    const rounds = collectAllRounds(participants);

    assert.strictEqual(rounds.length, 3, '4 players should have 3 rounds');

    const meets = new Map<string, number>();
    const colorDiff = new Map<string, number>();
    participants.forEach(p => colorDiff.set(p, 0));

    for (const round of rounds) {
      assert.strictEqual(round.pairings.length, 2, 'Each round should have 2 matches');
      const roundPlayers = new Set<string>();

      for (const p of round.pairings) {
        assert.strictEqual(p.kind, 'game', 'No byes for even N');
        const gp = p as GamePairing;
        
        // Track colors
        colorDiff.set(gp.white, colorDiff.get(gp.white)! + 1);
        colorDiff.set(gp.black, colorDiff.get(gp.black)! - 1);
        
        // Track unique players per round
        assert.ok(!roundPlayers.has(gp.white), `Player ${gp.white} playing twice in round`);
        assert.ok(!roundPlayers.has(gp.black), `Player ${gp.black} playing twice in round`);
        roundPlayers.add(gp.white);
        roundPlayers.add(gp.black);

        // Track matchups
        const pair = [gp.white, gp.black].sort().join('-');
        meets.set(pair, (meets.get(pair) || 0) + 1);
      }
    }

    // Check all unordered pairs meet exactly once
    assert.strictEqual(meets.size, 6, 'Total matches should be 6 (4 choose 2)');
    for (const count of meets.values()) {
      assert.strictEqual(count, 1, 'Each pair should meet exactly once');
    }

    // Check color balance
    for (const [player, diff] of colorDiff.entries()) {
      assert.ok(Math.abs(diff) <= 1, `Color balance violated for ${player}: diff ${diff}`);
    }
  });

  test('N = 5: odd N gives one bye per round, color balance holds', () => {
    const participants = ['A', 'B', 'C', 'D', 'E'];
    const rounds = collectAllRounds(participants);

    assert.strictEqual(rounds.length, 5, '5 players should have 5 rounds');

    const byes = new Map<string, number>();
    participants.forEach(p => byes.set(p, 0));

    const colorDiff = new Map<string, number>();
    participants.forEach(p => colorDiff.set(p, 0));

    for (const round of rounds) {
      let byeCount = 0;
      for (const p of round.pairings) {
        if (p.kind === 'bye') {
          byeCount++;
          byes.set(p.player, byes.get(p.player)! + 1);
        } else {
          colorDiff.set(p.white, colorDiff.get(p.white)! + 1);
          colorDiff.set(p.black, colorDiff.get(p.black)! - 1);
        }
      }
      assert.strictEqual(byeCount, 1, 'Exactly one bye per round');
    }

    // Check every player got exactly one bye
    for (const [player, count] of byes.entries()) {
      assert.strictEqual(count, 1, `Player ${player} should have exactly 1 bye, got ${count}`);
    }

    // Check color balance (difference between white and black games played)
    for (const [player, diff] of colorDiff.entries()) {
      assert.ok(Math.abs(diff) <= 1, `Color balance violated for ${player}: diff ${diff}`);
    }
  });

  test('N = 6: correct round count, pairs meet exactly once', () => {
    const participants = ['A', 'B', 'C', 'D', 'E', 'F'];
    const rounds = collectAllRounds(participants);

    assert.strictEqual(rounds.length, 5, '6 players should have 5 rounds');
    
    const meets = new Map<string, number>();
    for (const round of rounds) {
      assert.strictEqual(round.pairings.length, 3);
      for (const p of round.pairings) {
        if (p.kind === 'game') {
          const pair = [p.white, p.black].sort().join('-');
          meets.set(pair, (meets.get(pair) || 0) + 1);
        }
      }
    }

    assert.strictEqual(meets.size, 15, 'Total matches should be 15 (6 choose 2)');
    for (const count of meets.values()) {
      assert.strictEqual(count, 1, 'Each pair should meet exactly once');
    }
  });

  test('rejects less than 2 players', () => {
    const strategy = new RoundRobinPairing();
    const emptyCtx: PairingContext = {
      participants: [],
      roundNumber: 0,
      completedRounds: [],
      playerHistory: new Map()
    };
    assert.strictEqual(strategy.pairNextRound(emptyCtx), null);

    const singleCtx: PairingContext = {
      participants: ['A'],
      roundNumber: 0,
      completedRounds: [],
      playerHistory: new Map()
    };
    assert.strictEqual(strategy.pairNextRound(singleCtx), null);
  });

  test('returns null after all rounds are emitted', () => {
    const participants = ['A', 'B'];
    const strategy = new RoundRobinPairing();

    // Round 0 should be returned
    const r0 = strategy.pairNextRound({
      participants,
      roundNumber: 0,
      completedRounds: [],
      playerHistory: new Map()
    });
    assert.ok(r0 !== null, 'Round 0 should exist');
    assert.strictEqual(r0!.roundIndex, 0);

    // Round 1 should be null (2 players = 1 round)
    const r1 = strategy.pairNextRound({
      participants,
      roundNumber: 1,
      completedRounds: [],
      playerHistory: new Map()
    });
    assert.strictEqual(r1, null, 'No more rounds for 2 players');
  });
});
