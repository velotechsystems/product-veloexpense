-- ════════════════════════════════════════════════════════════════════════════
-- 0027 — WHOSE LOCALE, AND WHOSE CLOCK (VX4-7 part 1, GAP-AUDIT IL-1/IL-2/IL-7)
--
-- Three facts get storage here: a company default locale, a per-reader
-- override, and the same pair for timezone. Plus one data migration, which is
-- the reason this could not wait — stored copy is keyed by locale TAG, and the
-- tag is changing.
--
-- ── WHY COLUMNS ON `organization`, SETTLED ALREADY ──────────────────────────
--
-- 0023 argued this at length for branding and the argument is unchanged, so it
-- is cited rather than repeated: `organization.settings jsonb` has advertised
-- "branding, enabled modules, locale/currency" in its comment since 0001, and
-- 0021 (modules) and 0023 (branding) both refused it, because "a value inside
-- jsonb is out of reach of every constraint, index and RLS predicate that would
-- otherwise protect it". A locale needs exactly such a constraint — see the
-- CHECK below and the test that polices it.
--
-- The other half of 0023's reasoning applies with even more force here.
-- `organization` carries no `organization_id` and so is not RLS-scoped; it is
-- "the one table already read by slug before anybody is signed in". A default
-- locale is needed at precisely that moment: the login screen is pre-auth, has
-- no user to have a preference, and still has to pick a language. A tenant-
-- scoped table under FORCE RLS would return zero rows to that reader.
--
-- ── AND WHY THIS SETTLES THE `settings` COMMENT FOR GOOD ────────────────────
--
-- Three migrations have now been asked to put a company setting in that blob and
-- three have declined. The DO block at the bottom of this file turns the comment
-- from a suggestion into a checked claim: if any tenant actually has a locale
-- stored in `settings`, this migration REFUSES TO RUN rather than quietly
-- leaving a stored preference behind while installing a new column that
-- overrides it. Nothing writes that key today, so the guard should cost nothing
-- — which is the only kind of guard worth having for a case you believe is
-- impossible. (0014's `postable IS NULL` branch is the house precedent: kept
-- precisely because it fires only if a later change reopens the hole.)
--
-- ── NULL MEANS "FOLLOW THE COMPANY" ─────────────────────────────────────────
--
-- `app_user.locale` and `app_user.timezone` are NULLABLE, and NULL is a real
-- answer rather than missing data: it means "whatever the company says", so an
-- admin changing `organization.default_locale` moves every employee who never
-- expressed an opinion. Storing the resolved value per user instead would
-- freeze today's default into every row and make the company setting inert for
-- everyone who had ever loaded a page.
--
-- This is 0021's absence-means-off and 0023's NULL-means-default-palette, once
-- more: "an absent brand colour and a brand colour that happens to equal our
-- sky are not the same fact".
-- ════════════════════════════════════════════════════════════════════════════

-- ── the company's answers ───────────────────────────────────────────────────

ALTER TABLE organization
    -- NOT NULL with a default, unlike branding's nullable columns, and the
    -- difference is meaningful: there is no such thing as a company with no
    -- locale. Somebody's language is being used to render the page either way,
    -- so the only question is whether the choice is recorded. DEFAULT_LOCALE in
    -- lib/i18n/locales.ts is the same string, and the test named below asserts
    -- these two never drift.
    ADD COLUMN default_locale text NOT NULL DEFAULT 'en-CA',

    -- `UTC`, deliberately, and NOT `America/Toronto` despite this being a
    -- Canadian product. The product ships no client JavaScript, so the server
    -- cannot discover a reader's zone from anything — there is no timezone
    -- request header, and `Intl...resolvedOptions().timeZone` runs in a browser.
    -- A zone is therefore either configured or unknown, and an unknown one
    -- rendered as `America/Toronto` is a wrong answer wearing a right answer's
    -- clothes: every timestamp would be off by hours for a Vancouver reader with
    -- nothing on screen suggesting anything had been assumed. `UTC` is visibly
    -- neutral, so an admin who cares sets it, and an admin who does not gets
    -- timestamps that are at least consistently what the database holds.
    ADD COLUMN default_timezone text NOT NULL DEFAULT 'UTC';

-- ── the reader's overrides ──────────────────────────────────────────────────

ALTER TABLE app_user
    ADD COLUMN locale   text,
    ADD COLUMN timezone text;

-- ── constraints ─────────────────────────────────────────────────────────────

ALTER TABLE organization
    -- THIS LIST IS A SECOND COPY OF `SUPPORTED_LOCALES`, and there is no way to
    -- avoid that in SQL: a CHECK cannot read a TypeScript array, and the whole
    -- reason the column is not in jsonb is to have a constraint like this one.
    --
    -- So the copy is made SAFE instead of avoided. `test/i18n-schema.db.test.ts`
    -- reads the accepted set back out of the catalog — the constraint's own
    -- source text — and asserts it EQUALS `SUPPORTED_LOCALES` exactly, in both
    -- directions. Adding a locale to the registry without a migration fails that
    -- test; adding one here without the registry fails it too.
    --
    -- ExpenseOS is the cautionary case and it is the same shape one level up:
    -- their CI coverage gate opens by restating `['en', 'fr-CA']` locally, so the
    -- gate polices a list it also owns a stale copy of, and a third locale would
    -- have been silently unwatched. A duplicated list with a test is fine. A
    -- duplicated list without one fails open.
    ADD CONSTRAINT organization_default_locale_supported
        CHECK (default_locale IN ('en-CA', 'en-US', 'fr-CA'));

ALTER TABLE app_user
    ADD CONSTRAINT app_user_locale_supported
        CHECK (locale IS NULL OR locale IN ('en-CA', 'en-US', 'fr-CA')),

    -- '' is a third state nobody wants, exactly as 0023 said of `login_tagline`:
    -- "the form submits it for a cleared field and every reader then needs
    -- `?? null`". A cleared picker must write NULL, and the database is where
    -- that is settled rather than in whichever action happens to handle it.
    ADD CONSTRAINT app_user_timezone_nonempty
        CHECK (timezone IS NULL OR length(btrim(timezone)) > 0);

ALTER TABLE organization
    ADD CONSTRAINT organization_default_timezone_nonempty
        CHECK (length(btrim(default_timezone)) > 0);

-- ── the timezone has to be a real zone, and only a trigger can say so ───────

-- A CHECK constraint's expression must be IMMUTABLE. Every way of asking
-- Postgres whether a zone name is real is not:
--
--   `now() AT TIME ZONE tz`      — timezone(text, timestamptz) is STABLE.
--   `tz IN (SELECT ...)`         — a CHECK may not read another table at all.
--
-- Which leaves a trigger, and 0014's `gl_account_must_be_postable()` is the
-- house precedent for exactly this trade, with its reason stated there: "A CHECK
-- cannot see another row, so it is a trigger — and it is worth the trigger
-- rather than an app-level gate because the whole point is that the guard has to
-- hold for paths nobody has written yet."
--
-- The paths nobody has written yet, here, are a support script setting a zone by
-- hand, an HRIS importer, and a restored backup from a release where the picker
-- allowed something this one does not. Any of the three can write
-- `America/Torono`, and the failure it causes is not an error — it is
-- `Intl.DateTimeFormat` throwing a RangeError inside a server component on every
-- render of every page that shows a date, for one tenant, which reads as an
-- outage rather than as a typo in a settings row.
CREATE OR REPLACE FUNCTION timezone_must_be_known(p_zone text) RETURNS void AS $$
BEGIN
    IF p_zone IS NULL THEN
        RETURN;
    END IF;
    -- Blank is answered HERE, before the catalogue lookup, and the reason is a
    -- message rather than a rule. A BEFORE trigger runs ahead of the row's CHECK
    -- constraints, so `organization_default_timezone_nonempty` never gets to
    -- speak — the first probe of this migration produced
    -- `"     is not an IANA timezone name"`, which sends whoever reads it looking
    -- for a typo in a zone name that is not there. The CHECK stays as the
    -- structural guarantee (0014's note applies: a trigger can be dropped and a
    -- constraint cannot be dropped by accident); this branch owns the wording.
    IF length(btrim(p_zone)) = 0 THEN
        RAISE EXCEPTION 'timezone is blank; use NULL to follow the company default'
            USING ERRCODE = '23514';
    END IF;
    -- `pg_timezone_names` is a view over the IANA database Postgres was built
    -- with. It is the same catalogue `AT TIME ZONE` accepts, so this asks the
    -- authority rather than a list we would have to maintain. Node's ICU data
    -- can differ from Postgres's tzdata at the margins (a zone renamed between
    -- releases); that is a real gap and the honest one to have, because the
    -- alternative is a hardcoded list that drifts from BOTH.
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_zone) THEN
        RAISE EXCEPTION '% is not an IANA timezone name', p_zone
            USING ERRCODE = '23514';
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION organization_timezone_known() RETURNS trigger AS $$
BEGIN
    PERFORM timezone_must_be_known(NEW.default_timezone);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_user_timezone_known() RETURNS trigger AS $$
BEGIN
    PERFORM timezone_must_be_known(NEW.timezone);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `UPDATE OF` the one column, not every UPDATE: an unrelated write to a row
-- whose zone was already accepted must not pay for a catalogue lookup, and must
-- not start failing if a Postgres upgrade retires a zone name that a tenant is
-- legitimately still using. 0014 scopes its triggers the same way and for the
-- same reason ("Inactive is refused on a NEW mapping only").
CREATE TRIGGER organization_default_timezone_known
    BEFORE INSERT OR UPDATE OF default_timezone ON organization
    FOR EACH ROW EXECUTE FUNCTION organization_timezone_known();

CREATE TRIGGER app_user_timezone_known
    BEFORE INSERT OR UPDATE OF timezone ON app_user
    FOR EACH ROW EXECUTE FUNCTION app_user_timezone_known();

-- ── the data migration: `en` was never `en` (IL-1) ──────────────────────────

-- `notification_template.subject` and `.body` are locale-keyed jsonb, keyed on
-- the tag the product shipped — which was `en`, while `lib/money.ts` had been
-- formatting `en-CA` since VX1. The two halves of one product disagreed about
-- what language it was in, and the audit pass showed the cost: bare `en` makes
-- `Intl` produce `3/4/2026` and `CA$10,799.00`, i.e. American, in a product
-- whose money formatter was already Canadian.
--
-- Retagging is therefore not a rename for tidiness — it makes the stored key
-- mean what the renderer means. Every row a tenant has authored keeps its text.
--
-- `- 'en' || jsonb_build_object(...)` rather than `jsonb_set`: `jsonb_set`
-- cannot rename a key, and doing this as set-then-delete leaves a window (inside
-- one statement, so invisible here, but the idiom gets copied) where a row holds
-- both keys and `localizedFrom` would answer from whichever the chain hits
-- first. Deleting and adding in one expression cannot produce that state.
UPDATE notification_template
   SET body = (body - 'en') || jsonb_build_object('en-CA', body -> 'en')
 WHERE body ? 'en'
   AND NOT body ? 'en-CA';

UPDATE notification_template
   SET subject = (subject - 'en') || jsonb_build_object('en-CA', subject -> 'en')
 WHERE subject ? 'en'
   AND NOT subject ? 'en-CA';

-- A row carrying BOTH keys is not something this migration can decide about:
-- somebody would have had to author `en-CA` copy against a product that only
-- ever wrote `en`, so the two strings are different text with equal claim, and
-- picking one silently discards a tenant's authored sentence. The two statements
-- above skip such rows (`AND NOT body ? 'en-CA'`) and this one stops the deploy
-- so a human can look.
DO $$
DECLARE
    both_count integer;
BEGIN
    SELECT count(*) INTO both_count
      FROM notification_template
     WHERE (body ? 'en' AND body ? 'en-CA')
        OR (subject ? 'en' AND subject ? 'en-CA');
    IF both_count > 0 THEN
        RAISE EXCEPTION
            '% notification_template row(s) carry both "en" and "en-CA"; '
            'resolve by hand before migrating (0027)', both_count
            USING ERRCODE = '23514';
    END IF;
END $$;

-- ── and the claim 0001's comment has been making since the beginning ────────

DO $$
DECLARE
    stray integer;
BEGIN
    SELECT count(*) INTO stray
      FROM organization
     WHERE settings ? 'locale' OR settings ? 'timezone' OR settings ? 'defaultLocale';
    IF stray > 0 THEN
        RAISE EXCEPTION
            '% organization row(s) store a locale or timezone in settings jsonb; '
            'this migration installs real columns that would silently override '
            'them (0027)', stray
            USING ERRCODE = '23514';
    END IF;
END $$;

-- ── comments ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN organization.default_locale IS
    'The company''s locale, used when a reader has expressed no preference AND '
    'pre-auth, where there is no reader at all. One of SUPPORTED_LOCALES in '
    'lib/i18n/locales.ts; test/i18n-schema.db.test.ts asserts this constraint''s '
    'accepted set equals that array exactly (IL-1/IL-7).';

COMMENT ON COLUMN organization.default_timezone IS
    'IANA zone name for rendering timestamptz values. Defaults to UTC because the '
    'product ships no client JS and so cannot discover a reader''s zone — a '
    'plausible-looking default would be wrong invisibly. Validated against '
    'pg_timezone_names by trigger, since a CHECK must be immutable.';

COMMENT ON COLUMN app_user.locale IS
    'Reader''s own locale, or NULL meaning "follow organization.default_locale". '
    'NULL is a real answer: an admin changing the company default moves everybody '
    'who never chose, which storing a resolved value per row would prevent.';

COMMENT ON COLUMN app_user.timezone IS
    'Reader''s own IANA zone, or NULL meaning "follow organization.default_timezone".';
