# 108. WebAuthn Passkeys Real Browser Web Flow

Date: 2026-08-09

## Status

Accepted

## Context

M14 Increment 44 delivers the client-side WebAuthn passkey authentication and management surface in `@chess-platform/web`. While the server API for WebAuthn endpoints was published earlier in M4, real browser flows require specific browser ceremony handling, discoverable credentials, session adoption, and account security management in the SPA.

## Decision

1. **Server Contract Alignment for Discoverable Credentials**:
   - `generateWebAuthnRegisterOptions` sets `authenticatorSelection.residentKey = 'required'`. This forces browser authenticators to save a discoverable credential (passkey).
   - `WebAuthnLoginOptions` returns challenge and verification requirements without returning an `allowCredentials` list, maintaining anti-enumeration guarantees while allowing native browser passkey selection.
   - OpenAPI schema in `@chess-platform/api` is updated and validated with 0 spec drift.

2. **Typed Web API Surface**:
   - `AuthApi` exposes `listPasskeys()`, `deletePasskey(id)`, `registerPasskeyOptions()`, `verifyPasskeyRegister(body)`, `loginPasskeyOptions(body)`, and `verifyPasskeyLogin(body)`.
   - `verifyPasskeyLogin` passes `credentials: 'include'` for httpOnly refresh cookies and adopts the returned `AuthResponse` session into `SessionManager`.

3. **Injectable Browser WebAuthn Adapter**:
   - `NativeWebAuthnAdapter` wraps `PublicKeyCredential.parseCreationOptionsFromJSON`, `navigator.credentials.create`, `PublicKeyCredential.parseRequestOptionsFromJSON`, `navigator.credentials.get`, and `credential.toJSON()`.
   - Features zero runtime dependencies, robust type guards, and preserves server JSON structure without mutating opaque handles or credential IDs.

4. **Sign-In Surface Integration**:
   - `#auth-passkey` button ("Sign in with passkey") allows one-touch sign-in using the handle field without requiring a password.
   - Session adoption persists session metadata (`{ handle, userId }`) without storing tokens in Web Storage.
   - Surfacing a generic `'Sign in with passkey failed'` error copy prevents account existence leakage.

5. **Self-Profile Account Security Surface**:
   - `#passkeys-self` on `/profile` provides passkey list, registration ("Add passkey"), and deletion actions.
   - Built with the standard `.panel-list`/`.panel-row` two-child structure: a label span followed by `.panel-row-actions`.
   - Managed by DOM-free `PasskeysController` with request generation counters, stale load guards, lifecycle disposal, and complete cleanup on sign-out.

## Consequences

- **Pros**:
  - Native browser ceremony and API wiring for passkey registration and sign-in, with the platform boundary covered by automated adapter tests.
  - Phishing-resistant passkey authentication available on both sign-in and profile surfaces.
  - Stale loads, multi-account disclosures, and token persistence anti-patterns strictly prevented.
- **Cons**:
  - Requires browser WebAuthn Level 3 JSON helper support (`parseCreationOptionsFromJSON` / `toJSON`). Older non-standard browsers fall back to an explicit unsupported error message.
  - A live authenticator still requires a supported browser in a valid secure-context deployment; this increment does not claim a hardware-backed deployment test.
