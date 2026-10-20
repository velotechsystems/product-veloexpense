/**
 * The OAuth 2.1 authorization server's database work: registration, consent, the code and
 * refresh grants, revocation, and the grant check every MCP call makes.
 *
 * Ported from VeloCRM `api/src/services/oauthServer.service.ts` and the handler bodies of
 * `api/src/routes/oauth.ts` (59fce1c). VeloExpense adaptations are marked "VeloExpense
 * (mcp-oauth):"; the shape-changing ones:
 *
 *   · Clients are global and grants per tenant (0080's header has the argument).
 *   · No owner pool. The token endpoint finds the tenant through 0080's two hatches
 *     (`oauthCodeTenantId`, `oauthRefreshTenantId`), then works inside it under RLS.
 *   · Codes are stored hashed, as refresh tokens already were.
 *   · A refused exchange RETURNS its failure instead of throwing, so that what replay detection
 *     wrote COMMITS. VeloCRM revokes the token family inside `withTenantDb` and then throws,
 *     which — `withTenantDb` being a transaction — rolls the revocation back: the replayed
 *     token is refused, but the family it was meant to end goes on working. (Flagged for the
 *     VeloCRM thread; not fixed there.)
 *   · A code presented twice revokes its grant too (RFC 6749 §4.1.2: the server SHOULD revoke
 *     tokens issued from a code that is used again). VeloCRM refuses the second use only.
 *   · Every exchange re-checks that the person is still an active member with access on
 *     (People 1's `hasAccess`): a token is a credential acting AS them, so it stops when they
 *     do. VeloCRM checks the client's status only.
 *   · Audit rows for consent, first token, and revocation (`lib/audit/actions.ts`).
 */
import { withAudit, writeAudit } from '@expenseos/audit';
import { db, withTenantDb, type TenantDb } from '@/lib/db/prisma';
import { withoutOrg, oauthCodeTenantId, oauthRefreshTenantId } from '@/lib/tenant/context';
import type { ValidClient } from './dcr';
import { onlyAllowed } from './scopes';
import {
  CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  looksLikeJwt,
  newCode,
  newRefreshToken,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  verifyPkceS256,
} from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── clients (global) ──────────────────────────────────────────────────────── */

export interface ClientRow {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: string[];
  readonly createdAt: Date;
}

const CLIENT_COLUMNS =
  'id, client_id AS "clientId", client_name AS "clientName", redirect_uris AS "redirectUris", created_at AS "createdAt"';

/** RFC 7591: store what a client registered. It authorizes nothing until somebody consents. */
export async function registerClient(client: ValidClient): Promise<ClientRow> {
  return withoutOrg(async (tx) => {
    const r = await tx.query(
      `INSERT INTO mcp_oauth_client (client_id, client_name, redirect_uris, grant_types, response_types)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
       RETURNING ${CLIENT_COLUMNS}`,
      [client.clientName, client.redirectUris, client.grantTypes, client.responseTypes],
    );
    return r.rows[0] as ClientRow;
  });
}

export async function findClient(publicClientId: string | null | undefined): Promise<ClientRow | null> {
  if (!publicClientId || !UUID.test(publicClientId)) return null;
  return withoutOrg(async (tx) => {
    const r = await tx.query(`SELECT ${CLIENT_COLUMNS} FROM mcp_oauth_client WHERE client_id = $1`, [
      publicClientId,
    ]);
    return (r.rows[0] as ClientRow | undefined) ?? null;
  });
}

/* ── consent → a grant and a code ──────────────────────────────────────────── */

export interface Consenter {
  readonly organizationId: string;
  readonly userId: string;
  readonly name: string;
}

/**
 * The person said Allow: record their grant and mint the single-use code (VeloCRM's
 * `createAuthorizationCode`, plus the grant row it does not have). The audit row is the
 * consent itself — a person giving a piece of software the right to act as them.
 */
export async function consent(
  who: Consenter,
  client: ClientRow,
  scopes: readonly string[],
  redirectUri: string,
  codeChallenge: string,
): Promise<{ code: string; grantId: string }> {
  const code = newCode();
  const granted = onlyAllowed(scopes);
  const out = await withTenantDb(who.organizationId, () =>
    withAudit(
      db,
      {
        action: 'OAUTH_GRANT_CREATED',
        entityType: 'McpOauthGrant',
        actor: { kind: 'user', id: who.userId, name: who.name, roleLabel: '' },
        details: { clientId: client.clientId, clientName: client.clientName, scopes: granted, redirectUri },
      },
      async (tx) => {
        const grant = await tx.mcpOauthGrant.create({
          data: { clientId: client.id, userId: who.userId, scopes: granted },
          select: { id: true },
        });
        await tx.mcpOauthCode.create({
          data: {
            grantId: grant.id,
            codeHash: sha256Hex(code),
            codeChallenge,
            redirectUri,
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        });
        return { code, grantId: grant.id };
      },
      (r) => r.grantId,
    ),
  );
  await withoutOrg((tx) => tx.query('UPDATE mcp_oauth_client SET last_authorized_at = now() WHERE id = $1', [client.id]));
  return out;
}

/* ── the token endpoint ────────────────────────────────────────────────────── */

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export type TokenResult =
  | { readonly ok: true; readonly body: TokenResponse }
  | { readonly ok: false; readonly error: 'invalid_grant' | 'invalid_client'; readonly description: string };

const invalidGrant = (description: string): TokenResult => ({ ok: false, error: 'invalid_grant', description });

/** Is the person a grant acts as still somebody a credential may act as? */
async function memberStillActive(tx: TenantDb, userId: string): Promise<{ name: string } | null> {
  const u = await tx.user.findFirst({
    where: { id: userId, deletedAt: null, hasAccess: true },
    select: { name: true, email: true },
  });
  return u ? { name: u.name || u.email } : null;
}

/** End a grant: every refresh token under it, and (through `gid`) every access token. */
async function revokeGrantTx(
  tx: TenantDb,
  grantId: string,
  reason: 'USER' | 'ADMIN' | 'REPLAY' | 'CLIENT',
  actor: { id: string; name: string } | null,
): Promise<boolean> {
  const done = await tx.mcpOauthGrant.updateMany({
    where: { id: grantId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason, revokedById: actor && reason !== 'REPLAY' && reason !== 'CLIENT' ? actor.id : null },
  });
  if (done.count === 0) return false;
  const grant = await tx.mcpOauthGrant.findUnique({
    where: { id: grantId },
    select: { userId: true, client: { select: { clientId: true, clientName: true } } },
  });
  await writeAudit(tx, {
    action: 'OAUTH_GRANT_REVOKED',
    entityType: 'McpOauthGrant',
    entityId: grantId,
    actor:
      actor !== null
        ? { kind: 'user', id: actor.id, name: actor.name, roleLabel: '' }
        : { kind: 'system', jobName: 'mcp-oauth' },
    details: { reason, clientId: grant?.client.clientId, clientName: grant?.client.clientName, userId: grant?.userId },
  });
  return true;
}

async function issueTokens(
  tx: TenantDb,
  base: string,
  organizationId: string,
  grant: { id: string; userId: string; scopes: string[]; client: { clientId: string } },
): Promise<TokenResponse> {
  const refresh = newRefreshToken();
  await tx.mcpOauthRefreshToken.create({
    data: { grantId: grant.id, tokenHash: sha256Hex(refresh), expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) },
  });
  const scope = onlyAllowed(grant.scopes).join(' ');
  const access = await signAccessToken(base, {
    sub: grant.userId,
    tenant_id: organizationId,
    scope,
    client_id: grant.client.clientId,
    gid: grant.id,
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  };
}

/** `grant_type=authorization_code` (VeloCRM's `exchangeCodeForTokens`). */
export async function exchangeCode(input: {
  base: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<TokenResult> {
  const codeHash = sha256Hex(input.code);
  const organizationId = await oauthCodeTenantId(codeHash);
  if (!organizationId) return invalidGrant('authorization code not found');

  return withTenantDb(organizationId, async (tx) => {
    const row = await tx.mcpOauthCode.findUnique({
      where: { codeHash },
      include: { grant: { include: { client: { select: { clientId: true } } } } },
    });
    if (!row) return invalidGrant('authorization code not found');
    // VeloCRM looks the code up by (tenant, code, client_id) together; a code presented by
    // another client is "not found" there and here.
    if (row.grant.client.clientId !== input.clientId) return invalidGrant('authorization code not found');
    if (row.usedAt) {
      // VeloExpense (mcp-oauth): RFC 6749 §4.1.2 — a code used twice ends what it issued.
      await revokeGrantTx(tx, row.grantId, 'REPLAY', null);
      return invalidGrant('authorization code already used');
    }
    if (row.expiresAt < new Date()) return invalidGrant('authorization code expired');
    if (row.redirectUri !== input.redirectUri) return invalidGrant('redirect_uri mismatch');
    if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) return invalidGrant('PKCE code_verifier mismatch');
    if (row.grant.revokedAt) return invalidGrant('the grant was revoked');

    // Atomic consumption (VeloCRM's UPDATE … WHERE used_at IS NULL): the second of two
    // concurrent exchanges gets no row and is refused, never a 500.
    const consumed = await tx.mcpOauthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count === 0) {
      await revokeGrantTx(tx, row.grantId, 'REPLAY', null);
      return invalidGrant('authorization code already used');
    }

    const member = await memberStillActive(tx, row.grant.userId);
    if (!member) return invalidGrant('the person this grant acts as is no longer active');

    const now = new Date();
    await tx.mcpOauthGrant.update({
      where: { id: row.grantId },
      data: { activatedAt: row.grant.activatedAt ?? now, lastUsedAt: now },
    });
    const body = await issueTokens(tx, input.base, organizationId, row.grant);
      await writeAudit(tx, {
      action: 'OAUTH_TOKEN_ISSUED',
      entityType: 'McpOauthGrant',
      entityId: row.grantId,
      actor: { kind: 'user', id: row.grant.userId, name: member.name, roleLabel: '' },
      details: { clientId: row.grant.client.clientId, scopes: row.grant.scopes, grantType: 'authorization_code' },
    });
    return { ok: true as const, body };
  });
}

/** `grant_type=refresh_token` (VeloCRM's `refreshAccessToken`), with rotation and reuse detection. */
export async function refreshTokens(input: { base: string; refreshToken: string; clientId: string }): Promise<TokenResult> {
  const tokenHash = sha256Hex(input.refreshToken);
  const organizationId = await oauthRefreshTenantId(tokenHash);
  if (!organizationId) return invalidGrant('refresh token not found');

  return withTenantDb(organizationId, async (tx) => {
    const row = await tx.mcpOauthRefreshToken.findUnique({
      where: { tokenHash },
      include: { grant: { include: { client: { select: { clientId: true } } } } },
    });
    if (!row || row.grant.client.clientId !== input.clientId) return invalidGrant('refresh token not found');
    if (row.grant.revokedAt) return invalidGrant('refresh token revoked');
    if (row.expiresAt < new Date()) return invalidGrant('refresh token expired');
    if (row.usedAt) {
      // Reuse detection: a rotated-away token came back, so either the client or a thief holds
      // a copy. End the whole grant — and COMMIT that (see the header).
      await revokeGrantTx(tx, row.grantId, 'REPLAY', null);
      return invalidGrant('refresh token replay detected — grant revoked');
    }
    const consumed = await tx.mcpOauthRefreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) {
      await revokeGrantTx(tx, row.grantId, 'REPLAY', null);
      return invalidGrant('concurrent refresh token replay — grant revoked');
    }
    const member = await memberStillActive(tx, row.grant.userId);
    if (!member) return invalidGrant('the person this grant acts as is no longer active');
    await tx.mcpOauthGrant.update({ where: { id: row.grantId }, data: { lastUsedAt: new Date() } });
    return { ok: true as const, body: await issueTokens(tx, input.base, organizationId, row.grant) };
  });
}

/**
 * RFC 7009 (VeloCRM's `/oauth/revoke`): end the grant a presented token belongs to, if the
 * presenting client owns it. Always "succeeds" — the endpoint answers 200 whatever happened.
 *
 * VeloExpense (mcp-oauth): an access token is VERIFIED before anything is revoked. VeloCRM
 * decodes it without checking the signature and revokes the refresh tokens of whatever `sub`
 * the payload names under the given client — so anyone who knows a client_id and a person's
 * id can forge an unsigned token and disconnect that person. (Flagged for the VeloCRM thread.)
 */
export async function revokeByClient(input: { base: string; token: string; clientId: string }): Promise<void> {
  if (looksLikeJwt(input.token)) {
    const claims = await verifyAccessToken(input.base, input.token);
    if (!claims || claims.client_id !== input.clientId) return;
    await withTenantDb(claims.tenant_id, (tx) => revokeGrantTx(tx, claims.gid, 'CLIENT', null));
    return;
  }
  const tokenHash = sha256Hex(input.token);
  const organizationId = await oauthRefreshTenantId(tokenHash);
  if (!organizationId) return;
  await withTenantDb(organizationId, async (tx) => {
    const row = await tx.mcpOauthRefreshToken.findUnique({
      where: { tokenHash },
      select: { grantId: true, grant: { select: { client: { select: { clientId: true } } } } },
    });
    if (!row || row.grant.client.clientId !== input.clientId) return;
    await revokeGrantTx(tx, row.grantId, 'CLIENT', null);
  });
}

/** A person or an admin ends a grant from the settings screens. True when it was live. */
export async function revokeGrant(
  tx: TenantDb,
  grantId: string,
  reason: 'USER' | 'ADMIN',
  actor: { id: string; name: string },
): Promise<boolean> {
  return revokeGrantTx(tx, grantId, reason, actor);
}

/* ── the check every MCP call makes ────────────────────────────────────────── */

export interface LiveGrant {
  readonly id: string;
  readonly userId: string;
  readonly scopes: string[];
  readonly clientId: string;
  readonly clientName: string;
}

/**
 * Inside the token's tenant: is the grant this access token names still live, for the person
 * and client the token says? Null otherwise — revoked, deleted, or a token whose claims do not
 * match its grant.
 */
export async function liveGrantFor(
  tx: TenantDb,
  claims: { gid: string; sub: string; client_id: string },
): Promise<LiveGrant | null> {
  const g = await tx.mcpOauthGrant.findUnique({
    where: { id: claims.gid },
    select: { id: true, userId: true, scopes: true, revokedAt: true, client: { select: { clientId: true, clientName: true } } },
  });
  if (!g || g.revokedAt || g.userId !== claims.sub || g.client.clientId !== claims.client_id) return null;
  return { id: g.id, userId: g.userId, scopes: onlyAllowed(g.scopes), clientId: g.client.clientId, clientName: g.client.clientName };
}
