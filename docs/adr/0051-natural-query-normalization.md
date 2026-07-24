# ADR-0051 — Natural-Language Query Normalization

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/search` (M11)  |

---

## Context

Milestone 11 introduces Search across games, openings, players, and studies. Increment 1 delivered the pure-domain keyword search core (`parseSearchQuery`, `search`), and Increment 2 established the stateful `SearchRepository` abstraction.

Users frequently type natural-language search strings (e.g. `"blitz games won by white"`, `"rapid player:magnus"`, `"show me all bullet matches"`) instead of strict `field:value` filters. The search domain requires a bounded, rule-based normalizer that maps recognized natural chess vocabulary into structured `SearchQuery` filters while dropping low-signal stop words.

Because `@chess-platform/search` is a dependency-free domain package, full semantic/LLM understanding and vector embeddings are out of scope for this layer and deferred to future increments.

## Decision

Introduce `parseNaturalQuery(input: string): SearchQuery` and exported constants `NATURAL_STOP_WORDS` and `NATURAL_VOCABULARY` in `@chess-platform/search` (`src/natural.ts`):

- **Layering on `parseSearchQuery`**: `parseNaturalQuery` runs `parseSearchQuery(input)` first, preserving explicit `field:value` filters and quoted `"phrases"` intact (explicit syntax always takes precedence).
- **Vocabulary Promotion & Stop-Words**:
  - `NATURAL_VOCABULARY`: A bounded `ReadonlyMap<string, { field, value }>` mapping lowercase chess terms to structured filters:
    - **Variants**: `blitz`, `bullet`, `rapid`, `classical`, `chess960`, `960` (maps to `chess960`), `atomic`, `crazyhouse`, `horde`, `antichess`.
    - **Colors**: `white`, `black`.
    - **Results**: `win`, `won`, `wins`, `winning` (map to `win`), `loss`, `lost`, `losses`, `lose` (map to `loss`), `draw`, `draws`, `drew`, `drawn`, `tie`, `tied` (map to `draw`).
  - `NATURAL_STOP_WORDS`: A `ReadonlySet<string>` of 27 bare filler words (`the`, `a`, `an`, `of`, `in`, `on`, `by`, `with`, `and`, `or`, `for`, `to`, `from`, `me`, `all`, `show`, `find`, `list`, `game`, `games`, `match`, `matches`, `played`, `between`, `was`, `were`, `that`) that carry no search signal and are dropped.
- **Term Processing & Filter Deduplication**:
  - Bare terms from `parseSearchQuery` are inspected in encounter order: recognized vocabulary words become non-negated filters `{ field, value, negated: false }`, stop words are dropped, and all other terms remain as raw terms.
  - Filters are combined as explicit filters followed by promoted filters, and deduplicated by the tuple `(field, value, negated)`, preserving first-occurrence order.
- **Normalization Target**: `parseNaturalQuery` normalizes natural language directly into the existing `SearchQuery` structure, enabling `search()` and `SearchRepository` to consume natural queries with zero changes to matchers or repositories.

## Consequences

- Natural queries like `'blitz games won by white'` map deterministically to structured filters `[variant:blitz, result:win, color:white]`.
- Explicit filter syntax (`field:value`) and quoted phrases (`"..."`) retain precedence over vocabulary promotion.
- Pure and dependency-free: operates strictly in memory with no LLM, external I/O, or third-party dependencies.
- Semantic vector embeddings and LLM-driven query understanding remain deferred to subsequent M11 increments.
