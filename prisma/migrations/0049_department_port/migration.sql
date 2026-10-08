-- Wave 1: ExpenseOS's departments, ported (w1-03). Brings `department` to
-- ExpenseOS's `Department` model so its admin-lookup router and screen run
-- unchanged, as 0047 and 0048 did for business units and legal entities.
--
-- 1. THE NAME IS PER LANGUAGE (d13): `name` becomes `label`, `{ "en": … }` JSON,
--    every existing name kept as the English one; readers take `label->>'en'`.
ALTER TABLE department RENAME COLUMN name TO label;
ALTER TABLE department
  ALTER COLUMN label TYPE jsonb USING jsonb_build_object('en', label);
ALTER TABLE department
  ADD CONSTRAINT department_label_en CHECK (
    COALESCE(
      jsonb_typeof(label) = 'object'
      AND jsonb_typeof(label -> 'en') = 'string'
      AND length(btrim(label ->> 'en')) > 0,
      false
    )
  );

--    VeloExpense: the old UNIQUE (organization_id, name) is kept, on the English
--    name, case- and space-insensitively (as 0047 and 0048).
ALTER TABLE department DROP CONSTRAINT department_organization_id_name_key;
CREATE UNIQUE INDEX department_org_label_en_uniq
  ON department (organization_id, lower(btrim(label ->> 'en')));

-- 2. ExpenseOS's other Department fields: an optional per-language description
--    (JSON null is ExpenseOS's "cleared") and the soft `active` toggle.
--    The parent stays VeloExpense's `parent_department_id` — ExpenseOS's
--    `parentId` — with its composite tenant FK (0019); prisma/schema.prisma maps
--    the name.
ALTER TABLE department
  ADD COLUMN description jsonb,
  ADD COLUMN active      boolean NOT NULL DEFAULT true;
ALTER TABLE department
  ADD CONSTRAINT department_description_object CHECK (
    description IS NULL OR jsonb_typeof(description) IN ('object', 'null')
  );

--    ExpenseOS's router refuses a department as its own parent and a parent
--    that would close a loop. The first is a row-level fact the table can hold
--    too; a cycle spans rows and stays the router's (`preWrite`).
ALTER TABLE department
  ADD CONSTRAINT department_not_own_parent CHECK (parent_department_id IS DISTINCT FROM id);

-- 3. EXTERNAL IDS for departments (ExpenseOS's DepartmentExternalId), on the
--    tenant's own sources from 0047. Same shape and rules as the business-unit
--    and legal-entity aliases.
CREATE TABLE department_external_id (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id        uuid NOT NULL,
    source_value     text NOT NULL,
    department_id    uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT department_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    CONSTRAINT department_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT department_external_id_department_fkey
      FOREIGN KEY (organization_id, department_id)
      REFERENCES department (organization_id, id) ON DELETE CASCADE,
    UNIQUE (source_id, source_value)
);
CREATE INDEX department_external_id_department_idx
    ON department_external_id (department_id);
ALTER TABLE department_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON department_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
