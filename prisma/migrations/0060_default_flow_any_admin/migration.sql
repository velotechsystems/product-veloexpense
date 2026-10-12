-- VeloExpense 0060_default_flow_any_admin — Wave 4 (w4-00c-1, d59).
--
-- The default approval flow 0059 wrote names the tenant's FIRST ADMINISTRATOR as the
-- approver when the submitter has no manager. That routes the first admin's own reports
-- back to them whenever they have no manager on file, and nobody approves their own
-- expenses (4 Oct 2026). d59: the fallback is the Admin system role instead — any
-- administrator but the submitter may take the approval, as the ladder allowed.
--
-- 0059 is left as it was applied; this rewrites what it wrote. Only a default flow nobody
-- has changed is touched: the `expense-report-default` workflow whose current version is
-- still its version 1, whose manager step is still 0059's (a manager approver with a named
-- user as the fallback, or none), and on which no approval has run. A flow an admin has
-- edited in the builder is left alone. Nothing routes through the engine until the cutover
-- (w4-00c-2), so no running approval sees the change.
--
-- Data written per tenant, under each tenant's scope (as 0059 does): safe in a batch.

DO $$
DECLARE
  org uuid;
  -- The Admin system role (@expenseos/rbac SYSTEM_ROLE_IDS.admin).
  approver constant jsonb := jsonb_build_object('kind', 'manager',
    'fallback', jsonb_build_object('kind', 'role', 'roleId', '019e3000-0000-7000-8000-000000000001'));
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE approval_workflow_version v
       SET graph = jsonb_set(v.graph, '{nodes}', (
             SELECT jsonb_agg(
                      CASE WHEN e.n->>'id' = 'manager' THEN jsonb_set(e.n, '{approver}', approver)
                           ELSE e.n END
                      ORDER BY e.ord)
               FROM jsonb_array_elements(v.graph->'nodes') WITH ORDINALITY AS e(n, ord)))
      FROM approval_workflow w
     WHERE w.organization_id = org
       AND w.key = 'expense-report-default'
       AND w.current_version_id = v.id
       AND v.version = 1
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(v.graph->'nodes') AS m(n)
              WHERE m.n->>'id' = 'manager'
                AND m.n->'approver'->>'kind' = 'manager'
                AND COALESCE(m.n->'approver'->'fallback'->>'kind', 'user') = 'user')
       AND NOT EXISTS (SELECT 1 FROM approval_instance i WHERE i.workflow_version_id = v.id);
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
