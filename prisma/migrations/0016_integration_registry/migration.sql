-- VeloExpense 0016_integration_registry — VX3-3.
--
-- ONE tenant table. No global reflection table, deliberately — see below.
--
-- ── What is NOT here, and why ────────────────────────────────────────────────
--
-- ExpenseOS has a global `Integration` row per descriptor, upserted at boot by a
-- `reconcile` that validates cross-references before writing. The design is
-- sound and its own file says the right thing — "specs are code-owned … the DB
-- rows are a persisted reflection … never the source of truth for a spec's shape"
-- — but GAP-AUDIT AC-2 records two costs: stale rows are never pruned, so a
-- removed descriptor keeps listing with its old schema; and the whole reconcile is
-- wrapped in one try/catch at boot, with a blast radius their own test spells out:
-- "a typo in `requiresIntegrations` does not fail the build, does not fail the
-- boot, and does not fail loudly: it silently skips the ENTIRE reconcile, so no
-- module or integration row is created or updated, and every module-gated page
-- 404s with nothing in the logs pointing at the cause."
--
-- VeloExpense already has a better convention for exactly this, from `0006`:
--
--     -- Validated against the code registry (lib/policy/rules.ts), NOT a CHECK
--     -- constraint: adding a rule kind must not require a migration.
--     kind text NOT NULL
--
-- So `integration_slug` is text, `lib/integrations/registry.ts` is the source of
-- truth, and there is nothing to reconcile, nothing to prune, and no boot step
-- that can fail silently. An installation whose adapter a later deploy removed
-- lists as unknown on the admin screen rather than disappearing.

-- ── First: the UNIQUE that a composite foreign key into `app_user` needs ────
-- BEFORE the table, not after: a composite FK is validated when the table is
-- created, and Postgres refuses with "there is no unique constraint matching given
-- keys for referenced table" if the key does not exist yet. Not a change to how
-- `app_user` behaves — it is the enabler, and VX3-10 needs it for the other FKs
-- into this table anyway.
ALTER TABLE app_user ADD CONSTRAINT app_user_org_id_uniq UNIQUE (organization_id, id);

CREATE TABLE integration_installation (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    -- Validated in code, per the note above.
    integration_slug text NOT NULL,
    -- ── `code`, and why it is not the slug ───────────────────────────────────
    -- Ported from ExpenseOS (AC-3), whose inline comment is the reason: "an
    -- integration TYPE may have several labeled installations (e.g. two Google
    -- Workspace connections). `code` is the per-installation unique identifier."
    -- Two ledgers of the same kind is a real shape — two QuickBooks companies for
    -- two subsidiaries — and a slug-keyed table cannot express it.
    code             text NOT NULL,
    label            text NOT NULL,
    active           boolean NOT NULL DEFAULT false,
    -- Secret-typed fields are encrypted IN PLACE, behind an `enc:v1:` marker, by
    -- lib/crypto/secrets.ts. The database never sees a credential in cleartext and
    -- never sees the key (AC-4 — ExpenseOS passes both to pgcrypto per call).
    config           jsonb NOT NULL DEFAULT '{}'::jsonb,
    connected_at     timestamptz,
    connected_by_id  uuid,
    -- The last time an admin pressed "test", and what happened. Kept because a
    -- connection that worked in March is not evidence about today, and the
    -- alternative is an operator guessing which end is broken.
    last_test_at     timestamptz,
    last_test_ok     boolean,
    last_test_error  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code),
    CONSTRAINT integration_installation_connected_complete
        CHECK ((connected_at IS NULL) = (connected_by_id IS NULL)),
    -- Composite, per GAP-AUDIT TN-1: a plain `REFERENCES app_user(id)` accepts
    -- ANOTHER TENANT's id, because Postgres checks referential integrity with RLS
    -- bypassed. `0014` set the precedent that every NEW foreign key is declared
    -- this way; VX3-10 still owns converting the 43 that predate it.
    --
    -- ── RESTRICT, and the first version of this was SET NULL ─────────────────
    -- `ON DELETE SET NULL (connected_by_id)` and the CHECK above CONTRADICT each
    -- other: nulling the actor while `connected_at` stays set violates the pair,
    -- so deleting the user failed with a check-constraint error rather than
    -- clearing the attribution. Only a delete surfaces that, and a test is what
    -- found it.
    --
    -- RESTRICT is also the right answer independently, and it is the same choice
    -- `0013` made for `reimbursed_by_id`: connecting a ledger is where a tenant's
    -- accounting credentials enter the system, and "who did that" should not be
    -- erasable by deleting a user. `app_user` is soft-deleted anyway
    -- (`deleted_at`), so this costs nothing in practice.
    CONSTRAINT integration_installation_connected_by_fkey
        FOREIGN KEY (organization_id, connected_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);


CREATE INDEX integration_installation_org_id_idx
    ON integration_installation (organization_id);

-- ── ONE ACTIVE INSTALLATION PER INTEGRATION, and this is a fix ──────────────
--
-- AC-3: ExpenseOS resolves an installation with
-- `installations: { where: { active: true }, take: 1 }` and NO ordering, so two
-- active installations of one type resolve arbitrarily and nothing detects that
-- state. Tolerable when a single-tenant admin created both rows by hand;
-- not tolerable once `code` is tenant-scoped and a customer can make the second
-- one on a Tuesday afternoon. Several installations are still allowed — that is
-- what `code` is for — but only one of them may be ACTIVE.
CREATE UNIQUE INDEX integration_installation_one_active_idx
    ON integration_installation (organization_id, integration_slug)
    WHERE active;

ALTER TABLE integration_installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_installation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_installation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON COLUMN integration_installation.config IS
    'Adapter configuration. Fields the adapter marks type=''secret'' are stored '
    'encrypted in place behind an enc:v1: marker (lib/crypto/secrets.ts). Never '
    'log this column.';
COMMENT ON COLUMN integration_installation.integration_slug IS
    'Names an adapter in lib/integrations/registry.ts. Validated in code, not by a '
    'CHECK — adding an adapter must not require a migration.';
