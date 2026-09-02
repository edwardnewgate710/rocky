-- Migration 0031: Validate the studies.variant foreign key after its non-blocking installation.

ALTER TABLE studies
    VALIDATE CONSTRAINT studies_variant_fk;
