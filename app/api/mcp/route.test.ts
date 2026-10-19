// @vitest-environment node
// Ported from ExpenseOS `apps/web/src/app/api/mcp/route.test.ts` (1e682dd6), w6-04 (d88).
// Each adaptation is marked "VeloExpense (w6-04):".
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-04): ExpenseOS's suite reads mock calls untyped; Biome allows it there. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runWithDelegation: vi.fn(),
  handleRpc: vi.fn(),
  toolByName: vi.fn(),
  activeModuleSlugs: vi.fn(),
  guardApiRequest: vi.fn(),
  completeRequestLog: vi.fn(),
  outcomeForTrpcCode: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  makeExecutor: vi.fn(),
  ipFromHeaders: vi.fn(),
  findFirst: vi.fn(),
  // VeloExpense (w6-04): the tenant lookup, the scope it opens, and the member resolution.
  apiKeyTenantId: vi.fn(),
  withTenantStatements: vi.fn(),
  resolveTenantMember: vi.fn(),
  hostTenantSlug: vi.fn(),
}));

vi.mock('@expenseos/audit', () => ({ runWithDelegation: h.runWithDelegation }));
// VeloExpense (w6-04): the tenant-scoped `db` (lib/db/prisma.ts), not ExpenseOS's global one.
vi.mock('@/lib/db/prisma', () => ({
  db: { user: { findFirst: h.findFirst } },
  withTenantDb: (_org: string, fn: (tx: unknown) => unknown) => fn({}),
  withTenantStatements: h.withTenantStatements,
}));
vi.mock('@/lib/tenant/context', () => ({ apiKeyTenantId: h.apiKeyTenantId }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: h.hostTenantSlug }));
vi.mock('@/server/trpc', () => ({ resolveTenantMember: h.resolveTenantMember }));
vi.mock('@expenseos/mcp-server', () => ({
  handleRpc: h.handleRpc,
  toolByName: h.toolByName,
}));
vi.mock('@expenseos/platform', () => ({ activeModuleSlugs: h.activeModuleSlugs }));
vi.mock('@/server/lib/apiKeyGuard', () => ({
  completeRequestLog: h.completeRequestLog,
  guardApiRequest: h.guardApiRequest,
  outcomeForTrpcCode: h.outcomeForTrpcCode,
}));
vi.mock('@/server/lib/idempotency', () => ({
  claim: h.claim,
  complete: h.complete,
  release: h.release,
}));
vi.mock('@/server/lib/mcpExecutor', () => ({ makeExecutor: h.makeExecutor }));
vi.mock('@/server/lib/rateLimit', () => ({ ipFromHeaders: h.ipFromHeaders }));

import { GET, POST } from './route';

/**
 * The remote MCP endpoint — ExpenseOS as a tool server for external Claude clients.
 *
 * A thin adapter whose only real content is ORDER:
 *
 *   guard (auth, IP, rate limit, log) → actor → idempotency → delegation → protocol → complete
 *
 * Three of those steps fail in ways nothing downstream can see, which is why they are
 * asserted here rather than left to the libraries they call:
 *
 *   · **The delegation scope** is what puts "which API key drafted this" INSIDE the audit
 *     hash, without any `withAudit` call site knowing this endpoint exists. Losing the
 *     wrapper produces audit rows that verify perfectly and attribute a key's mutation to
 *     a human who was asleep.
 *   · **The actor lookup** feeds `actorName`, which is also inside the hash. A blank one
 *     yields rows that verify and name nobody — worse than a missing row, because they
 *     look fine.
 *   · **The idempotency claim** must be released on every path that did not produce a
 *     stored result, or a crashed call locks the key out for 24 hours and the protection
 *     becomes the outage.
 */

const PRINCIPAL = {
  actingUserId: 'u-1',
  roleLabel: 'Admin',
  permissions: ['expense.read'],
  auditDetails: { viaApiKey: { keyId: 'key-1', label: 'Claude Desktop' } },
  resolved: { key: { id: 'key-1', scopes: ['expenses:read'] } },
};

const ACTOR = {
  id: 'u-1',
  firstName: 'Dana',
  lastName: 'Patel',
  email: 'dana@e.inc',
  roleId: 'r-1',
};

const MUTATE_SPEC = { name: 'expense.submit', kind: 'mutate', scope: 'expenses:write' };

/** VeloExpense (w6-04): a token of the real shape, so the route's tenant lookup reaches it
 *  (ExpenseOS's suite sends `eos_live_x`, which its mocked guard never parses). */
const TOKEN = `vxe_u_${'a'.repeat(16)}_${'b'.repeat(43)}`;
const ORG = '019e3000-0000-7000-8000-00000000c0de';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://x/api/mcp', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    }),
  );

const call = (name = 'expense.submit', args: Record<string, unknown> = { id: 'rep-1' }) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

const OK_RESULT = { jsonrpc: '2.0', id: 7, result: { content: [], isError: false } };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.guardApiRequest.mockResolvedValue({
    ok: true,
    principal: PRINCIPAL,
    requestLogId: 'log-1',
  });
  h.findFirst.mockResolvedValue(ACTOR);
  h.activeModuleSlugs.mockResolvedValue(['expense-management']);
  h.toolByName.mockReturnValue(undefined);
  h.handleRpc.mockResolvedValue(OK_RESULT);
  h.runWithDelegation.mockImplementation((_s: unknown, fn: () => unknown) => fn());
  h.completeRequestLog.mockResolvedValue(undefined);
  h.outcomeForTrpcCode.mockReturnValue('FORBIDDEN');
  h.ipFromHeaders.mockReturnValue('1.2.3.4');
  h.claim.mockResolvedValue({ kind: 'claimed', id: 'idem-1' });
  h.complete.mockResolvedValue(undefined);
  h.release.mockResolvedValue(undefined);
  h.apiKeyTenantId.mockResolvedValue(ORG);
  h.withTenantStatements.mockImplementation((_org: string, fn: () => unknown) => fn());
  h.hostTenantSlug.mockResolvedValue(null);
  h.resolveTenantMember.mockImplementation(async (_tx: unknown, caller: { email: string }) => ({
    session: { user: { id: 'u-1', name: 'Dana Patel', email: caller.email, organizationId: ORG } },
    rbac: { id: 'u-1', roleId: 'r-1', roleLabel: 'Admin', permissions: ['resolved.again'] },
  }));
});

describe('the transport', () => {
  it('answers GET with 405 and says what to do instead', async () => {
    /** MCP clients probe with GET looking for a stream. A bare 405 with no `allow`
     *  header reads as a broken server rather than a POST-only one. */
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('answers a JSON-RPC parse error for a body that is not JSON', async () => {
    const res = await post('{oops');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error.' },
    });
  });

  it('does not authenticate an unparseable body', async () => {
    await post('{oops');
    expect(h.guardApiRequest).not.toHaveBeenCalled();
  });

  it('echoes the request id so a client can correlate the answer', async () => {
    const res = await post(call());
    await expect(res.json()).resolves.toMatchObject({ id: 7 });
  });
});

describe('what the guard is told', () => {
  it('names the scope a tool call requires, so a refusal is logged with it', async () => {
    h.toolByName.mockReturnValue(MUTATE_SPEC);
    await post(call());
    expect(h.guardApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'tools/call',
        toolName: 'expense.submit',
        requiredScope: 'expenses:write',
      }),
    );
  });

  it('requires no scope for listing what you may use', async () => {
    /** Listing is not itself a scoped action; demanding one would make discovery
     *  impossible for a key that is correctly limited. */
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(h.guardApiRequest.mock.calls[0]?.[1]).toMatchObject({
      toolName: null,
      requiredScope: null,
    });
  });

  it('passes the credential, the address and the agent for the log', async () => {
    await post(call(), { 'user-agent': 'Claude/1.0' });
    expect(h.guardApiRequest.mock.calls[0]?.[1]).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      ip: '1.2.3.4',
      userAgent: 'Claude/1.0',
    });
  });

  it('forwards an on-behalf-of header for the guard to validate', async () => {
    // VeloExpense (w6-04): ExpenseOS's `x-expenseos-on-behalf-of`, renamed.
    await post(call(), { 'x-veloexpense-on-behalf-of': 'sam@e.inc' });
    expect(h.guardApiRequest.mock.calls[0]?.[1].onBehalfOf).toBe('sam@e.inc');
  });

  it('records the method even when it is one nobody defined', async () => {
    await post({ jsonrpc: '2.0', id: 1 });
    expect(h.guardApiRequest.mock.calls[0]?.[1].operation).toBe('unknown');
  });

  it('looks up an unknown tool without crashing', async () => {
    h.toolByName.mockReturnValue(undefined);
    const res = await post(call('no.such.tool'));
    expect(res.status).toBe(200);
    expect(h.guardApiRequest.mock.calls[0]?.[1].requiredScope).toBeNull();
  });
});

describe('when the guard refuses', () => {
  it('answers with its status and message, as JSON-RPC', async () => {
    h.guardApiRequest.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'That API key is not valid.',
    });
    const res = await post(call());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32001, message: 'That API key is not valid.' },
    });
  });

  it('passes retry-after through for a rate-limited key', async () => {
    h.guardApiRequest.mockResolvedValue({
      ok: false,
      status: 429,
      message: 'Too many requests.',
      retryAfterSeconds: 30,
    });
    const res = await post(call());
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('sends no retry-after for a refusal that is not about time', async () => {
    /** A client that backs off for 30s on a permission error is waiting for something
     *  that will never change. */
    h.guardApiRequest.mockResolvedValue({ ok: false, status: 403, message: 'Out of scope.' });
    const res = await post(call());
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('runs nothing downstream', async () => {
    h.guardApiRequest.mockResolvedValue({ ok: false, status: 401, message: 'no' });
    await post(call());
    expect(h.handleRpc).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});

describe('the acting person behind the key', () => {
  it('builds the audit actor name from their real name', async () => {
    /** `withAudit` writes `actorName` into the hash. A blank one produces rows that
     *  verify correctly and name nobody. */
    await post(call());
    const ctx = h.makeExecutor.mock.calls[0]?.[0];
    expect(ctx.session.user.name).toBe('Dana Patel');
  });

  it('falls back to the email when the name is empty', async () => {
    h.findFirst.mockResolvedValue({ ...ACTOR, firstName: '', lastName: '' });
    await post(call());
    expect(h.makeExecutor.mock.calls[0]?.[0].session.user.name).toBe('dana@e.inc');
  });

  it('takes permissions from the guard rather than resolving them again', async () => {
    /** A second lookup could disagree with the one the scope check already used, which
     *  would let a call pass the scope gate and then act with different permissions. */
    await post(call());
    expect(h.makeExecutor.mock.calls[0]?.[0].rbac.permissions).toBe(PRINCIPAL.permissions);
  });

  it('excludes deleted users from the lookup', async () => {
    await post(call());
    expect(h.findFirst.mock.calls[0]?.[0].where).toEqual({ id: 'u-1', deletedAt: null });
  });

  it('404s when the acting user is no longer active', async () => {
    h.findFirst.mockResolvedValue(null);
    const res = await post(call());
    expect(res.status).toBe(404);
    expect(h.handleRpc).not.toHaveBeenCalled();
  });

  it('closes the request log with SUBJECT_UNKNOWN when they are gone', async () => {
    /** So "why did this key stop working" is answerable from the log alone. */
    h.findFirst.mockResolvedValue(null);
    await post(call());
    expect(h.completeRequestLog).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      operation: 'tools/call',
      outcome: 'SUBJECT_UNKNOWN',
    });
  });
});

describe('the delegation scope', () => {
  it('wraps the whole protocol call', async () => {
    /**
     * The load-bearing wrapper. It is what puts the key's identity INSIDE the audit
     * hash for any mutation the call performs, without a single `withAudit` call site
     * knowing this endpoint exists. Without it, a key's mutation is attributed to the
     * human it acts for, with nothing recording that it was a machine.
     */
    await post(call());
    expect(h.runWithDelegation).toHaveBeenCalledWith(
      { viaApiKey: { keyId: 'key-1', label: 'Claude Desktop' } },
      expect.any(Function),
    );
  });

  it('runs handleRpc inside it, not beside it', async () => {
    let inside = false;
    h.runWithDelegation.mockImplementation(async (_s: unknown, fn: () => unknown) => {
      inside = true;
      const r = await fn();
      inside = false;
      return r;
    });
    h.handleRpc.mockImplementation(async () => {
      expect(inside).toBe(true);
      return OK_RESULT;
    });
    await post(call());
    expect(h.handleRpc).toHaveBeenCalled();
  });

  it('hands the protocol only the capabilities this key has', async () => {
    await post(call());
    expect(h.handleRpc.mock.calls[0]?.[1]).toMatchObject({
      capabilities: {
        permissions: PRINCIPAL.permissions,
        activeModules: ['expense-management'],
      },
      scopes: ['expenses:read'],
    });
  });
});

describe('replay protection', () => {
  beforeEach(() => {
    h.toolByName.mockReturnValue(MUTATE_SPEC);
  });

  it('claims the key for a mutation', async () => {
    await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(h.claim).toHaveBeenCalledWith(expect.anything(), 'key-1', 'idem-abc', 'expense.submit', {
      id: 'rep-1',
    });
  });

  it('ignores the header for a read', async () => {
    /** Repeating a read is harmless, and covering reads would mean storing their
     *  responses — a copy of the data in a second place, for no benefit. */
    h.toolByName.mockReturnValue({ name: 'expense.list', kind: 'read', scope: 'expenses:read' });
    await post(call('expense.list'), { 'idempotency-key': 'idem-abc' });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('does nothing without the header', async () => {
    await post(call());
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('returns the stored answer for a replay, without re-running anything', async () => {
    h.claim.mockResolvedValue({ kind: 'replay', response: { reportId: 'rep-1' } });
    const res = await post(call(), { 'idempotency-key': 'idem-abc' });
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toContain('rep-1');
    expect(h.handleRpc).not.toHaveBeenCalled();
  });

  it('logs a replay as a successful request', async () => {
    h.claim.mockResolvedValue({ kind: 'replay', response: {} });
    await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(h.completeRequestLog).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      operation: 'tools/call',
      outcome: 'OK',
    });
  });

  it('409s a key still being processed', async () => {
    h.claim.mockResolvedValue({ kind: 'in_flight' });
    const res = await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(res.status).toBe(409);
    expect(h.handleRpc).not.toHaveBeenCalled();
  });

  it('422s a key reused with different arguments', async () => {
    /** Silently answering the first call's result would be the dangerous outcome:
     *  the client believes its NEW arguments were applied. */
    h.claim.mockResolvedValue({ kind: 'mismatch' });
    const res = await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(res.status).toBe(422);
    expect(h.handleRpc).not.toHaveBeenCalled();
  });

  it('stores the result of a call that worked', async () => {
    await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(h.complete).toHaveBeenCalledWith(
      expect.anything(),
      'idem-1',
      'expense.submit',
      OK_RESULT.result,
    );
  });

  it('releases rather than stores when the tool refused', async () => {
    /** A refusal is not an outcome worth replaying — the caller should be able to fix
     *  the problem and retry with the same key. */
    h.handleRpc.mockResolvedValue({ jsonrpc: '2.0', id: 7, result: { isError: true } });
    await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'idem-1');
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('releases when the call crashes, so the key is not locked out for a day', async () => {
    /** Otherwise the protection becomes the outage. */
    h.handleRpc.mockRejectedValue(new Error('boom'));
    await expect(post(call(), { 'idempotency-key': 'idem-abc' })).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'idem-1');
  });

  it('releases for a notification, which produces nothing to store', async () => {
    h.handleRpc.mockResolvedValue(null);
    await post(call(), { 'idempotency-key': 'idem-abc' });
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'idem-1');
  });
});

describe('closing the request log', () => {
  it('records OK for a call that worked', async () => {
    await post(call());
    expect(h.completeRequestLog).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      operation: 'tools/call',
      outcome: 'OK',
    });
  });

  it('records a tool refusal as not-OK, without calling it a transport failure', async () => {
    /** The distinction is what makes "why did this key stop working" answerable: a
     *  refused call is a scope problem, an ERROR is ours. */
    h.handleRpc.mockResolvedValue({ jsonrpc: '2.0', id: 7, result: { isError: true } });
    await post(call());
    expect(h.outcomeForTrpcCode).toHaveBeenCalledWith('FORBIDDEN');
    expect(h.completeRequestLog.mock.calls[0]?.[2].outcome).toBe('FORBIDDEN');
  });

  it('records ERROR when the call crashed', async () => {
    h.handleRpc.mockRejectedValue(new Error('boom'));
    await expect(post(call())).rejects.toThrow('boom');
    expect(h.completeRequestLog).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      operation: 'tools/call',
      outcome: 'ERROR',
    });
  });

  it('records OK for a notification', async () => {
    h.handleRpc.mockResolvedValue(null);
    await post(call());
    expect(h.completeRequestLog.mock.calls[0]?.[2].outcome).toBe('OK');
  });
});

describe('notifications', () => {
  it('answers 202 with no body', async () => {
    /** A JSON-RPC notification carries no id and expects no answer; returning one
     *  makes a compliant client treat the exchange as broken. */
    h.handleRpc.mockResolvedValue(null);
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});

/**
 * VeloExpense (w6-04): the tenant comes first, from the token (the route's header). None of
 * this is in ExpenseOS, which has one tenant.
 */
describe('the key names its tenant', () => {
  it('asks which tenant holds the key by the SHA-256 of the whole token', async () => {
    const { createHash } = await import('node:crypto');
    await post(call());
    expect(h.apiKeyTenantId).toHaveBeenCalledWith(createHash('sha256').update(TOKEN).digest('hex'));
  });

  it('runs everything after it in that tenant, one statement at a time', async () => {
    await post(call());
    expect(h.withTenantStatements).toHaveBeenCalledWith(ORG, expect.any(Function));
  });

  it('401s a key no tenant holds, guarding and logging nothing in any tenant', async () => {
    h.apiKeyTenantId.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(call());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32001, message: 'Invalid API key.' },
    });
    expect(h.guardApiRequest).not.toHaveBeenCalled();
    expect(h.withTenantStatements).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'api_key.unknown',
      prefixTried: 'a'.repeat(16),
    });
    warn.mockRestore();
  });

  it('does not even look up a token of the wrong shape, or a missing one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = await post(call(), { authorization: 'Bearer eos_live_x' });
    const none = await POST(new Request('http://x/api/mcp', { method: 'POST', body: JSON.stringify(call()) }));
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(h.apiKeyTenantId).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resolves the member as the tenant middleware does, by email, in the key tenant', async () => {
    await post(call());
    expect(h.resolveTenantMember).toHaveBeenCalledWith(
      expect.anything(),
      { email: 'dana@e.inc', organizationId: ORG },
      null,
    );
    // ...and hands the executor the caller, so every tool call runs the `tenant` middleware.
    expect(h.makeExecutor.mock.calls[0]?.[0].caller).toEqual({ email: 'dana@e.inc', organizationId: ORG });
  });

  it('refuses a key used at another company address, before any tool runs', async () => {
    const { TRPCError } = await import('@trpc/server');
    h.hostTenantSlug.mockResolvedValue('globex');
    h.resolveTenantMember.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'This address belongs to another organization.' }),
    );
    const res = await post(call());
    expect(res.status).toBe(403);
    expect(h.handleRpc).not.toHaveBeenCalled();
    expect(h.completeRequestLog).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      operation: 'tools/call',
      outcome: 'SUBJECT_UNKNOWN',
    });
  });
});
