-- VeloExpense 0065_expense_category_policy — Wave 4 (w4-02c, d63, d65).
--
-- ExpenseOS's `ExpensePolicy` (its schema.prisma `model ExpensePolicy`, 550b2945): one row
-- per expense category, holding the category's limits and receipt flag. ExpenseOS's
-- built-in rule kinds read it (server/policy/builtinKinds.ts): PER_TXN_LIMIT reads
-- `per_transaction_limit_minor`, RUNNING_LIMIT the daily / monthly / annual limits, and
-- RECEIPT_REQUIRED `receipt_required`. So it has to exist before the cutover (w4-02d) moves
-- submit onto that engine (d65 put this PR first for that reason).
--
-- Nothing reads it until the cutover. VeloExpense's own engine (lib/policy) keeps its
-- per-category limits on `expense_policy` (0006) until then; the cutover converts them in.
--
-- Adapted (VeloExpense):
--   · named `expense_category_policy`: `expense_policy` is VeloExpense's v1 rule table
--     until the cutover drops it. The Prisma model keeps ExpenseOS's name, `ExpensePolicy`.
--   · per tenant, under RLS like every tenant table, with a composite foreign key to the
--     category (TN-1). ON DELETE CASCADE, ExpenseOS's choice: the policy is the category's.
--   · a limit cannot be negative (a CHECK, answered as a 4xx by the router). ExpenseOS's
--     form refuses it; its column does not.

CREATE TABLE expense_category_policy (
    category_id                 uuid PRIMARY KEY,
    organization_id             uuid NOT NULL REFERENCES organization(id)
                                DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    receipt_required            boolean NOT NULL DEFAULT true,
    approval_required           boolean NOT NULL DEFAULT true,
    per_transaction_limit_minor bigint,
    daily_limit_minor           bigint,
    monthly_limit_minor         bigint,
    annual_limit_minor          bigint,
    notes                       text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, category_id),
    CONSTRAINT expense_category_policy_limits_nonnegative CHECK (
        (per_transaction_limit_minor IS NULL OR per_transaction_limit_minor >= 0)
        AND (daily_limit_minor IS NULL OR daily_limit_minor >= 0)
        AND (monthly_limit_minor IS NULL OR monthly_limit_minor >= 0)
        AND (annual_limit_minor IS NULL OR annual_limit_minor >= 0)
    ),
    CONSTRAINT expense_category_policy_category_fkey
      FOREIGN KEY (organization_id, category_id)
      REFERENCES expense_category (organization_id, id) ON DELETE CASCADE
);

ALTER TABLE expense_category_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_category_policy FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_category_policy
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
