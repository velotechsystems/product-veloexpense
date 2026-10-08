-- Wave 1: the starter categories' real traits, for tenants that already exist.
--
-- New tenants get these from `seedStarterCategories` (lib/onboarding/starter.ts,
-- STARTER_CATEGORY_TRAITS — ExpenseOS's seeded values). Tenants created before it
-- have the starter rows with migration 0045's defaults. This sets the traits on
-- those rows, and ONLY where every one of the fields is still exactly the 0045
-- default — so a value an admin has set since is never overwritten. A row matching
-- the defaults is indistinguishable from one an admin set back to them; that admin
-- loses nothing they can't set again, and the alternative (never backfilling) leaves
-- every existing tenant claiming 100% ITC on meals.
--
-- ── WHY IT LOOPS OVER TENANTS ───────────────────────────────────────────────
-- `expense_category` has FORCE ROW LEVEL SECURITY, which binds the table's OWNER —
-- on RDS that is the master login this migration runs as, which is not a superuser.
-- A plain UPDATE would therefore see no rows there (no `app.current_org`) and
-- silently change nothing, while passing locally as `postgres`, which bypasses RLS.
-- So each tenant's scope is set, transaction-local, exactly as the app sets it.
-- `organization` has no RLS. test/starter-category-traits.db.test.ts runs this file
-- as the app role, which RLS binds, to prove the loop is what makes it work.
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE expense_category c
       SET icon = t.icon,
           color = t.color,
           itc_gst_hst_rate = t.itc_gst,
           itc_qst_rate = t.itc_qst,
           accepts_tip = t.tip
      FROM (VALUES
              ('meals',          '🍽️', '#d97706',  50,  50, true),
              ('travel_air',     '✈️', '#2563eb', 100, 100, false),
              ('travel_lodging', '🏨', '#2563eb', 100, 100, false),
              ('ground',         '🚕', '#2563eb', 100, 100, true),
              ('office',         '📎', '#0d9488', 100, 100, false),
              ('software',       '💻', '#4f46e5', 100, 100, false)
           ) AS t(code, icon, color, itc_gst, itc_qst, tip)
     WHERE c.organization_id = org
       AND c.code = t.code
       AND c.icon IS NULL
       AND c.color IS NULL
       AND c.itc_gst_hst_rate = 100
       AND c.itc_qst_rate = 100
       AND NOT c.accepts_tip
       AND NOT c.is_mileage
       AND NOT c.requires_attendees
       AND NOT c.pst_recoverable;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
