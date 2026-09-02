-- Migration 0029: Reject unsupported legacy variant catalog rows before changing studies.

ALTER TABLE variants
    VALIDATE CONSTRAINT variants_code_check;
