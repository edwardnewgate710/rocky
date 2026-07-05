# Gambit — Milestone Roadmap

Each milestone ships **real, tested code** and has explicit acceptance criteria.
We do not advance until a milestone's criteria are met and it passes a
self-critique + multi-perspective review. This is deliberately incremental: the
full platform is a multi-year effort, and correctness compounds.

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## ✅ Milestone 1 — Rules engine core (`@chess-platform/core`)

[unchanged]

## ✅ Milestone 2 — Game Authority + event sourcing

[unchanged]

## ✅ Milestone 3 — Realtime Gateway (`@chess-platform/realtime-gateway`)

[unchanged]

## ✅ Milestone 4 — API & identity (REST)

[unchanged]

## ✅ Milestone 5 — Engine bridge (`@chess-platform/engine`)

[unchanged]

## 🚧 Milestone 6 — Web frontend (playable)

- Board UI (animation, premoves, drag + click), clock, game view, lobby,
  profile; PWA; a11y; light/dark.
- **Acceptance:** e2e (Playwright) plays a full game vs. bot and vs. human;
  Lighthouse a11y ≥ 95.
- 🚧 **Increment 1 landed:** `@chess-platform/web` scaffold + dependency-free view core (board geometry, premove queue, chess clock, FEN placement) with 21 passing `node --test` tests, strict-TS + lint clean. Next: interactive board, REST/WS client seam, Playwright e2e, Lighthouse gate.
- 🚧 **Increment 2 landed:** interactive board — drag & drop, click-to-move, selection/legal-destination/last-move/premove highlighting, promotion UI, and premove application; legality behind a `LegalMoveOracle` port (server authoritative) + view-only optimistic mover. 54 `node --test` tests green, strict-TS + lint clean. Next: REST/WS client seam.
- 🚧 **Increment 3A landed:** REST networking foundation — a `fetch`-based `HttpTransport` port, an `HttpClient` (per-request timeout, safe-method retry with exponential backoff + jitter, JSON, and a typed error taxonomy), hand-authored request/response models mirroring `packages/api/openapi.json`, the typed `GambitClient` (health, auth/session, users/profile, ratings, leaderboard, game summaries), and a session/auth abstraction (pluggable token store + proactive, single-flight token refresh with 401 replay). Framework-independent, UI kept separate from networking; no WebSocket / lobby / gameplay sync yet. 94 `node --test` tests green, strict-TS + lint clean, production build passes. Next (3B): WS game stream + core/server-backed move oracle, wired into the app/game view.
- 🚧 **Increment 3B landed:** WebSocket foundation + gameplay synchronization — a `WebSocketConnection` port + browser adapter, a typed `WsClient` (connection state machine, automatic reconnect with exponential backoff + jitter, ping/pong heartbeat with silent-link detection), hand-authored wire-protocol models mirroring `packages/realtime-gateway/src/protocol.ts` with a JSON codec, and a `GameSync` synchronization layer (join/resume lifecycle, authoritative snapshot + live move ledger, optimistic move tracking with `clientSeq`-based confirm/rollback, ply-gap resync, presence/ended/draw-offer state). Framework-independent, networking kept separate from UI; no lobby/matchmaking/profile UI yet. 115 `node --test` tests green, strict-TS + lint clean, production build passes. Next: wire the REST + WS clients into the app composition root and game view.
- 🚧 **Increment 3C landed:** App composition root (`packages/web/src/app.ts`) wiring REST (`GambitClient`), WebSocket (`WsClient`), `GameSync`, and `CoreMoveOracle` (backed by `@chess-platform/core`) into a single injectable root. `main.ts` is now a thin bootstrap. `@chess-platform/core`/`api`/`realtime-gateway` added as workspace dependencies. The server remains authoritative; the client sends intents and reconciles from authoritative snapshots/broadcasts. 115 `node --test` tests green, strict-TS + lint clean, production build passes. Next: lobby/matchmaking UI, profile page, Playwright e2e, Lighthouse a11y gate.

## ⬜ Milestone 7 — AI orchestration layer

[unchanged]

## ⬜ Milestone 8 — AI features

[unchanged]

## ⬜ Milestone 9 — Tournament system

[unchanged]

## ⬜ Milestone 10 — Social features

[unchanged]

## ⬜ Milestone 11 — Moderation & safety

[unchanged]

## ⬜ Milestone 12 — Platform hardening

[unchanged]

## ⬜ Milestone 13 — Internationalisation (i18n)

[unchanged]

## ⬜ Milestone 14 — Deployable service

[unchanged]

---

## How we work

[unchanged]
