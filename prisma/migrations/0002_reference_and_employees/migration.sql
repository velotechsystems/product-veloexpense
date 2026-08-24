-- VeloExpense 0002 — reference data + employee fields (VX1-1).
-- Adds the org-structure reference tables and the per-tenant expense-category
-- template, and extends app_user with employee attributes. Every new table is
-- tenant-scoped: organization_id + org-id index + ENABLE/FORCE RLS + the
-- tenant_isolation policy (NULLIF form). Copy this block for every future table.

-- ── helper note ──────────────────────────────────────────────────────────────
-- tenant_isolation policy body (identical everywhere):
--   USING/WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)

-- ── Legal entity ─────────────────────────────────────────────────────────────
CREATE TABLE legal_entity (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    name            text NOT NULL,
    country         text,                        -- ISO-3166-1 alpha-2
    currency_code   text REFERENCES currency(code),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);
CREATE INDEX legal_entity_org_id_idx ON legal_entity (organization_id);
ALTER TABLE legal_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legal_entity
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Business unit ────────────────────────────────────────────────────────────
CREATE TABLE business_unit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);
CREATE INDEX business_unit_org_id_idx ON business_unit (organization_id);
ALTER TABLE business_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_unit
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Department (parent/child for rollups) ────────────────────────────────────
CREATE TABLE department (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    uuid NOT NULL REFERENCES organization(id),
    name               text NOT NULL,
    parent_department_id uuid REFERENCES department(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);
CREATE INDEX department_org_id_idx ON department (organization_id);
ALTER TABLE department ENABLE ROW LEVEL SECURITY;
ALTER TABLE department FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON department
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Expense category (per-tenant; seeded from a starter chart of accounts) ────
CREATE TABLE expense_category (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    code            text NOT NULL,               -- stable key, e.g. 'meals'
    label           text NOT NULL,
    gl_account      text,                         -- maps to the tenant's chart of accounts
    active          boolean NOT NULL DEFAULT true,
    sort_order      int NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code)
);
CREATE INDEX expense_category_org_id_idx ON expense_category (organization_id);
ALTER TABLE expense_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_category FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_category
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── app_user employee fields (app_user already tenant-scoped + RLS from 0001) ─
ALTER TABLE app_user
    ADD COLUMN title              text,
    ADD COLUMN manager_id         uuid REFERENCES app_user(id),
    ADD COLUMN department_id      uuid REFERENCES department(id),
    ADD COLUMN business_unit_id   uuid REFERENCES business_unit(id),
    ADD COLUMN legal_entity_id    uuid REFERENCES legal_entity(id),
    ADD COLUMN employee_status    text NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | ON_LEAVE | DEACTIVATED
    ADD COLUMN deleted_at         timestamptz;
CREATE INDEX app_user_manager_id_idx ON app_user (manager_id);
