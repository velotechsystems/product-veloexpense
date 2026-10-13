-- VeloExpense 0066_policy_cutover — Wave 4 (w4-02d, d63/d65/d67/d70).
--
-- The policy engine moves from VeloExpense's own (lib/policy, rule instances on
-- `expense_policy`) to ExpenseOS's (server/policy, rule instances on `policy_rule`, 0064,
-- and per-category limits on `expense_category_policy`, 0065). This migration carries each
-- tenant's rules across, reshapes `policy_violation` to ExpenseOS's `PolicyViolation`, and
-- drops `expense_policy`. Data steps live here, not in a sweep (the #211/#212 lesson).
--
-- ── How each v1 rule becomes an ExpenseOS rule instance ─────────────────────────────────
--
-- Every converted instance keeps the v1 row's severity, enabled flag, category scope and
-- window. A v1 window is in dates, inclusive at both ends and compared with today
-- (`effective_from <= CURRENT_DATE <= effective_to`); ExpenseOS's is timestamps compared
-- with now, so a v1 end date becomes the START of the following day (UTC, the database's
-- clock, which is what CURRENT_DATE read). No start means "always": 1970-01-01.
--
--   PER_TRANSACTION_LIMIT {thresholdMinor}  →  PREDICATE_LINE, `lineAmount > threshold`.
--       Not ExpenseOS's PER_TXN_LIMIT, which reads ONE limit per category from
--       `expense_category_policy` and takes its severity from one instance for every
--       category: v1 allowed a different severity per category and an all-categories rule
--       beside category ones, and only a per-row predicate keeps each exactly. `lineAmount`
--       is in minor units of the policy currency, as v1's threshold was.
--   RECEIPT_REQUIRED {thresholdMinor?}      →  RECEIPT_THRESHOLD {thresholdMinor}, '0' when
--       v1 had none ("a receipt on every expense"). Its category scope holds now that the
--       engine applies scope to AGGREGATE kinds (f36).
--   BUDGET_OVERAGE {}                       →  BUDGET_OVERAGE {}, fed from VeloExpense's
--       budgets (d66).
--   CATEGORY_ACTIVE {}                      →  CATEGORY_ACTIVE {}, VeloExpense's own kind (d70).
--   NON_NEGATIVE_AMOUNT {}                  →  nothing: the ported line inputs refuse a
--       negative amount outright (d70).
--
-- A v1 rule could state its threshold in its own currency (`currency_code`, 0015);
-- ExpenseOS's thresholds are always in the policy currency. Such a threshold is converted
-- at the tenant's latest rate for the pair (or the reciprocal of the opposite pair), at the
-- two currencies' exponents, rounded half away from zero. With no rate either way the
-- migration REFUSES, naming the tenant and the rule: guessing a threshold would be a
-- policy nobody chose.
--
-- ── policy_violation, to ExpenseOS's PolicyViolation ────────────────────────────────────
--
--   · gains `expense_id` (ExpenseOS's entry-level anchor), a composite key to `expense`,
--     filled for existing rows from their line, or from the expense id v1 kept in `data`.
--   · loses `policy_id` (its target is dropped), `finding_key` and `message_code` (v1's
--     identity and message-catalogue keys; ExpenseOS's rows are keyed by rule instance and
--     line, and carry the message key itself), and the identity index built on them.
--     ExpenseOS has no unique key here; its validate serializes per report by locking the
--     report row.
--   · findings on reports still being edited (DRAFT, RETURNED) are deleted: the next
--     validate writes them again under the new engine. Findings on every other report are
--     kept as the record of what the old engine said; their `rule_code` is a v1 kind name
--     and their `message` the sentence it wrote, which the screens show as written.

-- 1. Refuse a v1 threshold in a currency the tenant has no rate for.
DO $$
DECLARE bad record;
BEGIN
  FOR bad IN
    SELECT o.slug, p.kind, p.currency_code AS rule_currency, o.policy_currency_code AS policy_currency
      FROM expense_policy p
      JOIN organization o ON o.id = p.organization_id
     WHERE p.currency_code IS NOT NULL
       AND p.currency_code <> o.policy_currency_code
       AND p.params ? 'thresholdMinor'
       AND NOT EXISTS (SELECT 1 FROM fx_rate f
                        WHERE f.organization_id = p.organization_id
                          AND ((f.base = p.currency_code AND f.quote = o.policy_currency_code)
                            OR (f.base = o.policy_currency_code AND f.quote = p.currency_code)))
  LOOP
    RAISE EXCEPTION 'tenant % has a % rule stated in % and no FX rate between % and its policy currency %; add the rate (/admin/fx-rates) or restate the rule in %, then run this migration again',
      bad.slug, bad.kind, bad.rule_currency, bad.rule_currency, bad.policy_currency, bad.policy_currency;
  END LOOP;
END $$;

-- 2. Each v1 rule's threshold in the policy currency.
CREATE TEMP TABLE v1_rule ON COMMIT DROP AS
SELECT p.id, p.organization_id, p.kind, p.severity, p.enabled, p.category_id,
       COALESCE(p.effective_from::timestamp AT TIME ZONE 'UTC', '1970-01-01T00:00:00Z'::timestamptz) AS effective_from,
       CASE WHEN p.effective_to IS NULL THEN NULL
            ELSE (p.effective_to + 1)::timestamp AT TIME ZONE 'UTC' END AS effective_to,
       p.created_at,
       CASE
         WHEN NOT (p.params ? 'thresholdMinor') OR p.params->>'thresholdMinor' IS NULL THEN NULL
         WHEN p.currency_code IS NULL OR p.currency_code = o.policy_currency_code
           THEN (p.params->>'thresholdMinor')::numeric
         ELSE round(
                (p.params->>'thresholdMinor')::numeric
                * COALESCE(
                    (SELECT f.rate FROM fx_rate f
                      WHERE f.organization_id = p.organization_id
                        AND f.base = p.currency_code AND f.quote = o.policy_currency_code
                      ORDER BY f.fetched_at DESC LIMIT 1),
                    (SELECT 1 / f.rate FROM fx_rate f
                      WHERE f.organization_id = p.organization_id
                        AND f.base = o.policy_currency_code AND f.quote = p.currency_code
                      ORDER BY f.fetched_at DESC LIMIT 1))
                * power(10::numeric, tc.minor_unit - fc.minor_unit))
       END::bigint AS threshold_minor
  FROM expense_policy p
  JOIN organization o ON o.id = p.organization_id
  JOIN currency tc ON tc.code = o.policy_currency_code
  LEFT JOIN currency fc ON fc.code = p.currency_code;

-- 3. The ExpenseOS rule instances.
INSERT INTO policy_rule (organization_id, kind_code, scope, enabled, severity, condition, params,
                         message_key, category_id, effective_from, effective_to, created_at)
SELECT r.organization_id,
       m.kind_code, m.scope, r.enabled, r.severity, m.condition, m.params, m.message_key,
       r.category_id, r.effective_from, r.effective_to, r.created_at
  FROM v1_rule r
  CROSS JOIN LATERAL (
    SELECT 'PREDICATE_LINE' AS kind_code, 'LINE' AS scope,
           jsonb_build_object('all', jsonb_build_array(
             jsonb_build_object('field', 'lineAmount', 'op', 'gt', 'value', r.threshold_minor))) AS condition,
           '{}'::jsonb AS params, 'perTransactionLimit' AS message_key
     WHERE r.kind = 'PER_TRANSACTION_LIMIT' AND r.threshold_minor IS NOT NULL
    UNION ALL
    SELECT 'RECEIPT_THRESHOLD', 'AGGREGATE', NULL,
           jsonb_build_object('thresholdMinor', COALESCE(r.threshold_minor, 0)::text), 'receiptThreshold'
     WHERE r.kind = 'RECEIPT_REQUIRED'
    UNION ALL
    SELECT 'BUDGET_OVERAGE', 'AGGREGATE', NULL, '{}'::jsonb, 'budgetOverage'
     WHERE r.kind = 'BUDGET_OVERAGE'
    UNION ALL
    SELECT 'CATEGORY_ACTIVE', 'AGGREGATE', NULL, '{}'::jsonb, 'categoryInactive'
     WHERE r.kind = 'CATEGORY_ACTIVE'
  ) m;

-- 4. policy_violation → ExpenseOS's shape.
DELETE FROM policy_violation v
 USING expense_report r
 WHERE r.id = v.report_id AND r.status IN ('DRAFT', 'RETURNED');

ALTER TABLE policy_violation ADD COLUMN expense_id uuid;
UPDATE policy_violation v
   SET expense_id = li.expense_id
  FROM expense_line_item li
 WHERE li.id = v.line_item_id;
UPDATE policy_violation v
   SET expense_id = e.id
  FROM expense e
 WHERE v.expense_id IS NULL
   AND v.data ? 'expenseId'
   AND (v.data->>'expenseId') ~ '^[0-9a-fA-F-]{36}$'
   AND e.id = (v.data->>'expenseId')::uuid
   AND e.organization_id = v.organization_id;
ALTER TABLE policy_violation
  ADD CONSTRAINT policy_violation_expense_id_fkey
  FOREIGN KEY (organization_id, expense_id) REFERENCES expense (organization_id, id) ON DELETE CASCADE;
CREATE INDEX policy_violation_expense_idx ON policy_violation (expense_id);

ALTER TABLE policy_violation DROP CONSTRAINT policy_violation_policy_id_fkey;
DROP INDEX policy_violation_identity_idx;
ALTER TABLE policy_violation DROP COLUMN policy_id;
ALTER TABLE policy_violation DROP COLUMN finding_key;
ALTER TABLE policy_violation DROP COLUMN message_code;

-- 5. v1's rule table goes. `policy_severity` stays: `policy_rule` and `policy_violation` use it.
DROP TABLE expense_policy;
