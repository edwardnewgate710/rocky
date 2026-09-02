-- Migration 0030: Replace the duplicated studies.variant CHECK with the canonical catalog FK.

ALTER TABLE studies
    ADD CONSTRAINT studies_variant_fk
    FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;

ALTER TABLE studies
    DROP CONSTRAINT studies_variant_check;
