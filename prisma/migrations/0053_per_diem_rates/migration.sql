-- Wave 1: ExpenseOS's per-diem rates, ported (w1-09). A NEW table — VeloExpense had
-- none — shaped as ExpenseOS's `PerDiemRate` so its `policies.perDiemRate` router and
-- /admin/per-diem-rates screen run unchanged (prisma/schema.prisma maps the names).
-- Nothing here touches an existing row.
--
-- A rate is a daily cap for one (country, city, expense category), optionally scoped
-- to a job level, legal entity, business unit and currency — null meaning "applies to
-- everyone"; the per-diem resolver (Wave 2, with the approval engine) picks the most
-- specific match.
--
-- VeloExpense differences: per tenant (RLS, composite tenant FKs, 0019), every scoping
-- reference with ExpenseOS's onDelete: Restrict; the currency is the system's
-- `currency` row by its ISO code (ExpenseOS: a uuid, `currencyId`, which
-- prisma/schema.prisma maps onto this column, as for legal entities' home currency,
-- 0048); and the rules ExpenseOS leaves to its form — a city, a non-negative cap, an
-- end that does not precede the start — are held by the table too.
CREATE TABLE per_diem_rate (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    country          text NOT NULL,
    city             text NOT NULL,
    -- The per-diem "bucket" (meals, lodging, incidentals, …) IS the expense category.
    category_id      uuid NOT NULL,
    -- The daily cap, in `currency_code` (or the tenant's policy currency when null).
    amount_minor     bigint NOT NULL,
    -- Halve the cap on the first and last day of a trip (the GSA convention).
    first_last_day   boolean NOT NULL DEFAULT false,
    effective_from   timestamptz NOT NULL,
    effective_to     timestamptz,
    job_level_id     uuid,
    legal_entity_id  uuid,
    business_unit_id uuid,
    currency_code    text REFERENCES currency(code) ON DELETE RESTRICT,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT per_diem_rate_country_iso CHECK (country ~ '^[A-Z]{2}$'),
    CONSTRAINT per_diem_rate_city CHECK (length(btrim(city)) BETWEEN 1 AND 100),
    CONSTRAINT per_diem_rate_amount_nonnegative CHECK (amount_minor >= 0),
    CONSTRAINT per_diem_rate_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    UNIQUE (organization_id, id),
    CONSTRAINT per_diem_rate_category_fkey
      FOREIGN KEY (organization_id, category_id)
      REFERENCES expense_category (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT per_diem_rate_job_level_fkey
      FOREIGN KEY (organization_id, job_level_id)
      REFERENCES job_level (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT per_diem_rate_legal_entity_fkey
      FOREIGN KEY (organization_id, legal_entity_id)
      REFERENCES legal_entity (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT per_diem_rate_business_unit_fkey
      FOREIGN KEY (organization_id, business_unit_id)
      REFERENCES business_unit (organization_id, id) ON DELETE RESTRICT
);
-- ExpenseOS's three indexes, tenant-first.
CREATE INDEX per_diem_rate_lookup_idx
    ON per_diem_rate (organization_id, country, city, category_id, effective_from);
CREATE INDEX per_diem_rate_category_idx ON per_diem_rate (organization_id, category_id);
CREATE INDEX per_diem_rate_job_level_idx ON per_diem_rate (organization_id, job_level_id);
ALTER TABLE per_diem_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE per_diem_rate FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON per_diem_rate
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
