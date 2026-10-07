-- The home page's "Finish setting up" card can be collapsed, per admin.
--
-- DECIDED (John, 7 Oct): an admin can put the card away, but only to ONE LINE —
-- "5 setup steps left · Show" — never out of sight while a step is outstanding.
-- The step it most protects is "Invite somebody who can approve": a tenant of
-- one cannot submit anything, and an admin who had dismissed the card for good
-- would meet that wall as an error instead of as advice.
--
-- A column on the person, not a cookie: it follows the admin to another browser,
-- and it is that admin's choice, not the organization's (a second admin still
-- sees the full card until they collapse it themselves).
--
-- NOT NULL DEFAULT false, so every existing row reads "expanded" — today's
-- behaviour — without a backfill. No new table, so no RLS work: app_user's
-- FORCE ROW LEVEL SECURITY policy already covers the column.
ALTER TABLE app_user
    ADD COLUMN setup_checklist_collapsed boolean NOT NULL DEFAULT false;
