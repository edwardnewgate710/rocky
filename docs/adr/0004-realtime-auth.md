# ADR-0004: Realtime Protocol Authentication

**Status:** Accepted
**Date:** 2026-07-07
**Supersedes:** None
**Related:** ADR-0003 (legal-moves contract), `docs/ARCHITECTURE.md` §4

## Context

Review #01 (C4) identified that the realtime wire protocol had no authentication:
`JoinMessage` carried a client-asserted `userId` with no verification. Anyone
could join as either player, move their pieces, or resign for them. The
architecture document promises authN at the edge and zero-trust, but the
protocol did not implement or reserve it.

This is a durable-contract gap: shipping M14 (production WebSocket adapter) on
an unauthenticated protocol would force a breaking protocol change later —
exactly the scenario this project's ADR-gate process exists to prevent.

## Decision

**Token-based authentication in the join message, enforced behind a gateway-local port.**

1. **`JoinMessage` carries `token` (optional), not `userId`.** The client
   never asserts its own identity. The gateway derives `userId` exclusively
   from the token via a `TokenVerifier` port.

2. **`TokenVerifier` port** (`protocol.ts`):
   ```ts
   interface TokenVerifier {
     verify(token: string): { readonly userId: string } | null;
   }
   ```
   In production, the API's `AccessTokenService` satisfies this port at
   composition time. Tests use a `FakeTokenVerifier` that maps tokens to user
   ids.

3. **Spectator policy:** when `token` is absent, the connection joins as an
   anonymous spectator with a generated `anon-<connId>` identity. No move
   authority, no presence seat. When `token` is present but invalid, the join
   is rejected with `unauthorized`.

4. **`unauthorized` reject code** added to `RejectCode`.

5. **Identity is from the token, not from any client claim.** A token for
   user `bob` seats the connection as `bob` (black), regardless of what the
   client might have claimed. There is no `userId` field to claim.

## Consequences

- **Breaking protocol change:** `JoinMessage.userId` is removed; clients must
  send `token` instead. The web mirror (`ws-protocol.ts`) is updated in lockstep.
- **`GameSyncOptions` changes:** `userId` → `token?`. Bootstrap passes the
  token from the session/token store.
- **Anonymous spectating is allowed** but produces no move authority. Two
  anonymous tabs get different `anon-<connId>` ids, preventing collision.
- **The `TokenVerifier` port** keeps the gateway testable with fakes and
  decoupled from the API's JWS implementation details.
- **Production composition:** when the WebSocket adapter lands (M14), the
  `AccessTokenService` is injected as the `TokenVerifier`. No protocol change
  is needed at that point — the contract is already in place.

## Test Coverage

- Join with valid token → seated as the token's user.
- Join with invalid token → `unauthorized` reject, no seat, no presence.
- Join without token → anonymous spectator.
- Spectator (no token) cannot move → `not_a_player`.
- Identity comes from token, not from any client claim.
