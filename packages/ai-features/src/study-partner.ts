/**
 * `StudyPartner` — M8 increment 7.
 *
 * A stateful multi-step learning session that tracks the learner's
 * progress across several positions/moves.  This is the first M8
 * feature with session state.
 *
 * The Study Partner orchestrates the Coach; it does not re-implement
 * analysis.  Each turn, it uses the `Coach` to analyze the learner's
 * current position/move, records the outcome into the session, and
 * advances the learning plan.  Verified chess facts still originate
 * from the engine via the features.
 *
 * Session state lives behind a `StudySessionStore` port (with an
 * `InMemoryStudySessionStore` default).  Session state is explicit and
 * serializable — a plain data object that the store persists.  No
 * hidden mutable state on the class instance.
 *
 * This introduces the **stateful-session pattern**: session store port
 * + explicit serializable state.  Tournament Commentator (M9) may reuse
 * it.
 */

import type { AiProvider, CompletionRequest, EngineGrounding, TokenUsage } from '@chess-platform/ai-orchestrator';
import { buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import { Coach } from './coach.js';
import type { CoachingResponse } from './coach-types.js';
import type { MistakeClassification } from './mistake-types.js';

import type { StudySessionStore, StudySession, StudyTurn, SessionProgress } from './study-session-store.js';
import type {
  StartSessionRequest, StartSessionResponse,
  SubmitTurnRequest, SubmitTurnResponse,
  EndSessionRequest, EndSessionResponse,
  SessionSummary,
} from './study-types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a `StudyPartner`. */
export interface StudyPartnerOptions {
  /** The study session store port. */
  readonly store: StudySessionStore;
  /** The Coach (composition layer over the five features). */
  readonly coach: Coach;
  /** The AI completion provider (M7 port, optional narrative). */
  readonly ai?: AiProvider;
  /** Default temperature for the LLM call. */
  readonly temperature?: number;
  /** Default max output tokens. */
  readonly maxTokens?: number;
  /** ID generator (for session ids).  Defaults to crypto.randomUUID. */
  readonly idGenerator?: () => string;
}

// ---------------------------------------------------------------------------
// StudyPartner
// ---------------------------------------------------------------------------

/**
 * A stateful study partner that runs multi-step learning sessions.
 *
 * Session state is managed through the `StudySessionStore` port.  Each
 * method loads the session, operates on a copy, and saves it back —
 * no hidden mutable state on the class instance.
 */
export class StudyPartner {
  private readonly store: StudySessionStore;
  private readonly coach: Coach;
  private readonly ai: AiProvider | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly idGenerator: () => string;

  constructor(options: StudyPartnerOptions) {
    this.store = options.store;
    this.coach = options.coach;
    this.ai = options.ai;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 768;
    this.idGenerator = options.idGenerator ?? (() => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /**
   * Start a new study session.
   */
  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const id = this.idGenerator();
    const now = new Date().toISOString();
    const initialFen = request.initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    const session: StudySession = {
      id,
      topic: request.topic,
      difficulty: request.difficulty ?? null,
      status: 'active',
      turns: [],
      progress: emptyProgress(),
      currentFen: initialFen,
      createdAt: now,
      completedAt: null,
    };

    await this.store.create(session);

    // Optionally generate an introductory narrative.
    let narrative: string | null = null;
    if (this.ai) {
      narrative = await this.generateNarrative(
        `Starting a study session on "${request.topic}". ` +
        `The first position is ${initialFen}. ` +
        `Provide a brief, encouraging introduction to the session.`,
        initialFen,
      );
    }

    return { session, currentFen: initialFen, narrative };
  }

  /**
   * Submit a turn: run the Coach, append the turn, update progress.
   */
  async submitTurn(request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    // 1. Load the session.
    const session = await this.store.load(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }
    if (session.status !== 'active') {
      throw new Error(`Session is not active: ${request.sessionId}`);
    }

    // 2. Run the Coach to analyze the position/move.
    const coaching: CoachingResponse = await this.coach.coach({
      fen: request.fen,
      ...(request.move ? { move: request.move } : {}),
      ...(request.moves ? { moves: request.moves } : {}),
    });

    // 3. Extract the mistake classification (if a move was played).
    const mistakeClassification: MistakeClassification | null =
      coaching.mistakeVerdict?.classification ?? null;

    // 4. Build the turn record.
    const turn: StudyTurn = {
      turnNumber: session.turns.length + 1,
      fen: request.fen,
      move: request.move ?? null,
      coaching,
      mistakeClassification,
      timestamp: new Date().toISOString(),
    };

    // 5. Update the session (immutable copy).
    const turns = [...session.turns, turn];
    const progress = computeProgress(turns);
    const nextFen = request.nextFen ?? null;

    const updatedSession: StudySession = {
      ...session,
      turns,
      progress,
      currentFen: nextFen,
    };

    // 6. Persist.
    await this.store.save(updatedSession);

    // 7. Optionally generate narrative.
    let narrative: string | null = null;
    if (this.ai) {
      const summary = this.buildTurnSummary(turn, progress);
      narrative = await this.generateNarrative(summary, request.fen);
    }

    return {
      session: updatedSession,
      coaching,
      progress,
      nextFen,
      narrative,
    };
  }

  /**
   * End a session: mark complete, produce a summary.
   */
  async endSession(request: EndSessionRequest): Promise<EndSessionResponse> {
    // 1. Load the session.
    const session = await this.store.load(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    // 2. Mark as completed.
    const completedSession: StudySession = {
      ...session,
      status: 'completed',
      completedAt: new Date().toISOString(),
      currentFen: null,
    };

    await this.store.save(completedSession);

    // 3. Build the summary from recorded turns.
    const summary = this.buildSummary(completedSession);

    // 4. Optionally generate narrative.
    let narrative: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      const summaryText = this.buildSessionSummaryText(completedSession, summary);
      const result = await this.generateNarrativeWithMeta(summaryText, completedSession.turns[0]?.fen ?? '');
      narrative = result.narrative;
      providerId = result.providerId;
      model = result.model;
      usage = result.usage;
      latencyMs = result.latencyMs;
    }

    return {
      session: completedSession,
      progress: completedSession.progress,
      summary,
      narrative,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async generateNarrative(content: string, fen: string): Promise<string | null> {
    const result = await this.generateNarrativeWithMeta(content, fen);
    return result.narrative;
  }

  private async generateNarrativeWithMeta(content: string, fen: string): Promise<{
    narrative: string | null;
    providerId: string | null;
    model: string | null;
    usage: TokenUsage | null;
    latencyMs: number | null;
  }> {
    if (!this.ai) {
      return { narrative: null, providerId: null, model: null, usage: null, latencyMs: null };
    }

    const grounding: EngineGrounding = { fen };
    const messages = buildGroundedMessages(
      [{ role: 'user', content }],
      grounding,
    );

    const completionRequest: CompletionRequest = {
      task: 'general',
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      grounding,
    };

    const response = await this.ai.complete(completionRequest);
    return {
      narrative: response.content,
      providerId: response.providerId,
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
    };
  }

  private buildTurnSummary(turn: StudyTurn, progress: SessionProgress): string {
    const lines: string[] = [
      `Turn ${turn.turnNumber}: position ${turn.fen}`,
      turn.move ? `Learner played: ${turn.move}` : 'No move submitted (position analysis).',
    ];

    if (turn.mistakeClassification) {
      lines.push(`Mistake assessment: ${turn.mistakeClassification}`);
    }

    if (turn.coaching.opening) {
      lines.push(`Opening: ${turn.coaching.opening.name}`);
    }

    if (turn.coaching.puzzle && turn.coaching.puzzle.kind === 'puzzle') {
      lines.push(`Tactical puzzle detected.`);
    }

    if (turn.coaching.endgame) {
      lines.push(`Endgame: ${turn.coaching.endgame.entry.name}`);
    }

    lines.push(`Progress: ${progress.turnsCompleted} turns, accuracy ${(progress.accuracy * 100).toFixed(0)}%, ` +
      `${progress.blunderCount} blunders, ${progress.mistakeCount} mistakes, ${progress.inaccuracyCount} inaccuracies.`);

    return lines.join('\n');
  }

  private buildSummary(session: StudySession): SessionSummary {
    const p = session.progress;
    const recommendedNextFocus = this.deriveNextFocus(session);

    return {
      totalTurns: p.turnsCompleted,
      accuracy: p.accuracy,
      classificationCounts: {
        ok: p.okCount,
        inaccuracy: p.inaccuracyCount,
        mistake: p.mistakeCount,
        blunder: p.blunderCount,
      },
      topicsCovered: p.topicsCovered,
      featuresUsed: p.featuresUsed,
      recommendedNextFocus,
    };
  }

  private deriveNextFocus(session: StudySession): string {
    const p = session.progress;
    if (p.blunderCount > 0) {
      return 'Focus on avoiding blunders — double-check moves before playing.';
    }
    if (p.mistakeCount > 0) {
      return 'Focus on calculation depth — look 2-3 moves ahead before committing.';
    }
    if (p.inaccuracyCount > 0) {
      return 'Focus on finding the best move, not just a good one.';
    }
    if (p.turnsCompleted > 0) {
      return 'Great work! Try a harder topic or a new area to continue improving.';
    }
    return 'Start a new session to begin learning.';
  }

  private buildSessionSummaryText(session: StudySession, summary: SessionSummary): string {
    const lines: string[] = [
      `Study session completed: "${session.topic}".`,
      `Total turns: ${summary.totalTurns}.`,
      `Accuracy: ${(summary.accuracy * 100).toFixed(0)}%.`,
      `Blunders: ${summary.classificationCounts.blunder}, ` +
        `Mistakes: ${summary.classificationCounts.mistake}, ` +
        `Inaccuracies: ${summary.classificationCounts.inaccuracy}, ` +
        `Good moves: ${summary.classificationCounts.ok}.`,
      `Topics covered: ${summary.topicsCovered.join(', ') || 'none'}.`,
      `Recommended next focus: ${summary.recommendedNextFocus}`,
      `Provide a brief, encouraging summary of the session and the recommendation.`,
    ];
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/** Create an empty progress metrics object. */
export function emptyProgress(): SessionProgress {
  return {
    turnsCompleted: 0,
    okCount: 0,
    inaccuracyCount: 0,
    mistakeCount: 0,
    blunderCount: 0,
    noMoveCount: 0,
    accuracy: 1.0,
    featuresUsed: [],
    topicsCovered: [],
  };
}

/**
 * Compute progress metrics from a list of turns.
 *
 * This is a pure function — given the turns, it derives the metrics.
 * This makes progress accounting testable without running the full
 * StudyPartner.
 */
export function computeProgress(turns: readonly StudyTurn[]): SessionProgress {
  let okCount = 0;
  let inaccuracyCount = 0;
  let mistakeCount = 0;
  let blunderCount = 0;
  let noMoveCount = 0;

  const featuresUsedSet = new Set<string>();
  const topicsCoveredSet = new Set<string>();

  for (const turn of turns) {
    const cls = turn.mistakeClassification;
    if (cls === null) {
      noMoveCount++;
    } else if (cls === 'ok') {
      okCount++;
    } else if (cls === 'inaccuracy') {
      inaccuracyCount++;
    } else if (cls === 'mistake') {
      mistakeCount++;
    } else if (cls === 'blunder') {
      blunderCount++;
    }

    // Collect features used.
    for (const f of turn.coaching.featuresFired) {
      featuresUsedSet.add(f);
    }

    // Collect topics.
    if (turn.coaching.opening?.name) {
      topicsCoveredSet.add(turn.coaching.opening.name);
    }
    if (turn.coaching.puzzle?.kind === 'puzzle') {
      topicsCoveredSet.add('Tactics');
    }
    if (turn.coaching.endgame?.entry.name) {
      topicsCoveredSet.add(turn.coaching.endgame.entry.name);
    }
  }

  const turnsWithMoves = okCount + inaccuracyCount + mistakeCount + blunderCount;
  const accuracy = turnsWithMoves > 0
    ? (okCount + 0.5 * inaccuracyCount) / turnsWithMoves
    : 1.0;

  return {
    turnsCompleted: turns.length,
    okCount,
    inaccuracyCount,
    mistakeCount,
    blunderCount,
    noMoveCount,
    accuracy,
    featuresUsed: [...featuresUsedSet].sort(),
    topicsCovered: [...topicsCoveredSet].sort(),
  };
}
