# Enabling CI (GitHub Actions)

The CI workflow is **written and ready** but could not be committed to its final
location automatically: the credential used to push to this repo does not have the
GitHub **`workflow`** permission/scope, so GitHub rejects commits that create or
modify files under `.github/workflows/` (error: *"does not have the correct
permissions to execute `CreateCommitOnBranch`"*). Regular files (LICENSE, docs,
source) commit fine — only workflow files are blocked.

The finished workflow is stored here for review:

- [`docs/ci/ci.yml`](ci/ci.yml)  ← ready-to-use, verbatim contents for the workflow

## What the workflow does

On every push and PR to `main`, across Node 20 and 22:

1. `npm install` (workspaces)
2. `npm run build` — builds `core → game → realtime-gateway` in dependency order
3. `npm run lint` — `tsc --noEmit` typecheck of every package
4. `npm test` — `node --test` suites for every package

**Why build before lint/test:** `@chess-platform/game` and
`@chess-platform/realtime-gateway` resolve `@chess-platform/core`'s types from its
built `dist/` (the `types`/`main` fields point at `dist/`). If lint or test ran
first, those type imports would not resolve. The root `build`/`lint`/`test`
scripts already fan out to the packages in the correct order.

## How to enable it (one of the following)

**Option A — move the file with a `workflow`-scoped credential (recommended):**

```bash
git pull
mkdir -p .github/workflows
git mv docs/ci/ci.yml .github/workflows/ci.yml
git commit -m "CI: activate build + typecheck + test workflow"
git push
```

This requires either:
- pushing as a user/PAT with the **`workflow`** scope, **or**
- if pushing via a GitHub App / OAuth token, granting that app the
  **"Workflows" write** permission (Repo settings → the app's permissions),
  **or** simply doing the `git mv` + push from a local clone authenticated with
  your own account (which normally has `workflow`).

**Option B — create it in the GitHub UI:** open *Actions → New workflow → set up a
workflow yourself*, paste the contents of `docs/ci/ci.yml`, name it `ci.yml`, and
commit. The web UI commits with your account's `workflow` permission.

Once `.github/workflows/ci.yml` exists, delete `docs/ci/ci.yml` (it's only a
staging copy) — or keep it; it is inert outside `.github/workflows/`.

## Follow-up

- Add a root `package-lock.json` and switch the install step from `npm install`
  to `npm ci` for reproducible CI installs.
- Once CI is live, add a status badge to `README.md`.
