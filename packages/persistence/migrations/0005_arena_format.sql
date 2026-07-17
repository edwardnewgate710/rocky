-- Add 'arena' format to tournaments format check
ALTER TABLE tournaments DROP CONSTRAINT tournaments_format_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_format_check CHECK (format IN ('round_robin', 'swiss', 'arena'));
