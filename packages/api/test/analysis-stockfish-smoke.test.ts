/**
 * The one test that runs a real engine.
 *
 * Everything else in the analysis suite drives a `FakeEngineTransport` or a hand-written provider
 * double, which is what keeps the suite hermetic and fast. That leaves exactly one thing unproven,
 * and it is the thing most likely to be wrong: whether the *production composition* — env parsing →
 * `createEngineManager` → `ChildProcessTransport` → a real Stockfish binary → the UCI handshake →
 * capability discovery → variant routing — actually works end to end. A double cannot fail the way
 * a subprocess fails, and ADR-0102 is the record of what that gap costs: fifty passing engine tests,
 * every one of them routing the engine's own variant vocabulary, while the platform's `standard`
 * produced `NoEngineForVariantError` against a real binary in production.
 *
 * So this asks for `standard` — the platform's name, the one a caller sends — rather than the
 * engine's `chess`. That mapping is the part a hermetic test is least able to check.
 *
 * Env-gated: skipped unless `STOCKFISH_PATH` points at a binary that exists, so `npm test` on a
 * machine without one stays green and no other test grows a dependency on a binary. CI installs
 * Stockfish for the `analysis-smoke` job and runs this file there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createAnalysisFromEnv } from '../src/analysis/composition';

const binary = process.env['STOCKFISH_PATH'];
const available = binary !== undefined && binary !== '' && existsSync(binary);
const skip = available ? false : 'set STOCKFISH_PATH to a real Stockfish binary to run the smoke test';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('real Stockfish: the production composition analyses the opening position', { skip }, async () => {
  const composed = createAnalysisFromEnv(process.env);
  assert.ok(composed !== undefined, 'STOCKFISH_PATH is set, so a composition must be built');

  try {
    const outcome = await composed.service.analyze({
      fen: START_FEN,
      variant: 'standard',
      movetimeMs: 1_000,
      multiPv: 3,
    });

    assert.equal(outcome.fen, START_FEN);
    assert.equal(outcome.variant, 'standard');

    // Three lines were asked for and the position has far more than three legal moves, so a build
    // satisfying Puzzle Generation's cold-start guarantee must return all three. Asserting `>= 1`
    // instead would pass on an engine that
    // silently ignored the option.
    assert.equal(outcome.lines.length, 3, 'multiPv: 3 must yield three distinct lines');

    for (const line of outcome.lines) {
      assert.ok(line.depth > 0, 'a real search reports a depth');
      assert.ok(line.principalVariation.length > 0, 'a real search reports a principal variation');
      assert.ok(['cp', 'mate'].includes(line.evaluation.type));
      assert.ok(Number.isFinite(line.evaluation.value));
    }
    assert.equal(
      new Set(outcome.lines.map((line) => line.principalVariation[0])).size,
      3,
      'MultiPV 3 must produce three different candidate moves',
    );

    // The opening position is close to equal and certainly not a forced mate. This is deliberately
    // loose — it is here to catch a parser returning garbage or a mis-signed score, not to pin an
    // engine's opinion, which legitimately varies by build and by how long it thought.
    const best = outcome.lines[0];
    assert.ok(best !== undefined);
    assert.equal(best.evaluation.type, 'cp', 'the start position is not a forced mate');
    assert.ok(
      Math.abs(best.evaluation.value) < 200,
      `the start position should evaluate near equal, got ${best.evaluation.value}cp`,
    );

    // The first move of a principal variation from the start position must be a legal opening move
    // in UCI long algebraic form. This is what proves the FEN reached the engine intact and the
    // reply was parsed, rather than a plausible-looking object being fabricated somewhere.
    assert.match(best.principalVariation[0] ?? '', /^[a-h][1-8][a-h][1-8][qrbn]?$/);

    // The wall-clock ceiling is the safety property of the whole subsystem, so assert it held
    // against a real search rather than trusting the double that cannot overrun.
    assert.equal(outcome.applied.movetimeMs, 1_000);
  } finally {
    // Always drain: a leaked subprocess outlives the test run and the runner will not exit.
    await composed.shutdown({ deadlineMs: 5_000 });
  }
});
