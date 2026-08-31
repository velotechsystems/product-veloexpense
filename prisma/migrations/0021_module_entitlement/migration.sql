-- VX4-1 — per-tenant module entitlements.
--
-- ── What this replaces, and why it is a TABLE ────────────────────────────────
--
-- ExpenseOS gates optional functionality with `Module` + `ModuleInstallation`,
-- and `moduleInstallation.moduleId` is `@unique` — one row per module for the
-- whole deployment. Their schema says so in a comment (GAP-AUDIT MT-1):
--
--   "Single-tenant: one installation per Module (unique). A future tenant model
--    adds `tenantId` here only."
--
-- This is that future tenant model, and it is a TABLE rather than a key inside
-- `organization.settings`, whose 0001 comment has promised "enabled modules"
-- since the first migration and which nothing has ever read. AC-21 is the
-- argument: a value inside a jsonb column is out of reach of every constraint,
-- index, foreign key and RLS predicate that would otherwise protect it — which
-- is exactly how VX3-8's OAuth tokens survived a disconnect once they moved from
-- the config blob into columns. An entitlement decides whether a tenant may use
-- a paid part of the product. It wants a row.
--
-- ── ABSENCE MEANS OFF ───────────────────────────────────────────────────────
--
-- There is no `defaultOn` and no seeded row per module per tenant. A tenant with
-- no row for a module does not have that module, which makes the default
-- FAIL-CLOSED — the same choice VX2-8's `WORKER_SECRET` gate made, and for the
-- same reason: the failure mode of a missing row is "a feature is unavailable",
-- and the failure mode of an assumed default is "a tenant is using something
-- nobody sold them".
--
-- `enabled` is still a column rather than the row's existence carrying the
-- meaning, because turning a module OFF is an event worth keeping: who did it,
-- when, and — for the phase after this one — what a customer should be billed
-- for. A deleted row would answer none of that.
--
-- ── Module codes are owned by CODE, not by this table ───────────────────────
--
-- No `module` catalogue table, and no CHECK constraint enumerating the codes.
-- `lib/modules/registry.ts` is the single declaration, exactly as
-- `lib/integrations/registry.ts` is for adapters, and for the reason `0016`
-- gives for `integration_slug`: a build either has the code or it does not, and a
-- database CHECK would need a migration every time a module is added while still
-- not proving the build can serve it. `module_code` is validated in the service
-- against the registry, which also refuses a module that is declared but not yet
-- available (the dormant-QuickBooks pattern from VX3-8).

CREATE TABLE module_entitlement (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    -- Names a module in lib/modules/registry.ts. Validated in code, not by a
    -- CHECK — see the header.
    module_code      text NOT NULL,
    enabled          boolean NOT NULL DEFAULT true,

    -- Who last changed it and when. `enabled_at` is the moment it was last turned
    -- ON, kept separately from `updated_at` so "since when has this tenant had
    -- budgets" survives an unrelated edit.
    enabled_at       timestamptz,
    disabled_at      timestamptz,
    changed_by_id    uuid,

    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- One row per module per tenant. The whole point of the ticket: this is the
    -- constraint ExpenseOS wrote as `@unique` on the module alone.
    UNIQUE (organization_id, module_code),

    -- Composite through organization_id, per the §1 house rule VX3-10 made
    -- universal: a single-column REFERENCES accepts another tenant's id because
    -- Postgres checks referential integrity with RLS bypassed (TN-1).
    --
    -- SET NULL rather than RESTRICT: an admin who leaves the company must be
    -- deletable, and losing the attribution on a toggle is a smaller loss than a
    -- tenant unable to remove a user. The AUDIT row keeps the attribution — that
    -- is what it is for, and `audit_entry` is append-only.
    CONSTRAINT module_entitlement_changed_by_fkey
        FOREIGN KEY (organization_id, changed_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (changed_by_id)
);

-- The read every gated call makes: "is <module> on for this tenant". Covering,
-- so the check is an index-only lookup rather than a heap fetch — it runs on
-- every request that touches a gated surface.
CREATE UNIQUE INDEX module_entitlement_lookup
    ON module_entitlement (organization_id, module_code) INCLUDE (enabled);

ALTER TABLE module_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_entitlement FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON module_entitlement
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON TABLE module_entitlement IS
    'Which optional modules a tenant may use. ABSENCE MEANS OFF — there is no '
    'default-on set. Module codes are declared in lib/modules/registry.ts and '
    'validated in the service, not by a CHECK constraint (see 0016 on '
    'integration_slug for the same reasoning).';
COMMENT ON COLUMN module_entitlement.enabled IS
    'A column rather than the row''s existence, so turning a module OFF stays on '
    'the record with its actor and timestamp — a deleted row answers no billing '
    'question.';
