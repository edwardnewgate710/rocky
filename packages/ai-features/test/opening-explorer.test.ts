/**
 * Hermetic test suite for `OpeningExplorer`.
 *
 * Drives the explorer end-to-end with `BundledOpeningDatabase` (the
 * bundled real dataset) + `FakeProvider` (M7's fake AI provider) +
 * optional `FakeEngineTransport` (M5 fake).  No keys, no binary, no
 * network.
 *
 * Tests assert that:
 * - A known opening sequence → correct ECO code, name, and continuations.
 * - A sequence that matches a prefix then diverges → deepest matching
 *   opening and `outOfBook: true`.
 * - A non-book / unknown sequence → clean "no known opening" result,
 *   not a fabricated one.
 * - Engine enrichment omitted → valid result with DB fields only.
 * - AI provider omitted → valid result with DB/engine fields and no
 *   LLM text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { Position } from '@chess-platform/core';
import { OpeningExplorer } from '../src/index.js';
import { BundledOpeningDatabase } from '../src/index.js';
import type { OpeningDatabase, OpeningEntry, OpeningContinuation, OpeningLookupResult } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an `AnalysisProvider` backed by a `FakeEngineTransport`.
 */
function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
  const provider: AnalysisProvider = {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      const transport = new FakeEngineTransport({
        name: 'FakeStockfish 1.0',
        author: 'chess-platform',
        go: goHandler,
      });
      const instance = new UciEngineInstance(transport, { id: `fake-${Date.now()}-${Math.random()}` });
      await instance.init();
      const results = await instance.analyze({
        fen: request.fen,
        limits: request.limits,
        multiPv: request.multiPv ?? 1,
        signal: request.signal,
      });
      return results;
    },
    async play(request: PlayRequest): Promise<PlayResult> {
      const transport = new FakeEngineTransport({
        name: 'FakeStockfish 1.0',
        author: 'chess-platform',
        go: goHandler,
      });
      const instance = new UciEngineInstance(transport, { id: `fake-${Date.now()}-${Math.random()}` });
      await instance.init();
      const result = await instance.play({
        fen: request.fen,
        limits: request.limits,
        multiPv: 1,
        strength: request.strength,
        signal: request.signal,
      });
      return result;
    },
    capabilitiesFor(variant: string): EngineCapabilities | undefined {
      if (variant === 'chess' || variant === undefined) {
        return {
          engineName: 'FakeStockfish',
          engineAuthor: 'chess-platform',
          version: '1.0',
          fingerprint: 'fake-fingerprint',
          variants: new Set(['chess']),
          options: new Map(),
          supportsMultiPv: true,
          supportsLimitStrength: true,
          supportsSkillLevel: true,
          supportsPonder: true,
        };
      }
      return undefined;
    },
  };
  return provider;
}

/** A fake opening database for testing. */
class FakeOpeningDatabase implements OpeningDatabase {
  constructor(private readonly entries: readonly OpeningEntry[]) {}

  lookup(moves: readonly string[]): OpeningLookupResult {
    if (moves.length === 0) return { kind: 'notFound' };
    // Sort by move count descending
    const sorted = [...this.entries].sort((a, b) => b.moves.length - a.moves.length);
    for (const entry of sorted) {
      const matchLen = Math.min(entry.moves.length, moves.length);
      let matched = true;
      for (let i = 0; i < matchLen; i++) {
        if (entry.moves[i] !== moves[i]) { matched = false; break; }
      }
      if (matched && matchLen > 0) {
        if (entry.moves.length <= moves.length) {
          return { kind: 'found', entry, matchedMoves: entry.moves.length, outOfBook: moves.length > entry.moves.length };
        } else {
          return { kind: 'found', entry, matchedMoves: moves.length, outOfBook: false };
        }
      }
    }
    return { kind: 'notFound' };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpeningExplorer (hermetic)', () => {

  test('known opening sequence → correct ECO code, name, and continuations', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    // Ruy Lopez: 1.e4 e5 2.Nf3 Nc6 3.Bb5
    const result = await explorer.explore({
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
    });

    assert.equal(result.found, true);
    assert.equal(result.eco, 'C60');
    assert.equal(result.name, 'Ruy Lopez (Spanish Opening)');
    assert.equal(result.matchedMoves, 5);
    assert.equal(result.outOfBook, false);
    assert.ok(result.continuations.length > 0);
    // Check a continuation
    const morphy = result.continuations.find(c => c.move === 'a7a6');
    assert.ok(morphy);
    assert.equal(morphy!.san, 'a6');
    assert.equal(morphy!.eco, 'C70');
  });

  test('sequence that matches a prefix then diverges → deepest match, outOfBook: true', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    // Ruy Lopez 3...a6 4.Ba4 (matches Morphy Defense) then a non-book move
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 5.h4 (diverges)
    const result = await explorer.explore({
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'h7h6'],
    });

    assert.equal(result.found, true);
    // Should match the Morphy Defense (6 moves: e4 e5 Nf3 Nc6 Bb5 a6)
    assert.equal(result.eco, 'C70');
    assert.equal(result.name, 'Ruy Lopez, Morphy Defense');
    assert.equal(result.matchedMoves, 6);
    assert.equal(result.outOfBook, true); // 8 input moves > 6 entry moves
  });

  test('non-book / unknown sequence → clean "no known opening" result', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    // 1.a3 h4 — a nonsensical opening that no database would recognize
    const result = await explorer.explore({
      moves: ['a2a3', 'h7h5'],
    });

    assert.equal(result.found, false);
    assert.equal(result.opening, null);
    assert.equal(result.eco, null);
    assert.equal(result.name, null);
    assert.equal(result.continuations.length, 0);
    assert.equal(result.stats, null);
    assert.equal(result.matchedMoves, 0);
    assert.equal(result.outOfBook, false);
  });

  test('another non-book sequence: 1.Nc3 Nc6 → no known opening', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    const result = await explorer.explore({
      moves: ['b1c3', 'b8c6'],
    });

    assert.equal(result.found, false);
    assert.equal(result.eco, null);
    assert.equal(result.name, null);
  });

  test('engine enrichment omitted → valid result with DB fields only', async () => {
    const db = new BundledOpeningDatabase();
    // No engine supplied
    const explorer = new OpeningExplorer({ database: db });

    const result = await explorer.explore({
      moves: ['e2e4', 'e7e5'],
    });

    // Should find the King's Pawn Game (1.e4) as the deepest match
    // Actually, 1.e4 e5 matches "King's Pawn Game" (1.e4) with outOfBook=true
    // because the entry only has 1 move but we played 2.
    assert.equal(result.found, true);
    assert.ok(result.eco);
    assert.ok(result.name);
    // No engine fields
    assert.equal(result.engineEval, null);
    assert.equal(result.engineEvalLabel, null);
    assert.equal(result.engineBestMove, null);
    assert.equal(result.engineDepth, null);
  });

  test('AI provider omitted → valid result with DB fields and no LLM text', async () => {
    const db = new BundledOpeningDatabase();
    // No AI supplied
    const explorer = new OpeningExplorer({ database: db });

    const result = await explorer.explore({
      moves: ['e2e4', 'c7c5'],
    });

    assert.equal(result.found, true);
    assert.equal(result.eco, 'B20');
    assert.equal(result.name, 'Sicilian Defense');
    // No LLM fields
    assert.equal(result.narrative, null);
    assert.equal(result.providerId, null);
    assert.equal(result.model, null);
    assert.equal(result.usage, null);
    assert.equal(result.latencyMs, null);
  });

  test('with engine enrichment + AI → all fields populated', async () => {
    const db = new BundledOpeningDatabase();
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 20 seldepth 25 multipv 1 score cp 30 nodes 1000000 nps 500000 time 2000 pv g1f3'],
      bestmove: 'g1f3',
    }));
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'This is the Sicilian Defense. Black fights for the center with ...c5.',
    });

    const explorer = new OpeningExplorer({ database: db, engine, ai });
    const result = await explorer.explore({
      moves: ['e2e4', 'c7c5'],
    });

    assert.equal(result.found, true);
    assert.equal(result.eco, 'B20');
    // Engine fields
    assert.equal(result.engineEval!.type, 'cp');
    assert.equal(result.engineEval!.value, 30);
    assert.equal(result.engineEvalLabel, '+0.30');
    assert.equal(result.engineBestMove, 'g1f3');
    assert.equal(result.engineDepth, 20);
    // LLM fields
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'fake-ai');
  });

  test('deepest match: Sicilian Najdorf (10 moves)', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    // 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6
    const result = await explorer.explore({
      moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
    });

    assert.equal(result.found, true);
    assert.equal(result.eco, 'B90');
    assert.equal(result.name, 'Sicilian Defense, Najdorf Variation');
    assert.equal(result.matchedMoves, 10);
    assert.equal(result.outOfBook, false);
  });

  test('FEN is correctly derived from the move sequence', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    const result = await explorer.explore({
      moves: ['e2e4', 'e7e5'],
    });

    // After 1.e4 e5, it's White's turn (move 2)
    assert.ok(result.fen.includes(' w '));
    assert.ok(result.fen.includes('4p3')); // pawn on e4 and e5
  });

  test('empty move sequence → not found, startpos FEN', async () => {
    const db = new BundledOpeningDatabase();
    const explorer = new OpeningExplorer({ database: db });

    const result = await explorer.explore({
      moves: [],
    });

    assert.equal(result.found, false);
    assert.equal(result.opening, null);
    // FEN should be the starting position
    assert.equal(result.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  test('grounding is passed to the AI provider when supplied', async () => {
    const db = new BundledOpeningDatabase();
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 20 seldepth 25 multipv 1 score cp 30 nodes 1000000 nps 500000 time 2000 pv g1f3'],
      bestmove: 'g1f3',
    }));
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'Narrative.',
    });

    const explorer = new OpeningExplorer({ database: db, engine, ai });
    await explorer.explore({
      moves: ['e2e4', 'c7c5'],
    });

    assert.equal(ai.calls.length, 1);
    const call = ai.calls[0];
    assert.equal(call.task, 'opening_explorer');
    assert.ok(call.grounding);
  });
});

// ---------------------------------------------------------------------------
// BundledOpeningDatabase unit tests
// ---------------------------------------------------------------------------

describe('BundledOpeningDatabase', () => {

  test('all entries have valid ECO codes and names', () => {
    const db = new BundledOpeningDatabase();
    for (const entry of db.allEntries) {
      assert.ok(entry.eco.length >= 2, `ECO code too short: ${entry.eco}`);
      assert.ok(entry.eco.length <= 4, `ECO code too long: ${entry.eco}`);
      assert.ok(entry.name.length > 0, `Name is empty for ${entry.eco}`);
      assert.ok(entry.moves.length > 0, `No moves for ${entry.eco}`);
    }
  });

  test('all entry move sequences are legal (can be played from startpos)', () => {
    const db = new BundledOpeningDatabase();
    for (const entry of db.allEntries) {
      let pos = Position.initial();
      for (const uci of entry.moves) {
        // Should not throw
        pos = pos.play(uci);
      }
      // Verify the FEN is valid (not a terminal position check, just that we got here)
      assert.ok(pos.fen().length > 0, `Empty FEN for ${entry.eco}`);
    }
  });

  test('lookup returns notFound for empty sequence', () => {
    const db = new BundledOpeningDatabase();
    const result = db.lookup([]);
    assert.equal(result.kind, 'notFound');
  });

  test('lookup returns notFound for unknown sequence', () => {
    const db = new BundledOpeningDatabase();
    const result = db.lookup(['a2a3', 'h7h5']);
    assert.equal(result.kind, 'notFound');
  });

  test('lookup finds deepest match', () => {
    const db = new BundledOpeningDatabase();
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 → should match Morphy Defense (6 moves), not Ruy Lopez (5 moves)
    const result = db.lookup(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']);
    assert.equal(result.kind, 'found');
    if (result.kind === 'found') {
      assert.equal(result.entry.eco, 'C70');
      assert.equal(result.matchedMoves, 6);
    }
  });
});
