# ADR-0049 — Pure-Domain Search Core

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/search` (M11)  |

---

## Context

Milestone 11 introduces Search (keyword and semantic search over games, openings, players, and studies, with natural-language query parsing). Following the project's architecture — a dependency-free domain core with infrastructure behind ports — the first increment establishes a pure, self-contained search **domain package** `@chess-platform/search` before persistence (pgvector), semantic vector embeddings, or REST/GraphQL API wiring.

The keyword search core must tokenize text, parse structured queries (combining bare terms, quoted phrases, and key-value metadata filters), and match documents using strict AND semantics with deterministic scoring and ranking. It must operate entirely in memory without I/O or external npm dependencies, fully testable with `node --test`.

## Decision

Create a brand-new dependency-free domain package `@chess-platform/search`. Public domain components:

- **Shared Text Primitive (`tokenize`)**: `tokenize(text: string): string[]` normalizes text to lower-case Unicode-aware alphanumeric tokens (`/[^\p{L}\p{N}]+/u`), stripping punctuation and whitespace.
- **Query Parser (`parseSearchQuery`)**: `parseSearchQuery(input: string): SearchQuery` non-throwingly parses free-text search strings into:
  - `terms`: bare free-text words (raw as typed).
  - `phrases`: quoted phrase inner text (`"quoted phrase"`).
  - `filters`: metadata filters (`[-]field:value` or `field:"value"` where `field` matches `^[a-zA-Z][a-zA-Z0-9_]*$`). Empty values (`field:`) are treated as bare terms.
- **In-Memory Search Matcher & Ranker (`search`)**: `search(query, documents): SearchResult[]` matches documents using AND semantics:
  - **Filters**: case-insensitive exact matching against `doc.fields`. Negated filters (`-field:value`) match if the field is absent or holds a different value.
  - **Terms**: every query term-token (`tokenize(term)`) must exist in `tokenize(doc.text)`.
  - **Phrases**: every phrase token list must appear contiguously as a sublist of `tokenize(doc.text)`.
  - **Scoring & Ranking**: `score = (sum of query term-token occurrence counts in docTokens) + 2 * (number of phrase matches)`. Filters-only queries score passing documents at `0`. Results are sorted by `score` DESC, tie-broken deterministically by `id` ASC.

## Consequences

- The search core is completely pure and dependency-free — no database, vector storage, or HTTP/GraphQL dependencies.
- **Search Roadmap**: pgvector persistence, vector semantic embeddings, natural-language query transformation, and API surface integration are explicitly deferred to subsequent Milestone 11 increments.
