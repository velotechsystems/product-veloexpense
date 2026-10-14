-- VeloExpense 0068_role — Wave 4 (w4-10a, d73).
--
-- ExpenseOS's `Role` (its 20260519020417_rbac_role_table and later, 550b2945): a role is a
-- row holding a list of permission codes, and a person has one role (`roleId`). Until now
-- VeloExpense's people carried one of three fixed text roles (`app_user.role`, 0004) that
-- the code mapped to ExpenseOS's SYSTEM roles in memory (`systemRoleFor`). This makes the
-- roles rows, so permissions come from the database and the Role Builder (w4-10b) can edit
-- them. Nobody's access changes here.
--
-- Adapted (VeloExpense, d73):
--   · PER TENANT, under RLS. The primary key is (organization_id, id), and every tenant's
--     system roles carry ExpenseOS's FIXED ids (SYSTEM_ROLE_IDS in packages/rbac), so ported
--     code that names a system role by id keeps working. A custom role gets a fresh id.
--   · Every organization gets the six system roles, with SYSTEM_ROLE_PERMISSIONS as of
--     this migration: the existing ones below, and every new one through
--     `organization_system_roles` (a trigger on organization), however it is created —
--     provisioning, the seed, a test. A permission added to a system role in the registry
--     later needs a migration that updates these rows AND replaces the function; the test
--     test/system-role-permissions.db.test.ts fails until one does (ExpenseOS's guard,
--     systemRolePermissions.db.test.ts).
--   · Manager (ExpenseOS's retired …0003) is not created: no VeloExpense row ever pointed at
--     it. ExpenseOS keeps it, deactivated, for its own history.
--   · `app_user.role_id`, NOT NULL, with a composite foreign key to the tenant's role. A
--     role a person holds cannot be deleted, as ExpenseOS's Restrict says; it is NO ACTION
--     here (checked at the end of the statement) so deleting an organization, which
--     cascades to both its people and its roles, is not refused half-way. Backfilled from the text role: ADMIN → System
--     Administrator; MANAGER and EMPLOYEE → Employee, which already grants a superset of
--     what Manager did — exactly the mapping the code applied until now.
--   · STAGED (d73): the text role stays one release, and a trigger keeps `role_id` in step
--     whenever something still writes `role` (invites, the employee screen, SSO, the seed).
--     w4-10c retires the text role, VeloExpense's admin checks, and the trigger.
--   · No `createdBy` / `updatedBy` foreign keys, as ExpenseOS has none; and no Redis-only
--     state — the RBAC cache in front of these rows is keyed by organization (see
--     packages/rbac/src/cache.ts).

CREATE TABLE role (
    organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    label           jsonb NOT NULL,
    description     jsonb,
    is_system       boolean NOT NULL DEFAULT false,
    active          boolean NOT NULL DEFAULT true,
    permissions     text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_by      uuid,
    PRIMARY KEY (organization_id, id)
);

CREATE INDEX role_active_idx ON role (organization_id, active);

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── the six system roles, for one organization ─────────────────────────────
--
-- SYSTEM_ROLE_KINDS / _IDS / _LABELS / _PERMISSIONS, as generated from
-- packages/rbac/src/systemRoles.ts for this migration. Descriptions are ExpenseOS's where
-- its migrations wrote one (admin, expense administrator, employee); its seed creates the
-- other three without.
--
-- Inserts under the organization's own RLS scope, then puts the caller's scope back, so it
-- is safe inside a transaction that is already scoped (provisioning) or not (the seed).

CREATE FUNCTION seed_system_roles(org uuid) RETURNS void
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
          'vcc.card.issue', 'vcc.card.close', 'vcc.card.reassign', 'vcc.limit.requestIncrease',
          'vcc.transaction.import', 'vcc.transaction.match', 'ledger.reference.view', 'ledger.reference.sync',
          'ledger.reference.delete', 'ledger.mapping.manage', 'ledger.sync.push', 'ledger.sync.retry',
          'delegation.create.own', 'delegation.create.any', 'delegation.revoke.own', 'delegation.revoke.any',
          'delegation.view.all', 'policy.violation.override', 'budget.read', 'budget.view.all',
          'budget.create', 'budget.update', 'budget.delete', 'notification.read.own',
          'notification.template.update', 'notification.retry', 'notification.queue.view', 'audit.read',
          'audit.chain.verify', 'audit.fraudFlag.review', 'audit.controlEvaluation.run', 'analytics.dashboard.view',
          'analytics.view.own', 'analytics.view.reportingChain', 'analytics.view.all', 'analytics.report.build',
          'analytics.export.schedule', 'analytics.permissions.set', 'analytics.override.grant', 'admin.role.create',
          'admin.role.update', 'admin.role.delete', 'admin.role.list', 'admin.businessUnit.create',
          'admin.businessUnit.update', 'admin.businessUnit.delete', 'admin.businessUnit.list', 'admin.legalEntity.create',
          'admin.legalEntity.update', 'admin.legalEntity.delete', 'admin.legalEntity.list', 'admin.department.create',
          'admin.department.update', 'admin.department.delete', 'admin.department.list', 'admin.expenseCategory.create',
          'admin.expenseCategory.update', 'admin.expenseCategory.list', 'admin.travelCategory.create', 'admin.travelCategory.update',
          'admin.travelCategory.list', 'admin.module.view', 'admin.module.manage', 'admin.approvalWorkflow.view',
          'admin.approvalWorkflow.manage', 'admin.integration.view', 'admin.integration.update', 'admin.apiKey.create',
          'admin.apiKey.revoke', 'admin.apiKey.list', 'admin.webhook.view', 'admin.appSettings.update',
          'admin.help.manage'
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

CREATE FUNCTION organization_system_roles() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM seed_system_roles(NEW.id);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER organization_system_roles
    AFTER INSERT ON organization
    FOR EACH ROW EXECUTE FUNCTION organization_system_roles();

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM seed_system_roles(org);
  END LOOP;
END
$$;

-- ── app_user.role_id ────────────────────────────────────────────────────────

-- The text role a system role stands for, in one place (d73). Retired with the text role
-- in w4-10c.
CREATE FUNCTION role_id_for_legacy_role(legacy text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE legacy
           WHEN 'ADMIN' THEN '019e3000-0000-7000-8000-000000000001'::uuid
           ELSE '019e3000-0000-7000-8000-000000000004'::uuid
         END
$fn$;

ALTER TABLE app_user ADD COLUMN role_id uuid;

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE app_user SET role_id = role_id_for_legacy_role(role) WHERE organization_id = org;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;

ALTER TABLE app_user ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE app_user
    ADD CONSTRAINT app_user_role_fkey
    FOREIGN KEY (organization_id, role_id) REFERENCES role (organization_id, id);
CREATE INDEX app_user_role_id_idx ON app_user (organization_id, role_id);

-- Staged (d73): a write that still sets the text role sets the role it stands for. A write
-- that names `role_id` itself and leaves the text role alone keeps its `role_id`.
CREATE FUNCTION app_user_role_id_from_legacy() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role_id IS NULL THEN
      NEW.role_id := role_id_for_legacy_role(NEW.role);
    END IF;
  ELSIF NEW.role IS DISTINCT FROM OLD.role AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id THEN
    NEW.role_id := role_id_for_legacy_role(NEW.role);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER app_user_role_id_from_legacy
    BEFORE INSERT OR UPDATE OF role ON app_user
    FOR EACH ROW EXECUTE FUNCTION app_user_role_id_from_legacy();
