-- VeloExpense 0004 — employee roles + directory constraints (VX1-2).
--
-- No new tables here: app_user is already tenant-scoped with ENABLE/FORCE RLS
-- and the tenant_isolation policy from 0001, and the employee attribute columns
-- landed in 0002 (VX1-1). This migration adds the role attribute the admin
-- directory gates on, hardens the two free-text status/role columns with CHECK
-- constraints, and adds the lookup indexes the directory queries need.
--
-- Because no table gains an organization_id column, the CI RLS-coverage guard
-- is unaffected; app_user isolation is already proven by test/rls-isolation.test.ts.

-- ── Role ─────────────────────────────────────────────────────────────────────
-- EMPLOYEE — default; sees only their own expense data.
-- MANAGER  — additionally sees their direct reports (approvals arrive in Phase 2).
-- ADMIN    — org administrator; the employee directory is gated on this.
ALTER TABLE app_user
    ADD COLUMN role text NOT NULL DEFAULT 'EMPLOYEE';

ALTER TABLE app_user
    ADD CONSTRAINT app_user_role_check
        CHECK (role IN ('EMPLOYEE', 'MANAGER', 'ADMIN'));

-- employee_status arrived in 0002 as free text with a default; constrain it now.
ALTER TABLE app_user
    ADD CONSTRAINT app_user_employee_status_check
        CHECK (employee_status IN ('ACTIVE', 'ON_LEAVE', 'DEACTIVATED'));

-- A user can never be their own manager. Longer cycles (A -> B -> A) are
-- rejected in lib/employees/service.ts, which walks the chain before writing.
ALTER TABLE app_user
    ADD CONSTRAINT app_user_manager_not_self
        CHECK (manager_id IS NULL OR manager_id <> id);

-- ── Directory lookup indexes ─────────────────────────────────────────────────
CREATE INDEX app_user_org_role_idx        ON app_user (organization_id, role);
CREATE INDEX app_user_department_id_idx   ON app_user (department_id);
CREATE INDEX app_user_business_unit_id_idx ON app_user (business_unit_id);
CREATE INDEX app_user_legal_entity_id_idx ON app_user (legal_entity_id);
