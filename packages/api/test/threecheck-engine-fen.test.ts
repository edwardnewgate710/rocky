/**
 * What the engine is told, and what the cache remembers, for Three-Check.
 *
 * `AnalysisService` used to hand the caller's FEN to the engine verbatim. For Three-Check that was
 * a correctness bug rather than a stylistic one: Fairy-Stockfish reads a missing counter field as
 * **one check remaining for each side**, not as "none delivered", so a legacy six-field FEN was
 * analysed as though a single check ended the game. Measured against Fairy-Stockfish 14, the
 * Italian Game came back as a forced mate.
 *
 * These tests are hermetic — they assert what leaves the service, using a provider that records its
 * request. The real engine's half of the claim lives in `analysis-fairy-threecheck-smoke.test.ts`.
 * See ADR-0120.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { cacheKeyString } from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service';
import { coreFenValidator } from '../src/analysis/fen-validator';

/** Records the request rather than answering it, so the FEN that would reach a binary is visible. */
class CapturingProvider implements AnalysisProvider {
  lastRequest?: AnalysisRequest;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.lastRequest = request;
    return [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 12 },
        principalVariation: ['d1e1'],
        depth: 10,
        nodes: 1_000,
        nps: 10_000,
        timeMs: 10,
      },
    ];
  }

  // Unused here: this double exists to inspect the analysis request, not to play.
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in this double');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const BOARD = '4k3/8/8/8/8/8/8/3R3K';

async function fenSentToEngine(fen: string, variant: string): Promise<string> {
  const provider = new CapturingProvider();
  const service = new AnalysisService({ provider });
  await service.analyze({ fen, variant, movetimeMs: 50, multiPv: 1 });
  assert.ok(provider.lastRequest !== undefined, 'the provider must have been asked');
  return provider.lastRequest.fen;
}

test('a legacy six-field Three-Check FEN reaches the engine with its counters spelled out', async () => {
  const sent = await fenSentToEngine(`${BOARD} w - - 0 1`, 'threecheck');
  assert.equal(
    sent,
    `${BOARD} w - - 3+3 0 1`,
    'a bare six-field FEN means no checks delivered, and the engine has to be told so',
  );
});

test('the counters a caller supplies are preserved, not reset', async () => {
  const sent = await fenSentToEngine(`${BOARD} w - - 1+3 7 9`, 'threecheck');
  assert.equal(sent, `${BOARD} w - - 1+3 7 9`, 'two checks delivered by White must survive');

  const fromTrailing = await fenSentToEngine(`${BOARD} w - - 7 9 +2+0`, 'threecheck');
  assert.equal(fromTrailing, `${BOARD} w - - 1+3 7 9`, 'the compatibility spelling means the same');
});

test('no Three-Check FEN reaches the engine with six fields', async () => {
  for (const fen of [`${BOARD} w - - 0 1`, `${BOARD} w - - 2+3 5 4`, `${BOARD} w - - 5 4 +1+0`]) {
    const sent = await fenSentToEngine(fen, 'threecheck');
    assert.equal(sent.split(' ').length, 7, `"${fen}" must not be forwarded without its counters`);
  }
});

test('other variants reach the engine exactly as the caller wrote them', async () => {
  // Rewriting them would move every cached entry for every other variant for no reason.
  const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(await fenSentToEngine(standard, 'standard'), standard);

  const crazyhouse = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1';
  assert.equal(await fenSentToEngine(crazyhouse, 'crazyhouse'), crazyhouse);
});

test('two Three-Check positions differing only in checks delivered cannot share a cache entry', async () => {
  const fresh = await fenSentToEngine(`${BOARD} w - - 0 1`, 'threecheck');
  const twoChecksIn = await fenSentToEngine(`${BOARD} w - - 1+3 0 1`, 'threecheck');

  assert.notEqual(fresh, twoChecksIn, 'the same board with different counters is a different FEN');

  const keyOf = (fen: string): string =>
    cacheKeyString({ fingerprint: 'engine-1', fen, variant: 'threecheck', multiPv: 1 });
  assert.notEqual(
    keyOf(fresh),
    keyOf(twoChecksIn),
    'aliasing these would serve one position the other position’s evaluation',
  );
});

test('entries cached under the old counterless FEN become unreachable', async () => {
  // The old key was the six-field string. Nothing produces that key any more, so the entries held
  // under it — every one of them an evaluation made with the wrong counters — can never be served.
  const legacyKey = cacheKeyString({
    fingerprint: 'engine-1',
    fen: `${BOARD} w - - 0 1`,
    variant: 'threecheck',
    multiPv: 1,
  });
  const nowKey = cacheKeyString({
    fingerprint: 'engine-1',
    fen: await fenSentToEngine(`${BOARD} w - - 0 1`, 'threecheck'),
    variant: 'threecheck',
    multiPv: 1,
  });
  assert.notEqual(legacyKey, nowKey);
});

test('the authoritative validator accepts the canonical form and refuses a malformed one', () => {
  coreFenValidator.validate(`${BOARD} w - - 3+3 0 1`, 'threecheck');
  coreFenValidator.validate(`${BOARD} w - - 0 1`, 'threecheck');
  coreFenValidator.validate(`${BOARD} w - - 0 1 +1+0`, 'threecheck');

  for (const bad of [`${BOARD} w - - 4+3 0 1`, `${BOARD} w - - 2+ 0 1`, `${BOARD} w - - 0 1 +9+9`]) {
    assert.throws(
      () => {
        coreFenValidator.validate(bad, 'threecheck');
      },
      /Invalid FEN position/,
      `"${bad}" must be refused`,
    );
  }
});

test('a counter field is no way to smuggle a UCI command past the validator', () => {
  // UCI is newline-delimited and the FEN is interpolated into a `position fen ...` line, so a
  // terminator inside any field is an injected command. Adding a counter field must not open a
  // gap in that check.
  const injections = [
    `${BOARD} w - - 3+3 0 1\nsetoption name Threads value 128`,
    `${BOARD} w - - 3+3\n0 1`,
    `${BOARD} w - - 3+3 0 1\r\ngo infinite`,
  ];
  for (const fen of injections) {
    assert.throws(
      () => {
        coreFenValidator.validate(fen, 'threecheck');
      },
      /Invalid FEN|allowed set|whitespace/i,
      'a control character must be refused even with counters present',
    );
  }
});
