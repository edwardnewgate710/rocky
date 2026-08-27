# ADR-0135 — Game Review request ownership and privacy invalidation

| Field      | Value                                      |
|------------|--------------------------------------------|
| **Status** | Accepted                                   |
| **Date**   | 2026-08-27                                 |
| **Scope**  | Completed-game review web request lifecycle |

---

## Context

Completed-game review is private, owner-scoped data. The preserved web implementation put its
request promise and rendered result directly in the route mount. Sign-out refreshed the control but
did not erase a completed result, while a request already in flight could still publish after
sign-out. The same persistent page DOM is reused across SPA game mounts, so a slow response from one
game could also write into the next game's review panel.

Cancellation alone cannot establish correctness. A response may have completed and queued its
continuation before an abort is observed.

## Decision

The game route gives completed-game review a DOM-free lifecycle controller. Every request captures
four ownership facts: the immutable game ID of the mount, the authenticated user ID, a monotonically
increasing generation, and the concrete `AbortController` for that request.

A result may reach the view only when all four facts still match immediately before publication.
The returned payload's `gameId` must also equal the captured game ID. Sign-out, account replacement,
and route disposal synchronously increment the generation, abort the transport request, release its
pending state, and invoke the view's invalidation callback. That callback removes the summary,
move rows, and error state rather than merely hiding or disabling the control.

The typed Game Review API accepts an `AbortSignal` and forwards it through the existing HTTP port.
Abort reduces work; the final ownership predicate remains authoritative for stale-result rejection.

## Consequences

Private review state cannot survive an authentication boundary in the mounted page, and no response
owned by an older game, session, generation, or request can mutate the current view. Remount and
sign-out remain safe even when the underlying operation ignores cancellation or resolves after the
abort.

The controller deliberately keys privacy to stable user identity, not token text. Refreshing a token
for the same account does not erase a valid review, while any change to another user or no user does.

Deterministic controller and mount regressions cover rapid game switching, sign-out during an
in-flight request, sign-out after a completed result, an older request completing after its
replacement, response game-ID mismatch, rendered-state erasure, and transport cancellation.
