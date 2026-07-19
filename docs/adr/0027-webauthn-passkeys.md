# 27. WebAuthn and Passkeys

Date: 2026-07-19

## Status

Accepted

## Context

We are implementing WebAuthn (passkeys) support as part of the M4 Identity Hardening milestone to provide phishing-resistant, seamless authentication.

WebAuthn involves parsing binary CBOR and COSE data structures. Many implementations pull in large dependencies (e.g., `@simplewebauthn`) which violates this repository's strict "zero runtime dependencies" domain constraint. We need a way to support WebAuthn securely while maintaining our dependency posture, minimal attack surface, and deployment simplicity.

## Decision

1. **Zero New Runtime Dependencies**:
   We will not use third-party libraries for WebAuthn processing. We will implement a minimal custom parser for the exact CBOR and COSE subsets we need, using only the native `node:crypto` module.
   - **CBOR Decoder**: We implement a minimal recursive descent parser that decodes only the types strictly present in WebAuthn attestation objects (unsigned/negative ints, byte strings, text strings, arrays, and maps). We reject floats, tags, indefinite lengths, and anything else. The decoder enforces a hard input size limit (4 KiB) and a recursion depth cap (e.g., 10 levels) to prevent Resource Exhaustion (DoS).
   - **COSE Keys**: We support **ES256 ONLY** (kty EC2, alg ES256, crv P-256). We extract the `x` and `y` coordinates from the COSE map and construct a JWK format key for `node:crypto` to use. Registration requests asserting other algorithms (like RS256) will be explicitly rejected as unsupported.
   - **Signature Verification**: WebAuthn assertions return DER-encoded ECDSA signatures. Since `node:crypto` natively accepts DER format for signature verification, we pass it directly without converting to raw `r||s`.

2. **Attestation Policy "none"**:
   We will request and enforce an attestation policy of `'none'`.
   - *Tradeoff*: We parse the `attestationObject` solely to extract the `authData` (credential ID and COSE public key), but we **do not** verify the attestation statement or the provenance of the authenticator.
   - *Justification*: Our threat model focuses on authenticating the user (possession of the passkey), not restricting which hardware/software authenticators they are allowed to use. This matches mainstream consumer applications.

3. **DB-Backed Single-Use Challenges**:
   We will reuse the `identity_tokens` machinery introduced in M4 inc 1 to issue and verify WebAuthn challenges.
   - Challenges are 32 random bytes, stored as a SHA-256 hash in `identity_tokens` via `identityTokens.create` with a 5-minute TTL.
   - The token type is enforced via the `kind` constraint (`webauthn_register`, `webauthn_login`).
   - For login, the challenge row's `user_id` is the target user. For unknown handles, we use a decoy flow.
   - The token is atomically consumed on verify. Replayed challenges naturally fail.

4. **Anti-Enumeration on Login (Decoy Flow)**:
   To prevent handle enumeration on the `login/options` endpoint, we must return an indistinguishable response regardless of whether the user exists or has passkeys.
   - For a handle with no account or no passkeys, we generate a **decoy** `allowCredentials` list containing exactly one credential ID.
   - This credential ID is derived deterministically: `HMAC-SHA256(accessTokenSecret, 'webauthn-decoy:' + lowercased handle)`.
   - The determinism ensures that repeated requests for the same handle return the same fake credential ID, mimicking a real account.
   - Attempting to verify this decoy will result in a 401 Unauthorized, identical to a valid user presenting a bad signature.

5. **Sign Count Tracking**:
   We persist the authenticator's `signCount` to detect cloned passkeys.
   - If the stored count > 0 and the asserted count <= stored count, we reject the login, audit `auth.webauthn.clone_suspected`, and **do not** update the stored count.

## Consequences

- **Pros**:
  - The core API remains dependency-free, small, and easily auditable.
  - Phishing-resistant authentication is available to users.
  - User privacy is maintained by not strictly validating authenticator attestation models.
- **Cons**:
  - We must maintain the minimal CBOR/COSE parsing logic ourselves.
  - Users with non-ES256 authenticators (e.g., some older hardware tokens that only support RS256) will be unable to register them. Given that ES256 is nearly universal in modern passkeys (Apple, Android, Windows Hello), this is acceptable.
