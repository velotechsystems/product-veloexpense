-- VeloExpense 0064_policy_rule — Wave 4 (w4-02a, d63).
--
-- ExpenseOS's `PolicyRule` (its schema.prisma `model PolicyRule`, 550b2945): one row per
-- rule INSTANCE — a rule kind from the code registry (server/policy/kinds.ts), its
-- severity, its condition (a predicate over line or report facts, for the PREDICATE kinds),
-- its parameters, the label it raises, who it applies to and when. Any number of instances
-- of one kind, so "warn at $25, block at $75" is two rows (GAP-AUDIT PE-2), and the engine
-- keeps the most severe of them per line.
--
-- Nothing reads or writes this table until the cutover (w4-02c), when submit and validate
-- move onto ExpenseOS's engine and today's `expense_policy` rows are converted into it.
-- VeloExpense's own engine (lib/policy) keeps running every check until then.
--
-- Adapted (VeloExpense):
--   · per tenant, under RLS like every tenant table, with composite foreign keys (TN-1).
--   · ExpenseOS's two enums: `severity` is the `policy_severity` enum VeloExpense's policy
--     tables already use (0006); `scope` is text under a CHECK, as the Wave 2+ tables keep
--     enums. ExpenseOS's fourth scope, TRAVEL_REQUEST, is absent: travel is out of scope.
--   · the scope columns are ExpenseOS's six, each ON DELETE RESTRICT for its reason: with
--     SET NULL, deleting a business unit would silently turn its rule into one that
--     applies to everybody. `role_id` has no foreign key: VeloExpense has no role table
--     until the role builder (w4-10, d64), so the column is carried and nothing sets it.
--   · `created_by` is a bare id, as in ExpenseOS and 0058.
--
-- A new table, no rows: safe to deploy in a batch (d16).

CREATE TABLE policy_rule (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    kind_code        text NOT NULL,
    scope            text NOT NULL,
    enabled          boolean NOT NULL DEFAULT true,
    severity         policy_severity NOT NULL,
    condition        jsonb,
    params           jsonb NOT NULL DEFAULT '{}',
    message_key      text NOT NULL,
    department_id    uuid,
    job_level_id     uuid,
    legal_entity_id  uuid,
    business_unit_id uuid,
    role_id          uuid,
    category_id      uuid,
    effective_from   timestamptz NOT NULL,
    effective_to     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       uuid,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT policy_rule_scope CHECK (scope IN ('LINE', 'REPORT', 'AGGREGATE')),
    CONSTRAINT policy_rule_effective_range
      CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT policy_rule_department_fkey
      FOREIGN KEY (organization_id, department_id)
      REFERENCES department (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT policy_rule_job_level_fkey
      FOREIGN KEY (organization_id, job_level_id)
      REFERENCES job_level (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT policy_rule_legal_entity_fkey
      FOREIGN KEY (organization_id, legal_entity_id)
      REFERENCES legal_entity (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT policy_rule_business_unit_fkey
      FOREIGN KEY (organization_id, business_unit_id)
      REFERENCES business_unit (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT policy_rule_category_fkey
      FOREIGN KEY (organization_id, category_id)
      REFERENCES expense_category (organization_id, id) ON DELETE RESTRICT
);
-- ExpenseOS's two indexes, with the tenant leading.
CREATE INDEX policy_rule_enabled_scope_idx
    ON policy_rule (organization_id, enabled, scope, effective_from);
CREATE INDEX policy_rule_category_idx ON policy_rule (organization_id, category_id);

ALTER TABLE policy_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_rule FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_rule
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
