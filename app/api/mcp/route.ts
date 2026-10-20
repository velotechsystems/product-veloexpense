/**
 * The remote MCP endpoint — ExpenseOS as a tool server for external Claude clients.
 *
 * A thin adapter. Everything interesting lives elsewhere on purpose: the credential and its
 * limits in `guardApiRequest`, the registry and protocol in @expenseos/mcp-server, execution
 * in `makeExecutor`. What this file owns is the order those happen in, and that order is the
 * design:
 *
 *   guard (auth, IP, rate limit, log) → delegation scope → idempotency → protocol → complete
 *
 * The delegation scope wraps everything downstream so that any audited mutation the call
 * performs records WHICH KEY drafted it, inside the audit hash, without a single `withAudit`
 * call site knowing this endpoint exists.
 *
 * Ported from ExpenseOS `apps/web/src/app/api/mcp/route.ts` (1e682dd6), w6-04 (d88).
 * VeloExpense adaptations are marked "VeloExpense (w6-04):". The one that shapes the file:
 *
 *   **The tenant comes first, from the token.** ExpenseOS has one tenant, so its guard reads
 *   the key straight away. Here a request has no session and FORCE RLS shows an unscoped
 *   reader no key at all, so the route first asks `apiKeyTenantId` (0079's hatch) which
 *   tenant holds a key whose hash matches the presented token — only somebody holding the
 *   whole secret can learn that — and runs everything else in that tenant, one statement at
 *   a time (`withTenantStatements`), as the assistant's chat route does. Every row the guard
 *   writes therefore lands in the key's own tenant, and each tool call is a tRPC call that
 *   opens its own tenant transaction through the `tenant` middleware.
 *
 *   A token that names no key in ANY tenant has no tenant to be logged in, so it is not: it is
 *   refused with ExpenseOS's 401 and one structured log line (`api_key.unknown`). ExpenseOS
 *   coalesces those attempts into its request table; there is no tenant table they could
 *   belong to here.
 *
 * mcp-oauth (ported from VeloCRM 59fce1c `middleware/mcpAuth.ts`): THE SECOND CREDENTIAL. A
 * bearer token that is a JWT is an OAuth access token from a Claude connector: verified here
 * (signature, issuer and audience for the host the request came to, expiry with 30 s of leeway),
 * its `tenant_id` claim is the tenant — no hatch needed, nothing is read before it verifies — and
 * `guardOAuthRequest` then checks its grant is still live and does what `guardApiRequest` does for
 * a key. Anything else is an API key, exactly as before.
 *
 * And every 401 from this route carries `WWW-Authenticate: Bearer resource_metadata="…"`
 * (RFC 9728 §5.1). VeloCRM's note on why: a connector's first request has no token, and without
 * that header Claude cannot discover the authorization server and the connector fails.
 */

import { runWithDelegation } from '@expenseos/audit';
import { DEFAULT_LOCALE } from '@expenseos/i18n';
import { handleRpc, type JsonRpcRequest, toolByName } from '@expenseos/mcp-server';
import { activeModuleSlugs } from '@expenseos/platform';
import { TRPCError } from '@trpc/server';
import { db, withTenantDb, withTenantStatements } from '@/lib/db/prisma';
import { apiKeyTenantId } from '@/lib/tenant/context';
import { hostTenantSlug } from '@/lib/tenant/request';
import { completeRequestLog, guardApiRequest, outcomeForTrpcCode } from '@/server/lib/apiKeyGuard';
import { bearerToken, hashToken, parseToken } from '@/server/lib/apiKeys';
import { claim, complete, release } from '@/server/lib/idempotency';
import { makeExecutor } from '@/server/lib/mcpExecutor';
import { oauthBaseUrl, resourceMetadataUrl } from '@/lib/mcpOauth/host';
import { looksLikeJwt, verifyAccessToken, type AccessClaims } from '@/lib/mcpOauth/tokens';
import { guardOAuthRequest } from '@/server/lib/oauthGuard';
import { ipFromHeaders } from '@/server/lib/rateLimit';
import { type Context, resolveTenantMember } from '@/server/trpc';

export const dynamic = 'force-dynamic';

const jsonRpcError = (id: unknown, code: number, message: string, status: number) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export async function POST(request: Request) {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error.', 400);
  }

  const token = bearerToken(request.headers.get('authorization'));

  // mcp-oauth: an OAuth access token (see the header).
  if (token && looksLikeJwt(token)) {
    const base = oauthBaseUrl(request.headers);
    const claims = base ? await verifyAccessToken(base, token) : null;
    if (!claims) return unauthorized(request, body.id, 'Invalid or expired access token.');
    return withTenantStatements(claims.tenant_id, () =>
      call(request, body, claims.tenant_id, { kind: 'oauth', claims }),
    );
  }

  // VeloExpense (w6-04): which tenant is this key in? See the header. A malformed token, an
  // unknown one and a wrong secret are one case, as ExpenseOS's resolution makes them.
  const organizationId =
    token && parseToken(token) ? await apiKeyTenantId(hashToken(token)) : null;
  if (!organizationId) {
    console.warn(
      JSON.stringify({
        event: 'api_key.unknown',
        operation: String(body.method ?? '') || 'unknown',
        prefixTried: token ? (parseToken(token)?.prefix ?? null) : null,
        ip: ipFromHeaders(request.headers),
      }),
    );
    return unauthorized(request, body.id, 'Invalid API key.');
  }
  return withTenantStatements(organizationId, () => call(request, body, organizationId, { kind: 'key' }));
}

/** mcp-oauth: a 401 that tells an MCP client where to find the authorization server. */
function unauthorized(request: Request, id: unknown, message: string, extra: Record<string, string> = {}): Response {
  const base = oauthBaseUrl(request.headers);
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } },
    {
      status: 401,
      headers: {
        ...extra,
        ...(base ? { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(base)}"` } : {}),
      },
    },
  );
}

type Credential = { kind: 'key' } | { kind: 'oauth'; claims: AccessClaims };

/** What `call` needs from either guard. */
interface CallPrincipal {
  readonly actingUserId: string;
  readonly permissions: readonly string[];
  readonly roleLabel: string;
  readonly scopes: readonly string[];
  /** The key whose idempotency records a replay is checked against; null for OAuth. */
  readonly idempotencyKeyId: string | null;
  readonly delegation: Parameters<typeof runWithDelegation>[0];
}

/** VeloExpense (w6-04): ExpenseOS's `POST` from the guard on, in the key's tenant. */
async function call(
  request: Request,
  body: JsonRpcRequest,
  organizationId: string,
  credential: Credential,
): Promise<Response> {
  const method = String(body.method ?? '');
  const toolName = method === 'tools/call' ? String(body.params?.name ?? '') : null;
  const spec = toolName ? toolByName(toolName) : undefined;

  // The guard needs to know what scope this call requires so a refusal is logged with it.
  // For anything but `tools/call` there is no scope — listing what you may use is not itself
  // a scoped action.
  const common = {
    ip: ipFromHeaders(request.headers),
    userAgent: request.headers.get('user-agent'),
    operation: method || 'unknown',
    toolName,
    requiredScope: spec?.scope ?? null,
    access: spec?.access,
    body: body.params,
  };
  const guard =
    credential.kind === 'oauth'
      ? await guardOAuthRequest(db, { ...common, claims: credential.claims })
      : await guardApiRequest(db, {
          ...common,
          authorization: request.headers.get('authorization'),
          // VeloExpense (w6-04): ExpenseOS's `X-ExpenseOS-On-Behalf-Of`, renamed.
          onBehalfOf: request.headers.get('x-veloexpense-on-behalf-of'),
        });

  if (!guard.ok) {
    const headers: Record<string, string> =
      guard.retryAfterSeconds === undefined ? {} : { 'retry-after': String(guard.retryAfterSeconds) };
    if (guard.status === 401) return unauthorized(request, body.id, guard.message, headers);
    return Response.json(
      { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message: guard.message } },
      { status: guard.status, headers },
    );
  }

  const { requestLogId } = guard;
  const principal: CallPrincipal =
    'grantId' in guard.principal
      ? {
          actingUserId: guard.principal.actingUserId,
          permissions: guard.principal.permissions,
          roleLabel: guard.principal.roleLabel,
          scopes: guard.principal.scopes,
          idempotencyKeyId: null,
          delegation: { viaOAuth: guard.principal.auditDetails.viaOAuth },
        }
      : {
          actingUserId: guard.principal.actingUserId,
          permissions: guard.principal.permissions,
          roleLabel: guard.principal.roleLabel,
          scopes: guard.principal.resolved.key.scopes,
          idempotencyKeyId: guard.principal.resolved.key.id,
          delegation: { viaApiKey: guard.principal.auditDetails.viaApiKey as Record<string, unknown> },
        };

  /**
   * The acting person's identity, for the audit actor.
   *
   * Not optional detail: `withAudit` writes `actorName` from `session.user.name ?? email`,
   * and that column is inside the hash. Leaving it blank would produce audit rows that
   * verify correctly and name nobody — worse than a missing row, because they look fine.
   *
   * VeloExpense (w6-04): the member as the `tenant` middleware resolves one
   * (`resolveTenantMember`): the host checked against the key's tenant — a key used at
   * another company's address is refused here, before any tool runs — and the person's row,
   * deactivation and access switch read from the database. Each tool call resolves the same
   * member again in its own transaction, from `caller`, as a signed-in request does.
   */
  const actor = await db.user.findFirst({
    where: { id: principal.actingUserId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!actor) {
    await completeRequestLog(db, requestLogId, { operation: method, outcome: 'SUBJECT_UNKNOWN' });
    return jsonRpcError(body.id, -32001, 'The acting user is not active.', 404);
  }
  const caller = { email: actor.email, organizationId };
  let member: Awaited<ReturnType<typeof resolveTenantMember>>;
  try {
    const hostSlug = await hostTenantSlug();
    member = await withTenantDb(organizationId, (tx) => resolveTenantMember(tx, caller, hostSlug));
  } catch (err) {
    if (!(err instanceof TRPCError) || err.code !== 'FORBIDDEN') throw err;
    await completeRequestLog(db, requestLogId, { operation: method, outcome: 'SUBJECT_UNKNOWN' });
    return jsonRpcError(body.id, -32001, err.message, 403);
  }

  // VeloExpense (w6-04): `caller` too, so each procedure a tool names runs the `tenant`
  // middleware, as `createTRPCContext` arranges. Permissions come from the guard, which
  // already resolved them for the scope check; the middleware re-reads them per call.
  const ctx = {
    session: {
      ...member.session,
      user: {
        ...member.session.user,
        name: `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email,
      },
    },
    db,
    rbac: { ...member.rbac, permissions: principal.permissions, roleLabel: principal.roleLabel },
    caller,
  } as unknown as Context;

  const modules = await activeModuleSlugs(db);
  const idempotencyKey = request.headers.get('idempotency-key');

  // Only mutations are replay-protected: repeating a read is harmless, and covering reads
  // would mean storing their responses.
  let claimId: string | null = null;
  // mcp-oauth: replay protection is per API key (ExpenseOS's `api_key_idempotency`); an OAuth
  // call's `Idempotency-Key` is not honoured. Claude's connectors do not send one.
  if (idempotencyKey && spec?.kind === 'mutate' && principal.idempotencyKeyId) {
    const claimed = await claim(
      db,
      principal.idempotencyKeyId,
      idempotencyKey,
      spec.name,
      body.params?.arguments ?? {},
    );
    if (claimed.kind === 'replay') {
      await completeRequestLog(db, requestLogId, { operation: method, outcome: 'OK' });
      return Response.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(claimed.response, null, 2) }],
          isError: false,
        },
      });
    }
    if (claimed.kind === 'in_flight') {
      return jsonRpcError(body.id, -32002, 'That idempotency key is still being processed.', 409);
    }
    if (claimed.kind === 'mismatch') {
      return jsonRpcError(
        body.id,
        -32602,
        'That idempotency key was already used with different arguments.',
        422,
      );
    }
    claimId = claimed.id;
  }

  try {
    const response = await runWithDelegation(
      principal.delegation,
      () =>
        handleRpc(body, {
          capabilities: { permissions: principal.permissions, activeModules: [...modules] },
          scopes: [...principal.scopes],
          // VeloExpense (w6-04): English. ExpenseOS reads the person's stored `localePref`;
          // VeloExpense is English-only for now (decided 7 Oct) and stores no such column.
          execute: makeExecutor(ctx, DEFAULT_LOCALE),
        }),
    );

    // A notification carries no id and expects no body.
    if (response === null) {
      await completeRequestLog(db, requestLogId, { operation: method, outcome: 'OK' });
      if (claimId) await release(db, claimId);
      return new Response(null, { status: 202 });
    }

    const failed = 'result' in response && (response.result as { isError?: boolean })?.isError;
    await completeRequestLog(db, requestLogId, {
      operation: method,
      // A tool refusal is not a transport failure, but it is still not an OK outcome for
      // the log — the distinction is what makes "why did this key stop working" answerable.
      outcome: failed ? outcomeForTrpcCode('FORBIDDEN') : 'OK',
    });

    if (claimId) {
      if (failed) await release(db, claimId);
      else await complete(db, claimId, spec?.name ?? '', (response as { result: unknown }).result);
    }
    return Response.json(response);
  } catch (err) {
    // A crashed call must not leave the key claimed for 24 hours — the protection would
    // become the outage.
    if (claimId) await release(db, claimId);
    await completeRequestLog(db, requestLogId, { operation: method, outcome: 'ERROR' });
    throw err;
  }
}

/** MCP clients probe with GET for a stream; this server is POST-only by design. */
export function GET() {
  return new Response('MCP endpoint: POST JSON-RPC 2.0 here.', {
    status: 405,
    headers: { allow: 'POST' },
  });
}
