# 117. Move Explanation in the Game Sidebar

Date: 2026-08-18

Design mode: **Operate** — a player is reading this with a game in front of them, so scanability and
staying out of the board's way outrank expression. See `packages/web/CLAUDE.md`.

## Status

Accepted

## Context

ADR-0115 shipped `POST /v1/ai/move-explanation` with no consumer, exactly as ADR-0113 shipped
`POST /v1/analysis` with none. This makes it reachable, and nothing more.

## Decisions

### 1. Extend the Engine panel; add no surface — ADOPTED

The explain block lives inside the existing analysis panel on `#game-main`, separated by a hairline.
A heading and a border would announce a new surface for one button and a paragraph, and the two
things are the same subject: what the engine says about this game.

It reuses the shared `.panel-row` treatment, so an explanation's evidence reads as the same kind of
row as an analysis line, and reuses the memoised `loadCapabilities` envelope — no second
capability-fetch mechanism, per the PR #133 fix.

### 2. Evidence above prose, in separate elements — ADOPTED

`citation` renders into `#explain-evidence`, the model's paragraph into `#explain-prose`, and the two
are never merged. The engine fact is the verifiable part and the sentence is an interpretation of it,
so the reader meets what is checkable before what is asserted.

**Nothing parses the prose to recover a fact.** Every number shown comes from `citation`; a test
feeds contradictory numbers in the prose and asserts the evidence still matches the engine.

The paragraph is written by a language model, so it carries an attribution line naming provider and
model — the only provider-facing values the API returns. There is no usage or cost to show, and none
is invented.

### 3. Terminal outcomes render as results — ADOPTED

The client half of ADR-0116. `moveOutcome.kind === 'terminal'` renders "Checkmate — White wins" from
the structured `reason` and `result`; it must not reintroduce `+0.00` by rendering the terminal arm
as a score. An unrecognised future `reason` falls back to showing the authoritative `result` rather
than nothing.

### 4. Only the last replayed move can be explained — ADOPTED, with a stated limit

The endpoint needs the position the move was played **from** plus the full UCI. `GameController`
already replays moves from the snapshot, so it now retains the FEN preceding the last replayed move
and that move's whole UCI.

The **promotion suffix is kept deliberately**. `onLastMove` drops it because a highlight needs only
two squares, and reusing that value is the obvious way to build this — but `e7e8q` and `e7e8n` are
different moves with different evaluations, and a bare `e7e8` is not a legal UCI move at all, so the
server would reject it. A regression test covers promotion specifically.

The limit: this works only for moves the client itself replayed. The server's snapshot is
authoritative *at its own ply* and `MoveView` carries no per-move FEN, so joining a game mid-play has
nothing to explain until the next move arrives, and a finished game reviewed from a snapshot has
nothing to explain at all.

That is accepted rather than worked around. Recovering earlier positions needs either a parallel
move-history model on the client or replaying from a starting position the server does not send and
which Chess960 has no fixed value for. Explaining arbitrary past moves is its own increment; this is
the honest subset that needs no new state. The control is disabled with "No move to explain yet."
rather than failing on click.

### 5. The same lifecycle as the analysis panel — ADOPTED

Generation guard, `disposed` flag, `AbortController`, and `settle()` **before** the terminal
callbacks — the last of which exists because clearing `pending` only in `finally` left the control
disabled with no further event to re-enable it (ADR-0114).

A repeat request is ignored rather than superseding, and the reason is stronger here than for
analysis: the API still cannot observe a client disconnect (ADR-0113), so aborting does not stop the
work — an accepted request has already bought engine searches and a paid completion. A move change
does supersede, and the stale explanation is withdrawn rather than left beside a changed board.

The block is reset at mount, because this DOM lives in `index.html` and outlives any single mount: no
request is involved in that staleness, so nothing in the request lifecycle catches it. The same
omission was a bug in PR #133.

### 6. Explanation is user-triggered — ADOPTED

Nothing explains a move the player did not ask about. Each request costs engine time and money, and
an automatic explanation per half-move would spend both on a blitz game nobody is reading.

## What is NOT covered

- **No arbitrary past-move navigation** (Decision 4), and no move list.
- **No streaming.** The paragraph arrives whole.
- **No cost or usage display.**
- **No other AI feature** — Puzzle Generator, Mistake Predictor, Coach, Opening Explorer, Endgame
  Trainer and voice all remain library-only.
- **No shared HTTP plumbing change.** `RequestContext` still cannot observe client disconnect.
