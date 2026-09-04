# CI (GitHub Actions) — active

> Historical note: this document originally described how to manually activate
> the CI workflow, because the automation credential lacked the GitHub
> `workflow` scope needed to write under `.github/workflows/`. That activation
> has since been completed by a maintainer — the staged copies
> (`docs/ci/ci.yml`, later `deploy/helm/ci.yml`) were merged into the live
> workflow and deleted. This file now just documents what CI runs.

The workflow lives at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
and runs on matching pushes and pull requests targeting `main`, with a concurrency
group that cancels superseded runs on the same ref. Note that path filtering
skips documentation-only changes (`!**/*.md`), with an explicit exception carved
back in for `docs/adr/0121-deterministic-engine-install-in-ci.md` so that ADR
pin modifications trigger validation; engine pin parity across Dockerfiles and
scripts is additionally guarded in seconds by `.github/workflows/pin-parity.yml`.

## Jobs

- **detect changed areas (`changes`)** — detects which areas a diff touches
  (`gateway`, `web`, `deploy`, `images`) so heavier downstream jobs can skip
  when unaffected. Fails open (runs all jobs) if the diff base cannot be
  resolved.
- **build + typecheck + test (`build-test` on Node 22.x and 24.x)** — `npm ci`,
  then `npm run build` → `npm run lint` → `npm test`. Build runs first because
  downstream packages resolve upstream types from built `dist/` (the
  `types`/`main` fields point at `dist/`); lint/test on an unbuilt tree would
  fail to resolve those imports. Also runs static integrity checks including
  load harness contract tests (`test:load-harness`), Docker build-order
  validation (`check:build-order`), ADR claim verification (`check:adr-claims`),
  local CI runner parity (`check:ci-parity`), variant list parity
  (`check:variant-parity`), engine pin parity (`check:engine-pin-parity`), and
  guard script tests (`test:scripts`).
- **production image build (`docker-images`)** — builds the three published
  container images (`Dockerfile.api`, `Dockerfile.gateway`, `Dockerfile.web`)
  when image recipes or dependencies change. Inspects the runtime containers as
  `USER node` to assert that pinned Stockfish 16 executes, dynamic libraries
  resolve (`ldd`), and licenses are present. For the web image, verifies that
  `envsubst` renders a valid nginx upstream configuration without stripping
  built-in nginx variables.
- **postgres integration (`postgres-integration`)** — runs the `DATABASE_URL`-gated
  persistence tests (event store + repositories) and API concurrency control
  tests against a real PostgreSQL 16 service container with `pgvector`.
- **analysis smoke (`analysis-smoke`)** — validates real engine boundaries and
  durable analysis caching by testing against pinned, checksummed Stockfish 16
  and Fairy-Stockfish 14 binaries alongside a real PostgreSQL service container.
- **gateway service (`gateway-service`)** — compiles, typechecks, and tests the
  deployable `services/gateway` (isolated from the root workspace) with
  single-owner command-routing tests against a real Redis 7 container.
- **M6 acceptance (`m6-acceptance`)** — plays full games (vs bot and vs human)
  through the real UI against the in-process e2e harness using Playwright, and
  enforces a Lighthouse accessibility score ≥ 0.95. Reports are uploaded as
  artifacts.
- **helm lint + kubeconform (`helm`)** — lints `deploy/helm/gambit` with test
  secrets, asserts fail-closed behavior when secrets are missing, validates
  rendered manifests against Kubernetes schemas via `kubeconform -strict` across
  default values, external datastores, external secrets (ESO), and progressive
  delivery strategies (blue/green and canary). Runs `scripts/helm-snapshot-test.sh`,
  observability drift checks (`node scripts/check-observability-drift.mjs`),
  deploy gate invariants (`npm run check:deploy-gates`), and validates Prometheus
  alerting rules with `promtool`.

## Notes

- Installs use `npm ci` against the committed root `package-lock.json` for
  reproducible builds.
- The deeper chart-wiring checks (env-var ordering, gateway `replicas: 2`,
  secret sourcing, the search kill switches, and search indexer isolation) live
  in `scripts/helm-snapshot-test.sh`. The default of 2 gateway replicas enables
  horizontal scaling via single-owner authority and Redis command forwarding
  (ADR-0010; `replicas > 1` requires Redis). The `helm` job runs snapshot tests
  so a chart change that breaks wiring fails CI rather than waiting for a deploy.
  It is also runnable locally — see `docs/DEPLOYING.md`.
