-- VeloExpense 0017_integration_post — VX3-4.
--
-- One tenant table: what has been handed to a ledger, what failed, what to retry.
--
-- ── Why a second outbox and not a second use of the first ────────────────────
--
-- GAP-AUDIT AC-7's advice was "do not build a queue", and the substance of it is
-- honoured: the retry POLICY lives in `lib/outbox/policy.ts` and both outboxes
-- import it, so nobody has to learn two sets of backoff semantics. What is NOT
-- shared is the table, because a mail delivery and a ledger post differ in payload,
-- in terminal states, and in who reads the admin screen — and merging them would
-- put a migration on working notification machinery into the same PR as the first
-- real adapter.
--
-- ── The state AC-8 exists to make impossible ─────────────────────────────────
--
-- ExpenseOS posts in two phases and its own comment states the invariant: "The
-- record now EXISTS in NetSuite, so a failure here must NOT leave a re-postable
-- FAILED row." Then the catch on that phase writes exactly that — `status:
-- 'FAILED'`, `attempts + 1`, and the words "do NOT re-post" in `lastError` — and
-- their sweep selects `status notIn (SYNCED, DENIED, RECONCILED) AND attempts < 5`,
-- so the row is re-posted automatically up to five times with the instruction
-- sitting in its error column, addressed to a human and enforced against nobody.
--
-- `NEEDS_REVIEW` is that state, named, and no automatic path selects it. It means
-- "the ledger accepted this and we failed to write down that it did": the money
-- side is done, the bookkeeping side is not, and only a person may decide which.
--
-- Worth recording that VeloLedger makes this much less likely than NetSuite did:
-- `draft_bill` takes an `idempotencyKey`, namespaced per API key server-side, so a
-- genuine double-send is refused at the far end. AC-8's NetSuite equivalent was
-- `externalId` uniqueness asserted by no test, in a transport whose own header says
-- "UNVERIFIED against a live account". We keep the state anyway: a guard that
-- depends on the other system behaving is not the guard.

-- ── First: the UNIQUEs the composite foreign keys below need ────────────────
-- BEFORE the table. `0016` learned this the hard way: a composite FK is validated
-- when the table is created, and Postgres refuses with "there is no unique
-- constraint matching given keys for referenced table" if the key does not exist
-- yet. Neither ALTER changes how its table behaves; both are enablers, and VX3-10
-- needs them anyway for the FKs that already point at these tables.
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE integration_installation
    ADD CONSTRAINT integration_installation_org_id_uniq UNIQUE (organization_id, id);

CREATE TABLE integration_post (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    report_id        uuid NOT NULL,
    -- Which connection it went to. Kept even after a disconnect, so the history
    -- says where a report was sent rather than merely that it was sent.
    installation_id  uuid,
    status           text NOT NULL DEFAULT 'PENDING',
    attempts         int  NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- The visibility timeout, same idiom as `notification_delivery`.
    claimed_at       timestamptz,
    claimed_by       text,
    -- Verbatim from the adapter. Shown to an operator, so it must be a sentence.
    last_error       text,
    -- What the ledger called it. Null until it accepts one.
    external_id      text,
    -- Sent to the ledger so a retry cannot double-post at the far end. Stable for
    -- the life of the row: regenerating it on retry would defeat the point.
    idempotency_key  text NOT NULL,
    posted_at        timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- ONE POST PER REPORT. The whole duplicate-payment class of bug starts with a
    -- second row for one report, so it is unrepresentable rather than guarded.
    UNIQUE (organization_id, report_id),

    CONSTRAINT integration_post_status_chk CHECK (
        status IN ('PENDING', 'POSTED', 'FAILED', 'DEAD', 'CANCELLED', 'NEEDS_REVIEW')
    ),
    -- POSTED is the only status that may carry a posted_at, and it must.
    CONSTRAINT integration_post_posted_chk CHECK ((status = 'POSTED') = (posted_at IS NOT NULL)),
    -- An external id means the ledger accepted it, which is true of exactly two
    -- states: POSTED, and NEEDS_REVIEW (accepted upstream, unrecorded here).
    CONSTRAINT integration_post_external_chk CHECK (
        external_id IS NULL OR status IN ('POSTED', 'NEEDS_REVIEW')
    ),
    -- Composite, per TN-1. `0016` added the UNIQUE these need.
    CONSTRAINT integration_post_report_fkey
        FOREIGN KEY (organization_id, report_id)
        REFERENCES expense_report (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT integration_post_installation_fkey
        FOREIGN KEY (organization_id, installation_id)
        REFERENCES integration_installation (organization_id, id)
        ON DELETE SET NULL (installation_id)
);

CREATE INDEX integration_post_org_id_idx ON integration_post (organization_id);
-- The poller's read: due work, oldest first. Partial, because a drained queue is
-- the normal state and scanning POSTED rows forever is not.
CREATE INDEX integration_post_due_idx ON integration_post (next_attempt_at)
    WHERE status IN ('PENDING', 'FAILED');
CREATE UNIQUE INDEX integration_post_external_id_key
    ON integration_post (organization_id, external_id)
    WHERE external_id IS NOT NULL;

ALTER TABLE integration_post ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_post FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_post
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- The poller reads across tenants to find due work, exactly as `0012` does for
-- notification deliveries. Narrowed the same way: SELECT only, due rows only,
-- transaction-local flag, reached only through `withPlatformRead`.
CREATE POLICY platform_read ON integration_post
    FOR SELECT
    USING (NULLIF(current_setting('app.platform_task', true), '') = 'on'
           AND status IN ('PENDING', 'FAILED')
           AND next_attempt_at <= clock_timestamp());

COMMENT ON COLUMN integration_post.status IS
    'PENDING/FAILED are retryable; POSTED and CANCELLED are terminal; DEAD is out '
    'of attempts and needs a human; NEEDS_REVIEW means the ledger ACCEPTED it and '
    'recording that locally failed — no automatic path may retry it (GAP-AUDIT AC-8).';
