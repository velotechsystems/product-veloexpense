-- 0040 — inbound platform provisioning: make idempotency a constraint.
--
-- VX5-20 part 2. THIS IS A DELIBERATE DEVIATION FROM THE PORT and the only one
-- in the ticket, so it is worth stating why rather than leaving it to be found.
--
-- ── WHAT VeloLedger DOES, AND WHY IT IS NOT ENOUGH HERE ─────────────────────
--
-- VeloLedger's `provisionTenant` is idempotent on the platform Account, and it
-- implements that as a read followed by a write:
--
--     SELECT id FROM organization WHERE account_id = $1 LIMIT 1;   -- found? done
--     INSERT INTO organization (...) VALUES (...);
--
-- Its `0051` created `organization_by_account_idx` as a PLAIN index, and `0039`
-- ported that shape here verbatim. A plain index makes the lookup fast; it does
-- not make the invariant true. Two provisions for the same Account arriving
-- together both pass the SELECT and both INSERT, and the Account now owns two
-- tenants — one of which the platform will never find again, because every later
-- lookup takes `LIMIT 1` off an index with two matching rows.
--
-- ── AND THE CONCURRENT CASE IS THE EXPECTED CASE, NOT AN EXOTIC ONE ─────────
--
-- The caller is an orchestrator with a retry. The single most likely way this
-- endpoint is called twice for one Account is a first call that timed out —
-- which means it may well still be running. "Idempotent on retry" and "safe
-- under concurrency" are the same requirement for this endpoint, and only one of
-- them is satisfied by checking first.
--
-- So the index becomes UNIQUE, and `lib/platform/provision.ts` keeps the SELECT
-- as the fast path while treating 23505 on this index as `already_exists`. The
-- check is an optimisation; the constraint is the guarantee.
--
-- ── PARTIAL, BECAUSE MOST TENANTS HAVE NO ACCOUNT ──────────────────────────
--
-- `account_id` is nullable and null for every tenant that signed up through
-- VeloExpense's own front door. A UNIQUE index over nulls would be fine in
-- Postgres (nulls are distinct), so `WHERE account_id IS NOT NULL` is not
-- strictly required — it is kept because it says the intent out loud and keeps
-- the index the size of the platform-provisioned estate rather than the whole
-- one.
--
-- ── IF THIS MIGRATION FAILS, THAT IS THE MIGRATION WORKING ─────────────────
--
-- A duplicate `account_id` already in the table stops the CREATE. That is a real
-- billing defect (two tenants, one Account, one subscription) and the correct
-- outcome is a refused deploy and a person looking, not a plain index quietly
-- kept. The query that finds them:
--
--     SELECT account_id, count(*), array_agg(id) FROM organization
--      WHERE account_id IS NOT NULL GROUP BY account_id HAVING count(*) > 1;

DROP INDEX IF EXISTS organization_by_account_idx;

CREATE UNIQUE INDEX organization_by_account_idx ON organization (account_id)
    WHERE account_id IS NOT NULL;

COMMENT ON COLUMN organization.account_id IS
    'The VeloTech platform Account UUID (0039). NULL means this tenant signed up '
    'through VeloExpense''s own front door and the platform has never heard of it '
    '— a legitimate state, not a lapse. UNIQUE where present (0040): it is the '
    'idempotency key of POST /api/platform/provision.';
