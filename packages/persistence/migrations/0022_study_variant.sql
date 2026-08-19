-- Variant is study-wide: every chapter, imported game and appended move uses the same rule set.
-- The default keeps pre-migration rows and old application instances valid during rollout.
ALTER TABLE studies
    ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
    CHECK (variant IN (
        'standard',
        'chess960',
        'kingofthehill',
        'atomic',
        'crazyhouse',
        'threecheck',
        'horde',
        'racingkings'
    ));
