/**
 * `VoiceCoach` — M8 increment 8.
 *
 * Turns coaching output into speech-ready text.  The Voice Coach
 * **composes the `Coach`** — it does not re-implement analysis.  All
 * chess facts still come from the Coach / feature modules (engine-verified).
 * The Voice Coach only reshapes text for speech; it invents no assessments.
 *
 * The real, tested contribution is the **verbalization logic**: converting
 * a `CoachingResponse` (and chess moves) into natural spoken English via
 * the pure `verbalizeSan` / `verbalizeUci` transforms.
 *
 * Voice is split into **logic** (built now, hermetic) and **delivery**
 * (deferred to the deployment layer via the `SpeechSynthesizer` /
 * `SpeechRecognizer` ports).  No live TTS/STT service is integrated here.
 *
 * If no AI provider is supplied, the Voice Coach still verbalizes the
 * structured engine facts — the move-to-speech transform needs no LLM.
 * The LLM, if present, only smooths the connective narrative.
 */

import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import { Coach } from './coach.js';
import type { CoachingResponse, CoachRequest } from './coach-types.js';
import type { MistakeVerdict } from './mistake-types.js';
import type { MoveExplanationResponse } from './types.js';
import type { ExplorationResult } from './opening-types.js';
import type { TrainingPosition } from './endgame-types.js';
import type { MoveUci } from './types.js';

import { verbalizeUci, speakClassification } from './verbalizer.js';

import type {
  SpokenCoaching,
  SpokenSegment,
  SpokenSegmentKind,
  VoiceCoachOptions,
} from './voice-coach-types.js';
import type {
  SpeechSynthesizer,
  SpeechRecognizer,
  SynthesizeRequest,
  SynthesizeResult,
  RecognizeRequest,
  RecognizeResult,
} from './speech-ports.js';

// ---------------------------------------------------------------------------
// VoiceCoach
// ---------------------------------------------------------------------------

/**
 * Turns coaching into speech-ready output.
 *
 * The Voice Coach composes the `Coach` (it does not re-implement
 * analysis).  Its contribution is the verbalization: converting
 * `CoachingResponse` fields into an ordered list of short, natural
 * spoken segments ready for TTS.
 */
export class VoiceCoach {
  private readonly coach: Coach;
  private readonly synthesizer: SpeechSynthesizer | undefined;
  private readonly recognizer: SpeechRecognizer | undefined;
  private readonly ai: AiProvider | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: VoiceCoachOptions) {
    this.coach = options.coach;
    this.synthesizer = options.synthesizer;
    this.recognizer = options.recognizer;
    this.ai = options.ai;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Run the Coach and verbalize the result.
   *
   * Calls `Coach.coach(request)` to get the structured coaching response,
   * then transforms it into an ordered list of spoken segments.  The
   * Coach is actually called — analysis is not re-implemented here.
   */
  async coachAloud(request: CoachRequest): Promise<SpokenCoaching> {
    const coaching = await this.coach.coach(request);
    return this.verbalize(coaching);
  }

  /**
   * Verbalize a `CoachingResponse` into speech-ready segments.
   *
   * This is the core verbalization logic.  It takes the structured
   * coaching response and produces an ordered list of short, natural
 * spoken segments.  All chess facts come from the coaching response
   * (engine-verified); the Voice Coach only reshapes text for speech.
   *
   * If an AI provider is supplied, the LLM smooths the connective
   * narrative.  If not, the segments are built from engine facts only.
   */
  async verbalize(coaching: CoachingResponse): Promise<SpokenCoaching> {
    const segments: SpokenSegment[] = [];

    // 1. Greeting.
    segments.push(this.segment('greeting', 'Let me coach you on this position.'));

    // 2. Mistake assessment (if a move was played).
    if (coaching.mistakeVerdict) {
      segments.push(this.speakMistake(coaching.mistakeVerdict, coaching.fen, coaching.variant));
    }

    // 3. Better move (if the engine found a better move).
    if (coaching.mistakeVerdict && coaching.mistakeVerdict.betterMove && coaching.mistakeVerdict.betterMove !== '(none)') {
      const spoken = verbalizeUci(coaching.fen, coaching.mistakeVerdict.betterMove, coaching.variant);
      segments.push(this.segment('better-move', `Instead, consider ${spoken}.`));
    }

    // 4. Move explanation (if available).
    if (coaching.moveExplanation) {
      segments.push(this.speakMoveExplanation(coaching.moveExplanation));
    }

    // 5. Opening identification.
    if (coaching.opening) {
      segments.push(this.speakOpening(coaching.opening));
    }

    // 6. Puzzle detection.
    if (coaching.puzzle && coaching.puzzle.kind === 'puzzle') {
      segments.push(this.speakPuzzle(coaching.puzzle, coaching.fen, coaching.variant));
    }

    // 7. Endgame training.
    if (coaching.endgame) {
      segments.push(this.speakEndgame(coaching.endgame));
    }

    // 8. Narrative smoothing (if AI provider is supplied).
    if (this.ai && coaching.featuresFired.length > 0) {
      const narrative = await this.smoothNarrative(coaching);
      if (narrative) {
        segments.push(this.segment('narrative', narrative));
      }
    } else if (coaching.narrative) {
      // If the Coach already produced a narrative (from its own AI),
      // include it as a narrative segment.
      segments.push(this.segment('narrative', coaching.narrative));
    }

    // 9. Closing.
    if (segments.length <= 1) {
      // No features fired — nothing to coach about.
      segments.push(this.segment('closing', 'No specific lessons for this position. Keep playing!'));
    } else {
      segments.push(this.segment('closing', 'That is my assessment. Your move.'));
    }

    return { segments, coaching };
  }

  /**
   * Speak a mistake verdict.
   */
  private speakMistake(
    verdict: MistakeVerdict,
    fen: string,
    variant: CoachingResponse['variant'],
  ): SpokenSegment {
    const assessment = speakClassification(verdict.classification);
    if (verdict.move) {
      const spokenMove = verbalizeUci(fen, verdict.move, variant);
      return this.segment('assessment', `${assessment} You played ${spokenMove}.`);
    }
    return this.segment('assessment', assessment);
  }

  /**
   * Speak a move explanation.
   */
  private speakMoveExplanation(explanation: MoveExplanationResponse): SpokenSegment {
    // The explanation is already natural-language prose from the MoveExplainer.
    // We include it as-is — it is already speakable.
    return this.segment('better-move', explanation.explanation);
  }

  /**
   * Speak an opening identification.
   */
  private speakOpening(opening: ExplorationResult): SpokenSegment {
    const name = opening.name ?? 'an unknown opening';
    const eco = opening.eco ? ` ECO code ${opening.eco}.` : '';
    const book = opening.outOfBook ? ' You are out of book.' : ' You are still in book.';
    return this.segment('opening', `This is the ${name}.${eco}${book}`);
  }

  /**
   * Speak a puzzle detection.
   */
  private speakPuzzle(
    puzzle: { kind: 'puzzle'; solutionMove: MoveUci; theme: string | null; difficulty: string },
    fen: string,
    variant: CoachingResponse['variant'],
  ): SpokenSegment {
    const spokenSolution = verbalizeUci(fen, puzzle.solutionMove, variant);
    const theme = puzzle.theme ? ` The theme is ${puzzle.theme}.` : '';
    return this.segment('puzzle', `There is a tactical puzzle here.${theme} The solution is ${spokenSolution}. Difficulty: ${puzzle.difficulty}.`);
  }

  /**
   * Speak an endgame training position.
   */
  private speakEndgame(endgame: TrainingPosition): SpokenSegment {
    const name = endgame.entry.name;
    const goal = this.speakGoal(endgame.goal);
    return this.segment('endgame', `This is an endgame training position: ${name}. The goal is ${goal}.`);
  }

  /** Speak an endgame goal. */
  private speakGoal(goal: import('./endgame-database.js').EndgameGoal): string {
    switch (goal.kind) {
      case 'mate': return `mate in ${goal.distance}`;
      case 'win': return `to win — ${goal.description}`;
      case 'draw': return `to draw — ${goal.description}`;
    }
  }

  /**
   * Smooth the narrative using the LLM.
   *
   * The LLM takes the structured segments and produces a smooth,
   * conversational narrative.  It does not invent chess facts — it only
   * rephrases what the features already found.
   */
  private async smoothNarrative(coaching: CoachingResponse): Promise<string | null> {
    if (!this.ai) return null;

    const summary = this.buildSummary(coaching);
    const grounding: EngineGrounding = { fen: coaching.fen, variant: coaching.variant };

    const userContent =
      'You are a voice chess coach. Convert the following engine-verified analysis ' +
      'into a brief, natural, spoken-English narrative. Use spoken forms for moves ' +
      '(e.g. "Knight to f three", not "Nf3"). Do not invent assessments — only ' +
      'rephrase what the analysis found. Keep it concise and conversational.\n\n' +
      summary;

    const messages = buildGroundedMessages([{ role: 'user', content: userContent }], grounding);

    const completionRequest: CompletionRequest = {
      task: 'general',
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      grounding,
    };

    const response = await this.ai.complete(completionRequest);
    return response.content;
  }

  /** Build a text summary of the coaching response for the LLM. */
  private buildSummary(coaching: CoachingResponse): string {
    const lines: string[] = [`Position FEN: ${coaching.fen}`];

    if (coaching.move) {
      const spokenMove = verbalizeUci(coaching.fen, coaching.move, coaching.variant);
      lines.push(`Move played: ${spokenMove} (UCI: ${coaching.move})`);
    }

    if (coaching.mistakeVerdict) {
      const v = coaching.mistakeVerdict;
      // `centipawnLoss` is nullable since M15 increment 5. Spoken aloud, the literal token `null`
      // is worse than omitting the figure entirely.
      lines.push(
        v.centipawnLoss === null
          ? `Assessment: ${v.classification}.`
          : `Assessment: ${v.classification} (cp loss: ${v.centipawnLoss}).`,
      );
      if (v.betterMove && v.betterMove !== '(none)') {
        const spokenBetter = verbalizeUci(coaching.fen, v.betterMove, coaching.variant);
        lines.push(`Better move: ${spokenBetter} (UCI: ${v.betterMove}).`);
      }
    }

    if (coaching.moveExplanation) {
      lines.push(`Explanation: ${coaching.moveExplanation.explanation}`);
    }

    if (coaching.opening) {
      lines.push(`Opening: ${coaching.opening.name} (ECO ${coaching.opening.eco}). ${coaching.opening.outOfBook ? 'Out of book.' : 'In book.'}`);
    }

    if (coaching.puzzle && coaching.puzzle.kind === 'puzzle') {
      const spokenSolution = verbalizeUci(coaching.fen, coaching.puzzle.solutionMove, coaching.variant);
      lines.push(`Puzzle: theme ${coaching.puzzle.theme ?? 'tactics'}, solution ${spokenSolution}, difficulty ${coaching.puzzle.difficulty}.`);
    }

    if (coaching.endgame) {
      lines.push(`Endgame: ${coaching.endgame.entry.name}. Goal: ${this.speakGoal(coaching.endgame.goal)}.`);
    }

    if (lines.length === 1) {
      lines.push('No specific lessons found for this position.');
    }

    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Convenience methods for the speech ports
  // -----------------------------------------------------------------------

  /**
   * Synthesize speech for the spoken coaching using the injected
   * `SpeechSynthesizer`.  Returns one `SynthesizeResult` per segment.
   *
   * This is a convenience method — the caller can also feed segments to
   * their own synthesizer.  If no synthesizer was injected, throws.
   */
  async speak(spoken: SpokenCoaching): Promise<SynthesizeResult[]> {
    if (!this.synthesizer) {
      throw new Error('No SpeechSynthesizer configured');
    }
    const results: SynthesizeResult[] = [];
    for (const segment of spoken.segments) {
      const request: SynthesizeRequest = { text: segment.text };
      const result = await this.synthesizer.synthesize(request);
      results.push(result);
    }
    return results;
  }

  /**
   * Recognize a voice command using the injected `SpeechRecognizer`.
   *
   * If no recognizer was injected, throws.
   */
  async listen(audio: string, format?: string): Promise<RecognizeResult> {
    if (!this.recognizer) {
      throw new Error('No SpeechRecognizer configured');
    }
    const request: RecognizeRequest = { audio, ...(format ? { format } : {}) };
    return this.recognizer.recognize(request);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Create a spoken segment. */
  private segment(kind: SpokenSegmentKind, text: string): SpokenSegment {
    return { kind, text };
  }
}
