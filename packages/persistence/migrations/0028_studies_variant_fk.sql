-- Migration 0028: Replace studies.variant CHECK constraint with FOREIGN KEY referencing variants(code)

ALTER TABLE studies
    DROP CONSTRAINT studies_variant_check;

ALTER TABLE studies
    ADD CONSTRAINT studies_variant_fk
    FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;
