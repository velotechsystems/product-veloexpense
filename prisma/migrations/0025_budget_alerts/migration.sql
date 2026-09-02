-- ════════════════════════════════════════════════════════════════════════════
-- 0025 — BUDGET ALERTS (VX4-5 part 3a, GAP-AUDIT BG-6)
--
-- ── BG-6: their idempotency is a mutable marker stamped after the fan-out ───
--
-- `fireBudgetThresholdAlerts` (`server/lib/budgetAlerts.ts:41-126`) reads
-- `BudgetPeriod.alertedThresholdBp`, skips when it is already at or past the
-- crossed level, notifies, and stamps the marker AFTERWARDS. Their comment says
-- why it is stamped last — "so a failure re-fires next time rather than marking a
-- crossing nobody was told about" — and that instinct is right. The mechanism
-- cannot deliver it. Three ways the same threshold notifies twice:
--
--   1. Two concurrent submits both pass the read. No row lock, no unique guard.
--   2. The fan-out succeeds and the stamp throws. Their `catch` swallows it, so
--      the next evaluation sends the identical alert again.
--   3. Editing a budget's periods deletes and recreates the rows, and the marker
--      goes with them.
--
-- So the marker is not a column here. `budget_alert_claim` is a UNIQUELY KEYED
-- ROW written in the same transaction that sends — the idiom `notification_
-- delivery` (0012) and the approval-decision claim (0008) already use, and the
-- third single-use guarantee in this schema after VX2-8's token consume.
--
--   · (1) becomes impossible: the loser of the race gets 0 rows from
--     `ON CONFLICT DO NOTHING RETURNING id` and sends nothing.
--   · (2) becomes impossible in the other direction too — see the SAVEPOINT note
--     in `lib/budgets/alerts.ts`. Claim and fan-out commit together or neither
--     does, so there is no ordering left to get wrong.
--   · (3) is handled by the FK: a claim belongs to a period and CASCADEs with it.
--     Recreating periods legitimately re-arms the alerts, which is the same
--     answer their marker gave by accident.
--
-- RE-ARMING IS A DELETE, not a nulled column. A period that falls back under
-- every threshold has its claims removed, so a later overage alerts again. Their
-- `clearBudgetAlertMarkers` exists for exactly this and its reasoning is kept:
-- without it, a budget that goes over, gets a correction and goes over again
-- stays silent the second time, because the first crossing suppresses it forever.
--
-- ── The module gate, and a gap in what VX4-5 parts 1-2 shipped ──────────────
--
-- `budgets` is one of the four modules the Plan names as per-tenant, and `0024`
-- created `budget` and `budget_period` with a plain `tenant_isolation` policy and
-- NO module predicate. That is an omission in my own earlier work rather than a
-- decision, and this is where it is corrected: every budget table gets `0022`'s
-- backstop, so a tenant without the module cannot see or write a budget row no
-- matter which code path asks.
--
-- It also does the data-plane gating for free, which is what makes it safe to add
-- mid-phase. `loadBudgetSnapshots` and `recomputeForReport` run inside submit and
-- approval for EVERY tenant; a `requireModule` that threw there would break submit
-- for every tenant without budgets. Under RLS those functions simply find no
-- budgets and no periods, and no-op — fail-closed with no code branch to forget.
-- The `requireModule` calls belong on the ADMINISTRATIVE entry points, which is
-- VX4-5 part 3b's screen, and the registry flip to `available: true` lands with
-- them so `test/module-gates.test.ts` has gates to enumerate.
-- ════════════════════════════════════════════════════════════════════════════

-- ── budget.owner_id ─────────────────────────────────────────────────────────
--
-- Who hears about it. Ported from their `Budget.ownerId`, whose own comment is
-- the argument for it: without an owner an overage alert has nowhere to go.
-- NULLABLE, because a budget with no owner is a real state (nobody has been made
-- responsible yet) and refusing to create one would be worse than an alert that
-- reaches only the threshold's named recipients.
ALTER TABLE budget ADD COLUMN owner_id uuid;

-- Composite, per TN-1: referential integrity runs as the constraint owner with
-- RLS BYPASSED, so a single-column REFERENCES would accept another tenant's user.
ALTER TABLE budget
    ADD CONSTRAINT budget_owner_id_fkey
    FOREIGN KEY (organization_id, owner_id)
    REFERENCES app_user (organization_id, id) ON DELETE SET NULL (owner_id);

CREATE INDEX budget_owner_idx ON budget (organization_id, owner_id);

COMMENT ON COLUMN budget.owner_id IS
    'Who is answerable for this budget, and the first recipient of a threshold '
    'alert. NULL is legitimate: an alert then reaches the threshold''s own '
    'recipients, and a threshold with none records the crossing and tells nobody.';

-- ── budget_alert_threshold ──────────────────────────────────────────────────

CREATE TABLE budget_alert_threshold (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    budget_id       uuid NOT NULL,
    -- BASIS POINTS, as theirs are: 9000 is 90%, 10000 is 100%. Integer maths all
    -- the way through, because a float here would put 10000.00000001 on the wrong
    -- side of the 100% line — their `crossedThreshold` says exactly that and it
    -- is the reason the unit is bp rather than a percentage with decimals.
    --
    -- THE UNITS TRAP IS REAL AND THIS CHECK DOES NOT CATCH IT: somebody meaning
    -- 90% who writes 90 gets 0.9%, which is a legal value and will alert on the
    -- first dollar. No constraint can tell those apart, so the conversion belongs
    -- in ONE place — part 3b's screen takes a percentage and multiplies. A seed or
    -- an import writing bp directly is on its own, and this comment is the warning.
    threshold_bp    int NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Above 200% is not a warning anybody configures; it is a units mistake in the
    -- other direction, or a test fixture nobody cleaned up.
    CONSTRAINT budget_alert_threshold_range CHECK (threshold_bp BETWEEN 1 AND 20000)
);

ALTER TABLE budget_alert_threshold
    ADD CONSTRAINT budget_alert_threshold_budget_id_fkey
    FOREIGN KEY (organization_id, budget_id)
    REFERENCES budget (organization_id, id) ON DELETE CASCADE;

-- Declared now rather than retrofitted, for `budget_alert_recipient` below —
-- `0019_composite_tenant_fks` exists because nineteen tables were created without
-- it and every FK into them was therefore cross-tenant-permissive.
ALTER TABLE budget_alert_threshold
    ADD CONSTRAINT budget_alert_threshold_org_id_uniq UNIQUE (organization_id, id);

-- One row per level per budget. Plain NULLs are impossible here (both columns are
-- NOT NULL), so this needs no NULLS NOT DISTINCT the way `budget_scope_unique` did.
CREATE UNIQUE INDEX budget_alert_threshold_unique
    ON budget_alert_threshold (organization_id, budget_id, threshold_bp);

ALTER TABLE budget_alert_threshold ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alert_threshold FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_alert_threshold
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'));

-- ── budget_alert_recipient ──────────────────────────────────────────────────
--
-- Who else hears about THIS level. Their design and its rule are both kept: the
-- owner is always told, and an empty recipient list means "owner only" rather
-- than "nobody" — which is why this is a separate table rather than a column, and
-- why the absence of rows is a normal state instead of a misconfiguration.

CREATE TABLE budget_alert_recipient (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    threshold_id    uuid NOT NULL,
    user_id         uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE budget_alert_recipient
    ADD CONSTRAINT budget_alert_recipient_threshold_id_fkey
    FOREIGN KEY (organization_id, threshold_id)
    REFERENCES budget_alert_threshold (organization_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT budget_alert_recipient_user_id_fkey
    FOREIGN KEY (organization_id, user_id)
    REFERENCES app_user (organization_id, id) ON DELETE CASCADE;

CREATE UNIQUE INDEX budget_alert_recipient_unique
    ON budget_alert_recipient (organization_id, threshold_id, user_id);

CREATE INDEX budget_alert_recipient_user_idx
    ON budget_alert_recipient (organization_id, user_id);

ALTER TABLE budget_alert_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alert_recipient FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_alert_recipient
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'));

-- ── budget_alert_claim — THE ATOMIC CLAIM ───────────────────────────────────
--
-- One row per (period, threshold) that has been alerted for. The row IS the
-- guarantee: `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns nothing to
-- the loser of a race, and a caller that gets nothing back sends nothing.
--
-- SUPPRESSION IS "THIS LEVEL OR HIGHER", which the unique index alone cannot
-- express — a period at 100% must not re-alert at 90%. That check is a read
-- (`WHERE threshold_bp >= $crossed`) and reads race; it is the fast-fail for
-- noise, exactly as `decide`'s read-check is a fast-fail for a good error message
-- while the `AND status = 'PENDING'` is the guard. The worst a lost race can do
-- here is send the 90% and the 100% alert for one movement, which are two real
-- crossings and not a duplicate.
CREATE TABLE budget_alert_claim (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    period_id       uuid NOT NULL,
    threshold_bp    int NOT NULL,
    -- What was true when it fired, so an admin reading the row later does not
    -- have to reconstruct it from a rollup that has moved since.
    used_minor      bigint NOT NULL,
    amount_minor    bigint NOT NULL,
    -- How many inboxes it reached. ZERO IS A REAL VALUE and is the "nobody to
    -- tell, but the crossing still happened" case their code handles explicitly:
    -- recording it stops a backlog of stale alerts arriving the day somebody is
    -- finally made owner.
    notified_count  int NOT NULL DEFAULT 0,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT budget_alert_claim_range CHECK (threshold_bp BETWEEN 1 AND 20000),
    CONSTRAINT budget_alert_claim_counts CHECK (notified_count >= 0)
);

-- CASCADE from the period, which is BG-6's third double-send path closed by
-- construction: editing a budget's periods deletes the rows, the claims go with
-- them, and the alerts legitimately re-arm.
ALTER TABLE budget_alert_claim
    ADD CONSTRAINT budget_alert_claim_period_id_fkey
    FOREIGN KEY (organization_id, period_id)
    REFERENCES budget_period (organization_id, id) ON DELETE CASCADE;

CREATE UNIQUE INDEX budget_alert_claim_unique
    ON budget_alert_claim (organization_id, period_id, threshold_bp);

ALTER TABLE budget_alert_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alert_claim FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_alert_claim
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'));

COMMENT ON TABLE budget_alert_claim IS
    'The atomic claim that makes a threshold alert fire once. Replaces '
    'ExpenseOS''s mutable BudgetPeriod.alertedThresholdBp marker (GAP-AUDIT '
    'BG-6), which could double-send three ways. Re-arming is a DELETE of these '
    'rows, done when a period falls back under every threshold.';

-- ── The gate 0024 should have carried ───────────────────────────────────────
--
-- See the header. Rewritten rather than added to, because a policy is replaced
-- whole; `0022` does the same for `gl_account`.
DROP POLICY tenant_isolation ON budget;
CREATE POLICY tenant_isolation ON budget
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'));

DROP POLICY tenant_isolation ON budget_period;
CREATE POLICY tenant_isolation ON budget_period
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('budgets'));
