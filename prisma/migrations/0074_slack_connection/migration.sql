-- w5-02a — Slack: each tenant connects its own Slack app (decided 17 Oct 2026).
--
-- ExpenseOS keeps one org-wide Slack app as an `integration` installation whose config holds
-- `botToken` and `signingSecret`, encrypted at rest (`packages/notifications/src/slack.ts`,
-- 1e682dd6). VeloExpense is multi-tenant, and its `integration_installation` is the accounting
-- ledger's table — the screen, the module gate and the "one active installation" rule are all
-- about ledgers — so a tenant's Slack app gets a table of its own: one row per tenant, the two
-- secrets encrypted in Node by lib/crypto/secrets.ts (`enc:v1:`), never in cleartext here.
--
-- Disconnecting DELETES the row: a disconnect that leaves a working bot token in the database
-- is not a disconnect (the same rule /admin/integrations states).
CREATE TABLE slack_connection (
    organization_id  uuid PRIMARY KEY REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- The Bot User OAuth Token (xoxb-…), encrypted.
    bot_token        text NOT NULL,
    -- The app's Signing Secret, encrypted. Nullable as ExpenseOS's is: outbound DMs work
    -- without it, and only inbound requests (w5-02b) need it.
    signing_secret   text,
    connected_at     timestamptz NOT NULL DEFAULT now(),
    connected_by_id  uuid NOT NULL,
    -- The last time an admin pressed Test (auth.test), and what Slack said.
    last_test_at     timestamptz,
    last_test_ok     boolean,
    last_test_error  text,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Ciphertext only. A plaintext token reaching this table is a bug, and this says so at
    -- the write rather than at the next audit.
    CONSTRAINT slack_connection_bot_token_encrypted CHECK (bot_token LIKE 'enc:v1:%'),
    CONSTRAINT slack_connection_signing_secret_encrypted
        CHECK (signing_secret IS NULL OR signing_secret LIKE 'enc:v1:%'),
    -- Composite, per TN-1 (0014): a plain FK would accept another tenant's user.
    CONSTRAINT slack_connection_connected_by_fkey
        FOREIGN KEY (organization_id, connected_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE slack_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_connection FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slack_connection
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ExpenseOS's `User.slackUserId` / `User.slackLookupAt`: the recipient's Slack user id, resolved
-- lazily from their email with users.lookupByEmail and cached, and when that was last asked.
-- A null id with a lookup time is a cached "Slack has no account for this address".
ALTER TABLE app_user ADD COLUMN slack_user_id   text;
ALTER TABLE app_user ADD COLUMN slack_lookup_at timestamptz;
