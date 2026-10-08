-- Wave 1: ExpenseOS's legal entities, ported (w1-02). Brings `legal_entity` to
-- ExpenseOS's `LegalEntity` model so its admin-lookup router and screen run
-- unchanged, the same way 0047 brought `business_unit` to `BusinessUnit`.
--
-- 1. THE NAME IS PER LANGUAGE (d13): `name` becomes `label`, `{ "en": … }` JSON,
--    every existing name kept as the English one; readers take `label->>'en'`.
--    COALESCE because a CHECK that evaluates to NULL passes.
ALTER TABLE legal_entity RENAME COLUMN name TO label;
ALTER TABLE legal_entity
  ALTER COLUMN label TYPE jsonb USING jsonb_build_object('en', label);
ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_label_en CHECK (
    COALESCE(
      jsonb_typeof(label) = 'object'
      AND jsonb_typeof(label -> 'en') = 'string'
      AND length(btrim(label ->> 'en')) > 0,
      false
    )
  );

--    VeloExpense: the old UNIQUE (organization_id, name) is kept, on the English
--    name, case- and space-insensitively — as 0047 did for business units.
ALTER TABLE legal_entity DROP CONSTRAINT legal_entity_organization_id_name_key;
CREATE UNIQUE INDEX legal_entity_org_label_en_uniq
  ON legal_entity (organization_id, lower(btrim(label ->> 'en')));

-- 2. ExpenseOS's other LegalEntity fields:
--    · an optional per-language description (JSON null is ExpenseOS's "cleared");
--    · the soft `active` toggle — entities are never deleted;
--    · `itc_recoverable`, true by default as in ExpenseOS: false for a
--      non-registrant or foreign entity, whose employees' expenses then recover
--      neither GST/HST nor QST. (VeloExpense stores it now; its tax engine, which
--      reads it, arrives with the expense ports.)
ALTER TABLE legal_entity
  ADD COLUMN description     jsonb,
  ADD COLUMN active          boolean NOT NULL DEFAULT true,
  ADD COLUMN itc_recoverable boolean NOT NULL DEFAULT true;
ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_description_object CHECK (
    description IS NULL OR jsonb_typeof(description) IN ('object', 'null')
  );

--    The country is ExpenseOS's ISO-3166-1 alpha-2, uppercase, as its router
--    validates; held by the table too. Existing rows are normalised first, PER
--    TENANT: `legal_entity` has FORCE ROW LEVEL SECURITY, which binds the RDS
--    master login this runs as, so a plain UPDATE would silently change nothing
--    there (f08; the 0046 pattern). A value that is still not two letters after
--    trimming and upper-casing is cleared rather than guessed at.
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE legal_entity
       SET country = CASE
                       WHEN upper(btrim(country)) ~ '^[A-Z]{2}$' THEN upper(btrim(country))
                       ELSE NULL
                     END
     WHERE organization_id = org
       AND country IS NOT NULL
       AND country !~ '^[A-Z]{2}$';
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_country_iso CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

--    The home currency stays VeloExpense's `currency_code`, a foreign key to the
--    shared `currency` table by its ISO code. ExpenseOS's `homeCurrencyId` is a
--    foreign key to its Currency row by uuid; VeloExpense's currency row is keyed
--    by the code itself, so prisma/schema.prisma maps `homeCurrencyId` onto this
--    column and nothing about the stored value changes.

-- 3. EXTERNAL IDS for legal entities (ExpenseOS's LegalEntityExternalId), on the
--    tenant's own sources from 0047. Same shape and rules as
--    business_unit_external_id.
CREATE TABLE legal_entity_external_id (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id        uuid NOT NULL,
    source_value     text NOT NULL,
    legal_entity_id  uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT legal_entity_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    CONSTRAINT legal_entity_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT legal_entity_external_id_legal_entity_fkey
      FOREIGN KEY (organization_id, legal_entity_id)
      REFERENCES legal_entity (organization_id, id) ON DELETE CASCADE,
    UNIQUE (source_id, source_value)
);
CREATE INDEX legal_entity_external_id_legal_entity_idx
    ON legal_entity_external_id (legal_entity_id);
ALTER TABLE legal_entity_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legal_entity_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
