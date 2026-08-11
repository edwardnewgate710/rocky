# 109. Password-Recovery Web UI

Date: 2026-08-11

## Status

Accepted

## Context

M14 Increment 45 delivers the password-recovery web UI in `@chess-platform/web` over the existing M4 REST server contracts (`POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`). Backend endpoints and token design (opaque 256-bit single-use 30-minute tokens with SHA-256 store) were established in ADR-0026. The web client requires typed endpoint bindings, routing, request/reset forms, strict secret token secrecy, loading and error state management, session clearance on password change, and full test coverage.

## Decision

1. **Typed Web Client & Request Contracts**:
   - `packages/web/src/api/models.ts` exports `PasswordResetRequest` (`{ handleOrEmail: string }`) and `PasswordResetConfirmRequest` (`{ token: string, newPassword: string }`).
   - `AuthApi` in `packages/web/src/api/client.ts` exposes `requestPasswordReset(body)` and `confirmPasswordReset(body)` without backend contract modifications.

2. **SPA Routing & Discoverability**:
   - `packages/web/src/app/router.ts` introduces `{ name: 'password-reset', token: string | null }`.
   - `/password-reset` displays the account request form. `/password-reset?token=...` displays the new password reset form.
   - `#auth-form` on the signed-out auth surface carries a discoverable "Forgot password?" link (`#auth-forgot-password`).

3. **Form Orchestration & Anti-Enumeration Guarantees**:
   - Managed by pure, DOM-free `PasswordResetController` with callbacks (`onPending`, `onError`, `onSuccess`, `onSessionInvalidated`).
   - Request form returns generic success copy ("If an account matching that handle or email address exists, we have sent instructions to reset your password.") to prevent handle/email enumeration.
   - Reset form enforces client-side password length validation (8..1024 characters) and matching password confirmation.
   - In-flight operations disable submit controls and set `aria-busy="true"`. Concurrent submissions are blocked via an `isSubmitting` guard. Late async completions are guarded via `requestGeneration` checks and `dispose()`.

4. **Session Invalidation & Token Secrecy**:
   - Reset tokens are treated as secrets: never logged and never rendered in the DOM or HTML attributes.
   - When mounting `/password-reset?token=...`, the token is captured into memory and stripped from the visible URL bar via `history.replaceState(null, '', '/password-reset')` before any background network calls run, preventing token leakage in `Referer` headers.
   - Successful password reset confirmation (204) revokes sessions backend-side and clears the refresh cookie; `onSessionInvalidated` calls `auth.clearLocalSession()` to reset in-memory and storage session states, updating the UI topbar to "Not signed in".

5. **Lifecycle & Accessibility**:
   - Integrated into `BootstrappedDisposables` and `DISPOSABLE_TEARDOWN_MAP` in `lifecycle.ts` for clean SPA route teardown.
   - Reuses existing `.auth`, `.auth-form`, `.auth-field`, `.auth-actions`, and `.auth-meta` styling without adding new CSS frameworks or colors.
   - Preserves `>=16px` input font sizing and `>=44px` target sizing for mobile (390x844) without horizontal overflow.
   - Employs semantic headings (`<h2 id="password-reset-heading">`), labels (`for="..."`), and ARIA live regions (`role="status"` and `role="alert"`).

## Consequences

- **Pros**:
  - Full client-side password recovery flow for requesting links and setting new passwords.
  - Strict anti-enumeration and secret token hygiene (URL query parameter stripping and memory-only token retention).
  - Clean local session invalidation on password reset completion.
  - Zero backend drift and zero new CSS/dependency overhead.
- **Cons**:
  - Outbound production email delivery remains deployment/provider-dependent (`ConsoleEmailSender` default per ADR-0026). Real email delivery requires a production email provider integration.
