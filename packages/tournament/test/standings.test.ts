import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { computeStandings, GameResult } from '../src/standings';

describe('Standings', () => {
  test('computes points correctly and resolves ties with SB', () => {
    const participants = ['A', 'B', 'C', 'D'];
    
    // A beats B, draws C, beats D. Points: 2.5
    // B loses to A, beats C, beats D. Points: 2.0
    // C draws A, loses to B, beats D. Points: 1.5
    // D loses to A, loses to B, loses to C. Points: 0
    
    const results = new Map<string, GameResult | 'bye'>([
      ['m1', 'white_win'], // A vs B
      ['m2', 'draw'],      // A vs C
      ['m3', 'white_win'], // A vs D
      ['m4', 'white_win'], // B vs C
      ['m5', 'black_win'], // D vs B (so B wins)
      ['m6', 'white_win'], // C vs D
    ]);

    const pairings = new Map<string, { p1: string; p2: string | null }>([
      ['m1', { p1: 'A', p2: 'B' }],
      ['m2', { p1: 'A', p2: 'C' }],
      ['m3', { p1: 'A', p2: 'D' }],
      ['m4', { p1: 'B', p2: 'C' }],
      ['m5', { p1: 'D', p2: 'B' }],
      ['m6', { p1: 'C', p2: 'D' }],
    ]);

    const standings = computeStandings(participants, results, pairings);
    
    assert.strictEqual(standings.length, 4);
    
    const sA = standings.find(s => s.playerId === 'A')!;
    assert.strictEqual(sA.points, 2.5);
    
    const sB = standings.find(s => s.playerId === 'B')!;
    assert.strictEqual(sB.points, 2.0);

    const sC = standings.find(s => s.playerId === 'C')!;
    assert.strictEqual(sC.points, 1.5);

    const sD = standings.find(s => s.playerId === 'D')!;
    assert.strictEqual(sD.points, 0);

    // SB tiebreak check:
    // A beat B (2.0) and D (0) and drew C (1.5). SB = 2.0 + 0 + 1.5/2 = 2.75
    assert.strictEqual(sA.tiebreak, 2.75);

    // B beat C (1.5) and D (0). SB = 1.5
    assert.strictEqual(sB.tiebreak, 1.5);
  });

  test('tiebreak correctly orders players with same points', () => {
    const participants = ['A', 'B', 'C'];
    // A draws B (0.5), beats C (1) -> 1.5
    // B draws A (0.5), beats C (1) -> 1.5
    // C loses to A (0), loses to B (0) -> 0
    // Points are tied. SB:
    // A beat C (0), drew B (1.5). SB = 0.75
    // B beat C (0), drew A (1.5). SB = 0.75
    // Still tied!
    
    const results = new Map<string, GameResult | 'bye'>([
      ['m1', 'draw'],
      ['m2', 'white_win'],
      ['m3', 'white_win']
    ]);
    const pairings = new Map<string, { p1: string; p2: string | null }>([
      ['m1', { p1: 'B', p2: 'A' }], // A is black
      ['m2', { p1: 'A', p2: 'C' }],
      ['m3', { p1: 'B', p2: 'C' }]
    ]);

    const standings = computeStandings(participants, results, pairings);
    assert.strictEqual(standings[0].points, 1.5);
    assert.strictEqual(standings[1].points, 1.5);
    assert.strictEqual(standings[0].tiebreak, 0.75);
    assert.strictEqual(standings[1].tiebreak, 0.75);
    
    // Fallback tiebreak is alphabetical
    assert.strictEqual(standings[0].playerId, 'A');
    assert.strictEqual(standings[1].playerId, 'B');
  });
});
