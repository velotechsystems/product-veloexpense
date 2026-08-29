-- VeloExpense 0012 — outbound delivery (VX2-8, ExpenseOS Module 11's worker half).
--
-- TWO new tenant tables — `notification_delivery` and `action_token` — so each
-- takes the full treatment: organization_id + org-id index + ENABLE/FORCE ROW
-- LEVEL SECURITY + the tenant_isolation policy (NULLIF form), and both are added
-- to test/rls-isolation.test.ts. CI's RLS-coverage guard fails the build
-- otherwise.
--
-- Ported from ExpenseOS SOURCE, read 2026-08-29:
-- `packages/notifications/src/{actionTokens,email}.ts` and
-- `apps/worker/src/{notification-dispatch,channels}.ts`. Findings are
-- docs/porting/GAP-AUDIT.md NT-11, NT-12, NT-14, NT-17 through NT-21, and the
-- three decisions that shaped this file are in that file's second
-- "Decisions taken (2026-08-29, later)" table. Read those before changing
-- anything here.
--
-- ── The one divergence that matters ─────────────────────────────────────────
--
-- EXPENSEOS'S QUEUE IS BULLMQ ON REDIS. This is a Postgres outbox instead, and
-- the reason is the same one VX1-9 gave for choosing `s3rver` over MinIO —
-- "one Node process — no Docker for CI or a laptop". Redis would be a new
-- dependency of the image, of CI and of every developer machine, and the admin
-- queue screen would then read a datastore that is not RLS-scoped and is not
-- backed up alongside the database. What we give up is everything BullMQ hands
-- over free: the claim, the backoff, the visibility timeout and the
-- dead-lettering are all written by hand in lib/notifications/outbox.ts.
--
-- EMAIL ONLY. Slack and Teams are their own tickets (NT-20, NT-21). The
-- `channel` column still carries the full CHECK from `0011` so that adding one
-- is a code change rather than a migration.
--
-- ── The problem a poller has, and the hatch that solves it ──────────────────
--
-- A poller has no tenant. It has to find work in ANY tenant, and an approve-link
-- click arrives with a bare token and no session at all — so neither knows which
-- organization to set before reading.
--
-- `withoutOrg` DOES NOT SOLVE THIS, and believing it does is the trap. It still
-- connects as `veloapp`, which is subject to FORCE RLS, and with `app.current_org`
-- unset the policy body reads `organization_id = NULL`, which is NULL, which is
-- not true. An unset context therefore sees ZERO rows — that is a guarantee this
-- schema deliberately has, and `test/rls-isolation.test.ts` asserts it.
--
-- So each of these two tables carries a SECOND, NARROW policy, gated on its own
-- session flag `app.platform_task`, in the same spirit as `0010`'s single
-- `app.audit_purge` escape hatch. Three things keep it from being a hole:
--
--   1. `FOR SELECT` ONLY. Every write still requires a real `app.current_org`.
--      A platform task can therefore FIND a row and can never change one — it
--      must switch into the tenant to act, which is exactly the shape we want.
--   2. THE POLICY BODY IS NARROWED TO THE ROWS THE TASK NEEDS. The poller sees
--      only work that is due; the token handler sees only LIVE tokens. An
--      expired or consumed token is invisible to the hatch, so "reject an
--      expired token" stops being an `if` somebody could forget and becomes a
--      row that is not there.
--   3. `set_config(..., true)` — transaction-local, like `withOrg`. One helper
--      in `lib/tenant/context.ts` sets it, and it is used in exactly two places.
--
-- Everything either place takes from a row it found this way is the
-- `organization_id`. That constraint is the whole reason this is safe, and it is
-- easy to widen by accident.

-- ── notification_delivery ───────────────────────────────────────────────────
--
-- One row per (notification, channel) that something has to be DONE about.
-- IN_APP never appears here: it was delivered the moment `0011`'s notification
-- row was written, which is what "the always-on channel" means.
--
-- This table is three things at once and that is deliberate: the work queue, the
-- retry state, and the admin's answer to "did my approver get the email". A
-- separate log would drift from the queue it describes.
CREATE TABLE notification_delivery (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- CASCADE: a delivery is about a notification, and there is nothing to send
    -- once the notification is gone.
    notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    channel         text NOT NULL,
    -- PENDING  → waiting for a poller, at or after next_attempt_at
    -- SENT     → the transport accepted it. NOT "the human read it".
    -- FAILED   → the last attempt threw; will be retried while attempts < max
    -- DEAD     → out of attempts, or refused for a reason retrying cannot fix
    -- CANCELLED→ nothing to send after all (no address, channel turned off)
    status          text NOT NULL DEFAULT 'PENDING',
    attempts        integer NOT NULL DEFAULT 0,
    -- When a poller may pick this up. Set forward on failure — this column IS
    -- the backoff, so a failing send does not spin.
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- The VISIBILITY TIMEOUT, in two columns rather than a lock. A poller that
    -- dies mid-send leaves a row claimed forever unless something reclaims it,
    -- and `FOR UPDATE SKIP LOCKED` alone cannot help: the transaction that held
    -- the lock is gone, so the lock is gone with it, but `status` was already
    -- written. So the claim stamps `claimed_at` and a reclaim sweep releases
    -- anything stamped longer ago than the timeout.
    claimed_at      timestamptz,
    -- Which process holds it. Operational only; a name, not a guarantee.
    claimed_by      text,
    sent_at         timestamptz,
    -- The message the transport threw, verbatim and truncated by the app. This
    -- is the whole point of the admin screen: NT-11 records two ExpenseOS
    -- incidents where a non-delivery produced "no error, no log, no delivery",
    -- and a queue that cannot say WHY is the same failure with extra steps.
    last_error      text,
    -- Where it was sent, recorded at send time rather than joined at read time:
    -- an address can change, and "we emailed this person" has to keep meaning
    -- the address we actually used.
    destination     text,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_delivery_channel_check
        CHECK (channel IN ('IN_APP', 'EMAIL', 'SLACK')),
    -- IN_APP is delivered by the row existing in `notification`. A delivery row
    -- for it would be a job with nothing to do, forever PENDING, and it would
    -- make the admin queue's "N waiting" number a lie.
    CONSTRAINT notification_delivery_not_in_app CHECK (channel <> 'IN_APP'),
    CONSTRAINT notification_delivery_status_check
        CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'DEAD', 'CANCELLED')),
    CONSTRAINT notification_delivery_attempts_sane CHECK (attempts >= 0),
    -- SENT is the only status that may carry a sent_at, and it must.
    CONSTRAINT notification_delivery_sent_complete
        CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
    -- One job per notification per channel. Without it a retry that re-enqueued
    -- instead of updating would double-send, and a double-sent approval email
    -- means two approve links for one task.
    CONSTRAINT notification_delivery_one_per_channel UNIQUE (notification_id, channel)
);
CREATE INDEX notification_delivery_org_id_idx ON notification_delivery (organization_id);
-- THE POLLER'S INDEX, and the reason it is partial.
--
-- The claim query asks "the oldest due work, in any tenant" — it runs with the
-- service role because a poller has no tenant of its own (NT-19). Only PENDING
-- and FAILED rows are ever due, and in a healthy system those are almost none of
-- the table while SENT grows forever. A full index would be mostly SENT rows the
-- poller never reads.
--
-- No organization_id in the key: the poller deliberately scans ACROSS tenants,
-- and prefixing the tenant would make "oldest due work anywhere" a full scan of
-- the index instead of a range read of it.
--
-- NOT `FOR UPDATE SKIP LOCKED`, which is the usual answer and is the wrong one
-- here. The claim happens in a SEPARATE transaction from the scan — the send is
-- an SMTP round trip and holding a transaction open across it would pin a pooled
-- connection for the duration — so a row lock taken during the scan would be
-- released before the claim anyway. Instead the claim is a CONDITIONAL WRITE
-- (`WHERE id = $1 AND status IN (...) AND claim is free`) and the loser of a race
-- sees `rowCount = 0` and moves on. That is the same idiom as VX2-3's decision
-- claim and VX2-8's own token consume, which is worth more than a fourth
-- concurrency mechanism.
CREATE INDEX notification_delivery_due_idx
    ON notification_delivery (next_attempt_at)
    WHERE status IN ('PENDING', 'FAILED');
-- The admin screen: this tenant's queue, worst first.
CREATE INDEX notification_delivery_admin_idx
    ON notification_delivery (organization_id, status, created_at DESC);

ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_delivery
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
-- The poller's hatch: DUE WORK ONLY, and read-only. See the header.
--
-- Narrowed to PENDING/FAILED on purpose: a platform task can never read a
-- tenant's SENT history, which is the part of this table with a retention
-- question attached to it. Permissive policies are OR'd, so this widens SELECT
-- for a flagged session and changes nothing for a tenant session.
CREATE POLICY platform_read ON notification_delivery
    FOR SELECT
    USING (NULLIF(current_setting('app.platform_task', true), '') = 'on'
           AND status IN ('PENDING', 'FAILED'));

-- ── action_token ────────────────────────────────────────────────────────────
--
-- A single-use, expiring credential embedded in an email link so an approver can
-- decide without signing in.
--
-- READ THIS BEFORE CHANGING ANYTHING HERE. ExpenseOS's own header states the
-- property that makes the feature safe, and it is not obvious from the schema:
--
--     "The token only authenticates the actor and binds one action to one task;
--      the caller still re-runs canDecide + the atomic claim, so it never
--      bypasses authorization."
--
-- So this table AUTHENTICATES. It does not authorize. The click handler must go
-- through `assertCanDecide` and `engine.decide` exactly as a browser session
-- does — the token replaces the cookie and nothing else. A token that carried
-- its own permission would let somebody approve a report after being removed as
-- its approver.
CREATE TABLE action_token (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- ONLY THE HASH. The raw value exists in exactly one place — the link in
    -- somebody's mailbox — so a database leak yields nothing usable. sha256 hex,
    -- 64 lowercase characters, same shape as audit_entry's hashes.
    token_hash      text NOT NULL,
    -- Bound to ONE task and ONE action. Not "a token for this report": the whole
    -- point is that the link in the Approve button cannot reject, and neither
    -- link can act on a different step.
    task_id         uuid NOT NULL REFERENCES approval_task(id) ON DELETE CASCADE,
    action          text NOT NULL,
    -- And to ONE person. `decide` still re-derives what they may do, so this is
    -- the identity claim rather than the grant.
    recipient_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    -- Which delivery carried it, so the admin queue can say "this email's links
    -- were used". SET NULL rather than CASCADE: a purged delivery row must not
    -- silently delete a live credential.
    delivery_id     uuid REFERENCES notification_delivery(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT action_token_action_check CHECK (action IN ('APPROVE', 'REJECT')),
    CONSTRAINT action_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
-- GLOBALLY unique, not per tenant, and that is the one index in this schema that
-- deliberately has no organization_id in it.
--
-- The lookup happens BEFORE any tenant is known: a click arrives with a bare
-- token and no session, so the handler reads with the service role to find which
-- tenant the token belongs to and only then sets `app.current_org` (NT-17). A
-- per-tenant unique would permit the same hash in two tenants, which would make
-- that lookup ambiguous at exactly the moment there is nothing to disambiguate
-- it with. 32 random bytes make a collision not worth reasoning about; an
-- ambiguous lookup is worth designing out.
CREATE UNIQUE INDEX action_token_hash_idx ON action_token (token_hash);
CREATE INDEX action_token_org_id_idx ON action_token (organization_id);
-- "Are there live links for this task" — used when a decision arrives by another
-- route, so the outstanding ones can be consumed rather than left usable.
CREATE INDEX action_token_task_live_idx
    ON action_token (organization_id, task_id)
    WHERE consumed_at IS NULL;

ALTER TABLE action_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_token FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON action_token
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
-- The click handler's hatch: LIVE TOKENS ONLY, and read-only.
--
-- This is the narrowing that pays for itself. ExpenseOS's `verifyActionToken`
-- returns null "if unknown / expired / consumed" via an `if` in application code:
--
--     if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null;
--
-- Here the same three cases are one case — the row is not visible — so the check
-- cannot be forgotten, reordered, or defeated by a clock the application reads
-- instead of the database. The application `if` is ported anyway, because two
-- independent guards on a credential is the right number.
--
-- And because the policy is FOR SELECT, consuming the token requires a real
-- tenant context: the handler must resolve the tenant, switch into it, and only
-- then write.
CREATE POLICY platform_read ON action_token
    FOR SELECT
    USING (NULLIF(current_setting('app.platform_task', true), '') = 'on'
           AND consumed_at IS NULL
           AND expires_at > clock_timestamp());
