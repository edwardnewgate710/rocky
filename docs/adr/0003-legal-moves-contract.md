# ADR 0003 — Legal-moves contract for clients (Milestone 6)

- **Status:** Accepted (rollout in progress — Increment 3C-2A ships the contract)
- **Date:** 2026-07-05
- **Context milestone:** M6 (Web frontend), Increment 3C-2
- **Supersedes:** none
- **Numbering note:** ADR-0002 tentatively earmarked "ADR-0003" for a *future durable
  analysis cache*. That ADR was never written; this ADR takes the 0003 number, and a
  durable-cache ADR (if written) should take the next free number.
- **Related:** [`docs/FRONTEND.md`](../FRONTEND.md), [`docs/adr/0002-engine-bridge.md`](0002-engine-bridge.md),
  `packages/web/src/ports/move-oracle.ts`, `packages/realtime-gateway/src/protocol.ts`

## Context

The web client's `LegalMoveOracle` port must answer `destinations(from) → Square[]`
**synchronously** (used by `interaction.ts` for legal-destination highlighting and
premove validation). Producing that data requires enumerating legal moves for a
position.

Project invariants forbid the two "easy" sources:
- **No chess rules in the frontend** (`FRONTEND.md`: *"Legality… stays server-side"*);
  `web` must **not** import `@chess-platform/core`.
- Legality must remain **server-authoritative**, computed by the single perft-verified
  engine (`@chess-platform/core`).

A decisive architectural fact: the REST `api` package cannot currently see live board
positions (`GET /v1/games/{id}` returns only `GameSummary`); the authoritative live
position lives in the realtime-gateway `GameAuthority`, and wiring the REST API to the
durable event store is deferred to **M14**. The gateway *already* computes legality via
core on every move.

## Decision drivers

1. Server authoritative; a single legality computation path (no divergence).
2. No `@chess-platform/core` in `web`; Ports & Adapters preserved.
3. Consistency with the authoritative position (no desync / stale highlights).
4. Latency of interactive highlighting.
5. Implementable within the current architecture (M14 wiring not yet done).
6. Reach: does it also serve future non-game positions (analysis, puzzles)?

## Options considered

1. **`GET /v1/games/{id}/legal-moves` (game-based REST).** Resource-oriented and
   server-owned, but **blocked**: the REST API has no access to the authoritative live
   position until the M14 event-store wiring — implementing it now pulls M14 forward.
   Also costs a round-trip per position.
2. **Embed `legalMoves` in the authoritative WS `StateView`.** The gateway already owns
   the live position and computes legality per move, so the legal-move set travels *with*
   the authoritative state: always consistent, zero extra round-trips, no second
   computation path, no race. Strongest form of "server authoritative." Only covers
   in-game positions; evolves the WS protocol.
3. **Stateless `GET /v1/games/legal-moves?fen=…` (FEN endpoint).** Pure function of a
   position; implementable today; serves any position — but adds a second legality entry
   point and evaluates a client-asserted position, and costs a round-trip per position.

## Decision

**Adopt Option 2** as the canonical long-term contract for in-game legality: the
authoritative `StateView` carries a typed `legalMoves` map (origin square → legal
destination squares) for the side to move, computed server-side by the core engine in the
gateway `GameAuthority`, empty (`{}`) once the game is over. Promotions collapse to their
destination square (the promotion piece is chosen by the client on submission and
re-validated by the server). Option 1 is rejected until M14; Option 3 may later be added
as a complementary stateless utility for non-game positions (analysis/puzzles), behind the
same `LegalMoveOracle` port.

## Rollout (three small, independently verified increments)

- **3C-2A — contract (this increment):** add typed `legalMoves` to the gateway `StateView`,
  compute it in `GameAuthority`, and mirror the field in `web`'s `ws-protocol.ts`; update
  tests + docs. No consumer wiring yet.
- **3C-2B — adapter:** surface `legalMoves` through `GameSync` state and implement a
  `LegalMoveOracle` adapter fed by the authoritative snapshot (behind the existing port).
- **3C-2C — composition:** wire that oracle into the composition root / board.

## Consequences

- WS protocol gains one additive, required field on `StateView` (a durable shared
  contract change — hence this ADR). The frontend consumes the typed mirror only; `web`
  never imports `@chess-platform/core`; the `LegalMoveOracle` port is unchanged.
- Legality is computed exactly once, where the authoritative position lives — no REST/WS
  divergence and no client-side rules.
- Non-game legality (analysis board, puzzles, pre-game) is out of scope here and would be
  served later by the Option 3 FEN endpoint if/when needed.
