-- People 1 of 4 — the columns ExpenseOS's People screen (/users) reads, on `app_user`.
--
-- Ported from ExpenseOS's `User` model (1e682dd6), as decided 16 Oct 2026:
--
-- 1. FIRST AND LAST NAME, split from `display_name` (decided: "add first/last columns",
--    as categories took ExpenseOS's per-language JSON on 8 Oct rather than the router
--    being adapted). ExpenseOS's directory sorts, filters, searches and pages by
--    (firstName, lastName, id), so the columns are what the port needs, not a display
--    choice.
--
--    `display_name` STAYS, as the full name, because everything VeloExpense already
--    has reads it (the shell, the pickers, mail, the audit log, approvals). A trigger
--    keeps the three in step so no writer has to know there are two shapes:
--      · a row written with only `display_name` (invitation acceptance, signup, the seed,
--        every test fixture) gets first/last split from it;
--      · a row written with first/last and no `display_name` gets it composed;
--      · an UPDATE that changes first/last but not `display_name` recomposes it, and one
--        that changes only `display_name` re-splits it.
--    The split is "first word / the rest". It is wrong for "Mary Ann Smith" (first name
--    "Mary"), and the People edit drawer (People 3) is where an admin corrects it; the
--    identity providers' given/family names are not stored anywhere to do better.
ALTER TABLE app_user
  ADD COLUMN first_name text,
  ADD COLUMN last_name  text;

-- 2. ACCESS (decided: "access = may sign in"). ExpenseOS's `hasExpenseOSAccess`: whether
--    this person may sign in at all, independent of employment status. Everybody in a
--    VeloExpense directory has signed in (VX5-3: the row is created at acceptance), so
--    every existing row starts WITH access. Sign-in (lib/auth/resolve-sso-user.ts) and
--    every request (requireActor, the tRPC tenant middleware) refuse a row without it.
ALTER TABLE app_user
  ADD COLUMN has_access boolean NOT NULL DEFAULT true;

-- 3. ExpenseOS's other directory columns. `on_leave_at` and `termination_date` are
--    written by the People actions (People 3); `last_login_at` by sign-in, from now on
--    (no history exists to backfill); `avatar_url` by nothing yet — ExpenseOS fills it
--    from Google's directory sync, which is Wave 5 here (w5-04).
ALTER TABLE app_user
  ADD COLUMN on_leave_at      timestamptz,
  ADD COLUMN termination_date timestamptz,
  ADD COLUMN last_login_at    timestamptz,
  ADD COLUMN avatar_url       text;

-- 4. ExpenseOS's TERMINATED status, alongside ACTIVE, ON_LEAVE and DEACTIVATED (0004).
ALTER TABLE app_user DROP CONSTRAINT app_user_employee_status_check;
ALTER TABLE app_user
  ADD CONSTRAINT app_user_employee_status_check
  CHECK (employee_status IN ('ACTIVE', 'ON_LEAVE', 'DEACTIVATED', 'TERMINATED'));

-- 5. Keep the name columns in step (see 1).
CREATE FUNCTION app_user_names_in_step() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  composed text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.first_name IS NULL AND NEW.last_name IS NULL THEN
      IF NEW.display_name IS NOT NULL THEN
        NEW.first_name := NULLIF(split_part(btrim(NEW.display_name), ' ', 1), '');
        NEW.last_name  := NULLIF(btrim(substr(btrim(NEW.display_name),
                            length(split_part(btrim(NEW.display_name), ' ', 1)) + 1)), '');
      END IF;
    ELSIF NEW.display_name IS NULL THEN
      composed := btrim(concat_ws(' ', NULLIF(btrim(NEW.first_name), ''), NULLIF(btrim(NEW.last_name), '')));
      NEW.display_name := NULLIF(composed, '');
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name)
     AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
    composed := btrim(concat_ws(' ', NULLIF(btrim(NEW.first_name), ''), NULLIF(btrim(NEW.last_name), '')));
    NEW.display_name := NULLIF(composed, '');
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name
     AND NEW.first_name IS NOT DISTINCT FROM OLD.first_name
     AND NEW.last_name IS NOT DISTINCT FROM OLD.last_name THEN
    NEW.first_name := NULLIF(split_part(btrim(coalesce(NEW.display_name, '')), ' ', 1), '');
    NEW.last_name  := NULLIF(btrim(substr(btrim(coalesce(NEW.display_name, '')),
                        length(split_part(btrim(coalesce(NEW.display_name, '')), ' ', 1)) + 1)), '');
  END IF;
  RETURN NEW;
END;
$$;

--    Existing rows: the same split, once.
UPDATE app_user
   SET first_name = NULLIF(split_part(btrim(display_name), ' ', 1), ''),
       last_name  = NULLIF(btrim(substr(btrim(display_name),
                      length(split_part(btrim(display_name), ' ', 1)) + 1)), '')
 WHERE display_name IS NOT NULL;

--    Then the trigger, so the backfill above does not recompose `display_name` from the split.
CREATE TRIGGER app_user_names_in_step
  BEFORE INSERT OR UPDATE OF display_name, first_name, last_name ON app_user
  FOR EACH ROW EXECUTE FUNCTION app_user_names_in_step();

-- 6. EXTERNAL IDS for people: ExpenseOS's `UserExternalId`, one alias row per (person,
--    system), as business units, departments and the other lookups have (0047). The
--    directory shows and filters them; the edit drawer (People 3) writes them.
--    VeloExpense: per tenant, composite keys, the same RLS as every tenant table.
CREATE TABLE user_external_id (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id       uuid NOT NULL,
    source_value    text NOT NULL,
    user_id         uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_by      uuid,
    CONSTRAINT user_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    CONSTRAINT user_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT user_external_id_user_fkey
      FOREIGN KEY (organization_id, user_id)
      REFERENCES app_user (organization_id, id) ON DELETE CASCADE,
    -- ExpenseOS's @@unique([sourceId, sourceValue]): one outside id names one person.
    UNIQUE (source_id, source_value)
);
CREATE INDEX user_external_id_user_idx ON user_external_id (user_id);
ALTER TABLE user_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- 7. SEARCH. ExpenseOS's directory search ranks with pg_trgm's `similarity` and `%`
--    across first name, last name and email, backed by trigram indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX app_user_first_name_trgm ON app_user USING gin (first_name gin_trgm_ops);
CREATE INDEX app_user_last_name_trgm  ON app_user USING gin (last_name gin_trgm_ops);
CREATE INDEX app_user_email_trgm      ON app_user USING gin (email gin_trgm_ops);
--    The directory's page order: (first name, last name, id), nulls last.
CREATE INDEX app_user_directory_order
    ON app_user (organization_id, first_name NULLS LAST, last_name NULLS LAST, id);
