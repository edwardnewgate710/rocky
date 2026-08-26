-- Accepted work has crossed an ambiguous charge/provider boundary. Exhausted records release the
-- session while permanently preventing the same turn intent from being purchased again.
ALTER TABLE study_partner_turn_requests
    DROP CONSTRAINT study_partner_turn_requests_status_check;

ALTER TABLE study_partner_turn_requests
    ADD CONSTRAINT study_partner_turn_requests_status_check
    CHECK (status IN ('claimed', 'accepted', 'succeeded', 'failed', 'exhausted'));
