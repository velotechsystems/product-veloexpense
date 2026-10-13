-- VeloExpense 0067_saved_view — Wave 4 (w4-08).
--
-- ExpenseOS's `SavedView` (its migration 20260521000000_add_saved_view, 550b2945): a
-- person's saved filter / sort / column state for one list ("resource"), with at most one
-- pinned default per person and list. The state is opaque JSON, validated by the router
-- (server/routers/savedViews.ts), so a list can grow columns without a migration.
--
-- Adapted (VeloExpense):
--   · per tenant, under RLS like every tenant table, with a composite foreign key to the
--     owner (TN-1). ON DELETE CASCADE, ExpenseOS's choice: a view is its owner's.
--   · `deleted_at` soft-deletes, as ExpenseOS's router does; the index serves its one read
--     (owner, resource, not deleted).
--   · one pinned default per owner and list is ALSO a partial unique index. ExpenseOS keeps
--     it in code only (clear the old default, then set the new one, in one transaction); two
--     concurrent pins could both pass that read. The router's order satisfies the index.

CREATE TABLE saved_view (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    owner_id        uuid NOT NULL,
    resource        text NOT NULL,
    name            text NOT NULL,
    state           jsonb NOT NULL,
    pinned          boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (organization_id, id),
    CONSTRAINT saved_view_owner_fkey
      FOREIGN KEY (organization_id, owner_id)
      REFERENCES app_user (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX saved_view_owner_resource_idx
    ON saved_view (organization_id, owner_id, resource, deleted_at);

CREATE UNIQUE INDEX saved_view_one_default
    ON saved_view (owner_id, resource)
 WHERE pinned AND deleted_at IS NULL;

ALTER TABLE saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_view
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
