# CI (GitHub Actions) — active

> Historical note: this document originally described how to manually activate
> the CI workflow, because the automation credential lacked the GitHub
> `workflow` scope needed to write under `.github/workflows/`. That activation
> has since been completed by a maintainer — the staged copies
> (`docs/ci/ci.yml`, later `deploy/helm/ci.yml`) were merged into the live
> workflow and deleted. This file now just documents what CI runs.

The workflow lives at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
and runs on every push and pull request targeting `main`, with a concurrency
group that cancels superseded runs on the same ref.

## Jobs

1. **build + typecheck + test (Node 22.x and 24.x)** — `npm ci`, then
   `npm run build` → `npm run lint` → `npm test`. Build runs first because
   downstream packages resolve upstream types from built `dist/` (the
   `types`/`main` fields point at `dist/`); lint/test on an unbuilt tree would
   fail to resolve those imports.
2. **postgres integration (persistence)** — runs the `DATABASE_URL`-gated
   persistence tests (event store + repositories) against a real Postgres 16
   service container.
3. **M6 acceptance (Playwright e2e + Lighthouse a11y)** — plays full games
   (vs bot and vs human) through the real UI against the in-process e2e
   harness, and enforces a Lighthouse accessibility score ≥ 0.95. Reports are
   uploaded as artifacts. A missing Lighthouse report (environmental
   Chrome-launch failure on the runner) warns instead of failing; only a
   genuine sub-threshold a11y score fails the job.
4. **helm lint + kubeconform (M14)** — lints `deploy/helm/gambit` and
   validates the rendered manifests against Kubernetes schemas with
   `kubeconform -strict`, for both the default (bundled postgres/redis) values
   and the external-datastore override.

## Notes

- Installs use `npm ci` against the committed root `package-lock.json` for
  reproducible builds.
- The deeper chart-wiring checks (env-var ordering, gateway `replicas: 1`,
  secret sourcing, the search kill switches) live in
  `scripts/helm-snapshot-test.sh`. The `helm` job runs it as its final step, so
  a chart change that breaks wiring fails CI rather than waiting for a deploy.
  It is also runnable locally — see `docs/DEPLOYING.md`.
