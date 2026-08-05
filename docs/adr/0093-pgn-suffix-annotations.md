# ADR-0093 — PGN suffix annotations were silently discarded on import

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-05                                             |
| **Scope**  | `packages/studies`                                     |

---

## Context

A move annotation written in the **suffix** form — `Nf3!`, `Bb5?`, `Qh5!!`, `Rxe8??`, `d4!?`, `Nc3?!` — was lost on PGN import. It survived neither in the stored SAN nor in `nags`, and nothing errored.

The chain:

1. `packages/studies/src/pgn-parse.ts` pushed `{ san: token, nags: [], … }` with the token still carrying its `!`.
2. `isSanShaped` strips `[+#!?]+$` **only to validate the shape** — that stripped form was never fed back into the node.
3. `appendNode` (`packages/studies/src/repository.ts`) then resolved `Nf3!` to the legal SAN `Nf3` via `resolveSan`, discarding the suffix.

The PGN specification treats these suffixes as exactly equivalent to NAGs `$1`–`$6`. Explicit `$n` tokens already parsed correctly; only the suffix form was dropped.

Found while building the studies viewer (ADR-0091), which renders NAGs correctly but never received any from PGN-imported studies. Recorded as a tracked follow-up in `docs/ROADMAP.md` at the time and resolved here.

## Decisions

### 1. Suffixes are converted to NAGs at the parse boundary

```
!  → $1     ?  → $2     !! → $3     ?? → $4     !? → $5     ?! → $6
```

The conversion happens in `parsePgn`, not in `resolveSan` or `appendNode`. By the time those run the SAN is already clean, so the domain below the parser is unchanged.

### 2. The trailing annotation run is captured whole, then looked up

The match is `/^(.*?)([!?]+)$/` — a non-greedy prefix and the **entire** trailing run of `!`/`?`, which is then looked up in the mapping table.

Capturing one character at a time would be wrong: `!!` would become two `$1`s and `?!` would become `$2` followed by a stray token. Matching the run and looking it up handles the one- and two-character cases uniformly and makes anything else detectable rather than silently mangled.

### 3. Check and mate markers stay in the SAN

`Qh5+!` yields `{ san: 'Qh5+', nags: [1] }` and `Rxe8#??` yields `{ san: 'Rxe8#', nags: [4] }`. The `+`/`#` is part of the move; only the `!`/`?` run is an annotation.

### 4. An unrecognised annotation run is a parse error, not a silent drop

`e4!!!` throws `PgnParseError('Unrecognised move annotation …')` with the token's position, rather than importing the move without its annotation.

This is a deliberate trade. The alternative — take the first two characters and ignore the rest — silently changes what the author wrote, which is the exact failure this ADR exists to fix. Import is atomic, so a malformed annotation rejects the whole file with a located error instead of half-importing it. The cost is that a PGN from a source using non-standard runs now fails loudly; that is the intended direction.

### 5. Round-trip is semantic, not literal

`pgn-serialize.ts` writes NAGs numerically, so importing `1. e4!` and exporting yields `1. e4 $1`. The two are equivalent under the PGN specification but not byte-identical, and the round-trip test asserts on the parsed NAGs rather than on string equality.

## Consequences

- Suffix annotations now reach the studies viewer, which has rendered NAGs since ADR-0091 but had no PGN-imported source for them.
- **Both adapters are fixed by one change.** `packages/persistence/src/pg/studies.ts:24` imports `parsePgn` from `@chess-platform/studies` rather than duplicating it, so the Postgres path inherits this automatically. This is *not* the situation ADR-0091 §10 found, where the two adapters had independently implemented import ordering and silently diverged — worth stating explicitly, because that divergence is the reason to check every time.
- A PGN containing an annotation run outside the six standard forms now fails to import where it previously imported with the annotation missing.

## Alternatives considered

- **Fix it in `resolveSan` or `appendNode`.** Rejected: those sit below the parser and receive a SAN that should already be clean. Teaching them about annotations would spread PGN syntax into the domain.
- **Strip the suffix and drop it.** That is the current behaviour, and it is the bug.
- **Take the longest recognised prefix of the run** (`!!!` → `!!`). Rejected in §4: it silently rewrites the author's text.
