# ADR-0126 — Production identity email uses one bounded Resend transport

| Field      | Value                                      |
|------------|--------------------------------------------|
| **Status** | Accepted                                   |
| **Date**   | 2026-08-21                                 |
| **Scope**  | `packages/api`, Helm/deployment configuration |

---

## Context

ADR-0026 introduced password-reset and email-verification tokens behind an `EmailSender` port, but
the Postgres composition root silently defaulted to `ConsoleEmailSender`. That sender printed the
recipient and raw token. Production therefore had no real delivery transport and put live bearer-
like recovery capabilities into container logs.

Reset requests also awaited delivery. A provider timeout or rejection could make an existing
account return a different response from a missing account. Registration had a different failure:
the account transaction committed first, then a delivery rejection returned 500, leaving a real
account behind an apparent failed registration with no resend path.

## Decision

### One production transport

Production uses Resend's fixed HTTPS send-email endpoint through the built-in `fetch`; no SDK and
no second provider abstraction are added. The adapter follows Resend's documented
[send-email request](https://resend.com/docs/api-reference/emails/send-email) and uses a SHA-256-
derived [idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys) that contains
neither the raw token nor recipient address. Requests have a configurable 5-second default timeout
bounded to 30 seconds, redirects are refused, success requires a non-empty provider message id,
and error response bodies are never parsed or surfaced.

`EMAIL_PROVIDER` is mandatory. `console` is allowed only when explicitly selected outside
`NODE_ENV=production`; its output now states only that a development delivery was suppressed.
Production requires `resend`, `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_WEB_ORIGIN`, and startup
fails before serving if any are absent or invalid. Helm production accepts `RESEND_API_KEY` only
through an existing Secret or External Secrets Operator reference; the chart has no inline provider
credential value. The chart also has no fake production sender/origin defaults: the deployment
workflow supplies `EMAIL_FROM` and `PUBLIC_WEB_ORIGIN` from the selected GitHub Environment and
fails before Helm when either is absent.

### One trusted origin and no token observability

`PUBLIC_WEB_ORIGIN` must be an absolute HTTP(S) origin with no userinfo, path, query, or fragment;
production requires HTTPS. It is the only origin used for both links:

- `/password-reset#token=...`
- `/email-verify#token=...`

The encoded token appears only inside the message body. It is never supplied to a logger, metric
label, provider error, or separate plaintext field. Recipient addresses and completed URLs follow
the same rule. Telemetry is limited to purpose (`password_reset` / `email_verify`), bounded outcome,
and latency.

Registration validates an optional address with the same single-mailbox syntax used as transport
defense in depth. A malformed address is rejected before an account or token is created, matching
the email-formatted OpenAPI contract rather than creating an account that cannot receive its link.

### Request and token lifecycle

The API commits token state, starts best-effort delivery, and does not await provider I/O on the
HTTP request path. Password-reset requests therefore retain the same 202 status, empty body, and
shape for existing and missing accounts, including provider failure. Registration remains 201 once
the account and verification token exist; provider errors never roll back or mask that account.

An authenticated, rate-limited `POST /v1/auth/email/verification/request` gives that user a recovery
path. It accepts no user id. Issuing either a replacement verification token or password-reset token
atomically marks earlier unused tokens of that user and kind used before storing the new hash. The
Postgres adapter locks the stable user row, so concurrent requests leave exactly one replacement
usable. Verification consumption takes that same lock and atomically marks the user verified;
replacement issuance checks the verification marker while holding it. A successful verification
and a concurrent resend therefore cannot both win and leave a new token for an already verified
account. Raw tokens remain 256 random bits, SHA-256-only at rest, one-time on consumption, and
expire after the ADR-0026 durations.

There is no automatic retry loop. A durable outbox would close the small process-crash window
between committing a token and starting delivery, but it would add queue ownership, retry policy,
dead-letter handling, and raw-message lifecycle. That infrastructure is deferred; authenticated
verification resend and the existing repeatable reset request are the bounded recovery mechanisms.

## Consequences

- Production cannot become healthy while silently suppressing identity email.
- Provider latency and failures cannot become a reset-account existence oracle or apparent failed
  registration.
- Provider failures are diagnosable through bounded counters/histograms without token or recipient
  data.
- Tests use fake/local transports and never send real email.
- Durable delivery/outbox infrastructure, multiple providers, marketing email, preferences, and
  generic notifications remain out of scope.
