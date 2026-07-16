import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { RoundRobinPairing } from '../src/round-robin';
import { GamePairing } from '../src/pairing';

describe('RoundRobinPairing', () => {
  test('N = 4: correct round count, pairs meet exactly once, color balance <= 1', () => {
    const participants = ['A', 'B', 'C', 'D'];
    const strategy = new RoundRobinPairing();
    const rounds = strategy.generateRounds(participants);

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
    const strategy = new RoundRobinPairing();
    const rounds = strategy.generateRounds(participants);

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
    const strategy = new RoundRobinPairing();
    const rounds = strategy.generateRounds(participants);

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
    assert.strictEqual(strategy.generateRounds([]).length, 0);
    assert.strictEqual(strategy.generateRounds(['A']).length, 0);
  });
});
