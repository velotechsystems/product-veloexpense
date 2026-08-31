-- VeloExpense 0020_integration_oauth — VX3-8, the plumbing half.
--
-- Makes an integration connectable BY REDIRECT rather than only by pasted value.
-- Nothing in this migration is QuickBooks-specific, and that is the point: the
-- vendor lives in `lib/integrations/<vendor>.ts` and the schema stays neutral
-- (HANDOFF §1, enforced by `npm run check:vendor`).
--
-- ── Why this exists before there is a tenant to use it ──────────────────────
--
-- VX3-3 built the registry around one shape of authentication: an admin pastes
-- values into a form, `ConfigField` is `text | url | secret`, and `AdapterConfig`
-- is `Record<string, string>`. That is exactly right for VeloLedger, whose auth is
-- a bearer API key.
--
-- QuickBooks Online cannot be connected that way at all. Its auth is OAuth2
-- authorization-code: the admin is redirected to Intuit, consents, and comes back
-- to a callback carrying a short-lived code plus an identifier for the company
-- they chose. The code is exchanged for an access token AND a refresh token; the
-- access token expires in the order of an hour, the refresh token lasts months,
-- ROTATES when used, and when it finally dies the only remedy is asking the human
-- to consent again. None of that is expressible as a form field.
--
-- So the plumbing lands now, while there is time to get it right, rather than on
-- the morning a client is being onboarded. AC-18 records the reasoning.
--
-- ── Tokens live on the INSTALLATION, not in a separate table ────────────────
--
-- An installation already IS "one tenant's connection to one far-end system",
-- with `code` allowing several (AC-3: two QuickBooks companies for two
-- subsidiaries is a real shape). Tokens belong to that, one to one. A separate
-- table would buy nothing and add a join plus a second RLS policy to keep right.
--
-- Token columns are ENCRYPTED IN PLACE by `lib/crypto/secrets.ts`, behind the
-- same `enc:v1:` marker the `config` blob uses — the database never sees a token
-- in cleartext and never sees the key (AC-4). They are separate columns rather
-- than more keys in `config` because the service has to read the expiry to decide
-- whether to refresh, and an expiry buried in an encrypted blob cannot be read
-- without decrypting every credential on the row.

-- ── auth_kind ───────────────────────────────────────────────────────────────
-- Which shape of authentication this installation uses. Declared by the ADAPTER
-- and copied here on connect, so a row can be understood without loading code.
ALTER TABLE integration_installation
    ADD COLUMN auth_kind text NOT NULL DEFAULT 'CONFIG';

ALTER TABLE integration_installation
    ADD CONSTRAINT integration_installation_auth_kind_chk
    CHECK (auth_kind IN ('CONFIG', 'OAUTH2'));

-- ── the tokens, and the far end's identifier for the account ────────────────
ALTER TABLE integration_installation
    -- Encrypted. Short-lived; refreshed on use.
    ADD COLUMN oauth_access_token text,
    -- Encrypted. Long-lived, and ROTATES: a refresh returns a new one, and the
    -- old one stops working. Losing the write that stores the new value therefore
    -- breaks the connection, which is why the service writes it in the same
    -- transaction that clears the consent flag.
    ADD COLUMN oauth_refresh_token text,
    ADD COLUMN oauth_access_expires_at timestamptz,
    -- The refresh token has its OWN, much longer expiry. Stored so an operator can
    -- be told "this will need re-authorising by <date>" instead of discovering it
    -- when a report fails to post.
    ADD COLUMN oauth_refresh_expires_at timestamptz,
    -- What the far end calls the account/company/tenant the admin chose. QuickBooks
    -- sends a realm id; another vendor will send something else. Deliberately NOT
    -- named after any of them.
    ADD COLUMN external_account_id text,
    -- Recorded because a token granted under narrower scopes than the adapter needs
    -- fails later, on a capability, with a message about permissions.
    ADD COLUMN oauth_scope text,
    -- Set when a refresh has failed in a way only a human can fix — the refresh
    -- token expired, or was revoked at the far end. NOT set for a network failure:
    -- the difference is the same refused-versus-ambiguous distinction AC-17 is
    -- about, and getting it wrong here means nagging an admin to re-consent
    -- because somebody's DNS blipped.
    ADD COLUMN oauth_needs_consent boolean NOT NULL DEFAULT false,
    ADD COLUMN oauth_authorised_at timestamptz;

-- An OAUTH2 installation that is ACTIVE must hold a refresh token. Without one it
-- cannot survive its first access-token expiry, so "active" would be a claim that
-- stops being true within the hour.
ALTER TABLE integration_installation
    ADD CONSTRAINT integration_installation_oauth_complete
    CHECK (
        auth_kind <> 'OAUTH2'
        OR NOT active
        OR oauth_refresh_token IS NOT NULL
    );

-- A CONFIG installation must not carry tokens. Cheap, and it means a bug that
-- wrote a token onto the wrong kind of row fails at the write rather than leaving
-- a credential somewhere nothing will ever read or rotate.
ALTER TABLE integration_installation
    ADD CONSTRAINT integration_installation_config_has_no_tokens
    CHECK (
        auth_kind = 'OAUTH2'
        OR (oauth_access_token IS NULL AND oauth_refresh_token IS NULL)
    );

COMMENT ON COLUMN integration_installation.auth_kind IS
    'CONFIG (values pasted into a form) or OAUTH2 (authorization-code redirect). '
    'Declared by the adapter; copied here so a row is legible without code.';
COMMENT ON COLUMN integration_installation.external_account_id IS
    'The far end''s identifier for the account the admin authorised — a realm, '
    'company or tenant id depending on the vendor. Vendor-neutral by name on purpose.';
COMMENT ON COLUMN integration_installation.oauth_needs_consent IS
    'A refresh failed in a way only a human can fix (expired or revoked). Never '
    'set for an ambiguous or network failure — see GAP-AUDIT AC-17.';

-- ── the one-time state of an authorisation attempt ──────────────────────────
--
-- An OAuth redirect leaves and comes back, so something has to survive in between
-- and prove the callback belongs to a request this tenant actually started. That
-- is the `state` parameter, and it is a CREDENTIAL: anyone who can replay it can
-- attach their own far-end account to somebody else's installation.
--
-- Which is why this table stores a HASH, single-use and short-lived, exactly as
-- `0012` does for approve-link tokens (`action_token`) and for the same reason:
-- a database read must not yield a usable value. The plaintext exists only in the
-- URL the admin's browser carries.
CREATE TABLE integration_oauth_state (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    installation_id  uuid NOT NULL,
    -- sha256 hex of the state value. Same shape constraint as action_token_hash.
    state_hash       text NOT NULL,
    -- Echoed back to the token exchange, which must receive the SAME redirect_uri
    -- it was authorised with. Stored rather than recomputed so a deployment whose
    -- origin changes mid-flight fails loudly instead of silently mismatching.
    redirect_uri     text NOT NULL,
    expires_at       timestamptz NOT NULL,
    consumed_at      timestamptz,
    created_by_id    uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT integration_oauth_state_hash_shape
        CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    -- Composite through organization_id, per the §1 house rule VX3-10 made
    -- universal: a single-column REFERENCES accepts another tenant's id because
    -- Postgres checks referential integrity with RLS bypassed (TN-1).
    CONSTRAINT integration_oauth_state_installation_fkey
        FOREIGN KEY (organization_id, installation_id)
        REFERENCES integration_installation (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT integration_oauth_state_created_by_fkey
        FOREIGN KEY (organization_id, created_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);

-- Global, not per tenant: the callback arrives with a state and NO session, so
-- the lookup cannot be tenant-scoped. Unique because a state is single-use.
CREATE UNIQUE INDEX integration_oauth_state_hash_idx
    ON integration_oauth_state (state_hash);
CREATE INDEX integration_oauth_state_by_installation
    ON integration_oauth_state (organization_id, installation_id, created_at DESC);

ALTER TABLE integration_oauth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_oauth_state FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON integration_oauth_state
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── the hatch, and why it is narrower than it looks ─────────────────────────
--
-- The callback route has no session and no tenant: it holds a state value and
-- nothing else, so it cannot set `app.current_org` before reading. Same problem
-- `0012` solved for the approve-link, and the same solution — a second policy
-- gated on `app.platform_task`, matching ONLY rows that are still live work.
--
-- A consumed or expired state matches NOTHING here, so "reject a replayed or
-- stale callback" is a row that is absent rather than an `if` somebody has to
-- remember to write. FOR SELECT only: the callback reads the state to learn which
-- tenant it belongs to, then does every write inside `withOrg` for that tenant.
CREATE POLICY platform_read ON integration_oauth_state
    FOR SELECT
    USING (
        current_setting('app.platform_task', true) = 'on'
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
    );

COMMENT ON TABLE integration_oauth_state IS
    'One in-flight authorisation attempt. Stores a sha256 of the state value, '
    'single-use and short-lived, for the same reason action_token does: a database '
    'read must not yield a replayable credential.';
