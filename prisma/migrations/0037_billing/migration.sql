-- VeloExpense 0037 — the subscription (VX5-8). The first half of the only GA gate
-- condition the product does not meet.
--
-- ── WHY THIS IS GREENFIELD, CHECKED RATHER THAN ASSUMED ─────────────────────
--
-- The standing rule is to port from ExpenseOS, so the absence of a port needs
-- evidence rather than a shrug. ExpenseOS has NO billing: `Stripe` appears once,
-- as a merchant string in a test fixture; `subscription` twice, in comments about
-- expense categories; and there is no Subscription, Plan, Invoice or Billing model
-- anywhere in its 1,900-line schema. It also has no tenant at all. So there is
-- nothing to port here and — the half people forget — no upstream mistakes to be
-- warned by either. Everything below is a decision rather than an inheritance,
-- which is why there is so much of this comment.
--
-- ── NO VENDOR NAME, ANYWHERE, AND THE GUARD NOW ENFORCES IT ────────────────
--
-- John's decision (6 Sep) is that billing goes to a PROVIDER rather than in-house.
-- That is a decision about who runs the money, NOT a licence to model the schema
-- around one company. VX3-7 settled this shape for accounting — "no vendor name
-- appears in a core table, a shared enum, a permission slug or an audit action" —
-- and AC-13 is the record of what happens otherwise: in ExpenseOS the only
-- integration became the model, so `Budget.glAccountId` is a required FK to a
-- NetSuite-shaped table on a page that has nothing to do with NetSuite.
--
-- So a provider appears here as `subscription.provider`, a free-text slug next to
-- two opaque reference columns, exactly as `integration_installation` does. There
-- is deliberately NO CHECK constraint listing the known providers: that is the
-- reflection table AC-2/AC-3 declined, and it turns adding a provider into a
-- migration. `scripts/check-vendor-neutral.mjs` gains the billing vendors in this
-- PR, so the rule is now policed here too rather than only for ledgers.
--
-- ── THREE TABLES, AND WHY THE MIDDLE ONE EXISTS ────────────────────────────
--
-- The plan asks for "metering by seats/tenants/cards" and John chose ALL THREE.
-- A single `meter` column on the plan would force one, which is not what real
-- pricing looks like: a tier is normally a flat base PLUS a per-seat charge. So a
-- plan is a header and `billing_plan_component` is one row per meter on it. A
-- flat-only plan has one TENANT component; a seat-based plan has one SEAT
-- component; the common shape has both, and none of that needs a schema change.
--
-- CARD is in the vocabulary and NOTHING CAN COUNT IT. The VCC module does not
-- exist in VeloExpense — it is one of the ExpenseOS modules never ported — so a
-- CARD component would meter a thing that is not there. It is in the enum because
-- omitting it would mean a migration the day VCC lands; there is a CHECK below
-- that refuses to attach one to a plan until then, so the schema can express the
-- meter without the product being able to bill a silent zero. A meter that always
-- reads nought is indistinguishable from a customer who owes nothing.
--
-- ── THE TWO PRODUCT DECISIONS, MADE BY JOHN ON 6 SEP ───────────────────────
--
-- 1. A SEAT IS ANYBODY WHO CAN SIGN IN — a non-deleted `app_user`. Not live
--    invitations: an admin who invites ten and gets three should not argue with an
--    invoice. And because deactivation is what clears access, the charge stops on
--    the same event that stops the login, so a tenant can never be billed for
--    somebody who cannot get in. Counting is VX5-9's job; this migration only has
--    to not preclude it, and it does not, because the count is derivable from
--    `app_user` at any instant.
--
-- 2. A LAPSED TENANT IS READ-ONLY, not locked out. They sign in, read and export
--    everything, and cannot submit, approve or post. That is the decent version
--    and it is also the one that survives contact with PIPEDA and GDPR, under
--    which a customer retains a right of access to their own data — locking a
--    company out of its own expense records is a support ticket at best. The
--    status vocabulary below is what a write gate will read; the gate itself is a
--    later ticket, because putting it in every write path is a diff that deserves
--    its own review rather than a footnote to a schema.
--
-- ── WHAT IS NOT HERE, ON PURPOSE ───────────────────────────────────────────
--
-- No invoices, no payments, no meter readings, no webhooks. A provider owns the
-- money, so an invoice table here would be a second copy of somebody else's
-- record that drifts from it — the exact failure UD-9 catalogued three times over
-- in another form. Readings land with VX5-9 because a table nothing writes is a
-- table whose shape nobody has tested.

-- ── GLOBAL reference: the plan catalogue ────────────────────────────────────
--
-- No `organization_id` and no RLS, the same category as `currency` and the
-- chart-of-accounts templates: plans are the same for every tenant, and a tenant
-- that cannot read the catalogue cannot be shown what it is paying for.
CREATE TABLE billing_plan (
    code           text PRIMARY KEY,
    name           text NOT NULL,
    -- Retire a plan without deleting it. A subscription on a withdrawn plan must
    -- keep resolving — AC-11's lesson from the chart of accounts, where an account
    -- withdrawn upstream deactivates rather than disappears so historical mappings
    -- still resolve. A price list has exactly the same property.
    active         boolean NOT NULL DEFAULT true,
    -- MONTH or YEAR. Not an interval type: the billing period is a calendar
    -- concept the provider also holds, and `interval '1 month'` invites arithmetic
    -- that disagrees with theirs at a month end.
    period         text NOT NULL,
    currency_code  text NOT NULL REFERENCES currency(code),
    -- Days of trial a NEW tenant on this plan gets. Zero is a legitimate value and
    -- means "no trial", which is why it is here rather than a global constant.
    trial_days     integer NOT NULL DEFAULT 30,
    sort_order     integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT billing_plan_period_check CHECK (period IN ('MONTH', 'YEAR')),
    CONSTRAINT billing_plan_trial_days_check CHECK (trial_days >= 0),
    CONSTRAINT billing_plan_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]*$')
);

-- One row per meter on a plan. See the header: a tier is a base fee AND a per-seat
-- charge more often than it is either alone.
CREATE TABLE billing_plan_component (
    plan_code         text NOT NULL REFERENCES billing_plan(code) ON DELETE CASCADE,
    meter             text NOT NULL,
    -- Minor units, like every other amount in this schema (`lib/money.ts`). A
    -- price is money and money is never a float here.
    unit_amount_minor bigint NOT NULL,
    -- Units included before the meter starts charging — 5 seats free, say. Not a
    -- discount; a floor.
    included_units    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_code, meter),
    CONSTRAINT billing_plan_component_meter_check
        CHECK (meter IN ('SEAT', 'TENANT', 'CARD')),
    CONSTRAINT billing_plan_component_amount_check CHECK (unit_amount_minor >= 0),
    CONSTRAINT billing_plan_component_included_check CHECK (included_units >= 0),
    -- CARD is in the vocabulary and cannot be attached to a plan, because nothing
    -- in this product can count a card yet. Drop this constraint in the migration
    -- that lands VCC — deliberately a CHECK rather than a comment, so the day
    -- somebody prices a card plan they are stopped by the database rather than
    -- shipping an invoice line that is always zero.
    CONSTRAINT billing_plan_component_card_has_no_source
        CHECK (meter <> 'CARD')
);

-- The starter catalogue. Reference rows in the migration, as `currency` (0001) and
-- the chart-of-accounts templates (0014) — there is no second copy in the seed to
-- drift from this one, which is `DEFAULT_POLICIES`' rule applied again.
--
-- THESE PRICES ARE PLACEHOLDERS and are marked as such by being obviously round.
-- Pricing is John's to set; the schema's job is to hold whatever he decides, and a
-- catalogue with no rows makes every path below untestable.
INSERT INTO billing_plan (code, name, period, currency_code, trial_days, sort_order) VALUES
    ('STARTER', 'Starter', 'MONTH', 'CAD', 30, 10),
    ('TEAM',    'Team',    'MONTH', 'CAD', 30, 20),
    ('SCALE',   'Scale',   'MONTH', 'CAD', 30, 30);

INSERT INTO billing_plan_component (plan_code, meter, unit_amount_minor, included_units) VALUES
    -- Flat only: the smallest tier is a fixed fee with a handful of people.
    ('STARTER', 'TENANT', 4900,  0),
    ('STARTER', 'SEAT',   0,     5),
    -- Base plus per seat, which is the shape most of this market uses.
    ('TEAM',    'TENANT', 9900,  0),
    ('TEAM',    'SEAT',   900,   10),
    ('SCALE',   'TENANT', 29900, 0),
    ('SCALE',   'SEAT',   700,   50);

-- ── TENANT-SCOPED: the subscription ────────────────────────────────────────
CREATE TABLE subscription (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          uuid NOT NULL REFERENCES organization(id),
    plan_code                text NOT NULL REFERENCES billing_plan(code),
    status                   text NOT NULL,
    -- Null on a plan with no trial. Set once, at creation, and never moved: a
    -- trial that can be extended by an UPDATE is a trial nobody can reason about
    -- from the row.
    trial_ends_at            timestamptz,
    current_period_start     timestamptz NOT NULL DEFAULT clock_timestamp(),
    current_period_end       timestamptz,
    -- The provider, as a slug — never a CHECK listing them. Null until somebody
    -- actually pays: a trialing tenant has no customer record anywhere yet, and
    -- modelling that as an empty string would make "not yet" and "none" the same
    -- value.
    provider                 text,
    provider_customer_ref    text,
    provider_subscription_ref text,
    cancelled_at             timestamptz,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- TRIALING  — inside a trial, full function.
    -- ACTIVE    — paying, full function.
    -- PAST_DUE  — a payment failed and the provider is retrying. STILL FULL
    --             FUNCTION, deliberately: a card that expired on a Friday is not
    --             a reason to stop a finance team working on Monday, and the
    --             provider's own dunning is what escalates it.
    -- LAPSED    — trial ended or dunning gave up. READ-ONLY (John, 6 Sep).
    -- CANCELLED — the customer left. Read-only too; the data stays for whatever
    --             the retention policy ends up saying, which is VX5-14's problem.
    CONSTRAINT subscription_status_check
        CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'LAPSED', 'CANCELLED')),
    -- A trialing subscription has a trial end. Nothing else may have one — a row
    -- that says ACTIVE with a future trial date is two claims about the same
    -- tenant, and the code reading it would have to pick.
    CONSTRAINT subscription_trial_has_end
        CHECK ((status = 'TRIALING') = (trial_ends_at IS NOT NULL)),
    CONSTRAINT subscription_cancelled_has_date
        CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
    -- Both provider references arrive together or not at all, and neither without
    -- a provider. Half a linkage is how a reconciliation job ends up guessing.
    CONSTRAINT subscription_provider_refs_together
        CHECK (num_nonnulls(provider, provider_customer_ref, provider_subscription_ref) IN (0, 3))
);

-- ONE LIVE SUBSCRIPTION PER TENANT. Cancelled rows are kept — they are the record
-- of what a customer used to pay — so this is partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX subscription_one_live_per_org_idx
    ON subscription (organization_id)
    WHERE status <> 'CANCELLED';

CREATE INDEX subscription_org_id_idx ON subscription (organization_id);

-- The scheduled job that moves TRIALING to LAPSED reads exactly this, across every
-- tenant, so it is worth an index rather than a sequential scan per run.
CREATE INDEX subscription_trial_expiry_idx
    ON subscription (trial_ends_at)
    WHERE status = 'TRIALING';

-- Globally unique where present: a provider's subscription id maps to exactly one
-- of ours. A webhook arrives carrying only that id, and the tenant it belongs to
-- has to be unambiguous at the moment there is no tenant context to disambiguate
-- with — the same argument as `invite_token_hash_idx` and for the same reason.
CREATE UNIQUE INDEX subscription_provider_sub_ref_idx
    ON subscription (provider, provider_subscription_ref)
    WHERE provider_subscription_ref IS NOT NULL;

ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- THE PLATFORM HATCH, and it is narrower than it looks.
--
-- Two callers need to cross tenants and neither is a user: the trial-expiry sweep,
-- and the webhook handler that has a provider reference and no tenant. Both run
-- under `app.platform_task`, which 0012 established and 0033 reused, rather than a
-- new flag — unlike `app.invite_lookup`, whose lifetime is a single statement in a
-- single sign-in, these are exactly the long-running background paths that flag
-- was introduced for.
--
-- FOR SELECT ONLY. A sweep that can also UPDATE across every tenant is one bug
-- away from cancelling everybody, so the write happens under a real tenant context
-- once the row has told the caller which tenant that is. Same rule as the invite
-- hatch: take nothing from this but the identity you needed to set the context.
CREATE POLICY subscription_platform_read ON subscription
    FOR SELECT
    USING (NULLIF(current_setting('app.platform_task', true), '') = 'on');

-- NO EXPLICIT GRANTS, and their absence is the convention rather than an
-- oversight: `ALTER DEFAULT PRIVILEGES` (HANDOFF §3) already gives `veloapp`
-- SELECT/INSERT/UPDATE/DELETE on every table created in this schema. No migration
-- since 0001 has granted per-table, and a `GRANT` here would read as though these
-- tables were special when the RLS policies above are what actually constrain them.
