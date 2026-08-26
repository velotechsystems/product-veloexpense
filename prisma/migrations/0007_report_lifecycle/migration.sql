-- VeloExpense 0007 — report lifecycle audit (VX1-8).
--
-- One NEW tenant table, so it takes the full treatment: organization_id + org
-- index + ENABLE/FORCE RLS + tenant_isolation (NULLIF form), and an entry in
-- test/rls-isolation.test.ts (CI's RLS-coverage guard fails otherwise).
--
-- Phase 1 only performs SUBMIT and RECALL, but the CHECK already admits the
-- Phase-2 approval transitions so the approval engine needs no migration to
-- start writing history. The expense_report_status enum from 0003 already has
-- the destination states.

CREATE TABLE expense_report_event (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    report_id       uuid NOT NULL REFERENCES expense_report(id) ON DELETE CASCADE,
    action          text NOT NULL,
    from_status     expense_report_status NOT NULL,
    to_status       expense_report_status NOT NULL,
    -- Who did it. Kept even after the employee is deactivated (app_user rows
    -- are soft-deleted), so the trail never loses its actor.
    actor_id        uuid NOT NULL REFERENCES app_user(id),
    note            text,
    -- Snapshot of what was true at the moment of the transition: the report
    -- total, and the violation counts that the gate saw. A later rule change
    -- must not be able to rewrite the history of why a submit was allowed.
    context         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- clock_timestamp(), NOT now(): now() returns the TRANSACTION start time, so
    -- two transitions written in one transaction (submit then recall, or a
    -- Phase-2 approve-and-reimburse) would share a timestamp and the history
    -- would come back in arbitrary order. clock_timestamp() is the real clock.
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT expense_report_event_action_check
        CHECK (action IN ('SUBMIT', 'RECALL', 'APPROVE', 'REJECT', 'RETURN', 'REIMBURSE'))
);
CREATE INDEX expense_report_event_org_id_idx ON expense_report_event (organization_id);
CREATE INDEX expense_report_event_report_idx ON expense_report_event (report_id, created_at);
ALTER TABLE expense_report_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_report_event FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_report_event
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
