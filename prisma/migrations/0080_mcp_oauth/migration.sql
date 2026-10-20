-- VeloExpense 0080_mcp_oauth — OAuth 2.1 for Claude connectors (ported from VeloCRM 59fce1c).
--
-- Claude's custom connectors (claude.ai, Cowork, Claude Desktop) take a server URL and nothing
-- else: no API-key field, no header. They authenticate a remote MCP server only through the MCP
-- authorization profile of OAuth 2.1 — discovery, Dynamic Client Registration, authorization
-- code + PKCE, short-lived access tokens and rotating refresh tokens. VeloCRM built that
-- (`api/src/db/schema/oauth.ts`, `services/oauthServer.service.ts`, `routes/oauth.ts`); this is
-- its data, made VeloExpense's.
--
-- VeloCRM's three tables, `mcp_oauth_clients`, `mcp_oauth_codes` and `mcp_oauth_refresh_tokens`,
-- become four here, and the split is the one design change worth reading:
--
-- ── CLIENTS ARE GLOBAL; EVERYTHING A PERSON GRANTS IS PER TENANT ────────────
--
-- VeloCRM gives every client a `tenant_id` and requires the tenant AT REGISTRATION (an
-- `X-Tenant-Id` header or a session), with a single-tenant auto-approve mode for the case where
-- neither exists. That case is the only one Claude ever produces: a connector registers
-- anonymously, from Anthropic's cloud, before anybody has signed in, so VeloCRM's registration
-- works only while VeloCRM has exactly one tenant. VeloExpense has many.
--
-- So a client here is what RFC 7591 says it is — software, identified by a random id and a set
-- of redirect URIs — and belongs to no tenant. It authorizes NOTHING by existing: VeloCRM's
-- decision 3 ("DCR open but inert until authorized") holds by construction, because the only
-- path to a token runs through a GRANT, and a grant is made by a signed-in person consenting,
-- in their own tenant, on the consent screen. A client nobody has authorized is a row with a
-- name and some URLs.
--
--   · mcp_oauth_client        — GLOBAL. No organization_id, no tenant data, no RLS: the client
--                               name the software chose and its redirect URIs. Read and written
--                               by the registration and token endpoints with no tenant set.
--   · mcp_oauth_grant         — per tenant. One person's consent to one client, with the scopes
--                               they agreed to. Revoking it (theirs, an admin's, or replay
--                               detection) ends every token the client holds under it, AT
--                               ONCE: an access token names its grant, and /api/mcp checks it.
--                               VeloCRM's family_id, made a row a person can see and revoke.
--   · mcp_oauth_code          — per tenant. VeloCRM's single-use PKCE code, 10 minutes, stored
--                               as a SHA-256 (VeloCRM stores it in clear).
--   · mcp_oauth_refresh_token — per tenant. VeloCRM's rotating refresh token, hashed, 30 days.
--                               Presenting a used one revokes its grant (reuse detection).
--
-- ── THE TWO HATCHES ─────────────────────────────────────────────────────────
--
-- The token endpoint receives a code or a refresh token and no session, so no `app.current_org`.
-- VeloCRM reads `mcp_oauth_codes` and `mcp_oauth_refresh_tokens` through its OWNER pool to find
-- the tenant (a carve-out in its apply-rls.ts). VeloExpense has no owner pool in the request
-- path, and 0079 already settled the shape for this: `api_key_lookup`. Two more of exactly that
-- shape:
--
--   `app.oauth_code_lookup`    — the SHA-256 of the presented code. Shows the ONE code row whose
--                                `code_hash` equals it.
--   `app.oauth_refresh_lookup` — the SHA-256 of the presented refresh token. Shows the ONE row
--                                whose `token_hash` equals it.
--
-- Neither GUC is a flag. To see a row you must already hold its full secret (256 and 320 bits
-- from a CSPRNG); there is nothing to enumerate and a wrong guess is a row that is not there.
-- FOR SELECT only. The callers take `organization_id` and nothing else, then do the real work
-- inside the tenant under `tenant_isolation`: `lib/tenant/context.ts` (`oauthCodeTenantId`,
-- `oauthRefreshTenantId`), and nothing else.
--
-- An ACCESS token needs no hatch: it is a signed JWT whose `org` claim names the tenant, and
-- nothing is read until the signature, issuer, audience and expiry have been verified.

-- ── mcp_oauth_client (global) ────────────────────────────────────────────────
CREATE TABLE mcp_oauth_client (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The public `client_id` handed back by registration. A random UUID, as VeloCRM's.
    client_id                  text NOT NULL UNIQUE,
    -- HTML-stripped and capped at 255 at registration (VeloCRM's XSS rule); shown on the
    -- consent screen as the software's own claim about itself, never as a fact.
    client_name                text NOT NULL,
    redirect_uris              text[] NOT NULL,
    grant_types                text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
    response_types             text[] NOT NULL DEFAULT ARRAY['code'],
    -- Public clients only, as VeloCRM's: no secret is ever issued, PKCE is the proof.
    token_endpoint_auth_method text NOT NULL DEFAULT 'none',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    -- Set when somebody first consents: an operator can tell a client in use from a stray
    -- registration without reading any tenant's rows.
    last_authorized_at         timestamptz,
    CONSTRAINT mcp_oauth_client_name CHECK (length(client_name) BETWEEN 1 AND 255),
    CONSTRAINT mcp_oauth_client_redirects CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
    CONSTRAINT mcp_oauth_client_auth_method CHECK (token_endpoint_auth_method = 'none')
);

-- ── mcp_oauth_grant ──────────────────────────────────────────────────────────
CREATE TABLE mcp_oauth_grant (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    client_id       uuid NOT NULL REFERENCES mcp_oauth_client(id) ON DELETE CASCADE,
    -- The person who consented, and whom every token under this grant acts as.
    user_id         uuid NOT NULL,
    -- Scope strings from @expenseos/api-scopes — a subset of what a personal key holds.
    scopes          text[] NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Set when the client first exchanges its code. A grant never activated reached no data.
    activated_at    timestamptz,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    revoked_by_id   uuid,
    -- USER (the person, on /preferences) | ADMIN (/admin/api-keys) | REPLAY (a used refresh
    -- token came back) | CLIENT (the client called /oauth/revoke).
    revoke_reason   text,
    UNIQUE (organization_id, id),
    CONSTRAINT mcp_oauth_grant_revoke_reason CHECK (
        revoke_reason IS NULL OR revoke_reason IN ('USER', 'ADMIN', 'REPLAY', 'CLIENT')),
    CONSTRAINT mcp_oauth_grant_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
    CONSTRAINT mcp_oauth_grant_user_id_fkey
        FOREIGN KEY (organization_id, user_id)
        REFERENCES app_user (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT mcp_oauth_grant_revoked_by_id_fkey
        FOREIGN KEY (organization_id, revoked_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (revoked_by_id)
);
CREATE INDEX mcp_oauth_grant_user_idx ON mcp_oauth_grant (organization_id, user_id);
CREATE INDEX mcp_oauth_grant_client_idx ON mcp_oauth_grant (client_id);

-- ── mcp_oauth_code ───────────────────────────────────────────────────────────
CREATE TABLE mcp_oauth_code (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       uuid NOT NULL REFERENCES organization(id)
                          DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    grant_id              uuid NOT NULL,
    -- SHA-256 of the code. VeloCRM stores the code itself.
    code_hash             char(64) NOT NULL,
    code_challenge        text NOT NULL,
    code_challenge_method text NOT NULL DEFAULT 'S256',
    redirect_uri          text NOT NULL,
    used_at               timestamptz,
    expires_at            timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT mcp_oauth_code_method CHECK (code_challenge_method = 'S256'),
    CONSTRAINT mcp_oauth_code_grant_id_fkey
        FOREIGN KEY (organization_id, grant_id)
        REFERENCES mcp_oauth_grant (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mcp_oauth_code_code_hash_key ON mcp_oauth_code (code_hash);
CREATE INDEX mcp_oauth_code_expires_at_idx ON mcp_oauth_code (expires_at);

-- ── mcp_oauth_refresh_token ──────────────────────────────────────────────────
CREATE TABLE mcp_oauth_refresh_token (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- VeloCRM's `family_id`: every rotation of one consent shares it.
    grant_id        uuid NOT NULL,
    token_hash      char(64) NOT NULL,
    used_at         timestamptz,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT mcp_oauth_refresh_token_grant_id_fkey
        FOREIGN KEY (organization_id, grant_id)
        REFERENCES mcp_oauth_grant (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mcp_oauth_refresh_token_token_hash_key ON mcp_oauth_refresh_token (token_hash);
CREATE INDEX mcp_oauth_refresh_token_grant_idx ON mcp_oauth_refresh_token (grant_id);
CREATE INDEX mcp_oauth_refresh_token_expires_at_idx ON mcp_oauth_refresh_token (expires_at);

-- ── the request log learns about grants ──────────────────────────────────────
-- A call made with an OAuth access token is logged in `api_key_request` beside the key calls,
-- naming the grant instead of a key: one log of who reached the tenant's data through
-- /api/mcp, whatever the credential.
ALTER TABLE api_key_request ADD COLUMN oauth_grant_id uuid;
ALTER TABLE api_key_request ADD CONSTRAINT api_key_request_oauth_grant_id_fkey
    FOREIGN KEY (organization_id, oauth_grant_id)
    REFERENCES mcp_oauth_grant (organization_id, id) ON DELETE SET NULL (oauth_grant_id);
CREATE INDEX api_key_request_oauth_grant_created_idx ON api_key_request (oauth_grant_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE mcp_oauth_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_grant FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_grant
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE mcp_oauth_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_code FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_code
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
-- The hatch (header above): the one code whose hash the caller presented, read-only.
CREATE POLICY mcp_oauth_code_lookup ON mcp_oauth_code
    FOR SELECT
    USING (code_hash = NULLIF(current_setting('app.oauth_code_lookup', true), ''));

ALTER TABLE mcp_oauth_refresh_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_refresh_token FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_refresh_token
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
-- The hatch (header above): the one refresh token whose hash the caller presented, read-only.
CREATE POLICY mcp_oauth_refresh_token_lookup ON mcp_oauth_refresh_token
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.oauth_refresh_lookup', true), ''));
