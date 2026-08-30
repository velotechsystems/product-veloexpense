-- VeloExpense 0018_account_pull — VX3-5.
--
-- Two columns and a widened key. No new table, and the absence of one is a
-- decision — see the note on sync runs at the bottom.
--
-- ── Keeping two promises `0014` made in comments ─────────────────────────────
--
-- 1. "One external account maps to at most one local row. Correct while a tenant
--    has one connected ledger … when a second installation becomes possible this
--    widens to include the installation id." VX3-3 made installations real, so it
--    widens now. GAP-AUDIT AC-12 is the reason it matters: ExpenseOS's seven
--    reference caches are keyed `netsuiteId @unique`, install-global, with no
--    tenant or installation column — so that schema cannot hold two ledgers side
--    by side at all, which is precisely what the Plan's exit criterion asks for.
-- 2. `source = 'PULLED'` carries an `external_id`; the reverse was deliberately
--    not asserted so that VX3-5 could adopt a TEMPLATE row by stamping one. That
--    is what `lib/accounts/pull.ts` now does.

-- Which connection an account came from. NULL for TEMPLATE, IMPORT and MANUAL
-- rows, which came from nobody.
ALTER TABLE gl_account ADD COLUMN installation_id uuid;

-- ── last_seen_at, and what it is for ────────────────────────────────────────
--
-- Stamped every time a pull sees the account. Its VALUE is not interesting; what
-- matters is which rows a completed pull did NOT touch, because those are the
-- accounts the ledger no longer reports. AC-12: ExpenseOS deactivates exactly
-- those — "rows no longer present upstream are marked isActive = false (never
-- hard-deleted…)" — and the never-hard-deleted half is the part worth copying,
-- because a line's `gl_account_id` is a SNAPSHOT and a snapshot that can vanish is
-- not one.
--
-- VeloExpense does NOT deactivate them automatically. That was settled when VX3-1
-- chose the reconcile strategy: unmatched on either side is surfaced for a human,
-- never silently resolved. A tenant whose ledger stops reporting an account it has
-- been coding to for a year should be told, not have its categories quietly
-- unmapped by a background job.
ALTER TABLE gl_account ADD COLUMN last_seen_at timestamptz;

ALTER TABLE gl_account
    ADD CONSTRAINT gl_account_installation_fkey
    FOREIGN KEY (organization_id, installation_id)
    REFERENCES integration_installation (organization_id, id)
    ON DELETE SET NULL (installation_id);

-- An external id is only meaningful with the installation that issued it.
ALTER TABLE gl_account
    ADD CONSTRAINT gl_account_pulled_has_installation_chk
    CHECK (external_id IS NULL OR installation_id IS NOT NULL);

-- ── A constraint `0014` wrote that VX3-5 invalidates ────────────────────────
--
-- `0014` asserted "TEMPLATE is the only source that names a template, and it must
-- name one":
--
--     CHECK ((source = 'TEMPLATE') = (source_template IS NOT NULL))
--
-- True when it was written, and false the moment adoption exists: a row
-- instantiated from a template and then CONFIRMED BY THE LEDGER becomes
-- `source = 'PULLED'` while still, factually, having come from that template. The
-- first version of `pull.ts` hit this constraint on the adoption path — the
-- central behaviour of this ticket — and a test found it.
--
-- Relaxed rather than dropped, and provenance is KEPT rather than cleared. "This
-- account came from the na-expense-claims template and the ledger now confirms it"
-- is worth more than a tidier constraint, and clearing the column to satisfy the
-- old rule would have destroyed information to preserve an assumption that had
-- stopped being true.
ALTER TABLE gl_account DROP CONSTRAINT gl_account_source_template_chk;
ALTER TABLE gl_account
    ADD CONSTRAINT gl_account_source_template_chk CHECK (
        -- A template row must name its template.
        (source <> 'TEMPLATE' OR source_template IS NOT NULL)
        -- And only a row that came from one may name one: TEMPLATE, or a TEMPLATE
        -- row the ledger has since adopted.
        AND (source_template IS NULL OR source IN ('TEMPLATE', 'PULLED'))
    );

DROP INDEX gl_account_external_id_key;
CREATE UNIQUE INDEX gl_account_external_id_key
    ON gl_account (organization_id, installation_id, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX gl_account_installation_idx ON gl_account (organization_id, installation_id)
    WHERE installation_id IS NOT NULL;

COMMENT ON COLUMN gl_account.last_seen_at IS
    'When a pull last reported this account. A NULL or stale value on a PULLED row '
    'means the ledger has stopped reporting it — surfaced to an admin, never acted '
    'on automatically (GAP-AUDIT AC-12).';

-- ── NO sync-run table, and that is the lesson rather than an omission ────────
--
-- ExpenseOS has `NetSuiteSyncRun`: states RUNNING/COMPLETED/ERROR/DISABLED/
-- CANCELLED, cooperative cancel, `updatedAt` as a heartbeat, and a ten-minute
-- stale-run reclaim. That reclaim exists because of a measured incident, and their
-- comment is the whole argument: "one dead run wedges every future sync forever
-- with 'already running' — which once froze the reference cache for ~3 weeks."
--
-- The reclaim is a fix for a LOCK. A pull here is triggered by an admin pressing a
-- button, is one HTTP call and one transaction, and holds no lock — so there is no
-- run to wedge, and nothing to reclaim. Their machinery is the right answer to a
-- scheduled background sync; if VeloExpense ever adds one, this comment is where
-- to start, and the heartbeat reclaim is the part to bring.
