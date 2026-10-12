-- VeloExpense 0062_drop_approval_ladder — Wave 4 (w4-00d, d50 / d61).
--
-- The approval ladder (0008, 0009) is retired. Since 0061 every approval runs on
-- ExpenseOS's engine (approval_instance / approval_instance_task, 0058), and nothing reads
-- the ladder's tables any more. d61: they are dropped outright, with no export — no real
-- customer approved on the ladder. Every decision made on it stays where it already is: in
-- the audit chain (REPORT_APPROVED / _REJECTED / _RETURNED, APPROVAL_STEP_APPROVED, with
-- the note and the override) and in each report's history (expense_report_event).
--
-- 1. A GUARD first. The cutover's recall (d52, the worker's approval sweep) puts every
--    report the ladder left SUBMITTED back to DRAFT. A report still SUBMITTED with no
--    approval instance is one it has not reached — a tenant the sweep skipped — and
--    dropping its ladder run would strand it: out for approval with nothing to approve.
--    So the migration refuses, naming the tenant, until the sweep has run there.
-- 2. Approve links: 0061 retired every ladder link; they go, the ladder's column with them,
--    and a link must now name an engine task.
-- 3. The four tables and their two enum types.
--
-- Data written per tenant, under each tenant's scope (as 0059 does): safe in a batch.

DO $$
DECLARE
  org record;
  stranded int;
BEGIN
  FOR org IN SELECT id, slug FROM organization LOOP
    PERFORM set_config('app.current_org', org.id::text, true);
    SELECT count(*) INTO stranded
      FROM expense_report
     WHERE organization_id = org.id AND status = 'SUBMITTED' AND approval_instance_id IS NULL;
    IF stranded > 0 THEN
      RAISE EXCEPTION
        'tenant % still has % report(s) SUBMITTED on the approval ladder; run the approval sweep '
        '(worker job approval.sweepExpired) for it before this migration', org.slug, stranded;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    DELETE FROM action_token WHERE organization_id = org AND task_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;

ALTER TABLE action_token DROP CONSTRAINT action_token_one_task;
ALTER TABLE action_token DROP COLUMN task_id;
ALTER TABLE action_token ALTER COLUMN instance_task_id SET NOT NULL;

DROP TABLE approval_task;
DROP TABLE approval_request;
DROP TABLE approval_policy_approver;
DROP TABLE approval_policy;
DROP TYPE approval_task_status;
DROP TYPE approval_request_status;
