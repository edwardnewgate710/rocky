# 121. Deterministic Engine Installation

Date: 2026-08-20

## Status

Accepted

Extends the artefact-pinning decision recorded in [ADR-0120](0120-threecheck-fen-and-engine-interop.md)
for Fairy-Stockfish to the other real engine the same job runs. ADR-0120 keeps its own record because
that pin exists for a Three-Check behavioural reason; this one exists for a CI reliability and
supply-chain reason, and the two should not be read as the same decision.

## Context

`analysis smoke (real Stockfish + Fairy-Stockfish)` is the only job that runs a real engine binary.
It installed the two engines by different means:

- **Fairy-Stockfish** — a pinned release asset, verified against a SHA-256 recorded in ADR-0120,
  `chmod`ed only after verification, then asked to identify itself over UCI.
- **Stockfish** — `apt-get update && apt-get install -y --no-install-recommends stockfish`, with no
  version pin, no integrity check and no identity assertion. `test -x` was the whole of it.

The second put the Ubuntu/Azure package mirror on the critical path of the job that proves the engine
boundary works. Measured across the thirty CI runs preceding this decision, the `Install Stockfish`
step behaved like this:

| statistic | `Install Stockfish` (apt) | `Install Fairy-Stockfish` (pinned) |
| --- | --- | --- |
| median | 18.5s | 0–1s |
| mean | 184s | ~0.5s |
| p90 | 460s | 1s |
| max | 2060s (34m, cancelled by hand) | 1s |
| runs over 60s | 10 / 30 | 0 / 30 |
| runs over 180s | 8 / 30 | 0 / 30 |
| total | 92.2 minutes | ~20s |

The smoke test the step exists to enable takes **ten seconds**. On a third of runs the job spent
minutes — once more than half an hour — installing a dependency for it. The stall is not a hang that
fails fast; it is unbounded tail latency, and the job inherited GitHub's six-hour default timeout, so
a stalled run consumed Actions minutes until a human noticed. That is what happened during the
post-merge verification of M15 Increment 9, recorded in `docs/PROJECT_STATE.md` as an infrastructure
exception.

Two independent problems, then: the mirror is unreliable, and the engine that reached the test was
neither pinned nor identified.

## Decision

Install Stockfish the way Fairy-Stockfish is already installed.

| release | asset | SHA-256 |
| --- | --- | --- |
| `sf_16` | `stockfish-ubuntu-x86-64.tar` | `efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983` |

The digest is of the **downloaded archive**, which is the object crossing the trust boundary. The
executable it contains, `stockfish/stockfish-ubuntu-x86-64`, is
`4350672d7314ad71965affc31fb46cebfbebfe6288083188b62aa3a79f8b4b23`; that value is recorded for
identification but is not separately checked, because verifying the archive and then extracting one
member by exact path already determines it.

The order is fixed and load-bearing: **download → verify → extract one member → `chmod` → identify →
test.** Nothing is executed, and nothing is made executable, before its digest has been checked.

Four things about the choice of artefact:

- **`sf_16` is the version the mirror was already serving** (`stockfish 16-1build1`). The engine under
  test does not change; only how it arrives does. This increment is about installation reliability,
  not about engine opinion.
- **The plain `x86-64` asset is the baseline build.** The `-modern` and `-avx2` assets of the same
  release require instruction sets a hosted runner is not guaranteed to have.
- **All three assets are byte-for-byte the same size** (41,594,880), so size distinguishes nothing.
  The digest is what tells them apart, and the archive member name is a second, independent guard:
  each build ships its executable under its own name, so requesting `stockfish/stockfish-ubuntu-x86-64`
  by exact path fails rather than silently yielding a CPU-specific binary.
- **GitHub publishes no digest for the asset** (the API returns `digest: null`) and a release asset is
  replaceable, so a locally pinned value is the whole integrity story — exactly as for Fairy.

Stockfish is now asked to identify itself (`id name Stockfish 16`) before the suite runs, closing the
asymmetry with Fairy. For a downloaded binary this doubles as the check that it *runs at all* on the
runner: a missing shared library or an incompatible architecture surfaces here, naming the step,
rather than as a spawn error inside the test run.

The job takes an explicit `timeout-minutes: 15`. A healthy run is 72 seconds, of which the build is
41, so fifteen minutes is roughly twelve times the expected duration — wide enough that a cold npm
cache or a slow runner cannot trip it, narrow enough that a future infrastructure stall is capped at
fifteen minutes instead of six hours.

## Consequences

- **The mirror leaves the critical path.** `apt-get` no longer appears in any executable line of any
  workflow *file*; the only remaining mention there is the comment recording what was replaced and
  why. It is still reached indirectly through the release image builds — see the production-images
  note below, which is where the remaining exposure is stated rather than glossed.
- **Supply-chain posture improves rather than degrades.** Where there was an unpinned, unverified,
  unidentified package there is now a pinned release, a verified digest, a single named archive
  member and a UCI identity assertion.
- **The download is larger.** 41.6 MB against roughly 2 MB for the Debian package, because the
  official archive carries the source tree and wiki alongside the binary. Only the executable is
  extracted. The whole install and identity sequence was measured end to end at 17.6s over a home
  connection — already at apt's *median* and far under its 184s mean, before the runner's much faster
  path to GitHub is taken into account.
- **No second download for the network.** The NNUE evaluation net `nn-5af11540bbfe.nnue` is embedded
  in the binary; the archive contains no separate `.nnue` file.
- **Production images kept apt at first, and no longer do.** As originally accepted this decision
  covered CI only: `Dockerfile.api` and `Dockerfile.gateway` still installed Stockfish through apt,
  narrowing the mirror dependency rather than removing it. M15 Increment 12 extended the same
  decision to those images — see the amendment below.
- **Licensing is unchanged.** Stockfish is GPLv3 either way; taking the official upstream binary
  instead of the Debian package alters no obligation for CI use.
- **A new engine version is now a deliberate act.** Moving off `sf_16` means changing the release, the
  digest and the identity assertion together, which is the point: the previous arrangement would have
  silently followed whatever the mirror decided to serve.


## Amendment — M15 Increment 12: the production images pin the same artefact

Date: 2026-08-20

As accepted above, this decision covered CI only. That left a worse problem than the one it fixed,
and stating it plainly: **the engine serving production was not the engine any test exercised.**

| | Stockfish version | how it was chosen |
| --- | --- | --- |
| CI, since this ADR | **16** | pinned release + digest |
| Production images, before Increment 12 | **15.1-4** | whatever `apt-get install stockfish` resolved on Debian bookworm |
| Production images, had `node:22-slim` followed Debian to trixie | **17-1** | the same, silently, with no commit of ours |

`node:22-slim` resolves to `22/bookworm-slim`, whose `FROM` is `debian:bookworm-slim`; bookworm
carries `stockfish 15.1-4` and trixie carries `17-1`. So production was a base-image bump away from
changing engine version on its own.

### What changed

Both images now take the binary from a dedicated `stockfish` artefact stage that pins exactly what
CI pins — release `sf_16`, asset `stockfish-ubuntu-x86-64.tar`, archive SHA-256
`efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983` — verifying the digest before
extraction, extracting the one member by exact path, `chmod`ing only after that, and asserting
`id name Stockfish 16` inside the stage. The runtime stages take `COPY --from=stockfish` and
nothing else, so the 41.6 MB archive never exists in a shipped layer.

`STOCKFISH_PATH` moves from `/usr/games/stockfish` (where the Debian package put it) to
`/usr/local/bin/stockfish`.

### Redistribution

This is the one place the images must not simply copy CI. CI *uses* the binary; `release.yml`
**publishes** the images to GHCR, which is distribution, and the Debian package being replaced
carried its own licence material. The upstream archive ships `Copying.txt` (GPLv3), `AUTHORS`,
`README.md` and the corresponding `src/` tree; all four are copied to
`/usr/local/share/stockfish/`, beside the binary, for about 0.7 MB. The repository had no existing
third-party licence convention to follow — a single root `LICENSE` for its own AGPL-3.0-or-later
code — so this establishes one: licence and source live next to the binary they belong to.

### Verification

`release.yml` builds these images only on a `v*` tag, so before this increment nothing checked them
until a release was already being cut. A `docker-images` job now builds them on every change to an
image recipe and, inside each engine image, asserts the binary exists, `ldd` resolves with no
`not found`, the engine reports `id name Stockfish 16`, the licence and source material is present,
and — with a positive control first, so an empty result is evidence rather than a broken scan — that
no Stockfish archive reached a shipped layer. It is gated on `Dockerfile*`, `docker/`,
`package(-lock).json` and the two workflows that build images — application code is compiled by
`build-test` on every run already, and rebuilding the images to compile it again would double a cost
that proves nothing new.

`release.yml` publishes a third image, `Dockerfile.web`, and the job builds and checks that one too.
It carries no engine, so what it is checked for is different in kind: `nginx.conf.template` is copied
into `/etc/nginx/templates/` and rendered by the entrypoint at container start, which means a
malformed proxy block is not a build failure — the image builds clean and dies on boot. The job runs
the entrypoint with representative loopback upstreams, requires `nginx -t` to accept the rendered
config, and requires both that the upstreams were substituted and that `$http_host` and `$uri` were
not, which is exactly what `NGINX_ENVSUBST_FILTER` exists to guarantee.

A tag does not start `ci.yml` or `pin-parity.yml`, so `release.yml` runs the parity guard and its
tests in its own `verify` job before `publish`. Publishing is the irreversible step and the guard
costs milliseconds; leaving it out was the one place a drifted pin could still have shipped.

`scripts/check-engine-pin-parity.mjs` holds the four copies of the pin together: this ADR, the CI
workflow, and both Dockerfiles. The failure it exists for is not a typo but a partial upgrade —
the release moved in one place and not the others, which is precisely the state described at the
top of this amendment.

### Measured, not estimated

From the `docker-images` job on the real images:

| | measured |
| --- | --- |
| `gambit-api` total image | **275 MB** |
| `gambit-gateway` total image | **276 MB** |
| Stockfish binary, in-image | **38.6 MB** |
| Licence + source, in-image | **0.8 MB** |
| **Stockfish footprint total** | **39.4 MB** |

Against Debian's declared `Installed-Size` for `stockfish 15.1-4` of **46.2 MB**, that is roughly
**6.8 MB smaller**. One caveat on that comparison, stated rather than glossed: the new figure is
measured inside a built image, the old one is package metadata. The previous images were not
rebuilt to weigh them, so the total-image before/after is not a like-for-like measurement and no
exact saving is claimed — only that the replacement is smaller than the package it replaces, and
that the 41.6 MB archive is nowhere in the shipped layers.

**Runtime libraries resolve.** `ldd` inside both images, on the shipped binary:

```text
libpthread.so.0 => /lib/x86_64-linux-gnu/libpthread.so.0
libstdc++.so.6  => /lib/x86_64-linux-gnu/libstdc++.so.6
libm.so.6       => /lib/x86_64-linux-gnu/libm.so.6
libgcc_s.so.1   => /lib/x86_64-linux-gnu/libgcc_s.so.1
libc.so.6       => /lib/x86_64-linux-gnu/libc.so.6
```

No `not found`, and no library had to be added: `node:22-slim` already carries `libstdc++6`, which
was the open question when Debian's `stockfish` package stopped supplying it transitively. Nothing
was installed speculatively to cover it.

### Consequences of the amendment

- **Production changes engine version, 15.1 → 16.** This is a real behavioural change, made
  deliberately: it aligns production with the only version any test exercises. Evaluations may
  legitimately differ between engine versions and no claim is made that they will not. What is
  asserted is capability, which is what the analysis composition depends on: MultiPV, `cp` and
  `mate` scores, UCI principal variations, and `movetime` being honoured.
- **`apt-get` is gone from the images as well as the workflows.** The mirror is no longer on any
  path this repository controls.
- **These images are amd64-only, and that is a change.** Release `sf_16` publishes no linux/arm64
  asset — `stockfish-ubuntu-x86-64.tar` and its `-modern`/`-avx2` siblings are the only Linux
  builds. Debian's package resolved per-architecture, so an arm64 workstation used to get an engine
  for free. Production is untouched: `release.yml` sets no `platforms:`, so the published images
  have always been the runner's amd64. Local development is not: both Dockerfiles fail fast with a
  named architecture error rather than an `exec format error` four steps later, and
  `docker-compose.yml` pins `api` and `gateway` to `linux/amd64` so `docker compose up --build`
  still works on ARM, under emulation. Slower than native, and it runs. A native arm64 engine means
  building Stockfish from source, which is a different decision from pinning a published artefact
  and is not taken here.
- **Fairy-Stockfish stays out of production.** Nothing in the deployable services routes to it;
  shipping it is a capacity and operations decision of its own, unchanged by this amendment.
- **The pin is now maintenance.** Moving off `sf_16` means changing four files together, which the
  parity guard enforces. That is the intended cost of not letting a mirror decide.

## Guards

`scripts/check-ci-parity.mjs` continues to record the real-engine smoke as not runnable locally —
that has not changed and must not be faked, because the suite self-skips without a binary and would
otherwise report a pass having proven nothing. The verification that matters for this ADR is the job
itself running on a GitHub-hosted runner, which is the only place the Linux artefact can be executed.
