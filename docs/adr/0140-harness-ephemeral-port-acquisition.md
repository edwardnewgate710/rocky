# ADR-0140 — Harness ephemeral-port acquisition

**Status:** Accepted
**Date:** 2026-08-30
**Supersedes:** the hand-tuned blocked-port set added in PR #14 (`7603abf`), whose failures ADR-0131 and ADR-0132 later recorded

## Context

`startHarness` (`packages/api/test/helpers.ts`) binds a test server with
`server.listen(0, '127.0.0.1')` and builds a `baseUrl` from whatever port the OS
returns. Two flaky signatures were tracked against it in `docs/ROADMAP.md`, and
this ADR deliberately resolves only one of them.

### Signature A — a port `fetch` refuses

WHATWG Fetch defines a table of **blocked ports**, and Node's bundled undici
enforces it. The check is a property of the port number alone and happens
*before* a socket is opened, so a server can be bound, listening, and answering
raw TCP while `fetch` still refuses to talk to it. The failure therefore does
not appear at listen time; it appears at the harness's *first request*, as
`TypeError: fetch failed` with `cause` `Error: bad port` and a stack pointing at
`helpers.ts`'s `json()` rather than at the listen that caused it. That mismatch
between where it breaks and where it is caused is what made it read as random.

Whether the OS can hand out such a port depends entirely on the host's dynamic
port range:

| Host | Dynamic range | Blocked ports inside it |
| --- | --- | --- |
| Linux (typical CI) | 32768–60999 | none |
| Windows (this project's dev machines) | 1024–15000 | nineteen |

That is the whole explanation for "green on CI, flaky locally". On a 1024–15000
range roughly one bind in 735 draws a port `fetch` will not use, and a full
`packages/api` run binds close to three hundred listeners — there are 283
`startHarness` call sites — so a run failing is a routine event, not a rare one.

An earlier mitigation already existed — a `do/while` that re-listened while the
drawn port was in a hardcoded `FETCH_BLOCKED_EPHEMERAL_PORTS` set — but it had
four faults:

1. **The set was incomplete.** It held the eighteen blocked ports someone had
   observed, which is the spec list intersected with one machine's range, minus
   one: **6679 was missing**. A harness handed 6679 walked straight past the
   guard, which is exactly the failure still being observed.
2. **The retry was unbounded.** `do { … } while (blocked)` has no ceiling, so a
   host that could not produce a usable port would hang the suite rather than
   fail it.
3. **Exhaustion had no behaviour at all**, and so no diagnostic.
4. **It was copy-pasted.** `auth-signin-schema.integration.test.ts` carried its
   own copy of the set and the loop, with a comment recording that it was copied
   from `helpers.ts`. Two copies meant the missing `6679` had to be found twice.

### Signature B — a whole file failing with `'test failed'`

Tracked separately, and **left open by this ADR**. See §4.

## Decision

Put ephemeral-port acquisition in one module, `packages/api/test/listen.ts`, and
have both binding sites use it.

### 1. The blocked-port set is spec-complete, and verified against the runtime

`FETCH_BLOCKED_PORTS` carries all eighty-two ports from the WHATWG table rather
than the subset one machine can reach. A list trimmed to an observed range is
only correct for the machine that observed it and drifts silently when someone
changes their `netsh` settings; the spec list cannot.

It was not transcribed on trust. Every port from 1 to 65535 was probed through
the real `fetch` on Node v24.15.0 — with nothing listening, a blocked port fails
with `bad port` while any other fails to connect — and exactly these eighty-two
came back blocked. `listen.test.ts` keeps the cheap half of that check running
in CI: every port the module lists must still be one the runtime refuses.

### 2. Retrying is bounded, and exhaustion is loud

`listenOnFetchablePort` tries at most `DEFAULT_MAX_LISTEN_ATTEMPTS` (20) times
and then throws, naming the attempt count and the ports it rejected. The bound
is not tuned to the odds — twenty consecutive blocked draws on the worst
ordinary range sits around 1e-58 — it exists so that a host which genuinely
cannot allocate ports fails with an actionable message instead of hanging.

The error names ports and a host and nothing else: no request bodies, no
credentials, no environment.

### 3. Ownership of the socket never leaves the harness

The rejected alternative was to pre-bind a probe socket, close it, and hand the
port number on to the real server — which is a race against every other process
on the machine, and against the OS's own reuse policy. Instead the harness keeps
whatever it binds: a rejected listener is closed *before* the next attempt asks
for another port, so at most one listener is ever open, and the port finally
returned is one the harness is still holding. `ApiServer.listen` already builds
a fresh `http.Server` per call, so no listener is ever re-bound and
`ERR_SERVER_ALREADY_LISTEN` cannot arise.

`server.address()` is now read through a guard rather than an
`as AddressInfo` cast. It can return `null` or a pipe string, either of which
previously produced a `baseUrl` ending in `:undefined`; both now throw, and the
listener is closed on the way out without masking the reason.

## Consequences

- Both binding sites share one implementation; the duplicated set and loop in
  `auth-signin-schema.integration.test.ts` are gone.
- `ApiServer.listen` now rejects on a failed bind. This is the one production
  change here, and it is what makes the bounded, diagnosable failure above
  actually true: the retry can only report a bind error if the listener it is
  given rejects, and this one never did. See §5.
- `startHarness` keeps its signature. No caller changes, and no test needs a
  workaround.
- No fixed port is introduced anywhere in the harness path. The two cases that
  need a real blocked port bind one directly and skip if the host will not give
  it to them, which is a property of those cases and not of the harness.
- IPv6 is **not** supported and was not added: `startHarness` has always
  hardcoded `127.0.0.1`, so there is no existing behaviour to preserve. A future
  IPv6 host would need bracketed authority construction; the host is now a named
  constant, which is where that would go.
- `packages/e2e-harness` is untouched. Despite the name it does not implement
  `startHarness`, and its own port handling reaches the network through
  `node:http` and `ws` rather than `fetch`, so the blocked-port policy does not
  apply to it. Its `freePort()` helper does use the pre-bind-and-close pattern
  rejected above; that is a separate concern and is left alone.

## 4. Signature B is not resolved here

A whole test file occasionally fails with `'test failed'`, no assertion, no
stack, and none of its own tests reported. **It was reproduced during this work
and it is not fixed.** It is recorded here so that the port fix is not
mistaken for having closed it.

Twenty consecutive full `packages/api` runs produced five failures. Four were on
the pre-fix code: one signature A (`auth.test.js`, `bad port`, stack in
`helpers.js`) and three signature B. One was on the post-fix code, and it was
signature B. The fix removes signature A and leaves signature B untouched, which
is the evidence that they are two defects and not one.

What the reproduction establishes:

- The affected file is **not fixed**. Four different files were hit across the
  runs — `move-explanation-route`, `tournament-commentary-route`,
  `bot-detection-analyze`, `anti-cheat-analysis` — and they share no import
  beyond `./helpers`.
- The file dies **early and silently**: 589–703 ms, with none of its own tests
  reporting. The suite total drops by exactly that file's test count minus one,
  the one being the file-level failure itself.
- No stack, no assertion, and no stderr from the child.

**The mechanism was not captured.** A second bounded pass — twelve further full
runs under the TAP reporter, which prints the file-level failure's YAML block
instead of collapsing it to `'test failed'`, with a preload recording
`uncaughtException`, `unhandledRejection` and any non-zero exit — produced
**twelve clean runs and nothing to read**. Twelve was chosen because the
observed rate was about one run in five, which makes a dozen runs likely but not
certain to catch one; it did not, and the honest reading is that the diagnostic
either got unlucky or perturbed the timing. Post-fix totals across both passes
are eighteen runs with one signature B and no signature A.

Hypotheses examined and **refuted** with evidence:

- *Ephemeral-port exhaustion.* The range holds 13977 ports; TIME_WAIT during a
  run measured 113.
- *A `Promise.race` loser rejecting late becoming an unhandled rejection.*
  `Promise.race` subscribes to every promise it is given, so the loser's
  rejection is handled. Confirmed directly on Node v24.15.0.
- *An `after`/`afterEach` hook throwing.* The affected files use neither; they
  use per-test `try`/`finally`, and every `close()` is awaited.
- *A double `close()` rejecting.* Awaited inside a test's `finally`, such a
  throw would be attributed to that test with a stack, which is not the
  observed signature.

One instance of an uncaught `'error'` event on an `http.Server` **has since been
fixed** (§5): with that fix reverted, the regression test for it fails through
an uncaught `ERR_UNHANDLED_ERROR`. That made it a plausible contributor, but a
follow-up investigation (below) has since ruled it out as the mechanism behind
the observed signature specifically, even though it remained a real defect
worth fixing on its own merits.

### Follow-up investigation: the failure mode is characterized, the trigger is not

A later increment (`claude/node-test-signature-b`) instrumented selected
termination and error paths a child process can raise and captured three
further real occurrences directly, rather than reasoning from symptoms or
synthetic proxies alone.

**Node's test runner spawns one child process per test file.** Verified
directly: two trivial files run together under
`node --test --test-concurrency=1` report distinct PIDs, neither matching the
parent's. The flag-free PID run is the evidence for default per-file process
isolation on the tested Node version, while the explicit `--test-isolation=process`
flag demonstrates that process isolation can also be explicitly selected. This process
boundary proves that a terminating child does not directly abort sibling test processes
in the runner, though shared host resources can still interact across processes.

**The bare `'test failed'` with no stack and empty stderr is what Node's runner reports for a
child that calls `process.exit(1)` (or terminates silently) before registering any test.** This was reproduced directly: a synthetic file that calls
`process.exit(1)` before registering any test produces the identical reported
shape as the real defect — `✖ <file> (Nms)` / `'test failed'`, zero individual
tests in the summary, nothing on stderr. Every OTHER synthetic mechanism tried
produces a visibly different shape:

- An error thrown after a test's own promise settles (`setImmediate` inside a
  passing test) — Node prints an explicit
  `ℹ Error: ... generated asynchronous activity after the test ended ...`
  diagnostic line, and the triggering test still shows `✔`.
- An `http.Server` emitting `'error'` with its listener already removed —
  same diagnostic line, same visible `✔` on the test that created it.
- A promise rejected synchronously inside a test's own body — attributed to
  that specific test, with a full stack.
- A process killed by `SIGKILL` after a test completes — that test's `✔`
  still prints before the file dies.
- A synchronous throw at module load, before any `test()` call — prints a
  full stack trace to stderr.

None of these match. The real defect's log is completely silent before the
bare file-level failure: no diagnostic line, no stderr, no test names at all
for that file (not even the ones that would have run first).

**A diagnostic preload
(`packages/api/test/diagnostics/signature-b-preload.cjs`) captures which of
those mechanisms fire on real occurrences, not synthetic ones.** It hooks
`process.exit`, `process.abort`, `process.kill`, `uncaughtExceptionMonitor` (a passive observer
that captures both uncaught exceptions and fatal unhandled rejections without registering active
listeners that alter Node's default crash handling), `warning`, `beforeExit`, and Node's
own unconditional `exit` event, writing a structured, redacted, timestamped
line to disk (before delegation for `process.exit`, `process.abort`, and `process.kill`, and during event delivery for `uncaughtExceptionMonitor`, `warning`, `beforeExit`, and `exit`) — bypassing stdout/stderr entirely so the test
reporter's own output is never touched. A bounded 20-run instrumented pass over
the full `packages/api` suite (chosen the same way as the original 20-run
sample: enough for >90% detection odds at the historically observed ~1-in-5
rate) reproduced the defect 3 times, on **three files never previously
implicated** — `rate-limit-atomicity`, `dependency-parity`, `studies-api` — none
of the original four. Combined with the original four, that is **seven distinct files** observed with this symptom
to date. Occurrences across seven distinct files make a shared or cross-cutting path more
plausible and make a defect confined to one test file less likely, but do not exclude
file-specific inputs or lifecycle interactions.

All three historical captures show the identical signature: **only the `start` and
`preload-installed` lines were logged. None of the hooks active at that time fired —
including `process.exit`, `process.kill`, `uncaughtExceptionMonitor`, `warning`,
`beforeExit`, and Node's `exit` event.**
Crucially, however, the diagnostic preload in use during those historical runs did
not yet wrap `process.abort()`. Because `process.abort()` terminates the process
immediately without emitting Node's `exit` event, those historical captures directly
ruled out `process.exit`, uncaught exceptions, and fatal unhandled rejections, but
could not categorically exclude an uninstrumented `process.abort()` or an external termination.

**This narrows Signature B's investigated possibilities while leaving its root cause unresolved:**
`process.abort()` is now instrumented so any future occurrence will record whether an abort
was invoked through JS; an absent record narrows in-runtime JS termination but cannot alone
prove external termination without corroborating child exit status/signal data or OS-level
evidence (e.g. distinguishing an external kill or uncatchable signal from a native C++/V8 crash).
Two observations remain consistent with an
environmental (not code) origin: at the time of capture this development machine had roughly
2.5 GB of 15.7 GB RAM free, with several unrelated concurrent processes (other agents' worktrees
and dev servers) running; and `node --test` spawns dozens of child processes across a full
`packages/api` run, each loading the same large cross-package import graph, which is exactly the
pattern most exposed to transient resource contention. Neither observation is proof of a specific
external actor — no crash was recorded in the Windows Application or System event logs in the
capture window — so the exact trigger (OS scheduler, memory pressure, antivirus, or something
else entirely) is not established.

**No fix is proposed.** The investigated JS mechanisms (`process.exit`, exceptions, rejections)
have been ruled out on the historical captures, `process.abort()` instrumentation is in place for
future occurrences, and the forbidden responses — sleeps, retries around the whole file,
swallowing errors, lowering concurrency to hide it — would suppress the symptom without touching
whatever the root cause turns out to be. Signature B stays open and unresolved. The diagnostic
preload is committed so the next occurrence — on this machine, in CI, or elsewhere — can be
captured with selected termination and error path instrumentation rather than re-deriving it.

### Follow-up: the parent knew the exit status all along, and `spec` was discarding it

The investigation above ends inside the child, because the child stops writing. This increment
crossed to the other side of the process boundary and found the missing evidence was never missing —
it was being thrown away by the reporter.

Node's runner already computes it. `internal/test_runner/runner.js` waits on the child's `exit`
event and, when the child failed, builds the error the file-level failure is reported through:

```js
if (code !== 0 || signal !== null) {
  if (!err) {
    const failureType = subtest.failedSubtests ? kSubtestsFailed : kTestCodeFailure;
    err = ObjectAssign(new ERR_TEST_FAILURE('test failed', failureType), {
      __proto__: null, exitCode: code, signal: signal, stack: undefined });
  }
  throw err;
}
```

**The `spec` reporter discards `exitCode` and `signal`.** `formatError` in
`internal/test_runner/reporter/utils.js` does `const err = error.code === 'ERR_TEST_FAILURE' ? error.cause : error`,
and `cause` is the bare string `'test failed'` — so every own property of the error, the exit status
included, is dropped before anything is printed. That is the whole reason this failure has looked
information-free for three increments. **The built-in `tap` reporter does not discard them:** its
`jsToYaml` walks the error's own enumerable properties and skips only `cause` and `code`, so
`exitCode` and `signal` land in its YAML block.

Both reporters can run at once, which is what makes this usable rather than a trade:

```sh
node --require ./test/diagnostics/signature-b-preload.cjs \
     --test-reporter=spec --test-reporter-destination=stdout \
     --test-reporter=tap  --test-reporter-destination=<file> \
     --test --test-concurrency=1 "dist-test/test/**/*.test.js"
```

Human-facing stdout is unchanged, the exit status is captured to a file, no custom reporter is
written and no Node internal is patched — which matters, because the last attempt to observe this
system by patching `EventEmitter.prototype.emit` crashed the parent runner. The earlier TAP-only
pass recorded above would have shown these fields had it caught an occurrence; it captured nothing,
so nobody read them.

**Exit codes were measured on this platform rather than assumed** (Windows 11, Node v24.15.0):

| Mechanism | `exitCode` | `signal` | How it was measured |
|---|---|---|---|
| `process.exit(1)` before any test registers | `1` | `null` | run under the runner, read from the TAP block |
| `process.abort()` | `134` | `null` | same; also prints a native + JS stack to stderr |
| `taskkill /F /PID` | `1` | `null` | spawned a sleeper, killed it, read `child.on('exit')` |
| `Stop-Process -Force` | `4294967295` | `null` | same |
| `process.kill(pid)` | `1` | `null` | same |
| `STATUS_ACCESS_VIOLATION` | `3221225477` | `null` | not reproduced here; NTSTATUS `0xC0000005` surfaced as a raw unsigned 32-bit value |

Two consequences follow, and the second is the one that keeps the analysis honest.

- **A native fault or a V8 fatal error is now nameable as a candidate.** `134` and `0xC0000005`
  name a specific mechanism — but naming is not proving. An exit status is a 32-bit integer the
  terminating party chooses, and `TerminateProcess(h, 0xC0000005)` produces the same number as a
  real access violation, so the status is the strongest candidate rather than proof.
  `signature-b-correlate.cjs` reports these as `specific` rather than `conclusive`, and confirmation
  has to come from the child log, the enumerated fatal stderr markers, or OS evidence.
  **Membership of the `0xC0000000` range is not itself a native-fault finding**, and an earlier
  draft of this section said otherwise: `STATUS_CONTROL_C_EXIT` (`0xC000013A`) is a console CTRL+C
  and sits in the same range. Codes the measured table covers name a candidate; a value in the range
  that it does not cover is reported `ntstatus-unmeasured` and non-specific, rather than assumed to
  be a crash.
- **Exit code `1` identifies nothing.** An uncaught exception, `process.exit(1)`, `taskkill /F` and
  `process.kill` all produce `1` with `signal: null`, because Windows has no POSIX signals and libuv
  reports one only when the parent's own handle did the killing. Reading `1` as proof of an external
  kill would be a wrong answer, and `signature-b-correlate.cjs` classifies it as `inconclusive`.

What rescues `1` is the child-side log, which is why the two sides are correlated rather than read
separately: `process.exit(1)` and an uncaught exception both leave a record and both fire Node's
`exit` event, so a child that reached `preload-installed` and then logged **nothing** cannot have
died either way. `packages/api/test/diagnostics/signature-b-correlate.cjs` joins the parent's TAP
record to the child's JSONL log on the test file path — the preload records `testFile` on every
line, which also yields the child's PID — and emits one record per failure carrying both views, the
classification, and an explicit statement of what the pair does and does not establish.

**Bounded pass: 20 runs, 0 captures.** Ceiling declared before starting at 20 full
`packages/api` runs or 45 minutes, stopping at the first capture; 20 runs at ~28s each
were executed and Signature B did not occur. That is not a fix and is not evidence of one. It bounds
the rate and nothing else: **treating the historically observed ~1-in-5 as an independent per-run
rate, zero captures in 20 runs has probability `(4/5)^20 ≈ 1.2%`** — small, but ordinary bad luck is
not excluded, and independence is an assumption here rather than something this data establishes. One difference from the capture conditions is
worth recording without being leaned on — this pass ran with 3084–3834 MB free of
16 GB, where the three historical captures happened at roughly 2.5 GB free with several other agents'
processes running. That is *consistent with* the standing resource-contention hypothesis and is not
evidence for it; nothing here establishes a causal link, and the hypothesis stays untested.

**Signature B remains UNRESOLVED.** No fix is proposed and none is disguised: no sleep, no retry, no
lowered concurrency, no excluded file. What changed is that the next occurrence is readable. A
capture now yields the child's PID, which JS lifecycle paths it did or did not run, and the exit
status the parent observed. Whether that status names anything depends on the status: a mapped code
names a **candidate** mechanism, while a bare `1`, a signal — which names the signal that killed the
child but never the party that sent it — and any code outside the measured table are all reported
`specific: false` and name nothing on their own.

## 5. `ApiServer.listen` rejects on a failed bind

Raised by the Qodo review of PR #21 and **valid**. `packages/api/src/server.ts`
built its promise as `new Promise((resolve) => …)` — no reject path — and
attached no `'error'` listener to the server. A bind that fails asynchronously
(`EADDRINUSE`, `EMFILE`) therefore did two bad things at once: the promise never
settled, and the `'error'` event, having no handler anywhere, was re-raised as an
uncaught exception.

That is a defect on its own, and it also made §2's contract false. Retrying can
only be bounded and diagnosable if the listener it is handed reports failure;
`listenOnFetchablePort` would otherwise sit forever inside `await listen(...)`,
never reaching its own attempt ceiling.

The fix attaches a one-shot `'error'` listener that rejects, and removes it once
the server is listening. Removing it matters: leaving it attached would let a
`reject` on an already-settled promise silently swallow later server errors,
which would be a quieter regression than the one being fixed. Post-listen errors
therefore keep exactly the semantics they had before.

This is a production change in an increment otherwise scoped to test helpers.
It is included rather than deferred because the contract this ADR publishes is
not true without it, it is three lines, and it strictly strengthens behaviour —
before, a failed bind hung and crashed; after, it rejects.
