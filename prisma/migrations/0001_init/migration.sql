-- VeloExpense 0001_init — tenancy spine.
-- Establishes: the Organization tenant root, ONE global reference table
-- (currency) as the pattern for global data, and ONE tenant-scoped table
-- (app_user) demonstrating the mandatory RLS convention. Every future
-- tenant table copies the app_user block verbatim.
--
-- Session variable: app.current_org  (LOCKED — do not use app.current_organization_id).

-- ── Root tenant table ────────────────────────────────────────────────────────
CREATE TABLE organization (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,                    -- used by org-slug SSO login
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'active',          -- active | suspended | trial
    settings    jsonb NOT NULL DEFAULT '{}'::jsonb,      -- branding, enabled modules, locale/currency, enc-key seam
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── GLOBAL reference table (no organization_id, no RLS) ───────────────────────
-- Reference data is shared across all tenants: currency, country, tax rates,
-- chart-of-accounts starter templates. This is the ONLY category exempt from RLS.
CREATE TABLE currency (
    code      text PRIMARY KEY,        -- ISO-4217, e.g. CAD, USD
    name      text NOT NULL,
    minor_unit smallint NOT NULL DEFAULT 2
);
INSERT INTO currency (code, name, minor_unit) VALUES
    ('CAD','Canadian Dollar',2), ('USD','US Dollar',2);

-- ── TENANT-SCOPED table — the mandatory pattern ──────────────────────────────
CREATE TABLE app_user (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    email           text NOT NULL,
    display_name    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, email)          -- tenant-scoped uniqueness
);
CREATE INDEX app_user_org_id_idx ON app_user (organization_id);

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE  ROW LEVEL SECURITY;   -- applies even to the table owner
CREATE POLICY tenant_isolation ON app_user
    USING      (organization_id = current_setting('app.current_org', true)::uuid)
    WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);
