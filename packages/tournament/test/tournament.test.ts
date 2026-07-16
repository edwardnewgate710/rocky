import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { Tournament } from '../src/tournament';
import { RoundRobinPairing } from '../src/round-robin';

describe('Tournament Aggregate', () => {
  const config = {
    id: 't1',
    name: 'Test Tournament',
    format: 'round_robin' as const,
    variant: 'standard' as const,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const }
  };

  test('state machine: registration -> running -> finished', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    
    assert.strictEqual(t.getState(), 'registration');
    t.register('Alice');
    t.register('Bob');
    t.register('Charlie');

    t.start();
    assert.strictEqual(t.getState(), 'running');

    // N=3 means 3 rounds, each has 1 game and 1 bye. 
    // Total pairings to resolve: 3 games.
    assert.throws(() => t.register('Dave'), /Cannot register after tournament has started/);
    assert.throws(() => t.withdraw('Alice'), /Cannot withdraw after tournament has started/);
    assert.throws(() => t.start(), /Tournament already started/);

    const rounds = t.getRounds();
    assert.strictEqual(rounds.length, 3);
    
    // Find non-bye games and resolve them
    let resolvedGames = 0;
    for (const round of rounds) {
      for (let i = 0; i < round.pairings.length; i++) {
        if (round.pairings[i].kind === 'game') {
          t.recordResult(round.roundIndex, i, 'white_win');
          resolvedGames++;
        }
      }
    }

    assert.strictEqual(resolvedGames, 3);
    assert.strictEqual(t.getState(), 'finished');
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
});
