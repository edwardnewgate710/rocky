# 122. A Movetext Walker Must Be Told Its Variant

Date: 2026-08-20

## Status

Accepted

Extends the variant work recorded in [ADR-0120](0120-threecheck-fen-and-engine-interop.md), which
made Three-Check counters survive FEN round-trips, and the variant-list guard from M15 Increment 10.
Those closed drift between places that *state* the variant list. This one is about a place that
never asked for the variant at all.

## Context

`packages/studies/src/import.ts` exported `importGame(reader, game, chapterName)` — a pure function
turning one parsed PGN game into a chapter tree. It walked the movetext recursively and resolved
every SAN token through the package's `PositionReader` port:

```text
importGame → buildLine → resolve → resolveSan(reader, fen, san)
                       → play    → reader.play(fen, san)
```

Neither call passed a variant. `resolveSan`'s signature is

```ts
resolveSan(reader, fen, san, variant: StudyVariant = DEFAULT_STUDY_VARIANT)
```

so omitting the argument does not fail — it silently means standard chess. A Crazyhouse or
Three-Check game imported through `importGame` would therefore have been validated against standard
rules: legal moves rejected, illegal ones accepted, and no error anywhere to say why.

Three facts decided what to do about it.

**It had no caller.** A search of the whole repository — sources, tests, docs, JSON — found
`importGame` referenced only by its own definition and its own test file. Same for the
`ImportedNode` and `ImportedChapter` types it returned, and for the `START_FEN` alias beside it.

**It was the third implementation of the same walk.** Both real import paths — the in-memory
`InMemoryStudiesRepository.buildTreeFromMovetext` and the Postgres
`PgStudiesRepository.buildTreeFromMovetextInternal` — do the same recursive descent, and both are
variant-correct. The Postgres one takes `variant: StudyVariant` as a required parameter and threads
it through every recursive call; the in-memory one resolves through `appendNode`, which reads
`study.variant` from the study record on each move. Different mechanisms, same guarantee.

**Duplicated import walkers in this package have already diverged once.** [ADR-0091](0091-studies-viewer.md)
§10 records the two adapters independently implementing import ordering and disagreeing: variations
were appended before the move they belonged to, taking `orderIndex 0`, which inverted mainline and
variation on every export. Nothing errored; the game was simply a different game. A third copy that
nothing exercises is that failure waiting with the safety off.

## Decision

Delete `importGame`, along with `buildLine`, its `resolve`/`play` wrappers, the `ImportedNode` and
`ImportedChapter` types, and the `START_FEN` alias — everything that existed only to serve it.
`chapterNameFor` stays: both adapters import it, which is why it lives in this file at all.

The principle this settles, stated so the next walker inherits it rather than rediscovering it:

> A function that interprets variant-specific chess content must be told which variant. It may not
> reach a default. Where a default exists it belongs to a caller that has genuinely decided standard
> is correct, not to a walker that never asked.

Fixing `importGame` instead — threading a required `StudyVariant` through it — was the alternative.
It was rejected because it buys a maintained variant contract for a function nothing calls, and
leaves the third walker in place. Deleting is also the reversible direction: the git history holds
it, and the day a pure importer is genuinely wanted it can come back variant-aware from the start.
This repository has taken that direction before, in Increment 31's deletion of
`AttemptResult.message`.

### What this is not

`resolveSan`'s standard default is **kept**. `@chess-platform/learning` calls it with three
arguments from four places to check that a lesson step's `expectedSan` is legal, and lessons carry
no variant of their own — the model has no such field. For that caller the default is a decision,
not an accident. It is now pinned by a test that says so, so changing it has to be argued for.

## Consequences

- **No production behaviour changes.** Nothing called the deleted function. Both real import paths
  are untouched.
- **Coverage moved rather than vanished.** `import.test.ts` was the only place `resolveSan`'s SAN
  suffix handling was pinned — the `Qh5+!` two-pass bug the resolver's own comment records, and the
  acceptance of exports that omit `+`/`#`. Those assertions now live in
  `packages/studies/test/move-resolver.test.ts`, against the function that owns the behaviour and
  that production actually calls, rather than reaching it through a dead one.
- **Variant propagation through variations is now pinned.** The existing three-check import test
  had no variations in its movetext, so the recursive branch was unverified. A new case in
  `packages/studies/test/studies.test.ts` imports `1. Re1+ (1. Rd8+)` into a `threecheck` study with
  a reader whose legal moves depend on the variant, so a branch resolving under standard rules
  cannot find the move and the import fails. Verified by mutation: dropping the variant from the
  recursive `validatePlayableMovetext` call fails exactly that test and no other.
- **The package's public surface shrinks.** `@chess-platform/studies` is a workspace package in a
  `private: true` monorepo, published nowhere, so there is no external compatibility contract to
  break. Removing an export with no consumer costs nothing and removes a way to be wrong.
- **One walker fewer to keep in step.** Two implementations of the movetext descent remain, one per
  adapter, which is the existing shape and not this increment's to change.
