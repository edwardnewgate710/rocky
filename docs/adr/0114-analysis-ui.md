# 114. Engine Analysis UI in the Game Sidebar

Date: 2026-08-17

Design mode: **Operate** — the visitor is reading an evaluation while a game is in front of them, so
scanability and staying out of the board's way outrank expression. See `packages/web/CLAUDE.md`.

## Status

Accepted

## Context

ADR-0113 shipped `POST /v1/analysis` with no consumer. The capability existed, `GET /v1/capabilities`
reported it, and nothing in the browser asked. This increment makes it reachable, and nothing more —
no Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach or
voice feature is designed or implemented here.

## Decisions

### 1. Extend the game sidebar rather than add an analysis route — ADOPTED

The board, the live FEN and the variant already live on `#game-main`: `GameController` exposes
`get fen()` and an `onPosition` callback, so analysis needs no new state source and no second
subscription. `applyRouteSurface` already governs that surface, so there is no new route, surface id
or router change, and `mountGame` already returns disposables into the compile-time-exhaustive
`DISPOSABLE_TEARDOWN_MAP`, so `bootstrap.ts` gains only wiring.

A standalone `/analysis` route with its own board was rejected: it would duplicate board mounting,
routing, surface registration and a second board-interaction path to reach the same primitive.

### 2. No board preview of the principal variation — ADOPTED

The panel never touches the board. That is a stronger guarantee that analysis cannot mutate
authoritative game state or submit a move than any reversible-highlight mechanism would be, and it
keeps the increment's blast radius to one sidebar section. Principal variations render as UCI text;
converting to SAN would need a rules engine the web client deliberately does not have (ADR-0003 keeps
legality server-authoritative), so showing UCI is honest about what the client knows.

### 3. A repeat request is ignored; a position change supersedes — ADOPTED

The API cannot observe a client disconnect (ADR-0113), so aborting an in-flight analysis does **not**
free the engine worker still searching for it. Superseding on every click would double real engine
load on the server while looking responsive in the browser, so a pending request wins and the control
disables to make that visible rather than silent.

A position change is the opposite case: the in-flight result describes a position the player has left,
so it is aborted and discarded. It is deliberately **not** re-run — analysis is on demand, and
re-analysing on every move would put a request on the wire for each half-move of a blitz game without
anyone asking.

### 4. The evaluation is converted to White's perspective — ADOPTED

The API reports evaluation **from the side to move**; every chess interface a competitive player has
used reports it from White's. Rendering the API value unchanged would show the correct number with the
wrong sign on every Black-to-move position: the evaluation would appear to swing by twice its value on
each half-move, and a player reading it would draw the opposite conclusion about who stands better. So
the side to move is read from the FEN and the score negated for Black, mate scores included.

The sign is the only cue. Colouring an advantage would need a second and third accent in a system that
has exactly one, and would encode the meaning in hue alone.

### 5. Reached and requested are reported separately — ADOPTED

`applied` is what the server enforced; `lines[].depth` is what the search actually reached, and they
differ whenever the wall-clock ceiling cuts a search short. They render as two separately labelled
lines. Presenting the request as the result would be a claim the user has no way to check.

### 6. The capability gate fails closed, and the read is shared — ADOPTED

The panel is revealed only on an explicit `analysis: true`. A missing key, a non-boolean, or a failed
request all mean "not answered", and an unanswered question must not surface a control whose every
request would answer 503. This is the opposite default from `routesToRemove`, which removes a nav link
only on an explicit `false` — deliberately so: there the cost of guessing wrong is hiding a link that
works, here it is offering a button that cannot.

`loadCapabilities` is exported from `capabilities-nav.ts` and memoised for the page. A second
unmemoised caller would have refetched on every SPA navigation, which is the behaviour that memo
already existed to prevent — `bootstrap` re-runs on every in-app click. The gate itself is a pure
predicate (`analysisEnabled`) because that memo has deliberately no reset seam, so a test cannot vary
the answer twice in one process; the same shape `routesToRemove` already has.

### 7. The control is never offered on a variant with no engine — ADOPTED

The capability flag is deployment-wide, but ADR-0113 registers only engines whose binary is
configured, and the API image installs Stockfish alone. So on an Atomic or Crazyhouse game the flag is
`true` while every request answers `422 unsupported variant` — six of the eight offered variants.
Raised in the Qodo review of PR #133.

The first attempt handled this **reactively**: read `details.variant` from the error envelope,
distinguish it from a rejected position, and disable the control for the rest of the mount. That is
still in place as a backstop, but it was not a resolution — the player had to click to discover the
control could never work, and Qodo correctly kept the finding open across it. DESIGN.md's rule is
that a control which would fail is *not shown*, with a sentence naming the obstacle; shown and then
retracted is a different thing.

So `GET /v1/capabilities` now also reports **`analysisVariants`**, the variants this deployment can
actually serve, and the client gates the control on membership. Three properties made this
affordable:

- `EnginePool.supportsVariant` falls back to each plugin's declared variants when cold (ADR-0102), so
  `EngineManager.supportsVariant` answers **without warming a pool** — advertising the list costs no
  engine process and does not compromise ADR-0113's `minWorkers: 0`.
- The predicate is supplied to `AnalysisService` by the composition root rather than added to
  `AnalysisProvider`. That interface has a couple of dozen test doubles across `ai-features`,
  `anti-cheat` and `api`, none of which has an opinion about a deployment's binaries; putting it on
  the interface would have churned every one of them for no information gain.
- A provider that cannot answer defaults to permitting everything, which preserves existing
  behaviour, and the route still rejects an unroutable variant at request time regardless.

A client reading a server that predates the field sees no list. That fails **open** — the control
stays available and the 422 backstop applies — because the alternative silently removes a working
feature from every variant. This is the opposite default from the `analysis` flag itself, and
deliberately so: an absent flag means "feature unknown", an absent list means "detail unknown about a
feature already known to be on".

### 8. Limits cannot be widened from the browser — ADOPTED

The only input is a line-count `<select>` offering 1, 3 and 5 — every value at or below the server's
published MultiPV maximum — and the click handler accepts only those values, so a request cannot carry
a `multiPv` outside the contract even if the option list is edited in the page. There is no depth,
time or node input at all. The server clamps and rejects independently; this keeps the client honest
at its own boundary rather than relying on the far side to catch it.

## What is NOT covered

- **No AI features.** Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame
  Trainer, Coach and voice all remain library-only.
- **No board PV preview** (Decision 2).
- **No cancellation on client disconnect.** `RequestContext` still exposes neither an `AbortSignal`
  nor the raw request (ADR-0113), and this increment deliberately does not expand shared HTTP
  plumbing to change that. Client-side stale-result and abort semantics are implemented regardless.
- **No automatic analysis.** Nothing analyses a position the player did not ask about.
- **No capacity claims.** Nothing here was load-tested, and the server's defaults are unchanged.
