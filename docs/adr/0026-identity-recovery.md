# 26. Identity Recovery

Date: 2026-07-19

## Status

Accepted

## Context

We need to provide users a secure way to recover forgotten passwords and to verify their email addresses. This is the first step in the M4 Identity Hardening milestone.

To send an email (either for password reset or email verification), the platform must have access to the user's plaintext email address. Previously (in `0001_init.sql`), we stored only `email_hash` (a SHA-256 hash of the normalized email) to maximize privacy. We now must introduce a mechanism to store the plaintext email address and to securely issue single-use recovery tokens.

## Decision

1. **Email Storage**: We will add a nullable `email CITEXT` column to the `users` table, which will be populated during registration. It will have a `UNIQUE` constraint (enforced where not null). 
    - *Privacy Tradeoff*: We are now explicitly storing users' plaintext email addresses. This is necessary to support outbound messaging. The `email_hash` will remain as a fallback identifier and for backward compatibility. Existing users without a plaintext email will not be able to use password recovery until they update their account with an email.
2. **Token Design**: We will use opaque, 256-bit random tokens, stored only as SHA-256 hashes in a new `identity_tokens` table.
    - Tokens are single-use, guaranteed by an atomic `UPDATE ... SET used_at = now() WHERE ... AND used_at IS NULL` operation in Postgres.
    - Tokens are TTL-bound: 30 minutes for password reset (`password_reset`), and 24 hours for email verification (`email_verify`).
    - The `kind` of token is enforced by a `CHECK` constraint (lookup style), avoiding native Postgres ENUMs per our database guidelines.
3. **Email Sending Port**: We define an `EmailSender` port with `sendPasswordReset` and `sendEmailVerification`.
    - We provide an `InMemoryEmailSender` for tests and a `ConsoleEmailSender` as the production default until a real email provider integration is built. No third-party dependencies (like `nodemailer`) are introduced at this stage.

## Consequences

- **Pros**:
    - Users can now recover accounts and verify emails securely.
    - Opaque, hashed tokens mean that even a database dump does not compromise active recovery links.
    - Atomic consumption eliminates race conditions (e.g. double-clicking a link).
- **Cons**:
    - We lose the pure-hash privacy guarantee for email addresses, bringing the platform in line with standard identity providers.
