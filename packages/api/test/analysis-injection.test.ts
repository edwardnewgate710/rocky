/**
 * UCI command injection through the FEN field.
 *
 * `buildPositionCommand` in `@chess-platform/engine` builds the engine command by interpolation —
 * `position fen ${fen}` — and UCI is a newline-delimited protocol on the subprocess's stdin. A FEN
 * carrying a newline would therefore not be a malformed position: it would be a second command,
 * chosen by the caller, executed by the engine. `setoption name Threads value 128` is the one that
 * matters, because it defeats every CPU control in ADR-0113 at once — the depth, node, time and
 * multi-PV ceilings all bound the *search*, and none of them bound how many cores serve it.
 *
 * The defence is the anchored character allowlist in the engine's `StructuralFenValidator`, which
 * `CoreFenValidator` runs before anything else. It holds on a detail worth stating: in JavaScript
 * `$` matches only at the very end of the input, so `"... w\n"` is rejected. The same expression in
 * Python would accept it, because there `$` also matches before a final newline.
 *
 * That makes this a property no one should have to rediscover. Nothing else pins it, and the way it
 * breaks is quiet: someone widens the allowlist to admit a character a new variant needs, and
 * injection becomes reachable with every existing test still green. These tests fail loudly instead.
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
import { InvalidFenError } from '@chess-platform/engine';
import { CoreFenValidator } from '../src/analysis/fen-validator';
import { AnalysisService } from '../src/analysis/service';
import { startHarness } from './helpers';

/** Records every request that reached it, so "never got there" is assertable. */
class RecordingProvider implements AnalysisProvider {
  readonly seen: AnalysisRequest[] = [];

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.seen.push(request);
    return [];
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const VALID = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Each of these carries a terminator followed by a payload, so each would be a distinct injected
 * UCI command if it reached the transport. The bare carriage return is included because UCI readers
 * commonly split on either terminator, and the tab case is here because it is *not* a terminator —
 * it must be refused as a malformed FEN rather than accepted as an exotic one.
 */
const INJECTION_FENS: readonly (readonly [string, string])[] = [
  ['trailing LF then setoption', `${VALID}\nsetoption name Threads value 128`],
  ['trailing CR then setoption', `${VALID}\rsetoption name Threads value 128`],
  ['CRLF then go infinite', `${VALID}\r\ngo infinite`],
  ['newline mid-placement', `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR\nw KQkq - 0 1`],
  ['tab then command', `${VALID}\tgo infinite`],
];

/**
 * Trailing whitespace with nothing after it. Kept apart from the list above because the *outcome*
 * differs and the difference is the point: the route reads `fen` with `trim: true`, so this arrives
 * at the validator as an ordinary valid FEN and is analysed normally. That is correct — the
 * terminator is gone, so there is no second command — and asserting 422 here would be asserting a
 * proxy for the security property rather than the property itself.
 */
const TRIMMABLE_FEN = `${VALID}\n`;

test('CoreFenValidator rejects every FEN carrying a terminator and a payload', () => {
  const validator = new CoreFenValidator();
  for (const [label, fen] of INJECTION_FENS) {
    assert.throws(
      () => validator.validate(fen, 'standard'),
      InvalidFenError,
      `"${label}" must be rejected — it would inject a UCI command`,
    );
  }
});

/**
 * The invariant, stated directly rather than through a status code: whatever the route does with an
 * input — refuse it, or sanitise it — a string containing a line terminator must never be handed to
 * something that will write it to a UCI stream. Rejection and trimming are both acceptable ways to
 * achieve that, and this passes for either, which is why it keeps holding if the route's handling
 * of whitespace ever changes.
 */
test('no FEN reaching the provider ever contains a line terminator', async () => {
  const provider = new RecordingProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');

    for (const [label, fen] of [...INJECTION_FENS, ['trimmable trailing newline', TRIMMABLE_FEN] as const]) {
      const res = await h.json('POST', '/v1/analysis', {
        token: user.token,
        body: { fen, variant: 'standard' },
      });
      assert.ok(
        res.status === 422 || res.status === 200,
        `"${label}" produced an unexpected ${res.status}`,
      );
    }

    for (const request of provider.seen) {
      assert.doesNotMatch(
        request.fen,
        /[\r\n]/,
        `a FEN containing a line terminator reached the engine: ${JSON.stringify(request.fen)}`,
      );
    }
  } finally {
    await h.close();
  }
});

/** The payload-bearing ones specifically must be refused outright, not sanitised into something. */
test('POST /v1/analysis refuses an injected FEN with 422 and never invokes the provider', async () => {
  const provider = new RecordingProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');

    for (const [label, fen] of INJECTION_FENS) {
      const res = await h.json('POST', '/v1/analysis', {
        token: user.token,
        body: { fen, variant: 'standard' },
      });
      assert.equal(res.status, 422, `"${label}" must be refused with 422, got ${res.status}`);
    }

    assert.deepEqual(provider.seen, [], 'no injected FEN may reach the engine provider');
  } finally {
    await h.close();
  }
});

/**
 * The counterpart, so the tests above cannot pass by rejecting everything — which is the failure
 * mode that would make the whole suite meaningless while looking maximally secure.
 */
test('a legitimate FEN still reaches the provider unchanged', async () => {
  const provider = new RecordingProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: VALID, variant: 'standard' },
    });

    assert.equal(res.status, 200);
    assert.equal(provider.seen.length, 1);
    assert.equal(provider.seen[0]?.fen, VALID);
  } finally {
    await h.close();
  }
});
