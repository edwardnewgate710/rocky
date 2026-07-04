# Gambit — System Architecture

This is the target architecture for the full platform. It is the design contract
that each milestone builds toward. Sections marked ✅ have shipped; the rest are
designed here and implemented on the roadmap.

## 1. Guiding principles

1. **Correctness first.** The rules engine is the source of truth and is
   property-tested (perft) before anything is built on top of it. ✅
2. **The server is the authority.** Clients never decide legality or results;
   they render server-validated state. This is the anti-cheat and
   anti-desync foundation.
3. **Stateless edges, stateful core.** HTTP/API nodes are stateless and
   horizontally scalable; game state lives in a small number of sharded,
   in-memory game processes backed by an event log.
4. **Event sourcing for games.** A game is an append-only sequence of validated
   moves/events. Current state is a fold over events; this gives free replay,
   spectator catch-up, reconnection, and audit.
5. **AI is a pluggable layer, never in the hot path** of gameplay legality.

## 2. High-level component map

```
                         ┌────────────┐
        Browser / App ── │    CDN     │ (static assets, replays)
              │          └────────────┘
              │ WSS / HTTPS
        ┌─────▼──────┐   ┌──────────────┐
        │  Edge /    │   │  API Gateway │  REST + GraphQL, authN/Z, rate limit
        │  LB (L7)   │   └──────┬───────┘
        └─────┬──────┘          │
   WebSocket  │                 │ gRPC / NATS
        ┌─────▼───────────┐  ┌──▼───────────┐  ┌──────────────┐
        │  Realtime Gateway│  │ Core Services│  │ AI Orchestr. │
        │ (WS fanout, rooms)│ │ users, games,│  │ router+voting │
        └─────┬───────────┘  │ tournaments, │  └──────┬───────┘
              │              │ social, learn │         │
        ┌─────▼───────────┐  └──┬───────────┘   ┌──────▼────────┐
        │ Game Authority   │     │              │ Engine Bridge  │
        │ (sharded actors, │◄────┘              │ Stockfish /    │
        │  event-sourced)  │                    │ Fairy-Stockfish│
        └─────┬───────────┘                     └───────────────┘
              │ events
   ┌──────────┼───────────────┬───────────────┬──────────────┐
┌──▼───┐  ┌───▼────┐     ┌─────▼─────┐   ┌─────▼─────┐  ┌─────▼─────┐
│ Redis│  │Postgres│     │  Kafka /  │   │  Search   │  │ Object    │
│cache │  │(primary│     │  NATS     │   │ (pgvector │  │ store     │
│+pub  │  │+replica)│    │ streams   │   │ /Meili)   │  │ (PGNs,    │
│ sub  │  └────────┘     └───────────┘   └───────────┘  │ replays)  │
└──────┘                                                 └───────────┘
```

## 3. Services

| Service | Responsibility | Scaling model |
|---|---|---|
| **Realtime Gateway** | WS connections, room membership, presence, fanout of authoritative events, latency/ping | Stateless; sticky by connection, state in Redis |
| **Game Authority** | Owns live game state; validates every move with `@chess-platform/core`; emits events; clocks | Sharded actors keyed by gameId; one owner per game |
| **API / Core** | Users, profiles, ratings, seeks/lobby, tournaments, social graph, studies, learning | Stateless replicas behind gateway |
| **AI Orchestrator** | Routes AI requests to providers, benchmarking, voting/ensemble, caching, cost/rate control | Stateless; queue-backed for heavy jobs |
| **Engine Bridge** | UCI process pool for Stockfish + Fairy-Stockfish (variants); analysis, hints, bots | Worker pool, autoscaled by queue depth |
| **Search** | Semantic + keyword search over games/openings/players/studies | Read replica + vector index |

Rationale for splitting Realtime from Game Authority: connection fanout scales
with *spectators* (can be huge for a broadcast), while state ownership scales
with *active games*. Decoupling lets 100k spectators watch a game held by one
authoritative shard.

## 4. Real-time protocol

- Transport: WebSocket (WSS), binary frames (MessagePack) for moves, JSON for
  control. Fallback to long-poll only for degraded networks.
- **Authority model:** client sends intended move `{gameId, uci, clientSeq}`.
  Authority validates via the core engine, applies to the event log, and
  broadcasts `{ply, san, fenHash, clockW, clockB, serverTs}`. Clients that sent
  an illegal move receive a rejection and roll back the optimistic render.
- **Reconnect:** client stores `lastPly`; on reconnect it sends `resume(gameId,
  lastPly)` and the gateway replays missed events from Redis stream / event log.
- **Latency compensation:** clocks are authoritative on the server; the client
  shows an interpolated clock corrected by measured RTT/2 (ping frames every 3s).
  Move animation is client-side and never affects timing.
- **Spectators & broadcast:** read-only room; events fan out via Redis pub/sub to
  all gateway nodes holding subscribers. Tournament broadcasting multiplexes many
  boards into one subscription.
- **Offline recovery:** unsent optimistic moves are queued and reconciled against
  authoritative state on resume; conflicts always resolve to server truth.

## 5. Data model (Postgres, abbreviated)

Event-sourced games + relational projections for query.

```
users(id, handle, email_hash, created_at, country, flags)
credentials(user_id, kind, secret_hash, ...)          -- argon2id
ratings(user_id, variant, rating, rd, vol, updated_at) -- Glicko-2 per variant
games(id, variant, rated, speed, white_id, black_id,
      result, termination, opening_eco, ply_count, started_at, ended_at)
game_events(game_id, ply, type, payload jsonb, server_ts)  -- append-only, PK(game_id, ply)
game_pgn(game_id, pgn text, fen_final)                 -- projection
tournaments(id, kind, variant, format, starts_at, status, ...)
tournament_players(tournament_id, user_id, score, tiebreak, seed)
studies(id, owner_id, name, visibility, chapters jsonb)
study_members(study_id, user_id, role)                 -- collaborative RBAC
follows(follower_id, followee_id)
friends(a_id, b_id, status)
messages(id, thread_id, sender_id, body, created_at)
puzzles(id, fen, moves, themes text[], rating, rd)
openings(eco, name, pgn, fen, popularity, embedding vector)  -- pgvector
audit_log(id, actor_id, action, target, meta jsonb, ts)
anti_cheat_signals(user_id, game_id, signal, score, model_ver, ts)
```

Indexing & scale:
- `game_events` PK `(game_id, ply)` — clustered access per game.
- `games` partitioned by month on `started_at`; BRIN on time, btree on player ids.
- Ratings/leaderboards cached in Redis sorted sets, rebuilt from Postgres.
- Read replicas for analytics/search; primary for writes only.
- pgvector for opening/study/game semantic embeddings.

## 6. AI orchestration layer

A provider-agnostic router with these responsibilities:

- **Adapters** for OpenAI, Anthropic, Google, DeepSeek, OpenRouter, and Ollama
  (local) behind one `complete()` / `stream()` / `embed()` interface.
- **Routing** by task class (coach, explanation, commentary, puzzle-gen),
  latency budget, cost ceiling, and availability. Automatic failover.
- **Benchmarking** harness scoring providers on curated chess tasks (move
  explanation accuracy vs. engine eval, puzzle solvability) → routing weights.
- **Voting / ensemble** for high-stakes outputs (e.g. mistake prediction):
  query N models, reconcile, and attach confidence.
- **Grounding:** every chess-reasoning prompt is grounded with engine facts
  (eval, best line, legal moves from the core) so the LLM explains rather than
  invents. This is the key to trustworthy AI coaching.
- Caching keyed by (task, positionHash, model) + strict per-user rate limits.

AI features (Coach, Move Explanation, Opening/Endgame Trainer, Puzzle Generator,
Commentator, Voice Coach, Study Partner, Opening Explorer, Mistake Predictor)
are all thin task definitions over this layer + the engine bridge.

## 7. Security

- **Zero-trust:** every internal call is authenticated (mTLS / signed service
  tokens); no implicit network trust.
- **AuthN:** argon2id passwords, WebAuthn/passkeys, OAuth; short-lived access
  tokens + rotating refresh; device/session registry with revocation.
- **RBAC:** roles (user, coach, tournament-director, moderator, admin) enforced
  at the gateway and re-checked in services; study/team fine-grained roles.
- **Anti-cheat:** server-side engine-correlation scoring (centipawn-loss vs.
  rating, move-time distributions, blunder patterns), plus behavioral bot
  detection; signals feed a review queue, never auto-ban silently. Replay
  protection via `clientSeq` + server ply monotonicity.
- **Abuse/infra:** L7 rate limiting, WAF, DDoS protection at the edge, per-IP and
  per-account quotas, audit logging of all privileged actions.

## 8. Observability

- **Tracing:** OpenTelemetry across gateway → authority → services → AI.
- **Metrics:** Prometheus (move latency, WS fanout, clock drift, queue depth,
  provider latency/cost); **Grafana** dashboards; SLO-based alerting.
- **Logging:** structured JSON, correlation id per request/game, shipped to a log
  store; PII-scrubbed.

## 9. Performance & deployment

- Target **100k+ concurrent connections** via horizontally scaled stateless
  gateways + sharded authority; Redis for presence/pubsub; Kafka/NATS for events.
- **Containers:** Docker; **orchestration:** Kubernetes (HPA on CPU + custom WS
  metrics). **IaC:** Terraform. **CI/CD:** GitHub Actions with lint → typecheck →
  unit → integration → e2e → load gates.
- **Progressive delivery:** blue/green for stateless services, canary for the
  authority (drain games before cutover), automated rollback on SLO breach.
- **CDN** for static assets, opening books, and replay files.

## 10. Frontend

- TypeScript + a modern component framework, mobile-first responsive, PWA with
  offline board; accessible (ARIA board, keyboard play, screen-reader move
  announcements); light/dark themes; move animation via the render layer only.
- Shares `@chess-platform/core` for instant client-side legality hints and
  premoves, always reconciled against server authority.
