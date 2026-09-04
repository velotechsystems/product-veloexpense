-- ════════════════════════════════════════════════════════════════════════════
-- VX4-8 part 1 / UD-8 — does approval post to the ledger, or does AP send it?
--
-- Upstream commit `836af348` is not a defect fix. Their AP lead asked for
-- "posting to manually sit with AP", and the answer was a per-installation
-- setting with two values. The reasoning is worth keeping verbatim, because it
-- is the whole argument for the default chosen below:
--
--     "a report parked in a queue is recoverable; a wrong posting in a general
--      ledger is a journal entry and a conversation."
--
-- Ours has posted on APPROVED unconditionally since VX3-4. John's call, 4 Sep:
-- make it a per-org setting, and make the SAFE value the default — but only for
-- organizations created from here on.
--
-- ── THE TWO-STATEMENT DEFAULT, WHICH IS THE DECISION ITSELF ─────────────────
--
-- `ADD COLUMN … DEFAULT 'AUTOMATIC'` fills every EXISTING row with AUTOMATIC.
-- `ALTER COLUMN … SET DEFAULT 'AP_QUEUE'` then changes what a FUTURE row gets.
--
-- Two statements rather than one because they are two different decisions, and
-- collapsing them would make exactly the mistake this migration exists to avoid:
-- a single `DEFAULT 'AP_QUEUE'` would silently stop posting for every tenant
-- already running, on the day this deploys, with nothing on any screen saying so.
-- A tenant whose finance team has posted on approval for months would find their
-- ledger quietly empty and their queue quietly full. The safe default is for
-- people who have not chosen yet; it is not a decision to make on behalf of
-- people who already did.
--
-- Same shape as 0021's absence-means-off and 0023's NULL-means-default-palette:
-- what a new tenant gets and what an existing tenant has are not the same fact.
--
-- ── WHY `HELD` IS A QUEUE STATUS AND NOT AN ABSENT ROW ──────────────────────
--
-- The obvious implementation of AP_QUEUE is to withhold the enqueue: no row
-- until somebody sends it. That was rejected for two reasons.
--
-- 1. IT BREAKS AC-7. `lib/integrations/post-outbox.ts` opens by stating that the
--    enqueue is "a row in the approving transaction… a row in the same
--    transaction cannot be lost, so the trade is not needed and neither is the
--    30-minute cron sweep that compensates for it". The record that this report
--    is destined for the ledger should exist from the moment of approval whether
--    or not a person has released it yet.
--
-- 2. IT CREATES A SECOND SOURCE OF TRUTH. `/admin/ledger-queue` lists queue
--    rows. With no row, "approved and waiting for AP" would have to come from a
--    second query over reports, and the screen would be showing the union of two
--    lists that can disagree. AC-14's `glAccountId IS NULL` control is what that
--    looks like when it goes wrong.
--
-- So a HELD row exists, is listed, and is not claimable. **It is invisible to the
-- poller by the DATABASE's rule rather than by a query remembering to exclude
-- it**: `0017`'s `platform_read` policy matches `status IN ('PENDING','FAILED')`
-- and the partial index behind it does the same, so a HELD row cannot be reached
-- through `withPlatformRead` at all. `claimPost`'s own `status IN
-- ('PENDING','FAILED')` is then a second, independent guard. Neither had to be
-- edited by this migration, which is the point of having written them that way.
-- ════════════════════════════════════════════════════════════════════════════

-- ── the setting ─────────────────────────────────────────────────────────────

-- Step 1: every EXISTING organization keeps posting on approval. Nothing changes
-- underneath a tenant that is already running.
ALTER TABLE organization
    ADD COLUMN posting_trigger text NOT NULL DEFAULT 'AUTOMATIC';

-- Step 2: every FUTURE organization holds for AP. See the header.
ALTER TABLE organization
    ALTER COLUMN posting_trigger SET DEFAULT 'AP_QUEUE';

-- This list is a SECOND COPY of the `PostingTrigger` union in
-- `lib/integrations/post-outbox.ts`, and 0027's note applies unchanged: a CHECK
-- cannot read a TypeScript type, so the copy is made SAFE rather than avoided.
-- `test/posting-trigger.db.test.ts` reads this constraint's own definition back
-- out of `pg_get_constraintdef` and asserts it equals the union exactly, in both
-- directions — so adding a value on either side alone fails.
ALTER TABLE organization
    ADD CONSTRAINT organization_posting_trigger_known
        CHECK (posting_trigger IN ('AP_QUEUE', 'AUTOMATIC'));

COMMENT ON COLUMN organization.posting_trigger IS
    'AUTOMATIC: reaching APPROVED enqueues the post as PENDING and the poller sends it. '
    'AP_QUEUE: the row is enqueued HELD instead, and a person releases it from '
    '/admin/ledger-queue. New organizations default to AP_QUEUE; organizations that '
    'existed before migration 0030 were backfilled to AUTOMATIC. UD-8.';

-- ── the queue status ────────────────────────────────────────────────────────

-- Postgres has no ADD VALUE for a CHECK, so the constraint is replaced. Dropping
-- and re-adding in one transaction (the runner wraps each migration) means no
-- window in which the column is unconstrained.
ALTER TABLE integration_post
    DROP CONSTRAINT integration_post_status_chk;

ALTER TABLE integration_post
    ADD CONSTRAINT integration_post_status_chk CHECK (
        status IN ('PENDING', 'POSTED', 'FAILED', 'DEAD', 'CANCELLED', 'NEEDS_REVIEW', 'HELD')
    );

-- The other two CHECKs on this table already say the right thing about HELD and
-- were deliberately not touched: `integration_post_posted_chk` requires
-- `posted_at IS NULL` for anything that is not POSTED, and the external_id CHECK
-- allows one only for POSTED and NEEDS_REVIEW. A HELD row has never been sent, so
-- both hold by construction.

COMMENT ON COLUMN integration_post.status IS
    'PENDING/FAILED are due work — and are the ONLY statuses 0017''s platform_read '
    'policy matches, so every other status is invisible to the poller by the '
    'database''s own rule. POSTED is terminal and successful. DEAD is out of '
    'attempts. NEEDS_REVIEW means the ledger accepted it and recording that failed '
    '— never retried automatically. CANCELLED is an operator withholding it. HELD '
    '(0030) means the organization posts on AP_QUEUE and nobody has released this '
    'one yet: not a failure, not a decision against posting, just not yet sent.';
