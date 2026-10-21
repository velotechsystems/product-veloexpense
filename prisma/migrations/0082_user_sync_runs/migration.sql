-- eos batch 4 (#582): ExpenseOS's people-sync run reports, ported (67db2e33, migration
-- 20261014150000_user_sync_runs), and its one-external-id-per-source rule
-- (20261014160000_user_external_id_one_per_source), which the Google directory sync v2
-- relies on: a person carries at most one `google` id, and sign-in and the sync read "the" one.
--
-- A run is a `user_sync_run`: opened before any work (it is also the per-kind run LOCK),
-- heart-beaten while it works, closed with its totals. Each person a run created, changed,
-- linked, refused or failed on is a `user_sync_run_item`, with the fields' from/to. The audit
-- log keeps the hash-chained summary of each run; these tables keep the per-person detail an
-- admin needs to see what a run did. Pruned after 90 days by the `userSyncRun.prune` job.
--
-- VeloExpense differences, as for the other ports:
--   · both tables are per tenant (RLS, composite tenant FKs, 0019), and the lock is per
--     tenant: one live run per KIND PER TENANT;
--   · ExpenseOS's three Postgres enums are text under CHECKs listing its values. The kind
--     lists GOOGLE_DIRECTORY only: VeloExpense has no NetSuite (d80), so NETSUITE_EMPLOYEES
--     is not a value anything here can write. The item outcomes are ExpenseOS's full list —
--     the NetSuite ones included — so a later port does not need a migration to widen it;
--   · ExpenseOS's `UserSyncDiscrepancy` table, which #583 drops, never existed here.
--
-- DATA: the run tables are new and empty. The external-id rule DELETES duplicate rows — a
-- person holding two ids from ONE source — keeping each person's newest (latest created_at,
-- then id), as ExpenseOS does. It runs once per tenant with `app.current_org` set, because
-- user_external_id is under FORCE RLS and the migration login is its owner, not a superuser:
-- a plain DELETE with no tenant set would delete nothing (f08) and the unique index below
-- would then fail on the duplicates it left. Check first:
--
--   SELECT x.organization_id, x.user_id, s.code, array_agg(x.source_value ORDER BY x.created_at)
--   FROM user_external_id x JOIN external_id_source s ON s.id = x.source_id
--   GROUP BY 1, 2, 3 HAVING count(*) > 1;
--
-- No audit rows are written for the deleted duplicates: the audit log is hash-chained, and
-- rows hand-written in SQL could break chain verification.

-- ── A run ──────────────────────────────────────────────────────────────────
CREATE TABLE user_sync_run (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    kind            text NOT NULL,
    -- 'cron' | 'manual' — what started it.
    trigger         text NOT NULL,
    dry_run         boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'RUNNING',
    -- The BullMQ job id, so a stalled job delivered again takes its own run over.
    job_id          text,
    actor_id        uuid,
    counts          jsonb NOT NULL DEFAULT '{}',
    message         text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    heartbeat_at    timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    CONSTRAINT user_sync_run_kind CHECK (kind IN ('GOOGLE_DIRECTORY')),
    CONSTRAINT user_sync_run_status
      CHECK (status IN ('RUNNING', 'COMPLETED', 'DISABLED', 'ERROR', 'CANCELLED')),
    UNIQUE (organization_id, id),
    CONSTRAINT user_sync_run_actor_fkey
      FOREIGN KEY (organization_id, actor_id)
      REFERENCES app_user (organization_id, id) ON DELETE SET NULL (actor_id)
);
CREATE INDEX user_sync_run_kind_started_idx ON user_sync_run (organization_id, kind, started_at);
CREATE INDEX user_sync_run_status_idx ON user_sync_run (organization_id, status);
ALTER TABLE user_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sync_run FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_sync_run
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── What a run did to one person ───────────────────────────────────────────
CREATE TABLE user_sync_run_item (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Null for a standalone item (ExpenseOS's edit-triggered NetSuite push); the Google sync
    -- always files against a run.
    run_id          uuid,
    kind            text NOT NULL,
    user_id         uuid,
    -- The outside id the item is about — the Google Directory user id.
    external_ref    text,
    outcome         text NOT NULL,
    -- Field → { from, to }.
    fields          jsonb NOT NULL DEFAULT '{}',
    message         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_sync_run_item_kind CHECK (kind IN ('GOOGLE_DIRECTORY')),
    CONSTRAINT user_sync_run_item_outcome CHECK (outcome IN (
      'CREATED', 'UPDATED', 'LINKED', 'CONFLICT', 'SKIPPED', 'DEFERRED', 'PUSHED', 'FAILED',
      'UNMATCHED', 'AMBIGUOUS', 'ERROR')),
    UNIQUE (organization_id, id),
    CONSTRAINT user_sync_run_item_run_fkey
      FOREIGN KEY (organization_id, run_id)
      REFERENCES user_sync_run (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT user_sync_run_item_user_fkey
      FOREIGN KEY (organization_id, user_id)
      REFERENCES app_user (organization_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX user_sync_run_item_run_idx ON user_sync_run_item (run_id);
CREATE INDEX user_sync_run_item_user_created_idx ON user_sync_run_item (user_id, created_at);
CREATE INDEX user_sync_run_item_kind_created_idx
    ON user_sync_run_item (organization_id, kind, created_at);
ALTER TABLE user_sync_run_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sync_run_item FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_sync_run_item
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── One external id per person per source ──────────────────────────────────
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    DELETE FROM user_external_id x
    USING (
      SELECT id,
             row_number() OVER (
               PARTITION BY user_id, source_id
               ORDER BY created_at DESC, id DESC
             ) AS rank
      FROM user_external_id
      WHERE organization_id = org
    ) ranked
    WHERE x.id = ranked.id AND ranked.rank > 1;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;

CREATE UNIQUE INDEX user_external_id_user_source_key ON user_external_id (user_id, source_id);
