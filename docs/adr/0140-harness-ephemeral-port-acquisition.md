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

The leading unrefuted hypothesis is a process-level fault in the test child
after module load and before the first test reports — a keep-alive socket to a
closed harness erroring inside undici's pool, or an uncaught `'error'` event on
an `http.Server`. **One instance of that second shape has now been fixed** (§5),
and it produces exactly this signature when it fires: with the fix reverted, the
regression test for it fails through an uncaught `ERR_UNHANDLED_ERROR` rather
than an assertion. That makes it a plausible contributor, but not a
demonstrated cause — signature B was reproduced on files doing no failing bind,
and it was never observed to coincide with one. It stays open.

Nothing above is strong enough to justify a fix, and a fix that cannot be shown
to remove a reproduction is indistinguishable from a coincidence. Signature B
stays open.

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
