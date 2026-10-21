-- Mileage routes keep no Google-drawn geometry (ExpenseOS ADR 0020).
--
-- Ported from ExpenseOS 67db2e33 `20261019120000_mileage_route_no_stored_geometry` (#594).
-- A stored mileage route is its claim alone: stops, legs, the chosen route's label,
-- position and count, and `via` (pass-through points as Google place IDs, which Google's
-- terms let us keep). The drawn path, dragged lat/lng points and the fetch stamp are never
-- stored or served, so this removes the three keys that would hold them from every row.
--
-- VeloExpense differences:
--   · No `SystemFlag` row to delete. ExpenseOS gated storing geometry behind a
--     `mileageRouteGeometry` flag (#593) that #594 removed; VeloExpense never ported the
--     storing half, so it never had the flag.
--   · Expected effect: 0 rows on every VeloExpense database. No VeloExpense code has ever
--     written these keys; this is a defensive sweep so a row written by any path (a
--     hand-made fixture, a future regression) is cleaned the same way ExpenseOS's are.
--     The read side strips them as well (`mileageRouteReadSchema`).
--   · expense_line_item is per tenant under FORCE row-level security, and the migration
--     login is its owner, not a superuser — so a plain UPDATE here sees no rows and changes
--     nothing (tracker f08). It runs once per tenant with `app.current_org` set, as 0082
--     does.
--
-- As in ExpenseOS: only object-valued routes carrying at least one of the keys are touched
-- (`-` on an array deletes string elements; on a scalar it raises), `updated_at` is left as
-- the traveller last set it, and a second run matches no row. DATA ONLY: no schema change.

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE expense_line_item
       SET mileage_route = mileage_route - ARRAY['encodedPolyline', 'passThrough', 'routeFetchedAt']
     WHERE organization_id = org
       AND jsonb_typeof(mileage_route) = 'object'
       AND mileage_route ?| ARRAY['encodedPolyline', 'passThrough', 'routeFetchedAt'];
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;
