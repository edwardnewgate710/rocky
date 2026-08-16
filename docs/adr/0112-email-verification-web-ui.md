# 112. Email-Verification Web UI

Date: 2026-08-16

Design mode: **Operate** — the visitor is completing a task an email link handed to them, so being
unambiguous about which of the four outcomes they landed in, and staying consistent with the
password-recovery surface this mirrors, outrank expression. See `packages/web/CLAUDE.md`.

## Status

Accepted

## Context

M14 Increment 48 delivers the email-verification web UI in `@chess-platform/web` over server contracts
that already existed and are unchanged by this increment: `POST /v1/auth/email/verify` in
`packages/api/src/routes.ts`, and the optional `email` field on the register request. `AuthService`
in `packages/api/src/auth/service.ts` issues a 256-bit verification token at registration, stores only
its SHA-256 hash with a 24-hour expiry, and consumes it atomically on verification — answering `401`
for a token that is invalid, expired, or already used.

Until this increment that half of the identity surface was unreachable from a browser: there was no
way to supply an email address at registration, and no page that could act on a verification link.
The web client therefore needs a typed endpoint binding, a public route that accepts the link, strict
secrecy for the token it carries, an accessible surface for the four outcomes, and route-lifetime
guarantees consistent with ADR-0092.

The shape follows ADR-0109 (password recovery) deliberately. That flow solved the same problem — a
secret arriving on a public SPA route from a link the visitor clicked in an email — and a second,
differently-shaped solution to it would be the drift worth avoiding. Building this increment on that
shape surfaced a flaw in it, which §4 corrects for both flows at once rather than for this one only.

## Decision

1. **Typed web client and request contract**
   - `packages/web/src/api/models.ts` exports `EmailVerifyRequest` (`{ token: string }`).
   - `AuthApi.verifyEmail(body)` in `packages/web/src/api/client.ts` issues
     `POST /v1/auth/email/verify` with that body and **no** `credentials: 'include'` and no bearer
     auth. The endpoint is public, sets no cookie, and must not carry or mutate the caller's session;
     a test asserts the absence of credentials so a later "consistency" edit cannot quietly attach one.
   - No API, OpenAPI, or backend token semantics changed.

2. **Optional email on the existing registration surface**
   - `packages/web/index.html` adds one optional `.auth-field` (`#auth-email`,
     `type="email"`, `autocomplete="email"`, `maxlength="320"`, not `required`) to the existing
     combined auth form.
   - `AuthController.register(handle, password, email?)` trims the value and includes the `email` key
     **only** when the result is non-empty, so an email-less registration sends exactly the request it
     sent before.
   - **Sign-in is not gated by it.** The form now carries `novalidate`, and validation is driven per
     action instead: register calls `reportValidity()` on the whole form (so the browser checks the
     email), while sign-in calls `reportValidity()` on the handle and password inputs only. Without
     this, a malformed address left in an optional field would have blocked an existing user from
     signing in — a registration affordance breaking the primary path. Passkey sign-in is untouched
     and remains handle-only.

3. **Route and entry transport**
   - `packages/web/src/app/router.ts` adds `{ name: 'email-verify' }`; `/email-verify` is public and
     accepts an optional `#token=...` **only** as an entry transport. Any deeper path is `not-found`.
   - `packages/web/src/app/route-surface.ts` maps the route to the `#email-verify` surface, so the
     existing exhaustive visibility record forces every future route to make the same decision.
   - The ordinary auth form is hidden while the route is active, consistently with password recovery,
     for signed-in and signed-out visitors alike.

4. **Token secrecy and ordering — the fragment, not the query string**
   - **The token travels in the URL fragment (`#token=...`), and this increment moves
     `/password-reset` to the fragment with it.** ADR-0109 put the token in the query string, and
     that is not recoverable client-side: a query string is part of the request line, so
     `/password-reset?token=...` reached the web tier on the first navigation, before any script
     parsed. `docker/web/nginx.conf.template` sets no redacting `log_format`, so nginx's default
     kept a live credential in its access log, and `history.replaceState` cannot retract a request
     already made. A fragment is never transmitted — browsers keep it out of the request line and
     out of `Referer` — so the secret now reaches the client without having touched the server.
     Both flows moved together; leaving one on the query string would be exactly the drift this ADR
     set out to avoid. Nothing in the repository composed such a URL yet
     (`EmailSender.sendEmailVerification` in `packages/api/src/ports/email.ts` is handed a bare
     token), so no already-delivered link is invalidated — but any real provider added later **must**
     emit the fragment form.
   - `packages/web/src/app/bootstrap.ts` captures the token and clears the fragment with
     `history.replaceState` **before** app composition, the capabilities request, session restoration,
     or any other background request. The fragment never reached the server, so this protects what it
     *does* reach: the location bar, the history entry, and anything copied out of either. The
     mechanism is one helper shared with the password-reset route rather than two copies.
   - Reading a token from `location.search` is not merely unused but tested against: a bootstrap test
     drives `/email-verify?token=...` and asserts no verification request is issued, so a later
     "accept both" edit cannot quietly restore the exposure. Both e2e specs record *every* request the
     browser makes, navigation included, and assert none carries the token.
   - Within the client the token lives only in route-local memory: a `bootstrap` local, the mount's
     state object, and the request body. The client never renders it, logs it, persists it, or puts
     it in an attribute.
   - Error copy is fixed text. The transient-failure message never interpolates the caught error, so
     no server envelope, status, or request detail can echo the token into the DOM; a controller test
     drives a 500 whose server message deliberately contains the token and asserts the surface copy
     does not.
   - The server's hashed, 24-hour, atomic single-use behaviour is preserved and **not** duplicated
     client-side. The client re-states none of it and infers nothing from the token's contents.

5. **Controller, states, and retry**
   - `packages/web/src/app/email-verification-controller.ts` is a DOM-free `EmailVerificationController`
     with `onPending` / `onError` / `onSuccess` / `onRetryable` callbacks, mirroring
     `PasswordResetController`'s dual-generation guards.
   - Four outcomes: pending; success (204); invalid, expired, or already used (401); and transient
     failure. A missing token is reported without issuing any request.
   - Success and 401 are **terminal**: the controller refuses further work and the mount releases the
     token, so a consumed or rejected token cannot be replayed by the mounted route. Only a transient
     failure retains the token and offers `Try again`, and an in-flight guard means retries cannot stack.

6. **Lifecycle**
   - `packages/web/src/app/email-verification-mount.ts` owns the surface, binds the retry control by
     property assignment (the section is static markup that survives SPA re-bootstrap, so re-mounting
     cannot stack handlers), and exposes an idempotent `dispose()` that unbinds, disposes the
     controller, clears the token, and restores idle controls.
   - `emailVerification` is its own named field in `BootstrappedDisposables` and in
     `DISPOSABLE_TEARDOWN_MAP` in `packages/web/src/app/lifecycle.ts`, so ADR-0092's compile-time
     exhaustiveness covers it. No other route's disposable is borrowed and no route context or service
     locator was introduced.
   - A completion arriving after disposal invokes no callback and mutates no DOM.

7. **Design and accessibility**
   - The surface reuses `.auth`, `.auth-actions`, `.auth-meta`, `.error` and the existing status
     treatment. No new visual primitive, colour, radius, card, or gradient was added.
   - One scoped rule was added to `packages/web/src/style.css`: `#email-verify .auth-actions button`
     keeps the system's existing 44px touch target. The shared 44px rule lives inside
     `@media (pointer: coarse)`, which a narrow window on a mouse-driven machine does not match, and
     the retry control measured 36px there. Scoped rather than global, because widening every button
     in the app would be a redesign; a style-contract test asserts the rule so the regression is
     caught without depending on a browser run.
   - Semantic `<h2>` heading with `aria-labelledby`, a `role="status"` live region for progress and
     success, and a `role="alert"` region for failures.

## Consequences

- **Pros**
  - A visitor can supply an email at registration and complete verification from the link, with the
    four outcomes stated plainly and a controlled retry for transient failures.
  - The token never reaches the server as part of a URL at all, for either recovery flow, so no
    access log or intermediary can retain one; it is memory-only within the client and stripped from
    the location bar before any request; replay by the mounted route is structurally impossible after
    a terminal outcome.
  - Signed-in and signed-out visitors are both served, and the session is untouched either way.
  - Zero backend drift, zero new dependencies, and one scoped CSS rule.
- **Cons**
  - The link template is now load-bearing in a way it was not before: a provider that emits
    `?token=...` would silently fall back to the missing-link state rather than verifying, because the
    query string is deliberately not read. That is the safe failure direction — a broken link rather
    than a leaked credential — but it does mean whoever wires a real sender must use `#token=...`.
  - This increment changed a previously-shipped surface (`/password-reset`) to fix the transport it
    shared. That is wider than an increment of this size would normally reach, and was done because
    fixing only the new flow would have left the older one carrying live tokens into access logs
    while appearing, in the ADR record, to have been considered.
  - Real provider delivery and opening a link from an actual email client remain **release/manual QA**:
    `ConsoleEmailSender` in `packages/api/src/ports/email.ts` is still the default, so no automated
    gate exercises a delivered message end to end. Browser coverage in
    `packages/web/e2e/email-verification.spec.ts` mocks the endpoint; the real server contract is
    proven by the API suite.
  - There is no resend-verification affordance. A visitor whose 24-hour token expired must register a
    new address or wait for a later increment; that was left out deliberately to keep this increment
    to the smallest coherent slice.
  - Verification status is not surfaced anywhere in the UI, because no existing public model exposes
    it. Adding one would be an API change this increment does not make.
