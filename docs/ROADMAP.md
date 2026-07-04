# Gambit — Milestone Roadmap

Each milestone ships **real, tested code** and has explicit acceptance criteria.
We do not advance until a milestone's criteria are met and it passes a
self-critique + multi-perspective review. This is deliberately incremental: the
full platform is a multi-year effort, and correctness compounds.

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## ✅ Milestone 1 — Rules engine core (`@chess-platform/core`)

The correctness-critical foundation everything else depends on.

- ✅ 0x88 board, immutable `Position`, FEN parse/serialize, UCI + SAN.
- ✅ Legal move generation: castling, en passant, promotion, pins, checks.
- ✅ Variants: Chess960 scaffolding, King of the Hill, Atomic, Crazyhouse
  (drops + pockets), Three-Check, Horde, Racing Kings.
- ✅ Terminal detection: checkmate, stalemate, insufficient material, fifty-move,
  variant win/draw conditions.
- ✅ **Acceptance:** `perft` matches published reference node counts for 5
  positions (startpos d4=197,281; Kiwipete d3=97,862; +3 edge cases). 14/14 tests
  pass; strict TypeScript with zero errors.

**Known follow-ups (tracked):** perft suites for each variant; threefold
repetition via position-hash history; Chess960 castling-by-file; PGN parser.

---

## ⬜ Milestone 2 — Game Authority + event sourcing ✅ done

- ✅ Deterministic clock model (`clock.ts`): Fischer increment, Bronstein/US
  delay, sudden-death, unlimited; flag detection; speed classification.
- ✅ Event-sourcing types (`events.ts`): `GameCreated`, `MovePlayed`,
  `DrawOffered`/`DrawDeclined`, `GameEnded`.
- ✅ `Game` aggregate (`game.ts`): server-authoritative legality via
  `@chess-platform/core`; commands (`playMove`, `resign`, `offerDraw`,
  `acceptDraw`, `declineDraw`, `claimFlag`, `abort`); pure reducer;
  `Game.fromEvents` reconstructs any game exactly.
- ✅ Terminal handling: checkmate, stalemate, timeout (with insufficient-material
  → draw), resignation, agreement, variant win/draw, abort.
- ✅ **Acceptance met:** 18/18 tests pass. Clock math property tests; a game is
  reconstructed byte-for-byte (FEN, ply, clocks, SAN) from its event log; a
  2,000-game reconstruction runs at ~1.17ms/game (headroom for high
  concurrency). Strict TypeScript, zero errors.

**Follow-ups (tracked):** threefold-repetition via position-hash history in the
aggregate; per-variant timeout material rules.

## ⬜ Milestone 3 — Realtime Gateway

- WebSocket server, rooms, presence, Redis pub/sub fanout.
- Reconnect/resume from `lastPly`, spectator mode, ping/latency compensation.
- **Acceptance:** reconnection integration test; 50k idle + 5k active WS
  connections sustained in load test with p99 move-broadcast < 50ms intra-region.

## ⬜ Milestone 4 — API & identity

- REST + GraphQL, argon2id + passkeys, sessions/refresh rotation, RBAC.
- Users, profiles, seeks/lobby, Glicko-2 ratings per variant, leaderboards.
- **Acceptance:** authZ matrix tests; rating updates verified against Glicko-2
  reference; OpenAPI published.

## ⬜ Milestone 5 — Engine bridge

- Stockfish + Fairy-Stockfish UCI worker pool; analysis, eval bars, hints, bots
  with rating-calibrated strength.
- **Acceptance:** analysis of a known game matches expected best moves; pool
  autoscales under queue load.

## ⬜ Milestone 6 — Web frontend (playable)

- Board UI (animation, premoves, drag + click), clock, game view, lobby,
  profile; PWA; a11y; light/dark.
- **Acceptance:** e2e (Playwright) plays a full game vs. bot and vs. human;
  Lighthouse a11y ≥ 95.

## ⬜ Milestone 7 — AI orchestration layer

- Provider adapters (OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Ollama),
  routing, benchmarking, voting, engine-grounded prompts, caching, rate limits.
- **Acceptance:** failover test (kill a provider mid-request); benchmark report;
  grounded move-explanation cited against engine eval.

## ⬜ Milestone 8 — AI features

Coach, Move Explanation, Opening/Endgame Trainer, Puzzle Generator, Tournament
Commentator, Voice Coach, Study Partner, Opening Explorer, Mistake Predictor —
each a task over M5 + M7.

## ⬜ Milestone 9 — Tournaments & broadcast

Arena + Swiss + round-robin, pairings, tiebreaks, live broadcast multiplexing.

## ⬜ Milestone 10 — Social & learning

Teams/communities, forums, messaging, friends/followers, achievements; lessons,
courses, video library, PGN import, studies (collaborative), opening/endgame
encyclopedias, master game explorer.

## ⬜ Milestone 11 — Search

Keyword + semantic (pgvector/Meilisearch) over games, openings, players, studies;
natural-language query parsing.

## ⬜ Milestone 12 — Security hardening & anti-cheat

Engine-correlation scoring, bot detection, fraud/DDoS, audit, pen-test pass.

## ⬜ Milestone 13 — Observability & SRE

OpenTelemetry, Prometheus, Grafana, alerting, SLOs, runbooks, chaos tests.

## ⬜ Milestone 14 — Deployment & scale

Docker, Kubernetes, Terraform, GitHub Actions, blue/green + canary, rollback,
secrets management, 100k-user load + chaos validation.

---

## Working method (applied every milestone)

1. **Build** the milestone to its acceptance criteria with tests.
2. **Self-critique loop:** review for architectural mistakes, perf bottlenecks,
   security issues, poor abstractions, duplication, race conditions, API
   inconsistencies, UX gaps — then refactor.
3. **Multi-perspective review:** evaluate from the viewpoints of a distributed-
   systems engineer, a performance engineer, a security engineer, and a chess-
   server maintainer; merge and apply feedback.
4. Advance only when no critical issue remains.
