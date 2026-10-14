-- VeloExpense 0070_role_builder — Wave 4 (w4-10c, d64, d73).
--
-- What ExpenseOS's Role Builder (server/routers/roles.ts, /admin/roles) needs of the role
-- table 0068 made, plus the one permission ExpenseOS added since (its #571).
--
--   · `role_external_id` — ExpenseOS's `RoleExternalId`: a role's ids in outside systems,
--     one row per source, as every other lookup has (department_external_id and kin, 0047).
--     Per tenant, under RLS, with composite foreign keys to the tenant's source and role;
--     a role's aliases go with it (Cascade, as ExpenseOS's).
--   · `policy_rule.role_id` — carried since 0064 with nothing behind it (d64). It now
--     names a role of the same tenant (composite foreign key). ExpenseOS's is Restrict on
--     purpose: a rule's null scope means "applies to everyone", so a role that vanished
--     from under a rule must not silently widen it. NO ACTION here (checked at the end of
--     the statement), so deleting an organization, which cascades to both, still works;
--     the Role Builder refuses to delete a role a rule names before the key ever fires.
--   · `vcc.card.edit.sensitive` (ExpenseOS 20261009120000): unioned into every tenant's
--     System Administrator role, keyed on its fixed id, ordered and de-duplicated, as
--     ExpenseOS's migration does. Card Administrator does not receive it. And
--     `seed_system_roles` is replaced with the registry's lists as of this migration, so
--     a tenant created from now on starts with it — test/system-role-permissions.db.test.ts
--     checks both.
--   · No audit rows, as ExpenseOS's: the chain is hash-linked, and a row written by hand in
--     SQL could break its verification.

CREATE TABLE role_external_id (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id       uuid NOT NULL,
    source_value    text NOT NULL,
    role_id         uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, source_value),
    CONSTRAINT role_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT role_external_id_role_fkey
      FOREIGN KEY (organization_id, role_id)
      REFERENCES role (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX role_external_id_role_idx ON role_external_id (organization_id, role_id);

ALTER TABLE role_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE policy_rule
    ADD CONSTRAINT policy_rule_role_fkey
    FOREIGN KEY (organization_id, role_id) REFERENCES role (organization_id, id);
CREATE INDEX policy_rule_role_idx ON policy_rule (organization_id, role_id);

-- ── vcc.card.edit.sensitive, for every tenant's System Administrator ─────────

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE role SET permissions = (
      SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(
        permissions || ARRAY['vcc.card.edit.sensitive']::text[]
      ) AS p
    )
    WHERE organization_id = org AND id = '019e3000-0000-7000-8000-000000000001';
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;

-- ── seed_system_roles, with the registry's lists as of this migration ────────

CREATE OR REPLACE FUNCTION seed_system_roles(org uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  previous text := current_setting('app.current_org', true);
BEGIN
  PERFORM set_config('app.current_org', org::text, true);
  INSERT INTO role (organization_id, id, label, description, is_system, active, permissions)
  SELECT org, v.id, v.label, v.description, true, true, v.permissions
    FROM (VALUES
      -- admin
      ('019e3000-0000-7000-8000-000000000001'::uuid, '{"en":"System Administrator","fr-CA":"Administrateur système"}'::jsonb,
       '{"en":"Full platform control: users, roles, integrations, security, retention.","fr-CA":"Contrôle complet de la plateforme : utilisateurs, rôles, intégrations, sécurité, conservation."}'::jsonb,
       ARRAY[
          'user.read.own', 'user.read.all', 'user.create', 'user.update',
          'user.deactivate', 'user.setRole', 'user.setOnLeave', 'config.policy.read',
          'config.policy.update', 'config.currency.update', 'config.fxRate.update', 'config.perDiem.update',
          'config.mileage.update', 'config.glAccount.update', 'config.budgetCategory.update', 'config.customField.update',
          'config.jobLevel.update', 'config.fiscalYear.update', 'expense.report.read.own', 'expense.report.read.reportingChain',
          'expense.report.read.all', 'expense.report.create.own', 'expense.report.update.own', 'expense.report.delete.draft',
          'expense.report.submit.own', 'expense.report.approve', 'expense.report.reject', 'expense.report.return',
          'expense.report.reimburse', 'expense.report.reassign', 'expense.report.decide.any', 'expense.report.fxOverride',
          'travel.request.create.own', 'travel.request.update.own', 'travel.request.submit.own', 'travel.request.approve',
          'travel.request.reject', 'travel.request.return', 'travel.request.decide.any', 'vcc.request.own',
          'vcc.request.approve', 'vcc.request.reject', 'vcc.request.decide.any', 'vcc.card.read.all',
          'vcc.card.issue', 'vcc.card.edit.sensitive', 'vcc.card.close', 'vcc.card.reassign',
          'vcc.limit.requestIncrease', 'vcc.transaction.import', 'vcc.transaction.match', 'ledger.reference.view',
          'ledger.reference.sync', 'ledger.reference.delete', 'ledger.mapping.manage', 'ledger.sync.push',
          'ledger.sync.retry', 'delegation.create.own', 'delegation.create.any', 'delegation.revoke.own',
          'delegation.revoke.any', 'delegation.view.all', 'policy.violation.override', 'budget.read',
          'budget.view.all', 'budget.create', 'budget.update', 'budget.delete',
          'notification.read.own', 'notification.template.update', 'notification.retry', 'notification.queue.view',
          'audit.read', 'audit.chain.verify', 'audit.fraudFlag.review', 'audit.controlEvaluation.run',
          'analytics.dashboard.view', 'analytics.view.own', 'analytics.view.reportingChain', 'analytics.view.all',
          'analytics.report.build', 'analytics.export.schedule', 'analytics.permissions.set', 'analytics.override.grant',
          'admin.role.create', 'admin.role.update', 'admin.role.delete', 'admin.role.list',
          'admin.businessUnit.create', 'admin.businessUnit.update', 'admin.businessUnit.delete', 'admin.businessUnit.list',
          'admin.legalEntity.create', 'admin.legalEntity.update', 'admin.legalEntity.delete', 'admin.legalEntity.list',
          'admin.department.create', 'admin.department.update', 'admin.department.delete', 'admin.department.list',
          'admin.expenseCategory.create', 'admin.expenseCategory.update', 'admin.expenseCategory.list', 'admin.travelCategory.create',
          'admin.travelCategory.update', 'admin.travelCategory.list', 'admin.module.view', 'admin.module.manage',
          'admin.approvalWorkflow.view', 'admin.approvalWorkflow.manage', 'admin.integration.view', 'admin.integration.update',
          'admin.apiKey.create', 'admin.apiKey.revoke', 'admin.apiKey.list', 'admin.webhook.view',
          'admin.appSettings.update', 'admin.help.manage'
       ]::text[]),
      -- expense-administrator
      ('019e3000-0000-7000-8000-000000000002'::uuid, '{"en":"Expense Administrator","fr-CA":"Administrateur des dépenses"}'::jsonb,
       '{"en":"Owns the expense process company-wide (policy, GL, reimbursement). Cannot administer the platform itself.","fr-CA":"Responsable du processus de dépenses à l''échelle de l''entreprise (politique, GL, remboursement). N''administre pas la plateforme elle-même."}'::jsonb,
       ARRAY[
          'user.read.own', 'user.read.all', 'config.policy.read', 'config.policy.update',
          'config.currency.update', 'config.fxRate.update', 'config.perDiem.update', 'config.mileage.update',
          'config.glAccount.update', 'config.budgetCategory.update', 'config.customField.update', 'config.jobLevel.update',
          'config.fiscalYear.update', 'expense.report.read.own', 'expense.report.read.reportingChain', 'expense.report.read.all',
          'expense.report.create.own', 'expense.report.update.own', 'expense.report.delete.draft', 'expense.report.submit.own',
          'expense.report.approve', 'expense.report.reject', 'expense.report.return', 'expense.report.reimburse',
          'expense.report.reassign', 'expense.report.decide.any', 'expense.report.fxOverride', 'travel.request.create.own',
          'travel.request.update.own', 'travel.request.submit.own', 'travel.request.approve', 'travel.request.reject',
          'travel.request.return', 'travel.request.decide.any', 'vcc.request.own', 'vcc.request.approve',
          'vcc.request.reject', 'vcc.transaction.import', 'vcc.transaction.match', 'ledger.reference.view',
          'ledger.mapping.manage', 'ledger.sync.push', 'ledger.sync.retry', 'delegation.view.all',
          'admin.expenseCategory.list', 'admin.expenseCategory.create', 'admin.expenseCategory.update', 'budget.read',
          'budget.view.all', 'budget.create', 'budget.update', 'budget.delete',
          'notification.read.own', 'notification.template.update', 'notification.retry', 'notification.queue.view',
          'audit.read', 'audit.fraudFlag.review', 'audit.controlEvaluation.run', 'analytics.dashboard.view',
          'analytics.view.own', 'analytics.view.reportingChain', 'analytics.view.all', 'analytics.report.build',
          'analytics.export.schedule', 'analytics.override.grant', 'policy.violation.override'
       ]::text[]),
      -- card-administrator
      ('019e3000-0000-7000-8000-000000000005'::uuid, '{"en":"Card Administrator","fr-CA":"Administrateur des cartes"}'::jsonb,
       NULL,
       ARRAY[
          'user.read.own', 'expense.report.read.own', 'expense.report.create.own', 'expense.report.update.own',
          'expense.report.delete.draft', 'expense.report.submit.own', 'travel.request.create.own', 'travel.request.update.own',
          'travel.request.submit.own', 'vcc.request.own', 'notification.read.own', 'analytics.view.own',
          'analytics.dashboard.view', 'user.read.all', 'vcc.request.approve', 'vcc.request.reject',
          'vcc.card.read.all', 'vcc.card.issue', 'vcc.card.close', 'vcc.card.reassign',
          'vcc.limit.requestIncrease', 'vcc.transaction.import', 'vcc.transaction.match', 'ledger.reference.view',
          'ledger.sync.push', 'ledger.sync.retry', 'delegation.create.own', 'delegation.revoke.own'
       ]::text[]),
      -- ap-clerk
      ('019e3000-0000-7000-8000-000000000006'::uuid, '{"en":"AP Clerk","fr-CA":"Commis aux comptes payables"}'::jsonb,
       NULL,
       ARRAY[
          'user.read.own', 'expense.report.read.own', 'expense.report.create.own', 'expense.report.update.own',
          'expense.report.delete.draft', 'expense.report.submit.own', 'travel.request.create.own', 'travel.request.update.own',
          'travel.request.submit.own', 'vcc.request.own', 'notification.read.own', 'analytics.view.own',
          'analytics.dashboard.view', 'user.read.all', 'expense.report.read.all', 'expense.report.reimburse',
          'vcc.card.read.all', 'vcc.transaction.import', 'vcc.transaction.match', 'ledger.reference.view',
          'ledger.sync.push', 'ledger.sync.retry', 'analytics.view.all'
       ]::text[]),
      -- employee
      ('019e3000-0000-7000-8000-000000000004'::uuid, '{"en":"Employee","fr-CA":"Employé"}'::jsonb,
       '{"en":"Default role. Captures and submits own spend.","fr-CA":"Rôle par défaut. Saisit et soumet ses propres dépenses."}'::jsonb,
       ARRAY[
          'user.read.own', 'expense.report.read.own', 'expense.report.create.own', 'expense.report.update.own',
          'expense.report.delete.draft', 'expense.report.submit.own', 'travel.request.create.own', 'travel.request.update.own',
          'travel.request.submit.own', 'vcc.request.own', 'notification.read.own', 'analytics.view.own',
          'analytics.dashboard.view', 'expense.report.read.reportingChain', 'expense.report.approve', 'expense.report.reject',
          'expense.report.return', 'travel.request.approve', 'travel.request.reject', 'travel.request.return',
          'vcc.request.approve', 'vcc.request.reject', 'delegation.create.own', 'delegation.revoke.own',
          'budget.read', 'analytics.view.reportingChain'
       ]::text[]),
      -- executive
      ('019e3000-0000-7000-8000-000000000007'::uuid, '{"en":"Executive","fr-CA":"Direction"}'::jsonb,
       NULL,
       ARRAY[
          'user.read.own', 'expense.report.read.own', 'expense.report.create.own', 'expense.report.update.own',
          'expense.report.delete.draft', 'expense.report.submit.own', 'travel.request.create.own', 'travel.request.update.own',
          'travel.request.submit.own', 'vcc.request.own', 'notification.read.own', 'analytics.view.own',
          'analytics.dashboard.view', 'analytics.view.reportingChain', 'analytics.view.all', 'analytics.report.build',
          'analytics.export.schedule'
       ]::text[])
    ) AS v (id, label, description, permissions)
  ON CONFLICT (organization_id, id) DO NOTHING;
  PERFORM set_config('app.current_org', COALESCE(previous, ''), true);
END
$fn$;

-- ── invite.role_id: a deleted role leaves an invitation's history, not a dead key ──
--
-- A role somebody has been invited to and not yet accepted cannot be deleted: the Role
-- Builder refuses, as it does for a role somebody holds (server/routers/roles.ts). An
-- invitation that is over — accepted, withdrawn or expired — still names the role it
-- offered, and would otherwise block the delete forever. So the key forgets a deleted role
-- on those rows, naming the column so the organization stays (`SET NULL (role_id)`, as
-- 0014 does for gl_account_id). What the invitation offered stays in the audit chain
-- (INVITE_SENT / INVITE_ACCEPTED record the role by id and by label, 0069).

ALTER TABLE invite ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE invite DROP CONSTRAINT invite_role_fkey;
ALTER TABLE invite
    ADD CONSTRAINT invite_role_fkey
    FOREIGN KEY (organization_id, role_id) REFERENCES role (organization_id, id)
    ON DELETE SET NULL (role_id);
