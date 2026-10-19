/**
 * The front door for an API-key request.
 *
 * One entry point that does, in order: parse the bearer token, verify it, check the IP
 * allowlist, count the rate limit, resolve the acting person's permissions — and record
 * the attempt either way. A transport (the MCP endpoint, in a later phase) calls this and
 * gets back either a principal it can act on or a refusal it can render.
 *
 * The ordering is deliberate. Cheap and total checks come first, so a revoked key or a
 * blocked address never reaches Redis or the role lookup; and every path — including the
 * ones that refuse — writes an `ApiKeyRequest` row, because a log that only records
 * successful calls is blind to exactly the traffic worth watching.
 */

// Ported from ExpenseOS `apps/web/src/server/lib/apiKeyGuard.ts` (1e682dd6), w6-04 (d88).
// VeloExpense adaptations are marked "VeloExpense (w6-04):". The whole guard runs inside the
// key's tenant: `/api/mcp` resolves the tenant from the token first (`apiKeyTenantId`), so
// `db` here is the tenant-scoped client, every row it writes lands in that tenant, and a call
// whose token names no key in ANY tenant never reaches this file (see the route).
import { type Access, denyReason, type ScopeResource } from '@expenseos/api-scopes';
import type { PrismaClient } from '@expenseos/db';
import { currentTenantId } from '@/lib/db/prisma';
import { resolveRbacUser } from '@expenseos/rbac/server';
import {
  type ApiKeyFailure,
  bearerToken,
  delegationAuditDetails,
  type ResolvedApiKey,
  resolveApiKey,
  touchLastUsed,
} from './apiKeys';
import { ipAllowed } from './ipMatch';
import { throttle } from './rateLimit';

/** Mirrors `ApiKeyRequest.outcome`. */
export type Outcome =
  | 'OK'
  | ApiKeyFailure
  | 'IP_BLOCKED'
  | 'RATE_LIMITED'
  | 'DENIED_SCOPE'
  | 'DENIED_PERMISSION'
  | 'ERROR';

/**
 * Operations whose request and response bodies are safe to store verbatim.
 *
 * **An allowlist, and it fails closed**: anything not named here is logged as
 * `{ redacted: true }`. That direction is not fussiness — `virtualCards.reveal` returns a
 * PAN and a CVV, and a log that stored responses by default would be a plaintext card
 * store with a different retention and threat model than the encrypted columns the data
 * came from. A new operation is sensitive until somebody declares otherwise.
 */
const BODIES_LOGGABLE: ReadonlySet<string> = new Set<string>([
  // Carries no subject data — just the names of the tools a key may call.
  'tools/list',
]);

const REDACTED = { redacted: true } as const;

/**
 * Outcomes whose rows are coalesced per address, operation and minute.
 *
 * Only `INVALID_KEY` — a malformed token, an unknown prefix, or a wrong secret. Those are
 * adversary-controlled and carry no traceability worth preserving per call: what matters is
 * that 900 attempts came from one address in one minute, not which 900 prefixes were tried.
 *
 * Everything else stays one row per call. `REVOKED`, `EXPIRED` and the `SUBJECT_*` refusals
 * all identify a real key, so they are somebody's operational history; and `OK` rows are the
 * traceability record a bulk load depends on.
 */
const COALESCED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(['INVALID_KEY']);

/** The minute a coalesced row covers. */
function windowStartFor(now: number): Date {
  return new Date(Math.floor(now / 60_000) * 60_000);
}

/** Cap on a stored body, so one enormous payload cannot bloat the table. */
const MAX_BODY_CHARS = 8_000;

/** Redact or truncate a body for storage. */
export function bodyForLog(operation: string, body: unknown): unknown {
  if (body === undefined) return undefined;
  if (!BODIES_LOGGABLE.has(operation)) return REDACTED;
  const json = JSON.stringify(body ?? null);
  if (json !== undefined && json.length > MAX_BODY_CHARS) {
    return { truncated: true, chars: json.length };
  }
  return body;
}

export interface GuardRequest {
  readonly authorization: string | null | undefined;
  readonly onBehalfOf: string | null | undefined;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly operation: string;
  readonly toolName?: string | null;
  /** Present when the operation names one — checked against the key's scopes. */
  readonly requiredScope?: ScopeResource | null;
  readonly access?: Access;
  readonly body?: unknown;
}

export interface GuardPrincipal {
  readonly resolved: ResolvedApiKey;
  readonly actingUserId: string;
  readonly permissions: readonly string[];
  readonly roleLabel: string;
  /** Merge into any `withAudit` call this request performs. */
  readonly auditDetails: Record<string, unknown>;
}

export type GuardResult =
  | { readonly ok: true; readonly principal: GuardPrincipal; readonly requestLogId: string }
  | {
      readonly ok: false;
      readonly outcome: Exclude<Outcome, 'OK'>;
      readonly status: number;
      readonly message: string;
      readonly requestLogId: string;
      /**
       * Seconds until the caller may retry — set on `RATE_LIMITED`.
       *
       * Surfaced so the transport can send a `Retry-After` header. A 429 without it tells a
       * client that it was too fast and nothing about when to come back, which produces
       * either a tight retry loop or an arbitrary sleep.
       */
      readonly retryAfterSeconds?: number;
    };

/** How long a request-log row is kept. Mirrors the audit retention default. */
const LOG_RETENTION_DAYS = 90;

const STATUS: Record<string, number> = {
  INVALID_KEY: 401,
  REVOKED: 401,
  EXPIRED: 401,
  SUBJECT_REQUIRED: 400,
  SUBJECT_NOT_ALLOWED: 403,
  SUBJECT_UNKNOWN: 404,
  IP_BLOCKED: 403,
  RATE_LIMITED: 429,
  DENIED_SCOPE: 403,
  DENIED_PERMISSION: 403,
  ERROR: 500,
};

const MESSAGE: Record<string, string> = {
  INVALID_KEY: 'Invalid API key.',
  REVOKED: 'This API key has been revoked.',
  EXPIRED: 'This API key has expired.',
  SUBJECT_REQUIRED:
    'This is a platform key: name the person it acts for with the X-VeloExpense-On-Behalf-Of header.',
  SUBJECT_NOT_ALLOWED: 'This key cannot act on behalf of another user.',
  SUBJECT_UNKNOWN: 'The named user is not active.',
  IP_BLOCKED: 'This API key is not permitted from this address.',
  RATE_LIMITED: 'Rate limit exceeded for this API key.',
  DENIED_SCOPE: 'This key does not have a scope permitting that.',
  DENIED_PERMISSION: 'The acting user does not have permission for that.',
  ERROR: 'The request failed.',
};

/** Verify, authorize, and log one API-key request. */
export async function guardApiRequest(db: PrismaClient, req: GuardRequest): Promise<GuardResult> {
  const startedAt = Date.now();

  const log = async (
    outcome: Outcome,
    extra: {
      apiKeyId?: string | null;
      prefixTried?: string | null;
      actingUserId?: string | null;
      scopeRequired?: string | null;
      response?: unknown;
    },
  ): Promise<string> => {
    const expiresAt = new Date(Date.now() + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const common = {
      prefixTried: extra.prefixTried ?? null,
      actingUserId: extra.actingUserId ?? null,
      toolName: req.toolName ?? null,
      scopeRequired: extra.scopeRequired ?? req.requiredScope ?? null,
      statusCode: STATUS[outcome] ?? (outcome === 'OK' ? 200 : 500),
      durationMs: Date.now() - startedAt,
      userAgent: req.userAgent,
      expiresAt,
    };

    if (COALESCED_OUTCOMES.has(outcome)) {
      // One row per (outcome, address, operation, minute), counting the attempts. The
      // address is never null on this path — `ipFromHeaders` yields 'unknown' instead —
      // which matters because a NULL in the key would make every upsert insert instead.
      const ip = req.ip ?? 'unknown';
      const windowStart = windowStartFor(Date.now());
      // VeloExpense (w6-04): the coalescing key carries the tenant (0079), so one tenant's
      // sweep never folds into another's row.
      const organizationId = currentTenantId();
      if (!organizationId) throw new Error('apiKeyGuard: no tenant scope');
      const row = await db.apiKeyRequest.upsert({
        where: {
          organizationId_outcome_ip_operation_windowStart: {
            organizationId,
            outcome,
            ip,
            operation: req.operation,
            windowStart,
          },
        },
        create: {
          ...common,
          apiKeyId: extra.apiKeyId ?? null,
          operation: req.operation,
          outcome,
          ip,
          windowStart,
          // Bodies are not kept on a coalesced row: it stands for many attempts, so any one
          // payload would misrepresent the rest.
          request: undefined,
          response: undefined,
        },
        update: {
          count: { increment: 1 },
          // Keep the horizon moving with the traffic, and remember the most recent prefix
          // tried — the full list is deliberately not retained.
          expiresAt,
          prefixTried: extra.prefixTried ?? null,
        },
        select: { id: true },
      });
      return row.id;
    }

    const row = await db.apiKeyRequest.create({
      data: {
        ...common,
        apiKeyId: extra.apiKeyId ?? null,
        operation: req.operation,
        outcome,
        request: bodyForLog(req.operation, req.body) as object | undefined,
        response: bodyForLog(req.operation, extra.response) as object | undefined,
        ip: req.ip,
      },
      select: { id: true },
    });
    return row.id;
  };

  const refuse = async (
    outcome: Exclude<Outcome, 'OK'>,
    extra: Parameters<typeof log>[1] = {},
    retryAfterSeconds?: number,
  ): Promise<GuardResult> => ({
    ok: false,
    outcome,
    status: STATUS[outcome] ?? 500,
    message: MESSAGE[outcome] ?? 'Refused.',
    requestLogId: await log(outcome, extra),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

  const token = bearerToken(req.authorization);
  if (!token) return refuse('INVALID_KEY');

  const resolution = await resolveApiKey(db, token, req.onBehalfOf ?? null);
  if (!resolution.ok) {
    return refuse(resolution.failure, { prefixTried: resolution.prefixTried });
  }
  const { resolved } = resolution;
  const keyId = resolved.key.id;

  if (!ipAllowed(resolved.key.allowedIps, req.ip)) {
    return refuse('IP_BLOCKED', { apiKeyId: keyId, prefixTried: resolved.key.prefix });
  }

  // One limiter for the whole app — `throttle` is the same fixed-window counter the auth
  // endpoints use, on its own Redis connection. The first cut of this file reimplemented it
  // and borrowed the RBAC permission-cache connection to do so.
  if (resolved.key.rateLimitPerMinute != null) {
    const verdict = await throttle(`apikey:${keyId}`, {
      max: resolved.key.rateLimitPerMinute,
      windowSec: 60,
    });
    if (!verdict.allowed) {
      return refuse(
        'RATE_LIMITED',
        { apiKeyId: keyId, prefixTried: resolved.key.prefix },
        verdict.retryAfterSec,
      );
    }
  }

  // Scope is checked before permissions: it is a property of the credential, and refusing
  // on it does not require a role lookup.
  if (req.requiredScope) {
    const denial = denyReason(resolved.key.scopes, req.requiredScope, req.access ?? 'write');
    if (denial) {
      return refuse('DENIED_SCOPE', {
        apiKeyId: keyId,
        prefixTried: resolved.key.prefix,
        actingUserId: resolved.actingUserId,
        scopeRequired: req.requiredScope,
      });
    }
  }

  // VeloExpense (w6-04): and `hasAccess` (People 1, 0072) — a person whose access was turned
  // off is refused by every request, a key acting as them included.
  const user = await db.user.findFirst({
    where: { id: resolved.actingUserId, deletedAt: null, hasAccess: true },
    select: { id: true, roleId: true },
  });
  if (!user?.roleId) {
    return refuse('SUBJECT_UNKNOWN', { apiKeyId: keyId, prefixTried: resolved.key.prefix });
  }
  // VeloExpense (w6-04): the role is the TENANT's row, keyed (organization, id), and its label
  // a locale map (0068); English, as the `tenant` middleware reads it.
  const organizationId = currentTenantId();
  if (!organizationId) throw new Error('apiKeyGuard: no tenant scope');
  const role = await db.role.findUnique({
    where: { organizationId_id: { organizationId, id: user.roleId } },
    select: { label: true },
  });
  const label = role?.label as Record<string, string> | string | null | undefined;
  const roleLabel = (typeof label === 'string' ? label : label?.en) || 'Employee';
  const rbac = await resolveRbacUser(db, {
    userId: user.id,
    roleId: user.roleId,
    roleLabel,
    organizationId,
  });

  await touchLastUsed(db, keyId);

  return {
    ok: true,
    principal: {
      resolved,
      actingUserId: resolved.actingUserId,
      permissions: rbac.permissions,
      roleLabel,
      auditDetails: delegationAuditDetails(resolved),
    },
    requestLogId: await log('OK', {
      apiKeyId: keyId,
      prefixTried: resolved.key.prefix,
      actingUserId: resolved.actingUserId,
    }),
  };
}

/**
 * Which log outcome does a tRPC failure correspond to?
 *
 * The permission check itself stays where it already is — inside the procedure, which is
 * authoritative. A second check in the guard would be a second definition of who may do
 * what, and the two would eventually disagree. So `DENIED_PERMISSION` is produced by
 * *observing* the procedure's refusal rather than by predicting it.
 */
export function outcomeForTrpcCode(code: string): Outcome {
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return 'DENIED_PERMISSION';
  return 'ERROR';
}

/** Attach the outcome of the work to the row the guard already wrote. */
export async function completeRequestLog(
  db: PrismaClient,
  requestLogId: string,
  update: { operation: string; outcome: Outcome; response?: unknown; statusCode?: number },
): Promise<void> {
  await db.apiKeyRequest
    .update({
      where: { id: requestLogId },
      data: {
        outcome: update.outcome,
        statusCode: update.statusCode ?? STATUS[update.outcome] ?? 200,
        response: bodyForLog(update.operation, update.response) as object | undefined,
      },
    })
    .catch(() => undefined);
}
