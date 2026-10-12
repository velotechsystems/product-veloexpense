-- VeloExpense 0061_approval_cutover — Wave 4 (w4-00c-2, d50 / d52 / d57).
--
-- Approvals move from the ladder (approval_request / approval_task, 0008) to ExpenseOS's
-- engine (approval_instance / approval_instance_task, 0058). The ladder's tables stay, read
-- only for history, until w4-00d retires them. Two schema changes:
--
-- 1. An emailed approve link (`action_token`, 0012) names an ENGINE task: a new
--    `instance_task_id`, a composite tenant key like every other (TN-1), and `task_id`
--    (the ladder's task) becomes nullable — exactly one of the two is set. Every link still
--    live in a mailbox names a ladder task, which the cutover cancels, so each is retired
--    here (consumed) rather than left to be refused one click at a time.
--
-- 2. A report's history row (`expense_report_event`, 0007) may name no person: an approval
--    deadline that passed, a workflow that decided on submit, and the cutover's own recall
--    (d52) are transitions nobody made. `actor_id` becomes nullable, and a row without one
--    must say what made it (`context.system`), as the audit chain's system rows do.
--
-- The reports still SUBMITTED on the ladder are NOT recalled here. A recall recomputes the
-- budgets and writes the audit chain, which SQL cannot do faithfully; the worker's first
-- approval sweep does it at boot (`recallLadderSubmissions`, lib/expenses/lifecycle.ts).
--
-- Data written per tenant, under each tenant's scope (as 0059 does): safe in a batch.

ALTER TABLE action_token ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE action_token ADD COLUMN instance_task_id uuid;
ALTER TABLE action_token
    ADD CONSTRAINT action_token_instance_task_id_fkey
    FOREIGN KEY (organization_id, instance_task_id)
    REFERENCES approval_instance_task (organization_id, id) ON DELETE CASCADE;
ALTER TABLE action_token
    ADD CONSTRAINT action_token_one_task CHECK (num_nonnulls(task_id, instance_task_id) = 1);
CREATE INDEX action_token_instance_task_id_idx ON action_token (instance_task_id);

ALTER TABLE expense_report_event ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE expense_report_event
    ADD CONSTRAINT expense_report_event_actor_or_system
    CHECK (actor_id IS NOT NULL OR context ? 'system');

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE action_token SET consumed_at = clock_timestamp()
     WHERE organization_id = org AND consumed_at IS NULL AND task_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
