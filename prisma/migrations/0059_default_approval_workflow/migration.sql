-- VeloExpense 0059_default_approval_workflow — Wave 4 (w4-00c-1, d54 / d56).
--
-- Two things the cutover (w4-00c-2) needs in place before it switches approvals onto
-- ExpenseOS's engine. Nothing reads either until then; the ladder still routes.
--
-- 1. `expense_report.approval_instance_id` — ExpenseOS's `ExpenseReport.approvalInstanceId`:
--    the run currently deciding the report, which submit sets and recall / return clear.
--    A composite tenant key (TN-1), set null if the run is ever removed.
--
-- 2. The default approval flow, for every tenant that exists today (a tenant provisioned
--    from now on gets it in `createOrganization`, lib/approvals/defaultWorkflow.ts, which
--    holds the same graph). ExpenseOS's engine APPROVES a subject no workflow governs, so a
--    tenant must never reach the cutover without one:
--      Start → the submitter's manager → Approved; with no manager on file, the tenant's
--      first active administrator (oldest first). No deadline, no escalation (d56). It is
--      an ordinary published workflow, the default for expense reports, which admins
--      change in the builder.
--    A tenant that already has a workflow under this key is left alone. A tenant with no
--    active administrator gets no fallback, and the engine's unassigned-pool rule applies.
--
-- Data written per tenant, under each tenant's scope (as 0055 does): safe in a batch.

ALTER TABLE expense_report ADD COLUMN approval_instance_id uuid;
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_approval_instance_id_fkey
    FOREIGN KEY (organization_id, approval_instance_id)
    REFERENCES approval_instance (organization_id, id) ON DELETE SET NULL (approval_instance_id);
CREATE INDEX expense_report_approval_instance_id_idx ON expense_report (approval_instance_id);

DO $$
DECLARE
  org uuid;
  admin uuid;
  wf uuid;
  ver uuid;
  approver jsonb;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM approval_workflow WHERE organization_id = org AND key = 'expense-report-default'
    );
    SELECT u.id INTO admin
      FROM app_user u
     WHERE u.organization_id = org
       AND u.role = 'ADMIN'
       AND u.deleted_at IS NULL
       AND u.employee_status = 'ACTIVE'
     ORDER BY u.created_at, u.id
     LIMIT 1;
    approver := CASE
      WHEN admin IS NULL THEN jsonb_build_object('kind', 'manager')
      ELSE jsonb_build_object('kind', 'manager',
             'fallback', jsonb_build_object('kind', 'user', 'userId', admin))
    END;

    INSERT INTO approval_workflow
        (organization_id, key, name, description, subject_type, is_default, priority, active, created_by)
    VALUES (org, 'expense-report-default', 'Default — Manager approval',
            'The submitter''s direct manager approves. With no manager on file, the fallback approver does.',
            'EXPENSE_REPORT', true, 0, true, admin)
    RETURNING id INTO wf;

    INSERT INTO approval_workflow_version
        (organization_id, workflow_id, version, match_condition, graph, status, published_at, published_by)
    VALUES (org, wf, 1, '{"always": true}'::jsonb,
            jsonb_build_object(
              'nodes', jsonb_build_array(
                jsonb_build_object('id', 'start', 'type', 'start',
                                   'position', jsonb_build_object('x', 240, 'y', 40)),
                jsonb_build_object('id', 'manager', 'type', 'approval', 'approver', approver,
                                   'position', jsonb_build_object('x', 240, 'y', 170)),
                jsonb_build_object('id', 'approved', 'type', 'approved',
                                   'position', jsonb_build_object('x', 240, 'y', 320))),
              'edges', jsonb_build_array(
                jsonb_build_object('id', 'e1', 'source', 'start', 'target', 'manager'),
                jsonb_build_object('id', 'e2', 'source', 'manager', 'target', 'approved'))),
            'PUBLISHED', now(), admin)
    RETURNING id INTO ver;

    UPDATE approval_workflow SET current_version_id = ver WHERE id = wf;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
