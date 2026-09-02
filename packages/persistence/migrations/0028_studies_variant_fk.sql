-- Migration 0028: Restore the canonical variant catalog and install its closed domain constraint.

INSERT INTO variants (code, name) VALUES
    ('standard',      'Standard'),
    ('chess960',      'Chess960'),
    ('kingofthehill', 'King of the Hill'),
    ('atomic',        'Atomic'),
    ('crazyhouse',    'Crazyhouse'),
    ('threecheck',    'Three-check'),
    ('horde',         'Horde'),
    ('racingkings',   'Racing Kings')
ON CONFLICT (code) DO NOTHING;

-- NOT VALID closes the domain for new writes immediately while deferring the legacy-row scan.
ALTER TABLE variants
    ADD CONSTRAINT variants_code_check
    CHECK (code IN (
        'standard',
        'chess960',
        'kingofthehill',
        'atomic',
        'crazyhouse',
        'threecheck',
        'horde',
        'racingkings'
    )) NOT VALID;
