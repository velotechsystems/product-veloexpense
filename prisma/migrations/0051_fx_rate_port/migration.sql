-- Wave 1: ExpenseOS's FX rates, ported (w1-07). Brings `fx_rate` to ExpenseOS's
-- `FxRate` so its `policies.fxRate` router and /admin/fx-rates screen run unchanged
-- (prisma/schema.prisma maps the names). Two changes to 0015's table:
--
-- 1. PER TENANT (d18). 0015 made the table global reference data. That held while
--    nothing in the app could write a rate; ExpenseOS's screen lets an admin add one,
--    and in a multi-tenant app a global row would let one tenant's admin set the rate
--    every other tenant's policies, budgets and analytics convert at. So the table gets
--    `organization_id` and RLS like every tenant table. Each company keeps its own
--    rates, which is what ExpenseOS's screen means in its single-tenant install. Every
--    reader already runs inside the tenant scope (lib/policy, lib/budgets,
--    lib/analytics, lib/fraud), so RLS narrows them with no code change. The Bank of
--    Canada sync arrives with the worker in Wave 3 (d19) and writes each tenant's rows.
--
-- 2. APPEND-ONLY HISTORY (d18). ExpenseOS keys a rate by the moment it was recorded
--    (`fetchedAt`), keeps every add, and reads the newest per pair. 0015 keyed it by a
--    date, one rate per pair per day. The key becomes (tenant, base, quote,
--    fetched_at). `as_of` stays, DERIVED from `fetched_at` (its UTC day), so
--    VeloExpense's readers — "the latest rate on or before this date", with
--    reciprocals derived rather than stored (0015, PE-7) — keep working, and the two
--    can never disagree.
--
-- What does not change: the rate's precision, `source`, and the checks.
--
-- EXISTING ROWS ARE COPIED INTO EVERY TENANT, each at 00:00 UTC on its old `as_of`,
-- so every tenant converts exactly as it did before this migration. The copy runs
-- per tenant with `app.current_org` set (f08: on RDS the migration role is bound by
-- FORCE RLS, so a statement outside a tenant scope would insert nothing). The old
-- table is read before RLS exists on the new one, and dropped after.

ALTER TABLE fx_rate RENAME TO fx_rate_0015;
ALTER INDEX fx_rate_pair_idx RENAME TO fx_rate_0015_pair_idx;
ALTER TABLE fx_rate_0015 RENAME CONSTRAINT fx_rate_pkey TO fx_rate_0015_pkey;

CREATE TABLE fx_rate (
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Named, so they keep 0015's names: Postgres would otherwise pick `…_fkey1`
    -- while the renamed old table still holds the originals.
    base       text NOT NULL CONSTRAINT fx_rate_base_fkey REFERENCES currency(code),
    quote      text NOT NULL CONSTRAINT fx_rate_quote_fkey REFERENCES currency(code),
    -- `quote` per 1 `base`, numeric(18,8) as before and as ExpenseOS's Decimal(18,8).
    rate       numeric(18,8) NOT NULL,
    -- ExpenseOS's `fetchedAt`: when the rate was recorded. The newest per pair wins.
    fetched_at timestamptz NOT NULL DEFAULT now(),
    -- The UTC day of `fetched_at`, for VeloExpense's "on or before this date" readers.
    as_of      date GENERATED ALWAYS AS ((fetched_at AT TIME ZONE 'UTC')::date) STORED,
    source     text NOT NULL DEFAULT 'MANUAL',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, base, quote, fetched_at),
    CONSTRAINT fx_rate_distinct_chk CHECK (base <> quote),
    CONSTRAINT fx_rate_positive_chk CHECK (rate > 0),
    CONSTRAINT fx_rate_source_chk   CHECK (source IN ('MANUAL', 'SYNC', 'SEED'))
);
-- ExpenseOS's two indexes, tenant-first.
CREATE INDEX fx_rate_pair_idx ON fx_rate (organization_id, base, quote, fetched_at DESC);
CREATE INDEX fx_rate_fetched_at_idx ON fx_rate (organization_id, fetched_at);

COMMENT ON TABLE fx_rate IS
    'Per-tenant exchange rates, quote per 1 base, append-only: the newest fetched_at '
    'per pair wins. Reciprocals are DERIVED in lib/policy/rates.ts and must NOT be '
    'stored — two rows for one pair can disagree, a derivation cannot (GAP-AUDIT PE-7).';

ALTER TABLE fx_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rate FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_rate
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    INSERT INTO fx_rate (organization_id, base, quote, rate, fetched_at, source, created_at)
    SELECT org, base, quote, rate, (as_of::timestamp AT TIME ZONE 'UTC'), source, created_at
      FROM fx_rate_0015;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;

DROP TABLE fx_rate_0015;
