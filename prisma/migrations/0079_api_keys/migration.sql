-- VeloExpense 0079_api_keys — Wave 6, the MCP server and personal API keys (w6-04, d88).
--
-- ExpenseOS's API keys (1e682dd6), as its schema stands after 20260818100000_api_keys,
-- 20260818150000_api_key_request_coalescing and 20260818170000_api_key_idempotency
-- (20260902130000 and 20260904060000 only re-point or count rows, and create nothing):
--   · api_key             — a credential that acts as a person: a personal key (USER) carries
--                           its owner's authority; a platform key (PLATFORM) names a subject
--                           per request. Only a SHA-256 of the token is stored, never the token;
--   · api_key_request     — every call made with a key, successful or not (not hash-chained;
--                           mutations still write a real audit row carrying `viaApiKey`);
--   · api_key_idempotency — replay protection for mutating calls.
--
-- VeloExpense adaptations (the plumbing, not the meaning), as 0077 and 0078 do them:
--   · every table is per tenant: `organization_id` from the transaction's tenant, FORCE RLS,
--     and composite tenant keys (TN-1) for every reference between tenant rows, the person
--     included. A key is a credential INSIDE one company; a key that could reach another
--     tenant's rows would be the worst kind of leak, because it is the kind with no person
--     on the other end of it;
--   · ExpenseOS's `ApiKeyKind` enum is text with a CHECK, as VeloExpense's ported tables keep
--     enums, and the request log's documented `outcome` set and the idempotency `status` set
--     get CHECKs;
--   · the request log's coalescing key carries the tenant, so one tenant's sweep never folds
--     into another's row.
--
-- ── THE HATCH, AND WHY IT IS THE NARROWEST ONE IN THE SCHEMA ────────────────
--
-- A call to /api/mcp carries a bearer token and no session, so there is no `app.current_org`
-- until the token says which tenant it belongs to. Under FORCE RLS an unset context sees no
-- row at all, so something has to answer that one question first. 0036's invite hatch is the
-- shape (FOR SELECT, take nothing but `organization_id`, then do the real work inside the
-- tenant), narrowed further:
--
--   `app.api_key_lookup` is not a flag. It is the SHA-256 of the presented token, and the
--   policy shows the ONE row whose `token_hash` equals it. To see a row through this hatch you
--   must already hold that row's full secret. There is nothing to enumerate, no prefix to
--   probe, and a wrong guess is a row that is not there. Unset or empty, it matches nothing.
--
-- Not narrowed to live keys, deliberately: a revoked or expired key's holder is told so
-- (REVOKED / EXPIRED, ExpenseOS's outcomes) and the attempt is logged in that tenant, rather
-- than the key collapsing into "invalid". Holding the full token is proof enough to learn the
-- key is dead. FOR SELECT only: every write still needs a real `app.current_org`.
--
-- Callers: `server/lib/apiKeyTenant.ts` (`apiKeyTenant`), and nothing else. The rule is the
-- invite hatch's: take nothing from the row but `organization_id`.

-- ── api_key ──────────────────────────────────────────────────────────────────
CREATE TABLE api_key (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       uuid NOT NULL REFERENCES organization(id)
                          DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- USER | PLATFORM (ExpenseOS's `ApiKeyKind`).
    kind                  text NOT NULL,
    -- Human label: "Claude Desktop — laptop", "NetSuite sync".
    name                  text NOT NULL,
    -- The token's public half (`vxe_u_<prefix>_<secret>`). Not secret; indexed so
    -- verification finds the one candidate and then checks the secret against it.
    prefix                text NOT NULL,
    -- SHA-256 of the full presented token. A fast hash, deliberately: the secret is 256 bits
    -- from a CSPRNG, so there is no dictionary for a slow hash to frustrate.
    token_hash            char(64) NOT NULL,
    -- The person this key acts as. NULL for a PLATFORM key.
    user_id               uuid,
    -- Who minted it, and separately from `user_id`, who may manage it.
    created_by_id         uuid NOT NULL,
    -- Scope strings from @expenseos/api-scopes. EMPTY MEANS NO ACTION PERMITTED.
    scopes                text[] NOT NULL DEFAULT '{}',
    rate_limit_per_minute integer,
    -- Plain addresses or CIDR blocks; enforced when non-empty.
    allowed_ips           text[] NOT NULL DEFAULT '{}',
    last_used_at          timestamptz,
    expires_at            timestamptz,
    revoked_at            timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT api_key_kind CHECK (kind IN ('USER', 'PLATFORM')),
    CONSTRAINT api_key_rate_limit CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0),
    -- SET NULL (user_id): a personal key whose owner is hard-deleted is inert rather than
    -- silently gone from the list an admin is auditing (ExpenseOS's `SetNull`).
    CONSTRAINT api_key_user_id_fkey
        FOREIGN KEY (organization_id, user_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (user_id),
    -- RESTRICT, as ExpenseOS's: a key's minter is part of its record.
    CONSTRAINT api_key_created_by_id_fkey
        FOREIGN KEY (organization_id, created_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);
-- Unique across every tenant, as ExpenseOS's: a prefix and a hash name one key, anywhere.
CREATE UNIQUE INDEX api_key_prefix_key ON api_key (prefix);
CREATE UNIQUE INDEX api_key_token_hash_key ON api_key (token_hash);
CREATE INDEX api_key_user_id_idx ON api_key (user_id);
CREATE INDEX api_key_kind_idx ON api_key (kind);
CREATE INDEX api_key_created_by_id_idx ON api_key (created_by_id);
CREATE INDEX api_key_revoked_at_idx ON api_key (revoked_at);

-- ── api_key_request ──────────────────────────────────────────────────────────
CREATE TABLE api_key_request (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Nullable: a refused call may have no key to reference.
    api_key_id      uuid,
    -- The prefix presented, even when it matched nothing. Never the secret.
    prefix_tried    text,
    -- Who the call acted as. No key, as ExpenseOS's: a log row outlives the person.
    acting_user_id  uuid,
    -- The operation, not a URL: `tools/call`, `tools/list`.
    operation       text NOT NULL,
    tool_name       text,
    scope_required  text,
    outcome         text NOT NULL,
    status_code     integer,
    duration_ms     integer,
    -- `{ redacted: true }` for anything not on the guard's allowlist.
    request         jsonb,
    response        jsonb,
    ip              text,
    user_agent      text,
    -- How many attempts this row stands for; 1 for an ordinary per-call row.
    count           integer NOT NULL DEFAULT 1,
    -- The minute a COALESCED row covers; null on every per-call row.
    window_start    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    CONSTRAINT api_key_request_outcome CHECK (outcome IN (
        'OK', 'DENIED_SCOPE', 'DENIED_PERMISSION', 'RATE_LIMITED', 'IP_BLOCKED', 'INVALID_KEY',
        'EXPIRED', 'REVOKED', 'SUBJECT_REQUIRED', 'SUBJECT_NOT_ALLOWED', 'SUBJECT_UNKNOWN', 'ERROR')),
    CONSTRAINT api_key_request_api_key_id_fkey
        FOREIGN KEY (organization_id, api_key_id)
        REFERENCES api_key (organization_id, id) ON DELETE SET NULL (api_key_id)
);
-- The coalescing key. NULLs stay DISTINCT (the default): per-call rows, whose `window_start`
-- is null, never collide; coalesced rows share a key and upsert. Do not "harmonise" it.
CREATE UNIQUE INDEX api_key_request_outcome_ip_operation_window_start_key
    ON api_key_request (organization_id, outcome, ip, operation, window_start);
CREATE INDEX api_key_request_api_key_created_idx ON api_key_request (api_key_id, created_at);
CREATE INDEX api_key_request_acting_user_created_idx ON api_key_request (acting_user_id, created_at);
CREATE INDEX api_key_request_outcome_created_idx ON api_key_request (outcome, created_at);
CREATE INDEX api_key_request_expires_at_idx ON api_key_request (expires_at);

-- ── api_key_idempotency ──────────────────────────────────────────────────────
CREATE TABLE api_key_idempotency (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    api_key_id      uuid NOT NULL,
    -- The client-supplied Idempotency-Key header.
    key             text NOT NULL,
    -- Fingerprint of (toolName, input).
    request_hash    char(64) NOT NULL,
    -- Stored result for replay; null for a tool marked sensitive.
    response        jsonb,
    status          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    CONSTRAINT api_key_idempotency_status CHECK (status IN ('IN_FLIGHT', 'COMPLETED')),
    CONSTRAINT api_key_idempotency_api_key_id_fkey
        FOREIGN KEY (organization_id, api_key_id)
        REFERENCES api_key (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX api_key_idempotency_api_key_id_key_key ON api_key_idempotency (api_key_id, key);
CREATE INDEX api_key_idempotency_expires_at_idx ON api_key_idempotency (expires_at);

-- ── RLS on the three ─────────────────────────────────────────────────────────
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- The hatch (header above): the one row whose hash the caller presented, read-only.
CREATE POLICY api_key_lookup ON api_key
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.api_key_lookup', true), ''));

ALTER TABLE api_key_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_request FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key_request
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE api_key_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_idempotency FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key_idempotency
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
