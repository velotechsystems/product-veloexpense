-- 0041 — the per-tenant export ledger.
--
-- VX5-12. A tenant admin asks for their whole dataset; a job builds two archives
-- and puts them in object storage; the admin downloads them for a while and then
-- cannot. This table is the request, the state and the receipt.
--
-- ── WHY A TABLE AND NOT JUST A DOWNLOAD ────────────────────────────────────
--
-- The obvious shape is a route that streams a ZIP in the response, and it is
-- wrong for three separate reasons, each of which this table answers:
--
--   1. IT CANNOT BE BOUNDED. `audit_entry` grows for the life of the tenant and
--      is never pruned (the retention policy does not exist — VX5-14). A request
--      that reads it whole, compresses it, and holds the socket open is a
--      request with no time limit, behind whatever proxy timeout production has.
--   2. THERE IS NOTHING TO ASK ABOUT AFTERWARDS. "Did my export work" is the
--      first question anybody has, and a streamed response leaves no row to look
--      at. `row_counts` is here so the answer is a number per file rather than a
--      shrug.
--   3. A LEGAL DELIVERABLE SHOULD LEAVE A TRAIL. Who asked, when, and what they
--      got. Not for the tenant's benefit — for ours, the first time somebody
--      claims they never received one.
--
-- ── WHAT `expires_at` IS FOR, AND WHY IT IS NOT NULLABLE ──────────────────
--
-- An export is a single file containing every expense, every approver decision
-- and every employee's name and email a tenant has. Left in a bucket forever it
-- is the highest-value object this product stores, and it is the one nobody is
-- watching.
--
-- So every export expires, and `expires_at` is NOT NULL so that "forever" cannot
-- be expressed. A purge deletes the storage objects and stamps `purged_at`; the
-- ROW survives, because the trail is the point and a deleted row answers no
-- questions. `status` then reads EXPIRED, which is a different sentence from
-- "never existed".
--
-- ── AND WHY THERE IS NO PLATFORM HATCH ────────────────────────────────────
--
-- Same reasoning as `subscription_meter_reading` (0038). The purge fans out per
-- tenant with `app.current_org` set, so nothing ever needs to see across
-- tenants. A hatch here would be a cross-tenant read of the one table that
-- points at every tenant's complete dataset.

CREATE TABLE tenant_export (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),

    -- WHO asked. Not nullable: an export nobody requested is not a state this
    -- product should be able to represent.
    --
    -- The FK is COMPOSITE, declared at the bottom of the table — TN-1, and
    -- `test/tenant-fk.db.test.ts` caught the single-column version I wrote
    -- first. A plain `REFERENCES app_user(id)` is checked by Postgres with RLS
    -- BYPASSED, so it would accept another tenant's user id: an export
    -- attributed to somebody who does not work there. Going through
    -- `(organization_id, id)` makes that unrepresentable rather than merely
    -- unlikely.
    requested_by_id  uuid NOT NULL,

    status           text NOT NULL DEFAULT 'PENDING',

    -- The two archives. Separate because receipts dominate size by orders of
    -- magnitude, and bundling them makes the deliverable a regulator asks for
    -- hostage to the one they do not.
    --
    -- Both nullable: they do not exist until the job has written them, and a
    -- FAILED export has neither. `files_key` stays null when the tenant has no
    -- receipts at all, which is a legitimate outcome rather than a failure.
    data_key         text,
    files_key        text,
    data_bytes       bigint,
    files_bytes      bigint,

    -- One count per file, as {"expenses.csv": 1421, …}. This is what makes the
    -- export CHECKABLE: a customer can compare a number here against the screen
    -- they are looking at, which no amount of "the export succeeded" achieves.
    row_counts       jsonb,

    -- The diagnostic when status = 'FAILED'. For a person reading the ledger,
    -- not for a screen — the screen says the export failed and offers to retry.
    error            text,

    requested_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at       timestamptz,
    completed_at     timestamptz,

    -- See the header. NOT NULL so that "keeps forever" is unrepresentable.
    expires_at       timestamptz NOT NULL,
    -- When the objects were actually deleted. Distinct from `expires_at`: one is
    -- a promise, the other is what happened, and an export whose expiry passed
    -- but whose bytes are still in the bucket is precisely the state worth being
    -- able to find.
    purged_at        timestamptz,

    CONSTRAINT tenant_export_status_check
        CHECK (status IN ('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
    -- A READY export has to have something to download. Without this, a bug that
    -- marks completion before uploading produces a row that says "ready" and a
    -- screen with a dead button.
    CONSTRAINT tenant_export_ready_has_data
        CHECK (status <> 'READY' OR data_key IS NOT NULL),
    -- And a FAILED one has to say why. `error` is how anybody finds out what
    -- went wrong; a failure with no reason is a support ticket by construction.
    CONSTRAINT tenant_export_failed_has_reason
        CHECK (status <> 'FAILED' OR error IS NOT NULL),
    CONSTRAINT tenant_export_expiry_after_request
        CHECK (expires_at > requested_at),

    -- TN-1. See the comment on `requested_by_id`. ON DELETE RESTRICT rather than
    -- CASCADE: an export row is the trail, and deactivating the person who asked
    -- for one must not delete the record that they did. (Employees are
    -- soft-deleted here anyway, so this should never fire — which is the right
    -- state for a RESTRICT to be in.)
    CONSTRAINT tenant_export_requested_by_fkey
        FOREIGN KEY (organization_id, requested_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);

-- The screen's query: this tenant's exports, newest first.
CREATE INDEX tenant_export_org_requested_idx
    ON tenant_export (organization_id, requested_at DESC);

-- ONE RUNNING EXPORT PER TENANT.
--
-- Not a nicety. An export is the most expensive read this product can perform,
-- and the button that starts one is on a screen — so the failure mode is a
-- person clicking it four times because the first click showed no feedback, and
-- four full-dataset reads running at once against the same connection pool.
-- A partial unique index says no in the database rather than in a handler that
-- the next caller forgets.
CREATE UNIQUE INDEX tenant_export_one_in_flight_idx
    ON tenant_export (organization_id)
    WHERE status IN ('PENDING', 'RUNNING');

-- The purge's query, across tenants but always under one `app.current_org`:
-- exports whose promise has passed and whose bytes are still there.
CREATE INDEX tenant_export_due_purge_idx
    ON tenant_export (expires_at)
    WHERE purged_at IS NULL;

ALTER TABLE tenant_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_export FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_export
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON TABLE tenant_export IS
    'VX5-12 per-tenant data export requests. One row per request; the archives live in '
    'object storage under data_key/files_key and are deleted at expires_at while the row '
    'survives as the trail.';
