-- Migration 0029: Validate studies_variant_fk constraint without blocking concurrent writes

ALTER TABLE studies
    VALIDATE CONSTRAINT studies_variant_fk;
