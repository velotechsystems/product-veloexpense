-- Wave 0 of the ExpenseOS port (decided 7 Oct): ported code runs on Prisma, and
-- ExpenseOS's `create` calls carry no organization. The database supplies it.
--
-- Every tenant table's `organization_id` defaults to the transaction's scope:
--
--     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid
--
-- WHY THIS IS SAFE, and not a loosening:
--   · The scope is set only by `withOrg` / `withTenantDb`, from the session's
--     organization, as the first statement of the transaction.
--   · No scope -> NULL -> the NOT NULL constraint refuses the row. An unscoped
--     write fails; it never lands in some default tenant.
--   · A caller that names a DIFFERENT organization is still refused by the
--     policy's WITH CHECK (tenant_isolation), exactly as before.
--   · NULLIF(…, '') is the house rule (HANDOFF §1): a pooled connection that has
--     carried a scope reads back '' afterwards, and ''::uuid raises.
--
-- Existing code that passes organization_id explicitly is unaffected.
--
-- Applied to every table that has the column, so none is missed; the test
-- `test/prisma-tenancy.db.test.ts` fails if a table added later lacks it.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN organization_id SET DEFAULT NULLIF(current_setting(''app.current_org'', true), '''')::uuid',
      t
    );
  END LOOP;
END $$;
