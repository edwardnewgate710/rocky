-- Migration 0007 — Identity hardening (M4 increment 1)
-- See docs/adr/0026-identity-recovery.md

ALTER TABLE users ADD COLUMN email CITEXT UNIQUE;
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

CREATE TABLE identity_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('password_reset', 'email_verify')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
