import type { RoundBasedConfig } from './config';
import type { PairingContext, PairingStrategy, Round, CompletedRound, PlayerHistory } from './pairing';
import type { GameResult, PlayerStanding } from './standings';
import { computeStandings } from './standings';

export type TournamentState = 'registration' | 'running' | 'finished';

/**
 * A plain, JSON-serializable representation of the tournament's state.
 */
export interface TournamentSnapshot {
  readonly config: RoundBasedConfig;
  readonly state: TournamentState;
  readonly participants: readonly string[];
  readonly withdrawn?: readonly string[];
  readonly rounds: readonly Round[];
  readonly results: readonly (readonly [string, GameResult | 'bye' | 'void'])[];
  readonly pairingsByMatchId: readonly (readonly [string, { readonly p1: string; readonly p2: string | null }])[];
  readonly gameLinks?: readonly (readonly [string, string])[];
  /** matchId -> number of games launched so far (bumped when a game is abandoned). */
  readonly gameAttempts?: readonly (readonly [string, number])[];
}

export class Tournament {
  private state: TournamentState = 'registration';
  private readonly participants: string[] = [];
  private readonly withdrawn = new Set<string>();
  private readonly rounds: Round[] = [];

  // matchId -> result
  private readonly results = new Map<string, GameResult | 'bye' | 'void'>();
  private readonly pairingsByMatchId = new Map<string, { p1: string; p2: string | null }>();
  
  // matchId <-> gameId
  private readonly gameLinks = new Map<string, string>();
  private readonly gameIds = new Map<string, string>();
  // matchId -> how many games have been launched for it. Bumped on abandon so a
  // re-launched pairing gets a fresh, non-colliding gameId (see AuthorityGameLauncher).
  private readonly gameAttempts = new Map<string, number>();

  constructor(
    public readonly config: RoundBasedConfig,
    private readonly pairingStrategy: PairingStrategy
  ) {}

  getState(): TournamentState {
    return this.state;
  }

  getParticipants(): readonly string[] {
    // Return a copy so callers can't mutate registration state through it.
    return [...this.participants];
  }

  getRounds(): readonly Round[] {
    return this.rounds;
  }

  register(playerId: string): void {
    if (this.state !== 'registration') {
      throw new Error('Cannot register after tournament has started');
    }
    if (!this.participants.includes(playerId)) {
      this.participants.push(playerId);
    }
  }

  withdraw(playerId: string): void {
    if (this.state === 'finished') {
      throw new Error('Cannot withdraw after tournament has finished');
    }

    if (this.state === 'registration') {
      const idx = this.participants.indexOf(playerId);
      if (idx >= 0) {
        this.participants.splice(idx, 1);
      }
      return;
    }

    // running state
    if (!this.participants.includes(playerId)) {
      return;
    }
    if (this.withdrawn.has(playerId)) {
      return;
    }

    this.withdrawn.add(playerId);

    // Forfeit their UNFINISHED game in the current round, if any
    if (this.rounds.length > 0) {
      const currentRound = this.rounds[this.rounds.length - 1];
      for (let p = 0; p < currentRound.pairings.length; p++) {
        const pairing = currentRound.pairings[p];
        const matchId = `${currentRound.roundIndex}-${p}`;
        
        if (!this.results.has(matchId)) {
          if (pairing.kind === 'game') {
            if (pairing.white === playerId || pairing.black === playerId) {
              const result = pairing.white === playerId ? 'black_win' : 'white_win';
              this.results.set(matchId, result);
            }
          } else if (pairing.kind === 'bye') {
            if (pairing.player === playerId) {
              this.results.set(matchId, 'void');
            }
          }
        } else if (this.results.get(matchId) === 'bye' && pairing.kind === 'bye' && pairing.player === playerId) {
          // If a bye was already recorded for this round (as they are by default in indexRound), void it
          this.results.set(matchId, 'void');
        }
      }
    }

    // After forfeit, the round might be complete
    this.tryAdvance();

    // Check if tournament should finish gracefully
    if (this.participants.length - this.withdrawn.size < 2) {
      this.state = 'finished';
    }
  }

  start(): void {
    if (this.state !== 'registration') {
      throw new Error('Tournament already started');
    }
    if (this.participants.length < 2) {
      throw new Error('Need at least 2 players to start a tournament');
    }

    this.state = 'running';

    // Generate round 1
    this.advanceRound();
  }

  recordResult(roundIndex: number, pairingIndex: number, result: GameResult): void {
    if (this.state !== 'running') {
      throw new Error('Cannot record result unless tournament is running');
    }

    const matchId = `${roundIndex}-${pairingIndex}`;
    if (!this.pairingsByMatchId.has(matchId)) {
      throw new Error('Unknown pairing');
    }
    if (this.pairingsByMatchId.get(matchId)?.p2 === null) {
      throw new Error('Cannot record result for a bye');
    }

    this.results.set(matchId, result);

    // Check if the current round is fully resolved, and if so advance
    this.tryAdvance();
  }

  linkGame(roundIndex: number, pairingIndex: number, gameId: string): void {
    const matchId = `${roundIndex}-${pairingIndex}`;
    if (!this.pairingsByMatchId.has(matchId)) {
      throw new Error('Unknown pairing');
    }
    if (this.pairingsByMatchId.get(matchId)?.p2 === null) {
      throw new Error('Cannot link game to a bye');
    }
    // Re-linking a match to a new game must not leave the old gameId dangling in
    // the reverse map, otherwise recordResultByGame(oldGameId) would still resolve.
    const previousGameId = this.gameLinks.get(matchId);
    if (previousGameId !== undefined && previousGameId !== gameId) {
      this.gameIds.delete(previousGameId);
    }
    this.gameLinks.set(matchId, gameId);
    this.gameIds.set(gameId, matchId);
  }

  gameIdFor(roundIndex: number, pairingIndex: number): string | undefined {
    return this.gameLinks.get(`${roundIndex}-${pairingIndex}`);
  }

  pairingForGame(gameId: string): { roundIndex: number; pairingIndex: number } | null {
    const matchId = this.gameIds.get(gameId);
    if (!matchId) return null;
    const [roundIndexStr, pairingIndexStr] = matchId.split('-');
    return { roundIndex: parseInt(roundIndexStr, 10), pairingIndex: parseInt(pairingIndexStr, 10) };
  }

  recordResultByGame(gameId: string, result: GameResult): void {
    const matchId = this.gameIds.get(gameId);
    if (!matchId) {
      throw new Error('Unknown game ID');
    }
    const [roundIndexStr, pairingIndexStr] = matchId.split('-');
    this.recordResult(parseInt(roundIndexStr, 10), parseInt(pairingIndexStr, 10), result);
  }

  /** How many games have been launched for this pairing (0 before the first). */
  launchAttemptFor(roundIndex: number, pairingIndex: number): number {
    return this.gameAttempts.get(`${roundIndex}-${pairingIndex}`) ?? 0;
  }

  /**
   * Abandon a launched-but-undecided game (e.g. it was aborted before a result).
   * Unlinks it and bumps the pairing's launch attempt so the next launch produces
   * a fresh, non-colliding gameId — letting the pairing be replayed cleanly.
   */
  abandonGame(gameId: string): void {
    const matchId = this.gameIds.get(gameId);
    if (!matchId) {
      throw new Error('Unknown game ID');
    }
    if (this.results.has(matchId)) {
      throw new Error('Cannot abandon a game that already has a result');
    }
    this.gameLinks.delete(matchId);
    this.gameIds.delete(gameId);
    this.gameAttempts.set(matchId, (this.gameAttempts.get(matchId) ?? 0) + 1);
  }

  /**
   * The recorded result for one pairing, or `undefined` while it is still unresolved.
   *
   * `bye` and `void` are results in this map as much as a decided game is: a round is not waiting
   * on them. Callers that need a *played* game must therefore check the value, not just presence.
   */
  resultFor(roundIndex: number, pairingIndex: number): GameResult | 'bye' | 'void' | undefined {
    return this.results.get(`${roundIndex}-${pairingIndex}`);
  }

  /**
   * Whether every pairing in a round has a recorded result.
   *
   * This is the condition {@link tryAdvance} uses to decide the round is over, exposed rather than
   * restated so a caller asking "is this round complete?" gets the same answer the aggregate acts
   * on. A second copy of the rule outside this class would be free to drift from the one that
   * actually advances the tournament.
   *
   * An out-of-range index is `false`, not an error: a round that does not exist is certainly not
   * complete, and callers reaching this with a user-supplied number should not have to pre-check.
   */
  isRoundComplete(roundIndex: number): boolean {
    // Found by its own `roundIndex` rather than by array position. The two agree today —
    // `buildContext` passes `roundNumber: this.rounds.length` and both strategies echo it back — but
    // matchIds are keyed on `round.roundIndex`, so reading a round by position would silently answer
    // about a different round the day a strategy numbers them any other way.
    const round = this.rounds.find((candidate) => candidate.roundIndex === roundIndex);
    if (!round) return false;
    for (let p = 0; p < round.pairings.length; p += 1) {
      if (!this.results.has(`${roundIndex}-${p}`)) return false;
    }
    return true;
  }

  /**
   * Standings as they stood at the end of a round, ignoring every later result.
   *
   * {@link standings} answers "how does the table look now", which is a different question and the
   * wrong one for anything that reports on a particular round: by the time a round-3 recap is
   * requested, round 4 may already have decided games, and presenting the current table beside
   * round 3's results would label later facts with an earlier round's number.
   *
   * **The `withdrawn` flag on each row is current, not historical.** Results are filtered by round;
   * withdrawals are not, because the aggregate records *that* a player withdrew and not *when*.
   * A player who withdrew in round 4 is therefore flagged withdrawn in a round-3 table where they
   * were still playing. Every other field — points, tiebreaks, ordering, the ranking itself — is
   * computed from the filtered results and is correct as of the round.
   *
   * No caller publishes the flag today: `RecapStanding` in the commentary service carries rank,
   * name and points only. Fixing it means recording a withdrawal round and migrating
   * {@link TournamentSnapshot}, which is a change to the persisted format and belongs in its own
   * increment. Raised in the CodeRabbit review of PR #153; recorded here so the next caller that
   * wants the flag finds out before publishing it rather than after.
   */
  standingsAfterRound(roundIndex: number): PlayerStanding[] {
    const upTo = new Map<string, GameResult | 'bye' | 'void'>();
    for (const [matchId, result] of this.results.entries()) {
      const round = Number.parseInt(matchId.slice(0, matchId.indexOf('-')), 10);
      if (Number.isFinite(round) && round <= roundIndex) upTo.set(matchId, result);
    }
    return computeStandings(
      this.getParticipants(),
      upTo,
      this.pairingsByMatchId,
      this.config.tiebreakOrder,
      this.withdrawn,
    );
  }

  standings(): PlayerStanding[] {
    return computeStandings(
      this.getParticipants(),
      this.results,
      this.pairingsByMatchId,
      this.config.tiebreakOrder,
      this.withdrawn
    );
  }

  /** Build the PairingContext from current state. */
  private buildContext(): PairingContext {
    const completedRounds: CompletedRound[] = [];
    for (const round of this.rounds) {
      const roundResults = new Map<string, GameResult | 'bye' | 'void'>();
      for (let p = 0; p < round.pairings.length; p++) {
        const matchId = `${round.roundIndex}-${p}`;
        const result = this.results.get(matchId);
        if (result !== undefined) {
          roundResults.set(matchId, result);
        }
      }
      completedRounds.push({ round, results: roundResults });
    }

    // Build per-player history
    const playerHistory = new Map<string, PlayerHistory>();
    const historyState = new Map<string, {
      opponents: string[];
      whiteCount: number;
      blackCount: number;
      byeCount: number;
      points: number;
    }>();

    for (const pid of this.participants) {
      historyState.set(pid, {
        opponents: [],
        whiteCount: 0,
        blackCount: 0,
        byeCount: 0,
        points: 0
      });
    }

    for (const [matchId, result] of this.results.entries()) {
      const pairing = this.pairingsByMatchId.get(matchId);
      if (!pairing) continue;

      if (result === 'bye' || result === 'void') {
        const s = historyState.get(pairing.p1);
        if (s && result === 'bye') {
          s.byeCount += 1;
          s.points += 1;
        }
        continue;
      }

      const p2 = pairing.p2;
      if (!p2) continue;

      const s1 = historyState.get(pairing.p1);
      const s2 = historyState.get(p2);
      if (!s1 || !s2) continue;

      s1.opponents.push(p2);
      s2.opponents.push(pairing.p1);
      s1.whiteCount += 1;
      s2.blackCount += 1;

      if (result === 'white_win') {
        s1.points += 1;
      } else if (result === 'black_win') {
        s2.points += 1;
      } else if (result === 'draw') {
        s1.points += 0.5;
        s2.points += 0.5;
      }
      // double_forfeit yields 0 points for both
    }

    for (const [pid, s] of historyState.entries()) {
      playerHistory.set(pid, {
        opponents: s.opponents,
        whiteCount: s.whiteCount,
        blackCount: s.blackCount,
        byeCount: s.byeCount,
        points: s.points
      });
    }

    // Exclude withdrawn players from the context for Swiss so they aren't paired again.
    // Round-robin keeps them to maintain the fixed schedule, relying on the indexRound safety net.
    const activeParticipants = this.config.format === 'swiss'
      ? this.participants.filter(p => !this.withdrawn.has(p))
      : this.participants;

    return {
      participants: activeParticipants,
      roundNumber: this.rounds.length,
      completedRounds,
      playerHistory
    };
  }

  /** Index a newly generated round's pairings and auto-record byes. */
  private indexRound(round: Round): void {
    for (let p = 0; p < round.pairings.length; p++) {
      const pairing = round.pairings[p];
      const matchId = `${round.roundIndex}-${p}`;
      
      if (pairing.kind === 'game') {
        this.pairingsByMatchId.set(matchId, { p1: pairing.white, p2: pairing.black });
        
        // Safety net for round robin: auto-record forfeit if either player is withdrawn
        const w1 = this.withdrawn.has(pairing.white);
        const w2 = this.withdrawn.has(pairing.black);
        if (w1 && w2) {
          this.results.set(matchId, 'double_forfeit');
        } else if (w1) {
          this.results.set(matchId, 'black_win');
        } else if (w2) {
          this.results.set(matchId, 'white_win');
        }
      } else {
        this.pairingsByMatchId.set(matchId, { p1: pairing.player, p2: null });
        if (this.withdrawn.has(pairing.player)) {
          this.results.set(matchId, 'void');
        } else {
          this.results.set(matchId, 'bye');
        }
      }
    }
  }

  /** Generate the next round via the pairing strategy. */
  private advanceRound(): void {
    const context = this.buildContext();
    const nextRound = this.pairingStrategy.pairNextRound(context);

    if (nextRound === null) {
      this.state = 'finished';
      return;
    }

    this.rounds.push(nextRound);
    this.indexRound(nextRound);

    // If the round is fully resolved (e.g. all byes or double forfeits), advance again
    this.tryAdvance();
  }

  /** Check if the current round is fully resolved; if so, advance. */
  private tryAdvance(): void {
    if (this.state !== 'running' || this.rounds.length === 0) return;

    const currentRound = this.rounds[this.rounds.length - 1];
    if (this.isRoundComplete(currentRound.roundIndex)) {
      this.advanceRound();
    }
  }

  /** Returns a deep, structurally-cloned snapshot of the tournament's state. */
  toSnapshot(): TournamentSnapshot {
    return {
      config: JSON.parse(JSON.stringify(this.config)),
      state: this.state,
      participants: [...this.participants],
      withdrawn: Array.from(this.withdrawn),
      rounds: JSON.parse(JSON.stringify(this.rounds)),
      results: Array.from(this.results.entries()),
      pairingsByMatchId: Array.from(this.pairingsByMatchId.entries()).map(([k, v]) => [k, { ...v }]),
      gameLinks: Array.from(this.gameLinks.entries()),
      gameAttempts: Array.from(this.gameAttempts.entries())
    };
  }

  /** Rebuilds an active aggregate from a snapshot. */
  static restore(snapshot: TournamentSnapshot, strategy: PairingStrategy): Tournament {
    const t = new Tournament(snapshot.config, strategy);
    t.state = snapshot.state;
    t.participants.push(...snapshot.participants);
    if (snapshot.withdrawn) {
      for (const w of snapshot.withdrawn) {
        t.withdrawn.add(w);
      }
    }
    t.rounds.push(...snapshot.rounds);
    for (const [matchId, result] of snapshot.results) {
      t.results.set(matchId, result);
    }
    for (const [matchId, pairing] of snapshot.pairingsByMatchId) {
      t.pairingsByMatchId.set(matchId, { ...pairing });
    }
    for (const [matchId, gameId] of snapshot.gameLinks || []) {
      t.gameLinks.set(matchId, gameId);
      t.gameIds.set(gameId, matchId);
    }
    for (const [matchId, attempt] of snapshot.gameAttempts || []) {
      t.gameAttempts.set(matchId, attempt);
    }
    return t;
  }
}

