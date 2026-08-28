-- VeloExpense 0010 — tenant-scoped hash-chained audit log (VX2-6, ExpenseOS Module 12).
--
-- ONE new tenant table, `audit_entry`, so it takes the full treatment:
-- organization_id + org-id index + ENABLE/FORCE ROW LEVEL SECURITY + the
-- tenant_isolation policy (NULLIF form), and it is added to
-- test/rls-isolation.test.ts. CI's RLS-coverage guard fails the build otherwise.
--
-- ── Where this shape comes from ──────────────────────────────────────────────
--
-- Ported from ExpenseOS `packages/audit/src/{canonical,chain,verify}.ts`, read in
-- full, and reconciled against the two in-house hash chains whose DDL was read
-- directly: VeloLedger `audit.audit_event` (0001_init) and VeloPulse HRIS
-- `audit_event` (0001_init_hris_schema). Findings and reasoning are in
-- docs/porting/GAP-AUDIT.md AU-1 through AU-6. Read those before changing
-- anything here.
--
-- THE ONE THING TO UNDERSTAND FIRST: ExpenseOS's chain is GLOBAL and
-- tenant-blind, in three separate places, and none of that is a defect on their
-- side — they are one enterprise on one database. All three are wrong for a
-- pooled multi-tenant database and all three port verbatim by accident:
--
--   1. one advisory lock for the whole database, so every tenant's appends
--      serialize against every other tenant's;
--   2. a head read with no tenant predicate, so chains interleave — which under
--      RLS makes verification IMPOSSIBLE, because verifying tenant A would
--      require reading tenant B's rows;
--   3. no organization_id in the hash payload, so a row's tenant attribution
--      sits OUTSIDE the integrity guarantee.
--
-- This migration fixes (3) by putting organization_id in the payload; lib/audit
-- fixes (1) and (2). See AU-1.

-- ── The frozen hash payload ─────────────────────────────────────────────────
--
-- HANDOFF says freeze this once, so here it is, in the schema, next to the
-- columns it EXCLUDES — which is the durable place for it, because the risk is
-- not somebody changing the payload deliberately, it is somebody adding a column
-- and hashing it because that seemed thorough.
--
--   IN:  organization_id, occurred_at, actor_id, actor_email, actor_name,
--        actor_role, action, entity_type, entity_id, details, ip_address,
--        prev_hash
--   OUT: id, sequence      — self-referential; a row cannot hash its own identity
--        request_id        — operational
--        user_agent        — operational
--        expires_at        — MUTATED BY RETENTION. Hashing it would make a
--                            retention pass look like tampering.
--
-- Two of those IN fields are additions to ExpenseOS's nine, both deliberate:
--   * organization_id — see above. Non-negotiable in a pooled database.
--   * actor_role — theirs excludes it with a comment inviting exactly this
--     change: "actorRole is intentionally NOT in the hash… If you need actorRole
--     integrity, surface a follow-up." After GAP-AUDIT AP-13 — a privileged user
--     approving their own report, which shipped in ExpenseOS — "under what
--     authority was this done" is the question an auditor asks first.
CREATE TABLE audit_entry (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The chain's ORDER, assigned by the database.
    --
    -- Not a UUIDv7, which is what ExpenseOS uses. Their verify.ts walks rows
    -- "ordered by id (= UUIDv7 timestamp)" because their id is doing double duty
    -- as the order; VeloLedger already separates the two and we follow it. The
    -- cheap reason is that `uuid` is not a dependency here and gen_random_uuid()
    -- is built in. The real reason is correctness: a v7 is minted by the
    -- APPLICATION from its own clock, so two appends in the same millisecond, or
    -- two app instances with skewed clocks, can order rows differently from the
    -- order they were actually appended in — while the hash chain records the
    -- true order. That disagreement reads as tampering. A bigserial is assigned
    -- by the database inside the same serialized transaction and cannot
    -- disagree.
    --
    -- GAPS ARE NORMAL: a rolled-back transaction consumes a sequence value and
    -- never fills it. A gap is therefore NOT evidence of a deleted row, and the
    -- verifier must never treat contiguity as a signal — deletion is caught by
    -- the hash, because the next surviving row's prev_hash stops matching. Do
    -- not "fix" this by adding a contiguity check; it would fail on every
    -- rollback. See AU-6.
    sequence         bigserial NOT NULL UNIQUE,

    organization_id  uuid NOT NULL REFERENCES organization(id),

    -- clock_timestamp(), NOT now(). now() is transaction-START time, so several
    -- audit rows written in one transaction would share a timestamp and their
    -- order would be unrecoverable from this column. Existing VeloExpense
    -- convention (0008's audit-ish columns do the same).
    occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- ON DELETE RESTRICT, and this one is load-bearing rather than tidy.
    -- HANDOFF records the lesson from ExpenseOS: an actor column INSIDE the hash
    -- with onDelete SetNull means one hard user delete permanently and
    -- unrepairably breaks verification of every row that user ever wrote.
    -- Employees are soft-deleted (deleted_at) in normal operation, so RESTRICT
    -- costs nothing.
    actor_id         uuid REFERENCES app_user(id) ON DELETE RESTRICT,
    -- Set instead of actor_id when an EXTERNAL approver acted (VX2-8's
    -- approve-link). Mirrors approval_task.decided_by_email.
    actor_email      text,
    -- Denormalized and FROZEN at write time, on purpose: a later rename must not
    -- alter history, and the hash means it cannot.
    actor_name       text NOT NULL,
    -- The actor's role AT THE TIME. Also frozen, also hashed. 'SYSTEM' for an
    -- entry no person caused.
    actor_role       text NOT NULL,

    action           text NOT NULL,
    entity_type      text,
    entity_id        uuid,
    -- Free-form context. AMOUNTS GO IN HERE AS STRINGS, never as BigInt: the
    -- canonicalizer throws on BigInt (ported verbatim from ExpenseOS), and it
    -- throws at audit-write time — i.e. inside the transaction that was
    -- recording a state change — so a sloppy detail payload fails the business
    -- operation, not just the log line. `pg` already returns bigint columns as
    -- strings, so the natural path is correct and only an explicit BigInt()
    -- breaks it. See AU-5.
    details          jsonb,
    ip_address       inet,

    -- OPERATIONAL, and outside the hash. Kept because they are what you want
    -- when correlating an entry with a request log.
    request_id       uuid,
    user_agent       text,

    -- Set by a retention policy. VX2-6 does NOT implement retention; the column
    -- exists now so that the hash payload above can state, in the same place,
    -- that retention must never enter it. When retention lands it also needs the
    -- purge watermark below.
    expires_at       timestamptz,

    -- The chain. NULL prev_hash = this tenant's genesis row.
    prev_hash        text,
    entry_hash       text NOT NULL,

    CONSTRAINT audit_entry_actor_exclusive
        CHECK (actor_id IS NULL OR actor_email IS NULL),
    CONSTRAINT audit_entry_actor_name_present
        CHECK (btrim(actor_name) <> ''),
    CONSTRAINT audit_entry_action_present
        CHECK (btrim(action) <> ''),
    -- Both hashes are hex SHA-256. Cheap shape check so a truncated or
    -- base64-encoded hash fails at the boundary rather than at verification time
    -- years later.
    CONSTRAINT audit_entry_hash_shape
        CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT audit_entry_prev_hash_shape
        CHECK (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$'),
    -- An entity reference is both columns or neither.
    CONSTRAINT audit_entry_entity_complete
        CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);

-- ── The chain cannot fork, structurally ─────────────────────────────────────
--
-- ExpenseOS relies solely on an advisory lock to prevent two appenders writing
-- rows that claim the same predecessor. The lock is correct and we port it, but
-- it is APPLICATION discipline: any code path that forgets it, or a manual
-- INSERT during an incident, forks the chain silently and the fork is
-- indistinguishable from tampering forever after.
--
-- These two indexes make a fork impossible regardless. Two rows in one tenant
-- claiming the same prev_hash is exactly what a fork IS.
CREATE UNIQUE INDEX audit_entry_no_fork_idx
    ON audit_entry (organization_id, prev_hash);
-- …and because NULLs do not conflict in a unique index, the genesis row needs
-- its own statement: at most one row per tenant may claim no predecessor.
-- (`UNIQUE NULLS NOT DISTINCT` would fold these into one on PG 15+, but two
-- indexes say what they mean, and "one genesis per tenant" is worth saying.)
CREATE UNIQUE INDEX audit_entry_one_genesis_idx
    ON audit_entry (organization_id)
    WHERE prev_hash IS NULL;

-- The head read: WHERE organization_id = … ORDER BY sequence DESC LIMIT 1.
CREATE INDEX audit_entry_org_sequence_idx
    ON audit_entry (organization_id, sequence DESC);
-- "What happened to this thing?"
CREATE INDEX audit_entry_entity_idx
    ON audit_entry (organization_id, entity_type, entity_id);
-- The log view, newest first.
CREATE INDEX audit_entry_org_occurred_idx
    ON audit_entry (organization_id, occurred_at DESC);
-- Who did what, for the reports AP-13 exists to make possible.
CREATE INDEX audit_entry_actor_idx
    ON audit_entry (organization_id, actor_id);

ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entry FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_entry
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Append-only ─────────────────────────────────────────────────────────────
--
-- A tamper-evident log that the application can UPDATE is only tamper-evident
-- against outsiders. VeloLedger uses a trigger for this and so do we.
--
-- The trigger is the WHOLE guarantee, and deliberately so — there is no
-- accompanying REVOKE, because one here would be theatre. Two reasons, both
-- checked rather than assumed:
--
--   * `veloapp` does not exist yet when this migration runs. CI applies
--     migrations FIRST and creates the role afterwards, so `REVOKE … FROM
--     veloapp` would error on a fresh database. `REVOKE … FROM PUBLIC` runs, but
--     PUBLIC never held those privileges, so it changes nothing.
--   * Even if it did run, CI's role setup issues
--     `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`
--     plus an ALTER DEFAULT PRIVILEGES doing the same for future tables — so the
--     grant would come straight back on the next CI run and on any fresh local
--     setup following HANDOFF §3.
--
-- Narrowing those two grant blocks to exclude this table is worth doing and is
-- NOT done here — it is a CI and setup-doc change, not a migration. Until then
-- the trigger is what holds, and unlike a grant it holds even against a
-- superuser.
--
-- Retention needs a way through, so there is exactly one, and it is explicit:
-- a session must set `app.audit_purge = 'on'`. A purge is a deliberate,
-- auditable act; it should not be reachable by a stray UPDATE.
CREATE FUNCTION audit_entry_append_only() RETURNS trigger AS $$
BEGIN
    IF COALESCE(NULLIF(current_setting('app.audit_purge', true), ''), 'off') = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION
        'audit_entry is append-only: % refused. A retention purge must set app.audit_purge to on.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_append_only_trg
    BEFORE UPDATE OR DELETE ON audit_entry
    FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();

-- ── The purge watermark, per tenant ─────────────────────────────────────────
--
-- Two columns on `organization` rather than a new table, following 0009's
-- precedent for the break-glass flag: `organization` is already the tenant row,
-- and a new table would mean a new RLS surface for two scalars.
--
-- Why this is part of VX2-6 and not a later retention ticket: the VERIFIER's
-- contract depends on it existing. ExpenseOS's verify.ts takes a `seedPrevHash`
-- and explains why —
--
--   "Needed after a retention purge: the deleted head means the oldest surviving
--    row's prevHash references a row that no longer exists, which is
--    indistinguishable from tampering. The caller supplies the purge watermark
--    here so the gap reconciles instead of reading as a break."
--
-- Theirs is a per-call argument because their chain is global. Ours must be
-- STORED and per-tenant, or one tenant's purge would require every other
-- tenant's verification to be seeded by hand. See AU-4.
ALTER TABLE organization
    ADD COLUMN audit_purged_through_sequence bigint,
    ADD COLUMN audit_purged_head_hash        text;

ALTER TABLE organization
    ADD CONSTRAINT organization_audit_watermark_complete
        CHECK ((audit_purged_through_sequence IS NULL) = (audit_purged_head_hash IS NULL)),
    ADD CONSTRAINT organization_audit_watermark_shape
        CHECK (audit_purged_head_hash IS NULL OR audit_purged_head_hash ~ '^[0-9a-f]{64}$');
