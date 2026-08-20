# 121. Deterministic Engine Installation in CI

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
- **Production images are deliberately untouched, and the mirror does survive there.**
  `Dockerfile.api` and `Dockerfile.gateway` install Stockfish through apt as before. `ci.yml` — the
  workflow that runs on pull requests and on `main`, and the one every measurement above was taken
  from — does not build those images, so they were never part of the measured failure path.
  `release.yml` **does** build both, on a `v*` tag push, and those builds run the apt layers;
  `chaos.yml` builds no image. The dependency is therefore narrowed rather than eliminated
  repository-wide, and saying otherwise would overstate what this decision achieved. It stays out of
  scope because the release path is a different workflow on a different trigger, with its own
  rollout and image-size trade-offs — not because it is absent. Raised in the Qodo review of PR #142.
- **Licensing is unchanged.** Stockfish is GPLv3 either way; taking the official upstream binary
  instead of the Debian package alters no obligation for CI use.
- **A new engine version is now a deliberate act.** Moving off `sf_16` means changing the release, the
  digest and the identity assertion together, which is the point: the previous arrangement would have
  silently followed whatever the mirror decided to serve.

## Guards

`scripts/check-ci-parity.mjs` continues to record the real-engine smoke as not runnable locally —
that has not changed and must not be faked, because the suite self-skips without a binary and would
otherwise report a pass having proven nothing. The verification that matters for this ADR is the job
itself running on a GitHub-hosted runner, which is the only place the Linux artefact can be executed.
