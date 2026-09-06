-- VeloExpense 0038 — what a tenant is billed FOR (VX5-9).
--
-- 0037 said what a tenant pays on. This says how much of it there was, and it is
-- the row an invoice is built from.
--
-- ── A READING IS A MEASUREMENT, NOT A CALCULATION ──────────────────────────
--
-- The single most important property of this table, and the reason it stores a
-- QUANTITY and not an amount.
--
-- A quantity is a fact about a moment: this tenant had 34 people who could sign
-- in on 30 September. It stays true forever. An amount is that fact multiplied by
-- a price, and a price can be corrected, discounted or renegotiated — so an amount
-- stored here would be a second copy of an arithmetic the provider is also doing,
-- drifting from it the first time somebody edits a plan. That is UD-9's defect
-- (three hand-kept copies, one of them already obsolete before anybody noticed)
-- and UD-1's (a currency the adapters DID send, that nothing asserted, and a month
-- of USD booked as CAD in the gap).
--
-- So: readings are counted here, priced by the provider, and the invoice lives at
-- the provider. If this product ever needs to show a customer their own invoice,
-- it fetches it rather than recomputing it.
--
-- ── AND IT IS APPEND-MOSTLY, FOR AN AUDIT REASON ───────────────────────────
--
-- One row per (tenant, meter, period), written once and thereafter idempotent —
-- a re-run of the sweep must not double a count or silently rewrite last month's.
-- The unique index below is what makes that a property rather than an intention,
-- and `recordReadings`' ON CONFLICT … DO NOTHING is the same conditional-write
-- idiom this codebase now uses in seven places.
--
-- WHY NOT `DO UPDATE`: because a period's reading is evidence. If September said
-- 34 seats and a later run says 31, the interesting fact is that they disagree,
-- and overwriting destroys it. A correction is a new period or a manual act with
-- a person's name on it, not a sweep quietly changing history — the same argument
-- `fraud_flag` makes for never deleting a finding whose rule stopped firing.
--
-- ── WHAT IT DOES NOT HAVE ──────────────────────────────────────────────────
--
-- No `subscription_id`. The tenant and the period are the identity; a subscription
-- that is cancelled and restarted must not orphan the readings that came before
-- it, and a FK to a row that can be superseded would do exactly that. `plan_code`
-- IS stamped, because "what were they on when this was measured" is a question the
-- current subscription cannot answer once they change plan.

CREATE TABLE subscription_meter_reading (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    meter            text NOT NULL,
    -- The plan in force AT MEASUREMENT. Not a FK to `billing_plan`: a plan can be
    -- retired, and a reading has to keep saying what was true then. The same
    -- stamp-on-write rule AC-10 gives for a line item's account, ported with its
    -- reasoning intact.
    plan_code        text NOT NULL,
    -- Half-open [start, end), as every period in this schema. A closed interval
    -- makes the last instant of September also the first of October, and somebody
    -- eventually bills it twice.
    period_start     timestamptz NOT NULL,
    period_end       timestamptz NOT NULL,
    quantity         bigint NOT NULL,
    -- WHEN the count was taken, which is not the same as the period it describes.
    -- A sweep that runs late still measures the period it was asked for, and the
    -- difference between those two timestamps is the first thing anybody
    -- investigating a disputed invoice will want.
    measured_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT smr_meter_check CHECK (meter IN ('SEAT', 'TENANT', 'CARD')),
    CONSTRAINT smr_quantity_check CHECK (quantity >= 0),
    CONSTRAINT smr_period_order CHECK (period_end > period_start)
);

-- ONE READING PER TENANT PER METER PER PERIOD. This is what makes the sweep safe
-- to re-run, which matters because it is a cron: it will be run twice on a
-- deploy, on a retry, and by a person testing it.
CREATE UNIQUE INDEX smr_one_per_period_idx
    ON subscription_meter_reading (organization_id, meter, period_start);

CREATE INDEX smr_org_period_idx
    ON subscription_meter_reading (organization_id, period_start DESC);

ALTER TABLE subscription_meter_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_meter_reading FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription_meter_reading
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- NO PLATFORM HATCH, and its absence is the decision.
--
-- The sweep fans out per tenant and sets `app.current_org` for each — the shape
-- VX0-8 established and `scanAllTenants` follows — so it never needs to see across
-- tenants at all. `subscription` has a read hatch because a WEBHOOK arrives
-- carrying a provider reference and no tenant, which is a genuinely tenant-less
-- question. Counting seats is not: every count happens inside exactly one tenant.
--
-- A hatch added "for the invoice screen later" would be a cross-tenant read of
-- billing quantities that nothing needs today, and the way to add it is to have a
-- caller that cannot work without it.
