-- w5-04 — Google Workspace directory sync: each tenant connects its own Workspace (decided
-- 18 Oct 2026, d84).
--
-- ExpenseOS syncs one Workspace from two environment variables — a service-account key
-- (GOOGLE_SERVICE_ACCOUNT_JSON) and the admin it impersonates
-- (GOOGLE_DIRECTORY_IMPERSONATE_EMAIL) — and records each run only as an audit row
-- (`packages/integrations-google/src/client.ts`, `apps/worker/src/handlers/directory-sync.ts`,
-- 1e682dd6). VeloExpense is multi-tenant, so each tenant's administrator pastes their own key
-- and admin address, and they live here: one row per tenant, the key encrypted in Node by
-- lib/crypto/secrets.ts (`enc:v1:`), never in cleartext — the shape of `slack_connection`
-- (0074), for the same reasons.
--
-- The last run's outcome is kept on the row too, so the admin screen can say what the night's
-- sync did without reading the audit chain.
--
-- Disconnecting DELETES the row: a disconnect that leaves a working key in the database is
-- not a disconnect.
CREATE TABLE google_directory_connection (
    organization_id    uuid PRIMARY KEY REFERENCES organization(id)
                       DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- The service-account key file's JSON, encrypted. It holds a private key.
    service_account_json text NOT NULL,
    -- The key's `client_email`: not a secret (it is the account's address, and the admin
    -- needs it to grant domain-wide delegation), kept in the clear so the screen can show it.
    client_email       text NOT NULL,
    -- The Workspace administrator the service account impersonates.
    impersonate_email  text NOT NULL,
    connected_at       timestamptz NOT NULL DEFAULT now(),
    connected_by_id    uuid NOT NULL,
    -- The last time an admin pressed Test, and what Google said.
    last_test_at       timestamptz,
    last_test_ok       boolean,
    last_test_error    text,
    -- The last sync run: when, how it ended, and its counts (the summary audit row's details).
    last_sync_at       timestamptz,
    last_sync_status   text,
    last_sync_summary  jsonb,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Ciphertext only. A plaintext key reaching this table is a bug, and this says so at the
    -- write rather than at the next audit.
    CONSTRAINT google_directory_connection_key_encrypted
        CHECK (service_account_json LIKE 'enc:v1:%'),
    CONSTRAINT google_directory_connection_sync_status
        CHECK (last_sync_status IS NULL OR last_sync_status IN ('completed', 'error')),
    CONSTRAINT google_directory_connection_sync_complete
        CHECK ((last_sync_at IS NULL) = (last_sync_status IS NULL)),
    -- Composite, per TN-1 (0014): a plain FK would accept another tenant's user.
    CONSTRAINT google_directory_connection_connected_by_fkey
        FOREIGN KEY (organization_id, connected_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE google_directory_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_directory_connection FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON google_directory_connection
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
