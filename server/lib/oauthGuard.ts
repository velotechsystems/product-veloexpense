/**
 * The front door for an MCP call made with an OAuth access token — `guardApiRequest`'s twin for
 * the other credential.
 *
 * VeloCRM's `mcpAuth` middleware (59fce1c) verifies the JWT, checks its `jti` against a Redis
 * blocklist and the client's status, and maps the token's scope onto an MCP role. VeloExpense
 * (mcp-oauth) keeps the shape of the API-key guard instead, so the two credentials are refused,
 * limited and logged the same way:
 *
 *   · the token was already verified by the route (signature, issuer, audience, expiry) and
 *     named this tenant, which is the scope this runs in;
 *   · its GRANT must still be live, for the same person and client (`liveGrantFor`) — this is
 *     the revocation check, and it replaces VeloCRM's blocklist;
 *   · the person must still be an active member with access on (the key guard's rule);
 *   · the grant's scopes, never wider than a personal key's, are checked against the tool;
 *   · 60 calls a minute per grant, a personal key's limit, in the app's one limiter;
 *   · every call, refused or not, is a row in `api_key_request`, naming the grant.
 *
 * Permissions are the person's own (RBAC), as for a personal key: OAuth changes how the caller
 * proves who it is, not what that person may do (VeloCRM's hard constraint, "OAuth must not
 * widen any tool's authority").
 */
import { type Access, denyReason, type ScopeResource } from '@expenseos/api-scopes';
import type { PrismaClient } from '@expenseos/db';
import { resolveRbacUser } from '@expenseos/rbac/server';
import { currentTenantId, type TenantDb } from '@/lib/db/prisma';
import { liveGrantFor } from '@/lib/mcpOauth/service';
import type { AccessClaims } from '@/lib/mcpOauth/tokens';
import { bodyForLog, type Outcome } from './apiKeyGuard';
import { throttle } from './rateLimit';

export const OAUTH_RATE_LIMIT_PER_MINUTE = 60;
const LOG_RETENTION_DAYS = 90;

export interface OAuthGuardRequest {
  readonly claims: AccessClaims;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly operation: string;
  readonly toolName?: string | null;
  readonly requiredScope?: ScopeResource | null;
  readonly access?: Access;
  readonly body?: unknown;
}

export interface OAuthPrincipal {
  readonly grantId: string;
  readonly actingUserId: string;
  readonly permissions: readonly string[];
  readonly roleLabel: string;
  readonly scopes: readonly string[];
  readonly auditDetails: { readonly viaOAuth: Record<string, unknown> };
}

export type OAuthGuardResult =
  | { readonly ok: true; readonly principal: OAuthPrincipal; readonly requestLogId: string }
  | {
      readonly ok: false;
      readonly outcome: Exclude<Outcome, 'OK'>;
      readonly status: number;
      readonly message: string;
      readonly requestLogId: string;
      readonly retryAfterSeconds?: number;
    };

const MESSAGE: Partial<Record<Outcome, string>> = {
  REVOKED: 'This connection has been revoked. Connect the application again.',
  SUBJECT_UNKNOWN: 'The person this connection acts as is not active.',
  RATE_LIMITED: 'Rate limit exceeded for this connection.',
  DENIED_SCOPE: 'This connection does not have a scope permitting that.',
};
const STATUS: Partial<Record<Outcome, number>> = { REVOKED: 401, SUBJECT_UNKNOWN: 403, RATE_LIMITED: 429, DENIED_SCOPE: 403 };

export async function guardOAuthRequest(db: PrismaClient | TenantDb, req: OAuthGuardRequest): Promise<OAuthGuardResult> {
  const startedAt = Date.now();
  const organizationId = currentTenantId();
  if (!organizationId || organizationId !== req.claims.tenant_id) throw new Error('oauthGuard: not in the token\'s tenant');

  const log = async (outcome: Outcome, grantId: string | null): Promise<string> => {
    const row = await db.apiKeyRequest.create({
      data: {
        apiKeyId: null,
        oauthGrantId: grantId,
        actingUserId: req.claims.sub,
        operation: req.operation,
        toolName: req.toolName ?? null,
        scopeRequired: req.requiredScope ?? null,
        outcome,
        statusCode: outcome === 'OK' ? 200 : (STATUS[outcome] ?? 500),
        durationMs: Date.now() - startedAt,
        request: bodyForLog(req.operation, req.body) as object | undefined,
        ip: req.ip,
        userAgent: req.userAgent,
        expiresAt: new Date(Date.now() + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return row.id;
  };
  const refuse = async (outcome: Exclude<Outcome, 'OK'>, grantId: string | null, retryAfterSeconds?: number): Promise<OAuthGuardResult> => ({
    ok: false,
    outcome,
    status: STATUS[outcome] ?? 500,
    message: MESSAGE[outcome] ?? 'Refused.',
    requestLogId: await log(outcome, grantId),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

  const grant = await liveGrantFor(db as TenantDb, req.claims);
  // A revoked or deleted grant, or a token whose claims do not match it. The id goes in the log
  // only if the row still exists to point at.
  if (!grant) {
    const exists = await db.mcpOauthGrant.findUnique({ where: { id: req.claims.gid }, select: { id: true } });
    return refuse('REVOKED', exists?.id ?? null);
  }

  const verdict = await throttle(`oauth-grant:${grant.id}`, { max: OAUTH_RATE_LIMIT_PER_MINUTE, windowSec: 60 });
  if (!verdict.allowed) return refuse('RATE_LIMITED', grant.id, verdict.retryAfterSec);

  if (req.requiredScope) {
    const denial = denyReason(grant.scopes, req.requiredScope, req.access ?? 'write');
    if (denial) return refuse('DENIED_SCOPE', grant.id);
  }

  const user = await db.user.findFirst({
    where: { id: grant.userId, deletedAt: null, hasAccess: true },
    select: { id: true, roleId: true },
  });
  if (!user?.roleId) return refuse('SUBJECT_UNKNOWN', grant.id);
  const role = await db.role.findUnique({
    where: { organizationId_id: { organizationId, id: user.roleId } },
    select: { label: true },
  });
  const label = role?.label as Record<string, string> | string | null | undefined;
  const roleLabel = (typeof label === 'string' ? label : label?.en) || 'Employee';
  const rbac = await resolveRbacUser(db as PrismaClient, { userId: user.id, roleId: user.roleId, roleLabel, organizationId });

  await db.mcpOauthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    ok: true,
    principal: {
      grantId: grant.id,
      actingUserId: grant.userId,
      permissions: rbac.permissions,
      roleLabel,
      scopes: grant.scopes,
      auditDetails: { viaOAuth: { grantId: grant.id, clientId: grant.clientId, clientName: grant.clientName } },
    },
    requestLogId: await log('OK', grant.id),
  };
}
