/**
 * The Three-Check half of the real-engine coverage.
 *
 * `analysis-stockfish-smoke.test.ts` proves the production composition reaches a real binary for
 * `standard`. This proves the thing that binary cannot check: that Fairy-Stockfish is told how many
 * checks have been delivered.
 *
 * It is not a missing-annotation problem. Fairy does not read an absent counter field as "nothing
 * delivered yet" — it defaults to **one check remaining for each side**. So every Three-Check
 * position we sent as a bare six-field FEN was analysed as though either player could win with a
 * single check, and the engine duly reported forced mates that do not exist. Measured against
 * Fairy-Stockfish 14: the Italian Game came back `mate 1` on the six-field FEN.
 *
 * The assertions here are deliberately semantic — the canonical counters the engine echoes, and
 * whether a fresh position is treated as one check from victory. Pinning a centipawn number would
 * bind the suite to an engine build and would not have caught the original defect any better.
 *
 * Env-gated on `FAIRY_STOCKFISH_PATH`, in the same shape as the Stockfish smoke test, so a machine
 * without the binary stays green. CI provides it for the analysis-smoke job. See ADR-0120.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createAnalysisFromEnv } from '../src/analysis/composition';

const binary = process.env['FAIRY_STOCKFISH_PATH'];
const available = binary !== undefined && binary !== '' && existsSync(binary);
const skip = available
  ? false
  : 'set FAIRY_STOCKFISH_PATH to a real Fairy-Stockfish binary to run the Three-Check smoke test';

/** The Italian Game. White has Bxf7+ available, so a wrong counter reads as an immediate win. */
const ITALIAN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';

/**
 * Drive the binary over UCI and return everything it printed.
 *
 * Deliberately raw rather than routed through the engine pool: the claim under test is what the
 * engine understood from the FEN, and `d` is the only place it says so.
 */
function uci(commands: readonly string[], settleMs = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary!, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(quitTimer);
      clearTimeout(killTimer);
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });
    child.on('close', () => {
      finish(() => {
        resolve(out);
      });
    });
    // A binary that has already exited makes the write below emit EPIPE on the stream, and an
    // unhandled stream error takes down the whole test process instead of failing one test.
    child.stdin.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });

    child.stdin.write(`${commands.join('\n')}\n`);
    const quitTimer = setTimeout(() => {
      child.stdin.write('quit\n');
      child.stdin.end();
    }, settleMs);
    // And a binary that ignores `quit` would otherwise leave this promise pending forever, hanging
    // the runner rather than failing. Both raised in the CodeRabbit review of PR #140.
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => {
        reject(new Error(`engine did not exit within ${settleMs + 10_000}ms`));
      });
    }, settleMs + 10_000);
  });
}

/** The `Fen:` line Fairy prints for `d`, which is its own reading of the position we gave it. */
function engineFen(output: string): string {
  const line = output.split(/\r?\n/).find((l) => l.startsWith('Fen: '));
  assert.ok(line !== undefined, `engine printed no Fen: line\n${output}`);
  return line.slice('Fen: '.length).trim();
}

test('real Fairy: a fresh Three-Check position is three checks from a win, not one', { skip }, async () => {
  const out = await uci([
    'uci',
    'setoption name UCI_Variant value 3check',
    'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1',
    'd',
  ]);
  assert.match(
    engineFen(out),
    / 3\+3 /,
    'the canonical counter field must survive into the engine unchanged',
  );
});

test('real Fairy: the production composition honors the puzzle MultiPV-3 guarantee', { skip }, async () => {
  const composed = createAnalysisFromEnv(process.env);
  assert.ok(composed !== undefined, 'FAIRY_STOCKFISH_PATH is set, so analysis must be composed');
  try {
    const outcome = await composed.service.analyze({
      fen: `${ITALIAN.split(' 0 1')[0]} 3+3 0 1`,
      variant: 'threecheck',
      movetimeMs: 1_000,
      multiPv: 3,
    });
    assert.equal(outcome.lines.length, 3, 'multiPv: 3 must yield three distinct lines');
    assert.equal(new Set(outcome.lines.map((line) => line.principalVariation[0])).size, 3);
  } finally {
    await composed.shutdown({ deadlineMs: 5_000 });
  }
});

test('real Fairy: the counter the engine holds falls as checks are delivered', { skip }, async () => {
  const after = async (moves: string): Promise<string> =>
    engineFen(
      await uci([
        'uci',
        'setoption name UCI_Variant value 3check',
        `position fen 4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1${moves}`,
        'd',
      ]),
    );

  assert.match(await after(''), / 3\+3 /, 'no checks delivered yet');
  assert.match(await after(' moves d1e1'), / 2\+3 /, "White's counter falls on White's check");
  assert.match(
    await after(' moves d1e1 e8f8 e1d1 f8e8 d1e1'),
    / 1\+3 /,
    'and again on the second, while Black is untouched',
  );
});

test("real Fairy: the second counter is Black's", { skip }, async () => {
  const out = await uci([
    'uci',
    'setoption name UCI_Variant value 3check',
    'position fen r3k3/8/8/8/8/8/8/4K2R w - - 3+3 0 1 moves h1h8 e8e7 h8h5 a8a1',
    'd',
  ]);
  assert.match(
    engineFen(out),
    / 2\+2 /,
    'one check each must move both counters, not one of them twice',
  );
});

test('real Fairy: a six-field Three-Check FEN is read as one check from victory', { skip }, async () => {
  // Pinning the defect itself. If a future engine version stopped defaulting to `1+1`, the reason
  // this increment exists would have changed and this test should be the thing that says so.
  const out = await uci([
    'uci',
    'setoption name UCI_Variant value 3check',
    'position fen 4k3/8/8/8/8/8/8/3R3K w - - 0 1',
    'd',
  ]);
  assert.match(
    engineFen(out),
    / 1\+1 /,
    'a bare six-field FEN does not mean "no checks delivered" to this engine',
  );
});

test('real Fairy: the production path no longer reports a phantom mate for Three-Check', { skip }, async () => {
  const composed = createAnalysisFromEnv(process.env);
  assert.ok(composed !== undefined, 'FAIRY_STOCKFISH_PATH is set, so a composition must be built');

  try {
    // A legacy six-field FEN, exactly as a client may still send it. Before this increment the
    // engine received it verbatim and answered `mate 1`.
    const outcome = await composed.service.analyze({
      fen: ITALIAN,
      variant: 'threecheck',
      movetimeMs: 1_500,
      multiPv: 1,
    });

    const line = outcome.lines[0];
    assert.ok(line !== undefined, 'the engine must return a line for a live position');

    // A real search, not a fabricated or short-circuited result: without these the assertion below
    // would also pass on an empty line or a provider double.
    assert.ok(line.depth > 0, 'a real search reports a depth');
    assert.ok(line.principalVariation.length > 1, 'a real search reports a principal variation');
    assert.match(line.principalVariation[0] ?? '', /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    assert.equal(outcome.terminal, undefined, 'the position is live, not adjudicated');

    assert.notEqual(
      line.evaluation.type,
      'mate',
      'a position three checks from a win must not be scored as a forced mate',
    );
  } finally {
    // Always drain: a leaked subprocess outlives the test run and the runner will not exit.
    await composed.shutdown({ deadlineMs: 5_000 });
  }
});
