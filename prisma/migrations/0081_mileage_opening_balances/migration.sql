-- eos batch 3 (#589): ExpenseOS's mileage opening balances, ported (67db2e33, migration
-- 20261015130000_mileage_opening_balances). Distance carried into VeloExpense from another
-- system (Concur), so the calendar-year mileage bands (first 5,000 km at one rate, the rest
-- at another) start from what the person has actually been paid this year, not from zero.
--
-- An upload is a `mileage_balance_import`; each person's carried distance is a
-- `mileage_opening_balance`. Uploads are evolutionary: the newest per (source, year) is in
-- force and the earlier ones are superseded, never deleted.
--
-- ADDITIVE ONLY: two new tables, no change to existing rows.
--
-- VeloExpense differences, as for the other ports: both tables are per tenant (RLS,
-- composite tenant FKs, 0019); the unit is text with a CHECK listing ExpenseOS's
-- `MileageUnit` values (no Postgres enums, as `mileage_rate.unit`, 0052); the country is
-- held to ISO-2 by a CHECK, as `mileage_rate.country` is; ExpenseOS's onDelete: SetNull on
-- the succession link is narrowed to that one column so the tenant stays.

-- ── An upload ────────────────────────────────────────────────────────────────
CREATE TABLE mileage_balance_import (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Where the distance came from — 'concur'.
    source           text NOT NULL,
    -- The calendar year the distance counts toward.
    year             integer NOT NULL,
    -- The file's period end. VeloExpense mileage dated on or before it is covered by the
    -- file (the other system already counted that period); only later trips add on top.
    as_of            timestamptz NOT NULL,
    filename         text NOT NULL,
    imported_by_id   uuid NOT NULL,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    -- The upload that replaced this one; null while it is in force.
    superseded_by_id uuid UNIQUE,
    superseded_at    timestamptz,
    CONSTRAINT mileage_balance_import_year CHECK (year BETWEEN 2000 AND 2999),
    CONSTRAINT mileage_balance_import_not_own_successor CHECK (superseded_by_id IS DISTINCT FROM id),
    UNIQUE (organization_id, id),
    CONSTRAINT mileage_balance_import_imported_by_fkey
      FOREIGN KEY (organization_id, imported_by_id)
      REFERENCES app_user (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT mileage_balance_import_superseded_by_fkey
      FOREIGN KEY (organization_id, superseded_by_id)
      REFERENCES mileage_balance_import (organization_id, id) ON DELETE SET NULL (superseded_by_id)
);
CREATE INDEX mileage_balance_import_source_year_superseded_idx
    ON mileage_balance_import (organization_id, source, year, superseded_at);
ALTER TABLE mileage_balance_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_balance_import FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_balance_import
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── One person's carried-over distance in one upload ─────────────────────────
CREATE TABLE mileage_opening_balance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    import_id       uuid NOT NULL,
    user_id         uuid NOT NULL,
    -- ISO-2 — the same country the mileage bands are kept per.
    country         text NOT NULL,
    unit            text NOT NULL,
    distance        numeric(12,2) NOT NULL,
    -- The person's name as the file wrote it, so the next upload matches it without asking.
    source_name     text NOT NULL,
    -- The last rate the other system paid, as reported (e.g. 0.73) — informational.
    paid_rate       numeric(6,4),
    CONSTRAINT mileage_opening_balance_country_iso CHECK (country ~ '^[A-Z]{2}$'),
    CONSTRAINT mileage_opening_balance_unit CHECK (unit IN ('KM', 'MI')),
    CONSTRAINT mileage_opening_balance_distance_nonnegative CHECK (distance >= 0),
    UNIQUE (organization_id, id),
    UNIQUE (import_id, user_id, country),
    CONSTRAINT mileage_opening_balance_import_fkey
      FOREIGN KEY (organization_id, import_id)
      REFERENCES mileage_balance_import (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT mileage_opening_balance_user_fkey
      FOREIGN KEY (organization_id, user_id)
      REFERENCES app_user (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX mileage_opening_balance_user_idx ON mileage_opening_balance (user_id);
ALTER TABLE mileage_opening_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_opening_balance FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_opening_balance
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
