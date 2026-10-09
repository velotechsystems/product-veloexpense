-- Wave 1: ExpenseOS's mileage rates, ported (w1-08). Three NEW tables — VeloExpense had
-- no mileage rates — shaped as ExpenseOS's `MileageRate`, `MileageRateTier` and
-- `MileageRateSubject` so its `policies.mileageRate` router and /admin/mileage-rates
-- screen run unchanged (prisma/schema.prisma maps the names). Plus ExpenseOS's
-- `ExpenseLineItem.mileageRateId`: nothing prices a claim yet (Wave 2), but the router
-- refuses to delete a rule a claim was priced under, and that check reads this column.
--
-- Nothing here rewrites an existing row: the one change to an existing table is a new
-- nullable column.
--
-- VeloExpense differences, as for the other ports: every table is per tenant (RLS,
-- composite tenant FKs, 0019); the unit is text with a CHECK listing ExpenseOS's
-- `MileageUnit` values (no Postgres enums); the GL account is the tenant's own
-- `gl_account` (ExpenseOS: its NetSuite account table), held postable by the same
-- trigger as every other account reference (0014); and the rules ExpenseOS keeps only
-- in its router are held by the tables where a single row can express them.

-- ── The rule ────────────────────────────────────────────────────────────────
CREATE TABLE mileage_rate (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    country          text NOT NULL,
    -- The unit BOTH the tier thresholds and the rates are expressed in.
    unit             text NOT NULL,
    effective_from   timestamptz NOT NULL,
    -- Null = in force. Written by succession, or explicitly to retire the country.
    effective_to     timestamptz,
    -- The rule that replaced this one (ExpenseOS's `supersededById`, unique: a rule is
    -- superseded once).
    superseded_by_id uuid UNIQUE,
    -- Where this rule's mileage posts; null falls back to the mileage category's account.
    gl_account_id    uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Who created it (ExpenseOS's `createdBy`, a bare id there too).
    created_by       uuid,
    CONSTRAINT mileage_rate_country_iso CHECK (country ~ '^[A-Z]{2}$'),
    CONSTRAINT mileage_rate_unit CHECK (unit IN ('KM', 'MI')),
    CONSTRAINT mileage_rate_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT mileage_rate_not_own_successor CHECK (superseded_by_id IS DISTINCT FROM id),
    UNIQUE (organization_id, id),
    -- ExpenseOS's onDelete: SetNull on both, narrowed to the one column so the tenant stays.
    CONSTRAINT mileage_rate_superseded_by_fkey
      FOREIGN KEY (organization_id, superseded_by_id)
      REFERENCES mileage_rate (organization_id, id) ON DELETE SET NULL (superseded_by_id),
    CONSTRAINT mileage_rate_gl_account_fkey
      FOREIGN KEY (organization_id, gl_account_id)
      REFERENCES gl_account (organization_id, id) ON DELETE SET NULL (gl_account_id)
);
CREATE INDEX mileage_rate_country_from_idx ON mileage_rate (organization_id, country, effective_from);
CREATE INDEX mileage_rate_effective_to_idx ON mileage_rate (organization_id, effective_to);
CREATE TRIGGER mileage_rate_gl_account_postable
    BEFORE INSERT OR UPDATE OF gl_account_id ON mileage_rate
    FOR EACH ROW EXECUTE FUNCTION gl_account_must_be_postable();
ALTER TABLE mileage_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_rate FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_rate
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Its bands ───────────────────────────────────────────────────────────────
-- Everything from `from_distance` up to the NEXT band's bills at `rate_minor` (minor
-- units per unit of distance). Only the lower bound is stored, so a gap or an overlap
-- is unrepresentable; the router requires the lowest to be 0.
CREATE TABLE mileage_rate_tier (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    rate_id         uuid NOT NULL,
    from_distance   numeric(12,2) NOT NULL,
    rate_minor      bigint NOT NULL,
    CONSTRAINT mileage_rate_tier_from_nonnegative CHECK (from_distance >= 0),
    -- VeloExpense: a negative rate would make a mileage claim pay the company.
    CONSTRAINT mileage_rate_tier_rate_nonnegative CHECK (rate_minor >= 0),
    CONSTRAINT mileage_rate_tier_rate_fkey
      FOREIGN KEY (organization_id, rate_id)
      REFERENCES mileage_rate (organization_id, id) ON DELETE CASCADE,
    UNIQUE (rate_id, from_distance)
);
CREATE INDEX mileage_rate_tier_rate_idx ON mileage_rate_tier (rate_id);
ALTER TABLE mileage_rate_tier ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_rate_tier FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_rate_tier
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Who it covers ───────────────────────────────────────────────────────────
-- No rows = the country default; one or more = a car allowance for exactly those people.
CREATE TABLE mileage_rate_subject (
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    rate_id         uuid NOT NULL,
    user_id         uuid NOT NULL,
    PRIMARY KEY (rate_id, user_id),
    CONSTRAINT mileage_rate_subject_rate_fkey
      FOREIGN KEY (organization_id, rate_id)
      REFERENCES mileage_rate (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT mileage_rate_subject_user_fkey
      FOREIGN KEY (organization_id, user_id)
      REFERENCES app_user (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX mileage_rate_subject_user_idx ON mileage_rate_subject (user_id);
ALTER TABLE mileage_rate_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_rate_subject FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_rate_subject
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── The claim side (Wave 2 prices into it) ──────────────────────────────────
-- ExpenseOS's `ExpenseLineItem.mileageRateId`, onDelete: SetNull.
ALTER TABLE expense_line_item ADD COLUMN mileage_rate_id uuid;
ALTER TABLE expense_line_item ADD CONSTRAINT expense_line_item_mileage_rate_fkey
    FOREIGN KEY (organization_id, mileage_rate_id)
    REFERENCES mileage_rate (organization_id, id) ON DELETE SET NULL (mileage_rate_id);
CREATE INDEX expense_line_item_mileage_rate_idx
    ON expense_line_item (mileage_rate_id) WHERE mileage_rate_id IS NOT NULL;
