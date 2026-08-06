# ADR-0105 — Running CI when GitHub Actions cannot

| Field      | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| **Status** | Accepted                                                                 |
| **Date**   | 2026-08-07                                                               |
| **Scope**  | `scripts/ci-local.mjs`, `scripts/check-ci-parity.mjs`, `.github/workflows/ci.yml`, `package.json`, `docs/RUNNING.md` |

---

## Context

On 2026-08-06 GitHub Actions entered a `major_outage` that was still unresolved a day later.
Confirmed from GitHub's own status API rather than inferred:

```
major_outage    Actions      (since 16:33 UTC)
operational     API Requests
operational     Git Operations
operational     Pull Requests
Incident: "Incident with Actions" — status: investigating
```

The progression on this repository: the last fully green run was 13:53 UTC; from 16:19 jobs began
failing at "Set up job"; by 17:30 whole runs were cancelled after exactly fifteen minutes with
`steps: []`; after 18:03 **no run was created at all**, for any branch or event.

Two increments finished during that window and could not be shown green. Nothing about them was
wrong; the checks were simply unavailable. Merging on an unverified branch and waiting indefinitely
were both bad answers, and each PR needed the same manual reconstruction of the workflow's commands
to say anything trustworthy about it.

An outage is only the loudest version of this. A network drop, an exhausted minutes quota, a fork
without Actions enabled, or a long flight produce the same situation, and none of them is a reason
the checks themselves should be unavailable.

## Decisions

### 1. `npm run ci:local` runs what CI runs

`scripts/ci-local.mjs` executes the workflow's commands on the developer's machine: build,
typecheck, test, the four check scripts, and — when the services are reachable — the two
service-backed jobs.

It is a **runner, not a pipeline**. It adds no step of its own, applies no different flags, and has
no configuration beyond two environment variables the workflow already uses.

### 2. Parity is enforced, not promised

`scripts/check-ci-parity.mjs` fails when the two files disagree in either direction: a workflow
command missing from the runner, or a runner command absent from the workflow. It runs in CI as a
step of its own and in `ci:local` itself.

This guard is the whole reason the runner is worth having. The failure mode is not someone deleting
a step deliberately — it is a new job landing in `ci.yml` and nobody thinking about the local copy,
after which the local run keeps printing green for a suite one job short. A trusted-but-stale
runner is worse than no runner.

Commands that genuinely cannot run locally (`npm ci` from a clean checkout, the Playwright browser
download, the Lighthouse global install and its preview server) are listed explicitly with the
reason. The list is a set of decisions, not exemptions: each entry is something a local run does
**not** cover, which is why the runner reports what it skipped.

### 3. Skipped is never reported as passed

When a service-backed job cannot run, it is named in a `SKIPPED` line and the closing summary says
so:

```
  SKIPPED  postgres integration (persistence + api) (DATABASE_URL is not set)
Everything that ran passed. 1 job(s) did NOT run — see SKIPPED above.
```

A local runner exists to be trusted when nothing else can confirm the branch. A green line that
quietly means "most of it" would defeat the purpose entirely.

### 4. The Postgres job insists on a disposable database

CI receives a fresh container per run. A local database keeps whatever the previous run left, and
several of these suites assume they are alone in it, so a second run fails on rows the first
inserted — which reads exactly like a regression and is not one. This was hit on the first real run
of the script.

The runner therefore requires `DATABASE_URL` to name a database with `test` in it, and skips the
job with that reason otherwise. It deliberately does **not** drop or recreate anything: pointing
the variable at a database that matters and having it silently cleared is far worse than a
confusing failure.

### 5. Only the service jobs see the service variables

The workflow gives `DATABASE_URL` and `REDIS_URL` to the two service-backed jobs and to nothing
else. Locally they are exported once for the whole session, and the suites that skip their
integration tests when the variable is absent then stop skipping — so the ordinary `npm test` step
silently became a larger, database-backed suite.

That is the opposite of parity, and it is how the first run of this script produced a failure the
real CI could not have produced. The runner now strips both variables from every step outside those
two jobs.

## Consequences

- A branch can be verified with one command while Actions is unavailable, and the result means the
  same thing the workflow's result would mean.
- A new CI job that is not mirrored locally fails `check:ci-parity` instead of silently weakening
  the local run.
- Two jobs (Lighthouse a11y, Playwright e2e) remain CI-only by decision, and a local run says so
  every time rather than implying otherwise.

## Out of scope

- Replacing GitHub Actions, or adding a second hosted CI provider. This is a local runner for when
  the hosted one is unavailable — the workflow stays the authority.
- `act` or another container-based workflow emulator. It would reproduce the runner environment
  rather than the checks, at a much higher cost, and would need its own drift guard anyway.
- Making the e2e and Lighthouse jobs runnable locally. Both are listed as not covered.
