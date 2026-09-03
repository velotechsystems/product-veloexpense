-- ════════════════════════════════════════════════════════════════════════════
-- 0028 — A SHIPPED LOCALE IS A COMPLETE LOCALE (VX4-7 part 2a)
--
-- `fr-CA` comes OUT of the accepted set, and this migration is the least
-- interesting half of that decision. The interesting half is what it makes true.
--
-- ── WHY REMOVE SOMETHING 0027 ADDED SIX HOURS AGO ───────────────────────────
--
-- Part 1 shipped three locales because the ticket said three. What part 2a
-- discovered while cataloguing the enums is that `fr-CA` had no copy anywhere
-- and no way to get any: the product's UI text is English literals in JSX, so a
-- French reader got French DATE AND MONEY formatting (which `Intl` does for
-- free) wrapped around English words. That looked like partial support and was
-- actually none.
--
-- Cataloguing the enums makes it worse rather than better. `fr-CA` deliberately
-- has NO English fallback — `lib/i18n/locales.ts` argues that at length, because
-- a fluent English sentence is invisible to everyone reviewing in English and so
-- ships forever. So the moment a rendered enum reads from the catalogue, a French
-- reader gets the missing-copy marker where they previously got a readable
-- English word. The choice was never "French or English"; it was "an honest gap
-- or a marker", and the honest gap is not offering French until French exists.
--
-- So `SUPPORTED_LOCALES` becomes the switch for "this locale is ready", and
-- `test/i18n-enum-catalog.test.ts` enforces the invariant that every locale IN
-- that list has copy for every rendered enum member. Putting `fr-CA` back is one
-- line in the registry plus this constraint — and the gate goes red until all 86
-- strings are authored, which is exactly the forcing function that was missing.
--
-- ── WHY THIS REFUSES RATHER THAN DOWNGRADES ─────────────────────────────────
--
-- A tenant or a reader could be sitting on `fr-CA`. Quietly rewriting their
-- setting to `en-CA` is the kind of change that is discovered by the person
-- whose product silently changed language, which is the worst way to discover
-- it. 0027 set the precedent twice (a template holding both `en` and `en-CA`,
-- and a locale stranded in `settings` jsonb): where the migration cannot know
-- what somebody meant, it stops and says so.
--
-- In practice this costs nothing — nothing has ever written `fr-CA`, because the
-- picker has existed for one afternoon — so the block below should be a no-op.
-- That is the only kind of guard worth having for a case you believe cannot
-- happen. If it DOES fire, the fix is one UPDATE and a conversation with that
-- tenant, not a silent migration.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    orgs  integer;
    users integer;
BEGIN
    SELECT count(*) INTO orgs  FROM organization WHERE default_locale = 'fr-CA';
    SELECT count(*) INTO users FROM app_user     WHERE locale = 'fr-CA';
    IF orgs > 0 OR users > 0 THEN
        RAISE EXCEPTION
            '% organization(s) and % user(s) are set to fr-CA, which this migration '
            'retires until its copy exists. Move them deliberately (UPDATE ... SET '
            'default_locale/locale) and tell them, then re-run (0028)', orgs, users
            USING ERRCODE = '23514';
    END IF;
END $$;

ALTER TABLE organization
    DROP CONSTRAINT organization_default_locale_supported,
    -- Still a second copy of SUPPORTED_LOCALES, still guarded the same way:
    -- `test/i18n-schema.db.test.ts` reads this constraint's accepted set out of
    -- `pg_get_constraintdef` and asserts it equals the registry in both
    -- directions. That test is what makes editing one without the other fail,
    -- and it is why shrinking the set here is safe rather than a drift risk.
    ADD CONSTRAINT organization_default_locale_supported
        CHECK (default_locale IN ('en-CA', 'en-US'));

ALTER TABLE app_user
    DROP CONSTRAINT app_user_locale_supported,
    ADD CONSTRAINT app_user_locale_supported
        CHECK (locale IS NULL OR locale IN ('en-CA', 'en-US'));

COMMENT ON COLUMN organization.default_locale IS
    'The company''s locale, used when a reader has expressed no preference AND '
    'pre-auth, where there is no reader at all. One of SUPPORTED_LOCALES in '
    'lib/i18n/locales.ts, which lists only locales whose copy is COMPLETE — see '
    '0028. test/i18n-schema.db.test.ts asserts this constraint''s accepted set '
    'equals that array exactly (IL-1/IL-7).';
