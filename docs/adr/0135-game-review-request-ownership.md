# ADR-0135 — Game Review request ownership and privacy invalidation

| Field      | Value                                      |
|------------|--------------------------------------------|
| **Status** | Accepted                                   |
| **Date**   | 2026-08-27                                 |
| **Scope**  | Completed-game review API capability and web request lifecycle |

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
Abort reduces work; the service checks it before archive I/O and again before quota admission, while
the final ownership predicate remains authoritative for stale-result rejection.

Game Review also owns a fixed MultiPV-2 evidence policy. Production composition stays absent unless
the configured analysis ceilings and at least one routed engine can honor that policy exactly. The
capabilities response publishes those exact `gameReviewVariants`; the web gates the current game on
that feature-specific list. The service repeats the predicate before quota admission, so a direct or
stale client cannot spend review quota on a request this deployment cannot execute.

Durable archive validation still folds the complete event stream through the authoritative `Game`
aggregate. Pre-move review positions are then captured by one forward `Position` replay rather than
reconstructing every event prefix. Once quota admits a review, a server-owned 120-second deadline is
combined with client cancellation and propagated through every engine search. The route's existing
bounded-cardinality duration histogram observes both successful and failed review requests.

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

Capability regressions also cover insufficient deployment ceilings, unavailable MultiPV-2 routing,
variant-subset publication, and withdrawal of the mounted control for an unsupported game.

Archive and service regressions cover exact pre-move positions from forward replay and expiry of the
server-owned total deadline, including propagation of its abort signal to engine work.

The archive result is also treated as untrusted at the service boundary: a record whose `gameId`
does not exactly match the requested ID is hidden as not found before participant checks, quota, or
engine work. MultiPV evidence is selected by the engine's `multipv` identity rather than array order,
so reordered output cannot change a positive classification and an absent runner-up degrades to the
ordinary best-move label.

Game Review remains strictly post-game. The durable archive returns no record for a live aggregate,
and the mounted control is both hidden and disabled until an authoritative ended state arrives. This
does not disable the separate position-analysis surface: ADR-0113 and the engine scheduling contract
explicitly define user-triggered live analysis/hints. The historical rule is retained for Game Review,
not generalized into an unrelated product change.

The server-owned review vocabulary remains the closed eleven-label contract recorded in
`GAME_REVIEW_CLASSIFICATIONS`. A `forced` label is not added because neither the current policy nor
the recovered classification implementation defines deterministic engine evidence for it; inventing
that evidence in a recovery change would make the result less truthful, not more complete.
