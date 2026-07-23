# ADR-0035 — Anti-Cheat Automated Auto-Analysis Worker

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-23                                                       |
| **Scope**  | `@chess-platform/realtime-gateway`, `@chess-platform/api` (M12) |

---

## Context

Anti-Cheat Increment 6 added an on-demand analysis service (`AntiCheatAnalysisService`) and moderation REST endpoint `POST /v1/moderation/anti-cheat/games/:gameId/analyze`. However, observing terminal game completion across the platform required per-game channel subscriptions. There was no global channel carrying game-ended events platform-wide, and no background worker to automatically trigger analysis upon game completion.

## Decision

We introduce a global game-ended channel in `@chess-platform/realtime-gateway` and an automated background worker (`AntiCheatAutoAnalyzer`) in `@chess-platform/api`.

### 1. Global Game-Ended Fan-Out Channel (`gamesEndedChannel`)

- Added `gamesEndedChannel(): string` returning `'games:ended'` in `@chess-platform/realtime-gateway`.
- `GameAuthority` (the single owner of a live game state under ADR-0010) fans out terminal `EndedBroadcast` messages to `gamesEndedChannel()` in addition to the per-game channel `gameChannel(gameId)`.
- Because each game is owned by exactly one authority node, each game's terminal `ended` broadcast is published to `gamesEndedChannel()` exactly once per game completion.

### 2. Auto-Analysis Worker (`AntiCheatAutoAnalyzer`)

- Implemented in `packages/api/src/anti-cheat/auto-analyzer.ts`.
- Subscribes once to `gamesEndedChannel()` on `start()`.
- **Deduplication:** Maintains an in-process `seen: Set<string>` of processed game IDs to avoid duplicate analysis runs within a worker process. The set is bounded (FIFO eviction past a cap) so a worker running indefinitely does not grow it without bound; an evicted-then-redelivered game is safely re-analyzed thanks to idempotent upserts.
- **Fire-and-Forget & Crash-Safety:** Analysis is launched as a background promise and tracked in `inFlight: Set<Promise<void>>`. Rejections are passed to `options.onError` (defaulting to `console.error`) and remove the game ID from `seen` so subsequent re-broadcasts can retry. The pubsub message handler never throws, preventing subscriber failure or process crashes (mirroring `TournamentResultReporter`).
- **Idempotency:** Delegates to `GameAnalyzer.analyzeAndStore(gameId, opts)`. The underlying service upserts reports keyed by `(playerId, gameId)`, so at-least-once delivery is safe.
- **Cleanup & Testing:** Provides `stop()` to unsubscribe and clear local state, and `async drain()` to await in-flight promises deterministically in tests.

### 3. Engine Gating & Export Seams

- Exports `AntiCheatAutoAnalyzer`, `AntiCheatAnalysisService`, and `EventStoreGameSource` from `@chess-platform/api` so they can be hosted by a deployment process.
- Real engine evaluation remains env-gated behind `analysisProvider`.

### 4. Deferrals

- **Worker Hosting in Gateway:** Hosting the auto-analysis worker inside `services/gateway` behind an environment flag and real `AnalysisProvider` is a deployment step deferred to a future deployment increment (the gateway currently builds no Stockfish/engine binaries).
- **Single-Worker Topology:** Deploying the worker in a single process per region/environment. Multi-replica worker deployments will deliver each `ended` event to all replicas, resulting in N× analysis passes (which remains correct due to idempotent report upserts, but wastes engine compute). Multi-node worker partitioning is deferred until worker scaling requires it.

## Consequences

- **Automated Anti-Cheat Analysis:** Finished games can be automatically analyzed upon completion without requiring manual moderator intervention.
- **Robustness & Isolation:** Analysis failures or missing engine configurations do not affect real-time game play or crash the gateway process.
- **Clean Seams:** Package purity is preserved — `@chess-platform/api` depends on `@chess-platform/realtime-gateway`, and no domain packages are modified.
