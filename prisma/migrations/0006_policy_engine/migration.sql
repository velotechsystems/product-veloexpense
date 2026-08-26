-- VeloExpense 0006 — policy engine v1 (VX1-7, ExpenseOS Module 9).
--
-- Two NEW tenant tables, so both take the full treatment: organization_id +
-- org index + ENABLE/FORCE RLS + tenant_isolation (NULLIF form), and both are
-- added to test/rls-isolation.test.ts (CI's RLS-coverage guard fails otherwise).
--
-- Shape follows ExpenseOS's v2 policy architecture: rule TYPES live in code
-- (lib/policy/rules.ts RULE_KINDS), rule INSTANCES are rows here, so an admin
-- can retune limits per tenant with no deploy. Trimmed to v1: no predicate DSL,
-- no job-level/entity scoping, no per-report rule versioning — a rule change
-- takes effect on the next validation, which is what Module 9 specifies.
--
-- Deferred to later phases: mileage/per-diem rules, custom-field requirements,
-- duplicate detection, fiscal-period close, i18n message keys.

CREATE TYPE policy_severity AS ENUM ('INFO', 'WARNING', 'BLOCK');

-- ── Expense policy (a rule instance) ─────────────────────────────────────────
CREATE TABLE expense_policy (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- Validated against the code registry (lib/policy/rules.ts), NOT a CHECK
    -- constraint: adding a rule kind must not require a migration.
    kind            text NOT NULL,
    severity        policy_severity NOT NULL DEFAULT 'WARNING',
    enabled         boolean NOT NULL DEFAULT true,
    -- NULL = applies to every category.
    category_id     uuid REFERENCES expense_category(id) ON DELETE CASCADE,
    params          jsonb NOT NULL DEFAULT '{}'::jsonb,
    effective_from  date,
    effective_to    date,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT expense_policy_effective_range
        CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);
CREATE INDEX expense_policy_org_id_idx ON expense_policy (organization_id);
-- One rule of a kind per scope. A plain UNIQUE would not dedupe the
-- "all categories" rows, because NULLs are distinct in Postgres.
CREATE UNIQUE INDEX expense_policy_kind_scope_idx
    ON expense_policy (
        organization_id,
        kind,
        COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );
ALTER TABLE expense_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_policy FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_policy
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Policy violation (a finding against one report) ──────────────────────────
CREATE TABLE policy_violation (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    report_id       uuid NOT NULL REFERENCES expense_report(id) ON DELETE CASCADE,
    -- NULL for a finding about the report or an expense rather than one line.
    line_item_id    uuid REFERENCES expense_line_item(id) ON DELETE CASCADE,
    policy_id       uuid REFERENCES expense_policy(id) ON DELETE CASCADE,
    rule_code       text NOT NULL,
    severity        policy_severity NOT NULL,
    message         text NOT NULL,
    -- Disambiguates several findings of the same rule at the same scope (e.g.
    -- three expenses each missing a receipt). ExpenseOS keys violations on
    -- (ruleCode, lineItemId) alone and documents the consequence: "a rule that
    -- emits several findings for one line silently loses all but the first".
    -- This column is that bug's fix; '' means "the only finding of its kind".
    finding_key     text NOT NULL DEFAULT '',
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Acknowledgement (Module 9's override-with-justification). BLOCK findings
    -- are never acknowledgeable — the service refuses; they must be fixed.
    resolved_at     timestamptz,
    resolved_by_id  uuid REFERENCES app_user(id),
    resolve_note    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT policy_violation_resolution_complete
        CHECK ((resolved_at IS NULL AND resolved_by_id IS NULL)
            OR (resolved_at IS NOT NULL AND resolved_by_id IS NOT NULL))
);
CREATE INDEX policy_violation_org_id_idx ON policy_violation (organization_id);
CREATE INDEX policy_violation_report_idx ON policy_violation (report_id);
CREATE INDEX policy_violation_rule_idx   ON policy_violation (rule_code, severity);
-- Identity: one row per (report, rule, scope, finding). Re-validation upserts
-- against this, which is what lets an acknowledgement survive a re-run.
CREATE UNIQUE INDEX policy_violation_identity_idx
    ON policy_violation (
        report_id,
        rule_code,
        COALESCE(line_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
        finding_key
    );
ALTER TABLE policy_violation ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_violation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_violation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
