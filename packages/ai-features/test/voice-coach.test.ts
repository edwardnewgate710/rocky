/**
 * Hermetic test suite for `VoiceCoach` and the verbalization logic.
 *
 * Tests that:
 * - An **exhaustive move-to-speech table** — every SAN construct
 *   (piece moves, captures, both castlings, promotion, check, checkmate,
 *   pawn moves, pawn captures, disambiguated moves) produces the correct
 *   spoken English form. This is the failure mode: a verbalizer that reads
 *   `Nxe5` literally as "N-x-e-5" is broken.
 * - A full `verbalize(coachingResponse)` producing an ordered segment list
 *   from a coaching response with a blunder + better move.
 * - The Coach is actually called (spy/fake), not re-implemented.
 * - AI provider omitted → valid spoken segments from engine facts, no LLM
 *   narrative.
 * - The fake `SpeechSynthesizer`/`SpeechRecognizer` ports are exercised,
 *   proving the seam works.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '@chess-platform/core';
import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { VoiceCoach, verbalizeSan, verbalizeUci, speakSquare, speakClassification } from '../src/index.js';
import { FakeSpeechSynthesizer, FakeSpeechRecognizer } from '../src/speech-ports.js';
import { Coach } from '../src/coach.js';
import type { CoachingResponse } from '../src/coach-types.js';
import type { SpokenSegment } from '../src/voice-coach-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Create a fake engine that returns a fixed eval. */
function createFakeEngine(evalCp: number = 200, bestMove: string = 'g1f3'): AnalysisProvider {
  return {
    async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
      return [{
        multipv: 1,
        evaluation: { type: 'cp', value: evalCp },
        principalVariation: [bestMove],
        depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
      }];
    },
    async play(_request: PlayRequest): Promise<PlayResult> { return { move: bestMove }; },
    capabilitiesFor(_variant: string): EngineCapabilities | undefined { return undefined; },
  };
}

/** Create a fake coaching response for testing verbalize(). */
function fakeCoachingResponse(overrides: Partial<CoachingResponse> = {}): CoachingResponse {
  return {
    fen: STARTPOS,
    move: 'a2a3',
    featuresFired: ['mistakePredictor'],
    mistakeVerdict: {
      fen: STARTPOS,
      move: 'a2a3',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
      classification: 'blunder',
      centipawnLoss: 400,
      evalBefore: { type: 'cp', value: 200 },
      evalBeforeLabel: '+2.00',
      moveOutcome: {
        kind: 'evaluation',
        evaluation: { type: 'cp', value: -200 },
        label: '-2.00',
      },
      betterMove: 'g1f3',
      bestLine: ['g1f3'],
      depth: 20,
      coaching: null,
      providerId: null,
      model: null,
      usage: null,
      latencyMs: null,
    },
    moveExplanation: null,
    opening: null,
    puzzle: null,
    endgame: null,
    narrative: null,
    providerId: null,
    model: null,
    usage: null,
    latencyMs: null,
    ...overrides,
  };
}

/** Get a UCI move from a position by SAN-like search (for test setup). */
function uciFromSan(fen: string, sanPredicate: (san: string) => boolean): string | null {
  const pos = Position.fromFen(fen);
  for (const move of pos.legalMoves()) {
    const san = pos.toSan(move);
    if (sanPredicate(san)) return pos.toUci(move);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Exhaustive move-to-speech table test
// ---------------------------------------------------------------------------

describe('verbalizeSan — exhaustive move-to-speech table', () => {

  // Helper: play moves from a FEN to reach a position where a specific SAN
  // is legal, then assert the spoken form.
  function assertSpoken(san: string, expected: string): void {
    const spoken = verbalizeSan(san);
    assert.equal(
      spoken, expected,
      `verbalizeSan('${san}') should be "${expected}" but got "${spoken}"`,
    );
  }

  test('pawn moves', () => {
    assertSpoken('e4', 'e four');
    assertSpoken('d5', 'd five');
    assertSpoken('a3', 'a three');
    assertSpoken('h8', 'h eight');
  });

  test('pawn captures', () => {
    assertSpoken('exd5', 'e takes d five');
    assertSpoken('axb5', 'a takes b five');
    assertSpoken('dxc6', 'd takes c six');
  });

  test('piece moves (non-capture)', () => {
    assertSpoken('Nf3', 'Knight to f three');
    assertSpoken('Qd1', 'Queen to d one');
    assertSpoken('Bc4', 'Bishop to c four');
    assertSpoken('Rd1', 'Rook to d one');
    assertSpoken('Ke2', 'King to e two');
  });

  test('piece captures', () => {
    assertSpoken('Nxe5', 'Knight takes e five');
    assertSpoken('Qxf7', 'Queen takes f seven');
    assertSpoken('Bxc4', 'Bishop takes c four');
    assertSpoken('Rxa8', 'Rook takes a eight');
    assertSpoken('Kxe2', 'King takes e two');
  });

  test('castling — kingside', () => {
    assertSpoken('O-O', 'castles kingside');
  });

  test('castling — queenside', () => {
    assertSpoken('O-O-O', 'castles queenside');
  });

  test('promotion', () => {
    assertSpoken('e8=Q', 'e eight, promotes to queen');
    assertSpoken('e8=R', 'e eight, promotes to rook');
    assertSpoken('e8=B', 'e eight, promotes to bishop');
    assertSpoken('e8=N', 'e eight, promotes to knight');
  });

  test('promotion with capture', () => {
    assertSpoken('exd8=Q', 'e takes d eight, promotes to queen');
  });

  test('check', () => {
    assertSpoken('Qd1+', 'Queen to d one, check');
    assertSpoken('Nxe5+', 'Knight takes e five, check');
    assertSpoken('e4+', 'e four, check');
    assertSpoken('O-O+', 'castles kingside, check');
  });

  test('checkmate', () => {
    assertSpoken('Qd1#', 'Queen to d one, checkmate');
    assertSpoken('Nxe5#', 'Knight takes e five, checkmate');
    assertSpoken('e8=Q#', 'e eight, promotes to queen, checkmate');
    assertSpoken('O-O#', 'castles kingside, checkmate');
  });

  test('disambiguated moves — by file', () => {
    assertSpoken('Nbd7', 'Knight b to d seven');
    assertSpoken('Nfd2', 'Knight f to d two');
    assertSpoken('Rad1', 'Rook a to d one');
  });

  test('disambiguated moves — by rank', () => {
    assertSpoken('R1e2', 'Rook one to e two');
    assertSpoken('N1f3', 'Knight one to f three');
  });

  test('disambiguated moves — by full square', () => {
    assertSpoken('Qh4e1', 'Queen h four to e one');
  });

  test('disambiguated captures', () => {
    assertSpoken('Nbxd7', 'Knight b takes d seven');
    assertSpoken('R1xe2', 'Rook one takes e two');
  });

  test('castling with check and checkmate', () => {
    assertSpoken('O-O+', 'castles kingside, check');
    assertSpoken('O-O-O+', 'castles queenside, check');
    assertSpoken('O-O#', 'castles kingside, checkmate');
    assertSpoken('O-O-O#', 'castles queenside, checkmate');
  });
});

// ---------------------------------------------------------------------------
// 2. speakSquare and speakClassification unit tests
// ---------------------------------------------------------------------------

describe('speakSquare', () => {
  test('coordinates spoken as file + rank word', () => {
    assert.equal(speakSquare('e5'), 'e five');
    assert.equal(speakSquare('d1'), 'd one');
    assert.equal(speakSquare('h8'), 'h eight');
    assert.equal(speakSquare('a1'), 'a one');
    assert.equal(speakSquare('c3'), 'c three');
    assert.equal(speakSquare('f6'), 'f six');
  });
});

describe('speakClassification', () => {
  test('ok', () => {
    assert.equal(speakClassification('ok'), 'That move is fine.');
  });
  test('inaccuracy', () => {
    assert.equal(speakClassification('inaccuracy'), 'That move is a slight inaccuracy.');
  });
  test('mistake', () => {
    assert.equal(speakClassification('mistake'), 'That move is a mistake.');
  });
  test('blunder', () => {
    assert.equal(speakClassification('blunder'), 'That move is a blunder.');
  });
});

// ---------------------------------------------------------------------------
// 3. verbalizeUci — integration with chess-core
// ---------------------------------------------------------------------------

describe('verbalizeUci', () => {
  test('UCI move → spoken English via Position.toSan', () => {
    // e2e4 from the start position → SAN "e4" → "e four"
    assert.equal(verbalizeUci(STARTPOS, 'e2e4'), 'e four');
    // g1f3 from the start position → SAN "Nf3" → "Knight to f three"
    assert.equal(verbalizeUci(STARTPOS, 'g1f3'), 'Knight to f three');
  });

  test('castling via UCI', () => {
    // White kingside castling: e1g1 from a position where O-O is legal.
    // Ruy Lopez after 1.e4 e5 2.Nf3 Nc6 3.Bb5 — white can castle kingside.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';
    const spoken = verbalizeUci(fen, 'e1g1');
    assert.equal(spoken, 'castles kingside');
  });

  test('promotion via UCI', () => {
    // White pawn promotion: a7a8q
    // Use a position where promotion does NOT give check.
    // Black king on e5 (far from the 8th rank and not in line with a8).
    const fen = '8/P7/8/4k3/8/8/8/4K3 w - - 0 1';
    const spoken = verbalizeUci(fen, 'a7a8q');
    assert.equal(spoken, 'a eight, promotes to queen');
  });
});

// ---------------------------------------------------------------------------
// 4. VoiceCoach.verbalize — full coaching response → segment list
// ---------------------------------------------------------------------------

describe('VoiceCoach.verbalize (hermetic)', () => {

  test('blunder + better move → ordered segment list with correct spoken forms', async () => {
    const engine = createFakeEngine(200, 'g1f3');
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach });

    // Use a coaching response with a blunder and better move.
    const coaching = fakeCoachingResponse({
      fen: STARTPOS,
      move: 'a2a3',
      mistakeVerdict: {
        fen: STARTPOS,
        move: 'a2a3',
        fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
        classification: 'blunder',
        centipawnLoss: 400,
        evalBefore: { type: 'cp', value: 200 },
        evalBeforeLabel: '+2.00',
        moveOutcome: {
          kind: 'evaluation',
          evaluation: { type: 'cp', value: -200 },
          label: '-2.00',
        },
        betterMove: 'g1f3',
        bestLine: ['g1f3'],
        depth: 20,
        coaching: null,
        providerId: null,
        model: null,
        usage: null,
        latencyMs: null,
      },
    });

    const spoken = await voiceCoach.verbalize(coaching);

    // Should have an ordered segment list.
    assert.ok(spoken.segments.length >= 3, 'Should have greeting, assessment, better-move, closing');

    // First segment is a greeting.
    assert.equal(spoken.segments[0]!.kind, 'greeting');

    // Find the assessment segment.
    const assessmentSeg = spoken.segments.find((s) => s.kind === 'assessment');
    assert.ok(assessmentSeg, 'Should have an assessment segment');
    assert.ok(assessmentSeg!.text.includes('blunder'), 'Assessment should say "blunder"');
    // The played move should be spoken, not read literally.
    // a2a3 → SAN "a3" → "a three"
    assert.ok(assessmentSeg!.text.includes('a three'), 'Assessment should speak the move as "a three"');
    assert.ok(!assessmentSeg!.text.includes('a2a3'), 'Assessment should NOT contain raw UCI "a2a3"');

    // Find the better-move segment.
    const betterSeg = spoken.segments.find((s) => s.kind === 'better-move');
    assert.ok(betterSeg, 'Should have a better-move segment');
    // g1f3 → SAN "Nf3" → "Knight to f three"
    assert.ok(betterSeg!.text.includes('Knight to f three'), 'Better move should be spoken as "Knight to f three"');
    assert.ok(!betterSeg!.text.includes('g1f3'), 'Better move should NOT contain raw UCI "g1f3"');

    // Last segment is a closing.
    assert.equal(spoken.segments[spoken.segments.length - 1]!.kind, 'closing');

    // The underlying coaching response is included for traceability.
    assert.equal(spoken.coaching, coaching);
  });

  test('no features fired → closing with "no specific lessons"', async () => {
    const engine = createFakeEngine(0, 'e2e4');
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach });

    const coaching = fakeCoachingResponse({
      featuresFired: [],
      move: null,
      mistakeVerdict: null,
    });

    const spoken = await voiceCoach.verbalize(coaching);

    // Should have greeting + closing with "no specific lessons".
    const closingSeg = spoken.segments.find((s) => s.kind === 'closing');
    assert.ok(closingSeg);
    assert.ok(closingSeg!.text.includes('No specific lessons'));
  });
});

// ---------------------------------------------------------------------------
// 5. VoiceCoach.coachAloud — Coach is actually called (spy test)
// ---------------------------------------------------------------------------

describe('VoiceCoach.coachAloud — Coach spy test', () => {

  test('Coach is actually called, not re-implemented', async () => {
    let coachCalled = false;
    let coachCallCount = 0;

    const spyCoach = {
      coach: async (_request: unknown) => {
        coachCalled = true;
        coachCallCount++;
        return fakeCoachingResponse();
      },
    } as unknown as Coach;

    const voiceCoach = new VoiceCoach({ coach: spyCoach });
    const spoken = await voiceCoach.coachAloud({ fen: STARTPOS, move: 'a2a3' });

    assert.ok(coachCalled, 'VoiceCoach should call Coach.coach');
    assert.equal(coachCallCount, 1, 'Coach should be called exactly once');
    assert.ok(spoken.segments.length > 0, 'Should produce spoken segments');
    assert.equal(spoken.coaching.move, 'a2a3');
  });
});

// ---------------------------------------------------------------------------
// 6. AI provider omitted → valid spoken segments from engine facts, no LLM
// ---------------------------------------------------------------------------

describe('VoiceCoach — AI provider omitted', () => {

  test('verbalizes engine facts without LLM narrative', async () => {
    const engine = createFakeEngine(200, 'g1f3');
    const coach = new Coach({ engine }); // No AI provider.
    const voiceCoach = new VoiceCoach({ coach }); // No AI provider.

    const coaching = fakeCoachingResponse({
      narrative: null,
      providerId: null,
      model: null,
      usage: null,
    });

    const spoken = await voiceCoach.verbalize(coaching);

    // Should have valid spoken segments from engine facts.
    assert.ok(spoken.segments.length >= 3);

    // Should have an assessment segment (from the mistake verdict).
    const assessmentSeg = spoken.segments.find((s) => s.kind === 'assessment');
    assert.ok(assessmentSeg, 'Should have assessment from engine facts');
    assert.ok(assessmentSeg!.text.includes('blunder'));

    // Should have a better-move segment.
    const betterSeg = spoken.segments.find((s) => s.kind === 'better-move');
    assert.ok(betterSeg, 'Should have better-move from engine facts');
    assert.ok(betterSeg!.text.includes('Knight to f three'));

    // Should NOT have a narrative segment (no AI provider).
    const narrativeSeg = spoken.segments.find((s) => s.kind === 'narrative');
    assert.equal(narrativeSeg, undefined, 'Should not have narrative segment without AI provider');
  });
});

// ---------------------------------------------------------------------------
// 7. Fake SpeechSynthesizer / SpeechRecognizer ports exercised
// ---------------------------------------------------------------------------

describe('VoiceCoach — speech ports seam', () => {

  test('FakeSpeechSynthesizer returns deterministic spoken text', async () => {
    const synth = new FakeSpeechSynthesizer();
    const result = await synth.synthesize({ text: 'Knight to f three' });

    assert.equal(result.text, 'Knight to f three');
    assert.equal(result.audio, '[SPOKEN: "Knight to f three"]');
    assert.equal(result.format, 'text');
    assert.equal(result.providerId, 'fake-tts');
  });

  test('FakeSpeechRecognizer maps canned tokens to commands', async () => {
    const rec = new FakeSpeechRecognizer();

    const explainResult = await rec.recognize({ audio: 'explain' });
    assert.deepEqual(explainResult.command, { kind: 'explain' });
    assert.equal(explainResult.confidence, 1.0);

    const stopResult = await rec.recognize({ audio: 'stop' });
    assert.deepEqual(stopResult.command, { kind: 'stop' });

    const unknownResult = await rec.recognize({ audio: 'hello world' });
    assert.deepEqual(unknownResult.command, { kind: 'unknown', text: 'hello world' });
  });

  test('VoiceCoach.speak() exercises the SpeechSynthesizer port', async () => {
    const synth = new FakeSpeechSynthesizer();
    const engine = createFakeEngine();
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach, synthesizer: synth });

    const coaching = fakeCoachingResponse();
    const spoken = await voiceCoach.verbalize(coaching);
    const audioResults = await voiceCoach.speak(spoken);

    // One result per segment.
    assert.equal(audioResults.length, spoken.segments.length);

    // Each result has the deterministic fake audio format.
    for (const result of audioResults) {
      assert.ok(result.audio.startsWith('[SPOKEN:'));
      assert.equal(result.providerId, 'fake-tts');
    }
  });

  test('VoiceCoach.listen() exercises the SpeechRecognizer port', async () => {
    const rec = new FakeSpeechRecognizer();
    const engine = createFakeEngine();
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach, recognizer: rec });

    const result = await voiceCoach.listen('explain');

    assert.deepEqual(result.command, { kind: 'explain' });
    assert.equal(result.providerId, 'fake-stt');
  });

  test('speak() without synthesizer → throws', async () => {
    const engine = createFakeEngine();
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach });

    const coaching = fakeCoachingResponse();
    const spoken = await voiceCoach.verbalize(coaching);

    await assert.rejects(() => voiceCoach.speak(spoken), /No SpeechSynthesizer/);
  });

  test('listen() without recognizer → throws', async () => {
    const engine = createFakeEngine();
    const coach = new Coach({ engine });
    const voiceCoach = new VoiceCoach({ coach });

    await assert.rejects(() => voiceCoach.listen('test'), /No SpeechRecognizer/);
  });
});

// ---------------------------------------------------------------------------
// 8. VoiceCoach with AI provider → narrative smoothing
// ---------------------------------------------------------------------------

describe('VoiceCoach — with AI provider', () => {

  test('AI provider present → narrative segment included', async () => {
    const engine = createFakeEngine();
    const ai = new FakeProvider({ id: 'fake-ai', content: 'This is a smooth narrative.' });
    const coach = new Coach({ engine }); // Coach without AI (so coaching.narrative is null)
    const voiceCoach = new VoiceCoach({ coach, ai }); // VoiceCoach with AI for smoothing

    const coaching = fakeCoachingResponse({
      narrative: null,
      providerId: null,
      model: null,
    });

    const spoken = await voiceCoach.verbalize(coaching);

    // Should have a narrative segment from the VoiceCoach's AI smoothing.
    const narrativeSeg = spoken.segments.find((s) => s.kind === 'narrative');
    assert.ok(narrativeSeg, 'Should have narrative segment from AI smoothing');
    assert.equal(narrativeSeg!.text, 'This is a smooth narrative.');
  });

  test('Coach narrative is included if present (no VoiceCoach AI)', async () => {
    const engine = createFakeEngine();
    const coachAI = new FakeProvider({ id: 'coach-ai', content: 'Coach narrative.' });
    const coach = new Coach({ engine, ai: coachAI });
    const voiceCoach = new VoiceCoach({ coach }); // No VoiceCoach AI

    // Build a coaching response with a narrative from the Coach's AI.
    const coaching = fakeCoachingResponse({
      narrative: 'Coach narrative.',
      providerId: 'coach-ai',
    });

    const spoken = await voiceCoach.verbalize(coaching);

    // Should include the Coach's narrative as a segment.
    const narrativeSeg = spoken.segments.find((s) => s.kind === 'narrative');
    assert.ok(narrativeSeg, 'Should have narrative segment from Coach');
    assert.equal(narrativeSeg!.text, 'Coach narrative.');
  });
});

/**
 * A verdict with no centipawn measure never puts the token `null` into the model's prompt.
 *
 * `centipawnLoss` became nullable in M15 increment 5: a transition touching a mate score, or a game
 * decided in a win or a loss, has no centipawn count to report. `buildSummary` interpolated it
 * unconditionally, so those verdicts reached the model as "cp loss: null" — a token that reads as a
 * value rather than as an absence, in the one text the narrative is derived from.
 *
 * This drives `buildSummary`, which is reachable **only** with an AI provider attached: the spoken
 * segments come from `speakMistake`, which never mentions the figure. An earlier version of this
 * test asserted on `spoken.segments` with no provider and therefore could not fail — caught by
 * mutating the fix back out and watching it still pass.
 */
test('a verdict with no centipawn measure reaches the model without the word null', async () => {
  const engine = createFakeEngine(200, 'g1f3');
  const coach = new Coach({ engine });

  const prompts: string[] = [];
  const inner = new FakeProvider({ id: 'fake-ai', content: 'A smooth narrative.' });
  const recording = {
    id: inner.id,
    complete: async (request: Parameters<typeof inner.complete>[0]) => {
      prompts.push(request.messages.map((m) => m.content).join('\n'));
      return inner.complete(request);
    },
  } as unknown as typeof inner;

  const voiceCoach = new VoiceCoach({ coach, ai: recording });

  const coaching = fakeCoachingResponse({
    fen: STARTPOS,
    move: 'a2a3',
    narrative: null,
    providerId: null,
    model: null,
    mistakeVerdict: {
      fen: STARTPOS,
      move: 'a2a3',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
      classification: 'blunder',
      // The move walked into a forced mate: a real verdict, with no centipawn count behind it.
      centipawnLoss: null,
      evalBefore: { type: 'cp', value: 200 },
      evalBeforeLabel: '+2.00',
      moveOutcome: {
        kind: 'evaluation',
        evaluation: { type: 'mate', value: -3 },
        label: 'mate in -3',
      },
      betterMove: null,
      bestLine: [],
      depth: 20,
      coaching: null,
      providerId: null,
      model: null,
      usage: null,
      latencyMs: null,
    },
  });

  await voiceCoach.verbalize(coaching);

  assert.equal(prompts.length, 1, 'precondition: the narrative path ran');
  const prompt = prompts[0]!;
  assert.match(prompt, /blunder/i, 'the verdict itself still reaches the model');
  assert.equal(/\bnull\b/i.test(prompt), false, 'no literal null in the prompt');
  assert.equal(/Infinity/i.test(prompt), false, 'and no leftover sentinel either');
});
