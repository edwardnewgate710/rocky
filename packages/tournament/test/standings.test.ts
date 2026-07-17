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
    
    const results = new Map<string, GameResult | 'bye' | 'void'>([
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

    // Buchholz check for A: Played B(2.0), C(1.5), D(0) = 3.5
    assert.strictEqual(sA.buchholz, 3.5);
    // Median-Buchholz for A: Drop max (2.0) and min (0) = 1.5
    assert.strictEqual(sA.medianBuchholz, 1.5);

    // Buchholz for B: Played A(2.5), C(1.5), D(0) = 4.0
    assert.strictEqual(sB.buchholz, 4.0);
    // Median-Buchholz for B: Drop max (2.5) and min (0) = 1.5
    assert.strictEqual(sB.medianBuchholz, 1.5);
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
    
    const results = new Map<string, GameResult | 'bye' | 'void'>([
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

  test('tiebreakOrder changes the ranking', () => {
    // A and B both score 1 point, but their tiebreaks diverge:
    //   A beats C, loses to D. C=1pt, D=3pts  -> SB=1 (from C), Buchholz=1+3=4
    //   B beats E, loses to F. E=0pts, F=5pts -> SB=0 (from E), Buchholz=0+5=5
    // So Sonneborn-Berger favours A, while Buchholz favours B. Byes are used to
    // pad C/D/E/F to the intended opponent scores.
    const p = ['A', 'B', 'C', 'D', 'E', 'F'];
    const results = new Map<string, GameResult | 'bye' | 'void'>([
      ['m1', 'white_win'], // A beats C
      ['m2', 'black_win'], // A loses to D
      ['m3', 'white_win'], // B beats E
      ['m4', 'black_win'], // B loses to F
      ['m6', 'bye'],                             // C -> 1 pt
      ['m7', 'bye'], ['m8', 'bye'],              // D -> 1 (win) + 2 = 3 pts
      ['m10', 'bye'], ['m11', 'bye'], ['m12', 'bye'], ['m13', 'bye'], // F -> 1 (win) + 4 = 5 pts
    ]);
    const pairings = new Map<string, { p1: string; p2: string | null }>([
      ['m1', { p1: 'A', p2: 'C' }],
      ['m2', { p1: 'A', p2: 'D' }],
      ['m3', { p1: 'B', p2: 'E' }],
      ['m4', { p1: 'B', p2: 'F' }],
      ['m6', { p1: 'C', p2: null }],
      ['m7', { p1: 'D', p2: null }], ['m8', { p1: 'D', p2: null }],
      ['m10', { p1: 'F', p2: null }], ['m11', { p1: 'F', p2: null }], ['m12', { p1: 'F', p2: null }], ['m13', { p1: 'F', p2: null }],
    ]);

    // Sonneborn-Berger first: A (SB=1) outranks B (SB=0).
    const bySB = computeStandings(p, results, pairings, ['sonneborn_berger', 'buchholz']);
    const aSB = bySB.find((s) => s.playerId === 'A')!;
    const bSB = bySB.find((s) => s.playerId === 'B')!;
    assert.strictEqual(aSB.points, 1);
    assert.strictEqual(bSB.points, 1);
    assert.strictEqual(aSB.tiebreak, 1);
    assert.strictEqual(bSB.tiebreak, 0);
    assert.strictEqual(aSB.buchholz, 4);
    assert.strictEqual(bSB.buchholz, 5);
    assert.ok(
      bySB.findIndex((s) => s.playerId === 'A') < bySB.findIndex((s) => s.playerId === 'B'),
      'SB-first ranks A above B',
    );

    // Buchholz first flips it: B (Buchholz=5) outranks A (Buchholz=4).
    const byBuch = computeStandings(p, results, pairings, ['buchholz', 'sonneborn_berger']);
    assert.ok(
      byBuch.findIndex((s) => s.playerId === 'B') < byBuch.findIndex((s) => s.playerId === 'A'),
      'Buchholz-first ranks B above A',
    );
  });
});
