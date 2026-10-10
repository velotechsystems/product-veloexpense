-- Wave 2 (w2-10): a person's COUNTRY, as ExpenseOS's `User.country` — the column its
-- mileage pricing reads to choose a rate ("Scope-matched by the traveller's country and
-- the expense date", server/lib/mileage.ts). VeloExpense people had no country, so every
-- mileage line stopped at ExpenseOS's own refusal for a traveller with none.
--
-- ISO-3166-1 alpha-2, uppercase, nullable — ExpenseOS's shape, and the same CHECK
-- legal_entity carries since 0048.
--
-- BACKFILLED from each person's legal entity (decided 10 Oct): the entity a person is
-- employed through is where they work for nearly everyone, and a column that starts empty
-- would refuse every mileage line until an administrator filled in every person by hand.
-- After this, the column is the person's own — an administrator changes it on the employee
-- screen, and changing the legal entity does not move it. A person with no entity, or whose
-- entity has no country, stays NULL.
--
-- This REWRITES rows, so per d16 it deploys alone.
ALTER TABLE app_user
  ADD COLUMN country text,
  ADD CONSTRAINT app_user_country_iso CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

-- PER TENANT: `app_user` and `legal_entity` have FORCE ROW LEVEL SECURITY, which binds the
-- RDS master login this runs as, so a plain UPDATE would silently change nothing there
-- (f08; the 0046 / 0048 pattern).
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE app_user u
       SET country = le.country
      FROM legal_entity le
     WHERE u.organization_id = org
       AND le.id = u.legal_entity_id
       AND u.country IS NULL
       AND le.country IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
