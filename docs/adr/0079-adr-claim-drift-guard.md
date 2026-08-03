# ADR-0079 — Making ADR claims checkable, and a flaky test that hid its own failure

| Field      | Value                                                                 |
|------------|-----------------------------------------------------------------------|
| **Status** | Accepted                                                              |
| **Date**   | 2026-08-03                                                            |
| **Scope**  | `scripts/check-adr-claims.mjs`, `packages/e2e-harness`, `.github/workflows/ci.yml` |

---

## Context

This repository prefers executable guards to trusted prose: `check-observability-drift.mjs` fails CI
when an alert names a metric nothing emits, `check-docker-build-order.mjs` fails when the container
build chain drifts from the dependency graph, `check-deploy-gates.mjs` fails when a deploy gate is
quietly removed. Each was written after a real incident.

The 78 ADRs had no such guard, and M14 increment 11 showed what that costs. ADR-0010 §7 specified six
ownership metrics — `gateway_owned_games`, `gateway_forwarded_commands_total` and four others — and
**not one of them had ever been implemented**. Game ownership was completely unobservable in
production: no dashboard could show it, no alert could fire on it, and no test could assert failover
because there was nothing to observe. The gap survived for months. The same ADR's §6 promised that an
owner could still process commands while Redis was down, which the code also did not do (fixed in
ADR-0078).

Prose is not executable, so nothing noticed.

## Decision

### 1. A guard for the mechanically checkable half

`scripts/check-adr-claims.mjs` (`npm run check:adr-claims`) scans `docs/adr/*.md` and fails when an
ADR names something that does not exist:

1. **Repo-relative paths** in backticks, rooted at a real top-level directory.
2. **Metric-shaped names** in backticks — must be registered in the application source. This is the
   check that would have caught ADR-0010 §7.

   The vocabulary is **derived from the source, not guessed by suffix**. The first version recognised
   a metric only by a `_total`/`_seconds`/`_bytes`/`_count` ending, which silently skipped every
   gauge: of the eighteen metrics this repo registers, exactly one — `gateway_owned_games` — fell
   outside that list, and it is one of the six from ADR-0010 §7 that motivated the guard. So the
   claim above was 5/6 true when first written, in the ADR making the claim. A name now qualifies if
   it carries a conventional suffix **or** lives in a namespace the application actually emits into.

   Registrations are read from `src` only. Tests register throwaway metrics against fake registries
   (reqs_total, active_games, lat_seconds — deliberately unbackticked here, see below), and letting
   those in invented an "active" namespace, which promptly made the workflow input `active_color`
   look like a metric an ADR had promised.

   Writing those three names in backticks is what this guard is *for*, so it rejected this very ADR
   when they were: they are illustrations, not signals anyone can scrape. The convention is the same
   one adopted for historical paths — an identifier in backticks is a claim that it exists, prose is
   not. That the document describing the guard had to obey it is the cheapest possible demonstration
   that it works.
3. **`npm run <script>`** references — must exist in some `package.json`.
4. **`ADR-NNNN` cross-references** — must resolve to an ADR file.

It runs in the `build-test` job rather than the deploy-gated `helm` job, because an ADR can be
invalidated by any change. Note that `ci.yml` sets `paths-ignore: ['**/*.md']`, so a markdown-only
edit does not trigger CI at all: this guard catches **code moving away from the ADRs**, which is the
direction that actually rots. An ADR edited in isolation is reviewed by a human, not by this.

### 2. What it deliberately does not check, and why that matters

**It cannot tell you an ADR is true.** ADR-0010 §6 claimed behaviour the code did not have; no
identifier was missing, the sentence was simply false. Only executing the system finds that, which is
what the chaos suite in ADR-0077 does. This guard must not be read as proof that the records are
accurate — it proves only that the things they name exist.

Three categories were considered and rejected, because a guard with a bad signal-to-noise ratio is a
guard people switch off:

- **Bare filenames.** ADRs legitimately write `Chart.yaml` or `bootstrap.ts` as shorthand. Requiring
  a path separator is what keeps the false-positive rate near zero.
- **Environment variables.** The obvious regex matches Redis commands (`HSETNX`, `XREADGROUP`) and
  ordinary words like `ENUM`, while real ones live in Dockerfiles a naive source scan misses.
- **Prose describing the past.** An ADR is a record of a decision, so it legitimately names things as
  they were. The convention adopted here: write a historical name as a bare filename (prose) and a
  current location as a full path (a reference). ADR-0075 was rewritten accordingly rather than
  having its history erased.
- **Gitignored paths**, which git is asked about rather than guessed at. ADR-0065 references
  `deploy/load/results/` and says in the same sentence that it is gitignored, because the load test
  writes its output there. That reference is correct; the directory just does not exist until someone
  runs the tool. This guard's **first CI run failed on exactly that**, and passed locally only
  because this machine had run the load test — a difference between a developer's tree and a clean
  checkout, which is the very class of drift the guard exists to catch, aimed at itself.

One allowlist entry exists, with its reason recorded in the script: ADR-0064 quotes a **deliberately
misspelled** metric to demonstrate the observability guard rejecting it. A guard that flags a
documented counter-example is one nobody keeps.

### 3. The audit found the corpus healthy

Running this over all 78 ADRs found **three** stale references, two of them created by our own
ADR-0075 rename of `nginx.conf` to `nginx.conf.template`, plus one malformed link label. Every metric
name, npm script and ADR cross-reference resolved. This is regression prevention, not a cleanup: the
value is that the next ADR-0010 §7 fails CI on the day it is introduced.

### 4. A flaky end-to-end test, and the failure it hid

`packages/e2e-harness`'s protocol test — "boots, registers a user, creates a bot game, plays to
completion, and broadcasts ended" — failed intermittently with `game did not end after 301 moves`.
Two players choosing legal moves at random frequently cannot reach a terminal position inside the
test's 300-move valve.

Worse than the flake: **when the assertion failed, the test file hung** (178s until an external
timeout killed it), so a failure presented as a frozen suite. That is the same signature as the known
port-4175 conflict between the harness and the compose gateway, which sends the next person
investigating in entirely the wrong direction.

Two changes, and the distinction between them is the point:

- **Termination is now guaranteed by construction.** The harness already had the lever — the bot's
  `resignAfterPlies`, which its own header calls a "determinism lever" — and this test simply never
  set it. Passing `botResignsAfterPlies: 20` bounds the game regardless of what random play does.
  Measured: the game now ends in 12–14 moves against a 300 valve.
- **Move choice is seeded** rather than `Math.random()`, which removes one source of variance.
  **This alone was not sufficient, and claiming otherwise would have been false**: with both sides
  seeded the game still took 109, 155 and 186 moves across three runs, because how many draws each
  side takes depends on message timing. That measurement is recorded in the code next to the seed so
  the next reader does not assume more determinism than exists.

Verified over 10 consecutive runs: 10 passed, 0 failed.

## Consequences

- An ADR that names a file, metric, script or sibling ADR which does not exist now fails CI.
- The guard's scope is honest and narrow. Behavioural claims still need executable proof — that is
  what ADR-0077's chaos suite is for, and it is why both exist.
- The e2e-harness test is bounded rather than lucky, and a failure in it now presents as a failure.
