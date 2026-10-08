-- Wave 1: ExpenseOS's business units, ported (w1-01). This brings
-- `business_unit` to ExpenseOS's `BusinessUnit` model, and adds ExpenseOS's
-- External IDs (decided 8 Oct, d14), so its admin-lookup router and screen run
-- unchanged (prisma/schema.prisma maps the names).
--
-- 1. THE NAME IS PER LANGUAGE, as for categories (0045, d13): `name` becomes
--    ExpenseOS's `label`, `{ "en": …, "fr-CA": … }` JSON. Every existing row
--    keeps its text as the English name, and readers take `label->>'en'`.
--    COALESCE because a CHECK that evaluates to NULL passes.
ALTER TABLE business_unit RENAME COLUMN name TO label;
ALTER TABLE business_unit
  ALTER COLUMN label TYPE jsonb USING jsonb_build_object('en', label);
ALTER TABLE business_unit
  ADD CONSTRAINT business_unit_label_en CHECK (
    COALESCE(
      jsonb_typeof(label) = 'object'
      AND jsonb_typeof(label -> 'en') = 'string'
      AND length(btrim(label ->> 'en')) > 0,
      false
    )
  );

--    VeloExpense: the old UNIQUE (organization_id, name) is kept as a guarantee,
--    on the English name, case- and space-insensitively. ExpenseOS has no unique
--    label, but VeloExpense always refused two business units with one name, and
--    a uniqueness on the whole JSON value would let "Head Office" in twice with
--    and without a French name. ExpenseOS's router already answers a unique
--    violation with CONFLICT ("already exists").
ALTER TABLE business_unit DROP CONSTRAINT business_unit_organization_id_name_key;
CREATE UNIQUE INDEX business_unit_org_label_en_uniq
  ON business_unit (organization_id, lower(btrim(label ->> 'en')));

-- 2. ExpenseOS's other BusinessUnit fields: an optional per-language
--    description, and the soft `active` toggle (business units are never
--    deleted — expense reports, budgets and people keep pointing at them).
ALTER TABLE business_unit
  ADD COLUMN description jsonb,
  ADD COLUMN active      boolean NOT NULL DEFAULT true;
--    ExpenseOS clears a description by writing JSON null (`Prisma.JsonNull`), so
--    that is accepted alongside SQL NULL; anything else must be a language map.
ALTER TABLE business_unit
  ADD CONSTRAINT business_unit_description_object CHECK (
    description IS NULL OR jsonb_typeof(description) IN ('object', 'null')
  );

-- 3. EXTERNAL IDS (ExpenseOS's ExternalIdSource and BusinessUnitExternalId):
--    the outside systems a tenant federates to, and one alias row per
--    (business unit, system). VeloExpense: per tenant, under the same RLS as
--    every tenant table — ExpenseOS's are global (one database per customer).
--    ExpenseOS's `integrationId` link is not ported: VeloExpense has no
--    integration row for a source to belong to yet.
CREATE TABLE external_id_source (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    code            text NOT NULL,
    label           jsonb NOT NULL,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT external_id_source_code_len CHECK (length(btrim(code)) BETWEEN 1 AND 100),
    CONSTRAINT external_id_source_label_en CHECK (
      COALESCE(
        jsonb_typeof(label) = 'object'
        AND jsonb_typeof(label -> 'en') = 'string'
        AND length(btrim(label ->> 'en')) > 0,
        false
      )
    ),
    UNIQUE (organization_id, code),
    UNIQUE (organization_id, id)
);
ALTER TABLE external_id_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_id_source FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_id_source
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE TABLE business_unit_external_id (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id        uuid NOT NULL,
    source_value     text NOT NULL,
    business_unit_id uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT business_unit_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    -- Composite, so an alias can only name a source and a business unit of its
    -- own tenant (0019's rule for every cross-table reference).
    CONSTRAINT business_unit_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT business_unit_external_id_business_unit_fkey
      FOREIGN KEY (organization_id, business_unit_id)
      REFERENCES business_unit (organization_id, id) ON DELETE CASCADE,
    -- ExpenseOS's @@unique([sourceId, sourceValue]): one outside id names one
    -- business unit. (A source is already one tenant's.)
    UNIQUE (source_id, source_value)
);
CREATE INDEX business_unit_external_id_business_unit_idx
    ON business_unit_external_id (business_unit_id);
ALTER TABLE business_unit_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_unit_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
