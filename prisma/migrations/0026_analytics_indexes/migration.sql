-- ════════════════════════════════════════════════════════════════════════════
-- 0026 — THE INDEXES ANALYTICS ACTUALLY SCANS (VX4-6a, GAP-AUDIT AN-10)
--
-- No new tables and no new columns: analytics reads what the expense loop already
-- writes. What it needs is the one thing AN-10 says their schema lacks.
--
-- ── AN-10, checked against OUR schema and true here too ─────────────────────
--
-- The finding is "`Expense` has no index on `date`", and the consequence there is
-- that a dashboard with no bounded range aggregates all history on every login.
-- Before writing this file I checked ours rather than assuming the audit
-- transferred: `expense` carries exactly `expense_org_id_idx (organization_id)`
-- and `expense_report_id_idx (report_id)` from `0003`. There is no index on
-- `txn_date` at all. Same gap, different codebase.
--
-- The other half of AN-10 is fixed in code, not here: `lib/analytics/service.ts`
-- REFUSES an unbounded range rather than defaulting to one, so there is no call
-- this index has to make fast for all history.
--
-- ── Why (organization_id, txn_date) and not (txn_date) ──────────────────────
--
-- Every analytics query is per tenant by construction — RLS adds
-- `organization_id = <current org>` to the predicate below the query, which is
-- what makes AN-2/3/5/9's whole class impossible here. So the leading column is
-- the one every scan already filters on, and the date is the range. An index on
-- `txn_date` alone would be a worse version of this for every caller.
--
-- `txn_date` is NULLABLE, and analytics attributes an undated expense by
-- `created_at` — the same expression `lib/budgets/service.ts` uses, for the same
-- reason (deterministic and immutable, where `current_date` would make a total
-- change overnight). So the index carries created_at too: without it a report
-- whose expenses are all undated falls back to a column the index cannot serve,
-- which is the case most likely to exist in bulk after an import.
CREATE INDEX expense_txn_date_idx
    ON expense (organization_id, txn_date, created_at);

-- The status filter is the other half of every spend query: only SUBMITTED,
-- APPROVED and REIMBURSED count (`lib/spend/statuses.ts`), which on a mature
-- tenant is most rows — so this exists to serve the JOIN back from `expense`
-- rather than to be selective on its own.
--
-- `0024` already added `expense_report_department_idx (organization_id,
-- department_id, status)` for the budget rollup. This is the same table from the
-- other direction: analytics groups by several dimensions and needs the status
-- and the currency without a heap fetch per row.
CREATE INDEX expense_report_spend_idx
    ON expense_report (organization_id, status)
    INCLUDE (currency_code, department_id, business_unit_id, submitter_id);

COMMENT ON INDEX expense_txn_date_idx IS
    'VX4-6a / AN-10. Analytics ranges scan by tenant and date; before this the '
    'only indexes on expense were organization_id and report_id. created_at is '
    'included because an undated expense is attributed by it.';
