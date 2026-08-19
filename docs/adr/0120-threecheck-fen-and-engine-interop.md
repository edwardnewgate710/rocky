# 120. Lossless Three-Check FEN, and Fairy-Stockfish Interoperability

Date: 2026-08-18

## Status

Accepted

Completes the work [ADR-0099](0099-chess960-withheld.md) §4 deferred and
[ADR-0119](0119-contract-and-rate-limit-correctness.md)'s follow-up left open. M15 Increment 8 made
`Position.snapshot()` carry the Three-Check counters; this makes the FEN carry them too, and closes
the engine defect that the missing field had been causing all along.

## Context

### The counters had nowhere to go

`PositionState.checkCount` records checks **delivered**, counting up, because that is what
`movegen` increments and what the win condition reads. FEN had no field for it, so `toFen` dropped
it. Increment 8 removed the internal consequence of that — snapshots no longer round-trip through
FEN — but anything that genuinely serialises a position still lost the counters.

### Fairy-Stockfish does not read a missing field as "none delivered"

This is the part that made it a live defect rather than a gap. Measured against **Fairy-Stockfish
14** (`fairy_sf_14`), the release the plugin already declares as `minVersion`:

| FEN sent for `3check` | what the engine understood |
| --- | --- |
| `4k3/8/8/8/8/8/8/3R3K w - - 0 1` (six fields) | `1+1` — **one check remaining each** |
| `4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1` | `3+3`, correct |

A bare six-field FEN tells Fairy that either player wins with a single check. The consequence is
visible immediately: the Italian Game under `3check` came back **`score mate 1`** on the six-field
FEN and a real six-ply line (`cp` in the thousands) on the canonical one. Every Three-Check
evaluation the platform could produce was reporting a forced mate that does not exist.

It was not reachable in production, and the reason matters for how urgent this was: no deployment
sets `FAIRY_STOCKFISH_PATH`, `Dockerfile.api` and `Dockerfile.gateway` install only vanilla
Stockfish, and `configuredPlugins()` registers only engines with a configured binary — so
`threecheck` currently finds no pool and returns `422 unsupported variant`. The defect was waiting
for the day someone deployed Fairy.

### What the engine actually expects

Empirically, driving the real binary over UCI and reading back its own `d` output:

- the canonical field is **`N+M`**, not `+N+M`;
- it sits in **field five**, between the en-passant square and the halfmove clock;
- the values are checks **remaining**, counting down from three — `3+3` at the start;
- the first value is White's, the second Black's. Playing checks moves them one at a time:
  `3+3` → `2+3` → `1+3` for White, and one check each gives `2+2`.

Fairy accepts a second spelling: `+N+M` **delivered**, appended after the fullmove counter, which is
the lichess convention. It converts on input and always emits the canonical form. The two are
exactly equivalent — `... 0 1 +2+1` and `... 1+2 0 1` produce a byte-identical `Fen:` line and an
identical evaluation.

## Decision

### Emit the canonical form; accept all three

`toFen` writes `<board> <turn> <castling> <ep> N+M <halfmove> <fullmove>` for `threecheck` and
leaves every other variant's six fields exactly as they were.

`parseFen` accepts, for `threecheck` only:

| input | meaning |
| --- | --- |
| canonical `N+M` in field five | remaining — the form this codec emits and Fairy emits |
| trailing `+N+M` after the clocks | delivered — the compatibility spelling Fairy also takes |
| six fields, no counter | nothing delivered yet — every game stored before this ADR |

Input spelling does not survive: whichever form comes in, the canonical form goes out.

The trailing form was considered as the permanent output because it maps 1:1 to the internal
counters and leaves field indices untouched. It was rejected. Interoperability should prefer the
representation the engine itself emits, and defining a second permanent format to dodge a rollout
question would have left the platform speaking a dialect forever to save one release of care.

### One place knows the inversion

`packages/chess-core/src/check-counters.ts` holds `THREE_CHECK_LIMIT` and the conversions both
ways. No `3 - x` appears in the parser, the serializer or the engine adapter. The limit is named
rather than inlined because Fairy also ships a `5check` variant — three is a property of this rule
set, not a constant of the universe.

### Malformed counters are refused, not reinterpreted

`4+3`, `2+`, `+2` and a trailing `+9+0` all throw `FenError`. Falling through to the legacy reading
would put the clocks back one position and silently rewrite the fifty-move state — precisely the
corruption this field's position creates the opportunity for.

**Recognition is not enough on its own.** The first version matched the trailing form only on an
exact `+N+M` and let everything else fall through, so `+2+`, `+2`, the canonical spelling in the
trailing position, and a stray field beside an otherwise valid counter were all silently discarded —
a position two checks in came back out as `3+3`, and the engine was handed a different game. A
Three-Check FEN may now carry six fields or seven; anything longer, or a seventh field matching
neither spelling, is refused. Raised in the Qodo and CodeRabbit reviews of PR #140.

**A canonical layout must also be complete.** A counter in field five declares the seven-field
layout, so that layout has to arrive whole: the counter plus both clocks. `... 2+3 17` is refused
rather than accepted with an invented fullmove. This is not the parser's ordinary tolerance for a
truncated FEN being withdrawn — that tolerance is about trailing fields being absent from a
six-field layout, and it is untouched, so a five-field `threecheck` FEN still defaults its clocks
exactly as a five-field standard one does. What changed is that a FEN which has *announced* a
longer layout can no longer stop halfway through it. Raised in the Qodo review of PR #140.

A clock slot must also hold a clock. `Number('+1+0')` is `NaN` and the clock reader falls back to a
default, so a FEN carrying *both* a canonical counter and a trailing one parsed happily, threw the
second counter away and quietly reset the fullmove to 1. Two counter fields is a contradiction
rather than a spelling.

### Move clocks are bounded, for every variant

A clock past `Number.MAX_SAFE_INTEGER` changes as it is read — `Number('9007199254740993')` is
`9007199254740992` — so the FEN coming back out described a different position from the one that
went in. That predates the counters and was never Three-Check-specific: the clock reader is shared,
and standard chess did exactly the same thing. It is fixed here rather than deferred because a codec
whose stated purpose is a lossless round trip cannot quietly rewrite a field, and the bound is the
narrowest thing that stops it: a token that is not a number at all keeps the long-standing tolerance
and falls back to the default. Raised in the Qodo review of PR #140.

Two related tolerances are deliberately **not** changed, because they are pre-existing, apply to
every variant equally, and lose nothing: a truncated FEN still defaults its missing trailing clocks
(a five-field standard FEN has always done so), and a non-numeric clock token still falls back
rather than throwing.

### A Three-Check FEN read without its variant is refused

The counter sits where the halfmove clock belongs, so reading one under another rule set is worse
than useless: `... 2+3 17 42` parsed as standard gave halfmove 0 and fullmove 17 — both clocks
wrong, the counters gone, and nothing said so.

That became reachable *because of this change*. The codec now emits seven-field Three-Check FENs, so
one can be copied out of an analysis response and passed somewhere that parses without a variant.
Before this ADR every FEN we emitted had six fields and the situation could not arise from our own
output.

`parseFen` therefore refuses a counter-shaped field when the variant is not `threecheck`, turning a
silent corruption into an error at that boundary. Study entry points now supply their persisted
variant as described below. Raised in the CodeRabbit review of PR #140.

### A study owns the rule set for every stored FEN

`studies.variant` records the platform variant once per study. Migration `0022_study_variant.sql`
adds the constrained, non-null column with a `standard` default, so existing rows and inserts from an
older process retain their previous meaning. The REST create request accepts the same closed variant
vocabulary as analysis, and REST, GraphQL and OpenAPI expose the stored value.

The study `PositionReader` contract accepts that variant, defaulting to `standard` for source
compatibility with existing callers. Both in-memory and PostgreSQL repositories pass it through
chapter append, PGN dry-run validation, recursive PGN import and FEN generation. Chapter FEN
validation also uses the owning study's variant. Exported non-standard studies carry a PGN
`Variant` tag; import deliberately uses the destination study's rule set rather than trusting a file
tag to change persistent study metadata.

The same rule applies to the composition layer: `CoachRequest` accepts a variant and `Coach` passes
it to mistake prediction, move explanation, puzzle generation and AI grounding. The response keeps
the variant so Voice Coach can parse and verbalise UCI moves under the same rules.

### The engine is given a canonical FEN, whatever the caller sent

`AnalysisService` re-serialises Three-Check FENs through the codec before the request reaches a
provider. `toFen` alone was not enough: the analysis API takes a FEN **from the caller** and passed
it through verbatim, so a client sending the legacy six-field form would still have reached Fairy as
`1+1`. Only Three-Check is rewritten, so no other variant's cache identity moves.

## Rolling deployment

The canonical field shifts the clocks one position right, and a parser that predates this ADR reads
`N+M` as the halfmove clock. That is a real hazard in general, so it was mapped rather than assumed
away.

**The game-event durable surface is safe.** No production path supplies a custom `initialFen` — every
`Game.create`/`createGame` caller omits it, so it is always `Position.initial(variant).fen()`. For
the Three-Check start position specifically, an old parser reads the canonical FEN
`rnbqkbnr/... w KQkq - 3+3 0 1` to a **byte-identical `PositionState`**: `3+3` fails `Number()` and
falls back to `halfmoves = 0`, the following `0` is rejected as a fullmove and falls back to `1` —
which is what the six-field form yields anyway. Replay and rollback are unaffected.

The remaining non-study surfaces do not parse the moved fields:

- gateway pub/sub forwards FENs to other nodes without parsing them;
- the web client reads `[1]` for the side to move;
- `repetitionKey` uses fields 0-3 and appends its own counter component, so keys are unchanged;
- `packages/web/src/app/studies-helpers.ts` reads only the fullmove field for display; its field-index
  handling remains on the explicit audit list.

A guard test now fails the build if any other file starts reading FEN field 4 or 5 by index, with
those two files on an audit list that must itself stay accurate.

The study migration is additive and safe to apply before code: old readers use explicit column lists
and old inserts receive `standard`. During a mixed-version rollout, however, do not create
non-standard studies until every API instance runs the variant-aware reader; an old instance cannot
correctly append to a new Three-Check study. The safe order is migration, then all API instances,
then enabling non-standard study creation.

## Consequences

- **Cache identity moves for Three-Check, deliberately.** The analysis cache is keyed on the FEN, so
  entries stored under the old counterless string become unreachable. They held evaluations made
  with the wrong counters, so losing them is the point rather than a cost. Two boards differing only
  in checks delivered can no longer alias.
- **`fenHash` changes when the counters change.** Previously a repeated board hashed identically
  even when a player was two checks from winning, so a client's desync check could not see a
  decisive difference.
- **No FEN rewrite.** `starting_fen`, `fen_after` and `fen` remain `TEXT`; stored six-field FENs still
  parse and still mean "none delivered". Migration `0022` only adds the study variant, defaulting
  existing rows to `standard`. The OpenAPI `maxLength: 200` and the engine's `MAX_FEN_LENGTH` have
  around 110 characters of headroom against a real FEN.
- **No historical result is rewritten.**
- **Production Fairy deployment stays out of scope.** CI now provides the binary so the contract is
  tested; putting it in the deployable images is a capacity and operations decision of its own. The
  CI download is pinned by release **and by SHA-256**, because a release asset is mutable and this is
  a native binary CI executes — the UCI name check cannot stand in for that, since a replaced asset
  would report whatever name it liked. `curl --fail` is set with it, so an HTTP error body cannot be
  saved as if it were the binary. Raised in the Qodo and CodeRabbit reviews of PR #140.

  The pinned artefact, recorded here so the expected value lives with the decision rather than only
  in the workflow that checks it:

  | release | asset | SHA-256 |
  | --- | --- | --- |
  | `fairy_sf_14` | `fairy-stockfish_x86-64` | `ab6b85823152e78654092dc2fbb154956a559c6ef0455d728268544390ee150f` |

- **Persisted studies are variant-aware.** Existing studies remain standard by migration default.
  New studies can select any supported platform variant, and every persisted or transported FEN is
  parsed, validated and advanced under that stored rule set. This closes the data-integrity gap
  raised in the CodeRabbit review of PR #140 instead of merely refusing canonical Three-Check FENs.

## Guards

- `packages/chess-core/test/threecheck-fen.test.ts` — the conversion is exact both ways; the
  canonical field is field five and the clocks stay put in all three spellings; every delivered pair
  survives a round trip; input spelling is canonicalised on output; malformed and out-of-range
  counters throw; the field belongs to Three-Check alone and the other seven variants keep six
  fields.
- `packages/chess-core/test/fen-field-index-guard.test.ts` — no file outside the codec reads FEN
  field 4 or 5 by index without being on the audit list, and the audit list may not outlive its
  entries.
- `packages/api/test/threecheck-engine-fen.test.ts` — what leaves the service: a legacy FEN gains
  its counters, supplied counters are preserved, no Three-Check FEN reaches a provider with six
  fields, other variants are untouched, cache keys separate, and the authoritative validator still
  refuses malformed counters and newline injection with a counter field present.
- `packages/realtime-gateway/test/threecheck-fen-hash.test.ts` — a delivered check changes the
  position hash even though the board is unchanged.
- `packages/api/test/analysis-fairy-threecheck-smoke.test.ts` — the real binary, env-gated on
  `FAIRY_STOCKFISH_PATH` in the same shape as the Stockfish smoke test: the canonical counters
  survive into the engine, fall as checks are delivered, and the second belongs to Black; the
  six-field default of `1+1` is pinned as the defect it is; and the production path no longer scores
  a fresh Three-Check position as a forced mate. Assertions are semantic — no centipawn value is
  pinned, since those vary by build.
- Verified by mutation, all fourteen caught by tests rather than by the compiler: dropping the counter
  field, swapping White and Black, emitting delivered as remaining, an off-by-one in the conversion,
  writing the field after the clocks, reading the field as the halfmove clock, dropping the engine
  boundary canonicalisation, letting the trailing form overwrite the clocks, clamping out-of-range
  counters, letting a malformed field fall through to the legacy reading, dropping the guard on a
  surplus or misplaced counter, matching the trailing form anywhere rather than in the seventh field,
  accepting a counter in a clock slot, and rounding an over-large clock instead of refusing it.
