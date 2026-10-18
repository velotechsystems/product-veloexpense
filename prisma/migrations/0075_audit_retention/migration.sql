-- w5-07 — audit retention, per tenant, and what the last purge did (decided 17 Oct 2026, d82).
--
-- ExpenseOS keeps one platform-wide retention window (the `auditRetentionYears` SystemFlag,
-- default 7, floor 7: SOX) and records the last purge in another flag (`auditPurgeWatermark`:
-- the newest purged row's id and hash, how many rows went, when). VeloExpense's chain is per
-- tenant (0010), so both are per tenant, on the tenant row — following 0010's watermark
-- columns, for 0010's reason: `organization` is already the tenant row, and a table would be a
-- new RLS surface for a few scalars.
--
-- NULL retention means "the floor", as ExpenseOS's absent flag does — and the screen says so
-- ("7 years because nobody chose" and "7 years chosen" are different facts to an auditor).
ALTER TABLE organization
    ADD COLUMN audit_retention_years      integer,
    ADD COLUMN audit_retention_updated_at timestamptz,
    -- The last purge run: how many rows it removed and when. The sequence and hash it purged
    -- through are 0010's `audit_purged_through_sequence` / `audit_purged_head_hash`.
    ADD COLUMN audit_purged_count         integer,
    ADD COLUMN audit_purged_at            timestamptz;

ALTER TABLE organization
    -- ExpenseOS's router bounds: never below the SOX floor, and not absurdly long.
    ADD CONSTRAINT organization_audit_retention_bounds
        CHECK (audit_retention_years IS NULL OR audit_retention_years BETWEEN 7 AND 50),
    ADD CONSTRAINT organization_audit_purge_run_complete
        CHECK ((audit_purged_count IS NULL) = (audit_purged_at IS NULL));
