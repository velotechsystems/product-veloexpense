// @vitest-environment node
// Ported from ExpenseOS `apps/web/src/server/lib/apiKeyGuard.db.test.ts` (1e682dd6), w6-04 (d88).
// Each adaptation is marked "VeloExpense (w6-04):".
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-04): ExpenseOS's suite holds its db untyped (`any`); Biome allows it there. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';
import { mintToken } from './apiKeys';

/**
 * The guard's whole pipeline, against a real database.
 *
 * The property that matters most here is not any single refusal — it is that **every**
 * path writes an `ApiKeyRequest` row, including the ones that refuse. A log that only
 * records successful calls is blind to precisely the traffic worth watching, and it is the
 * sort of gap that is invisible until somebody asks "was this key being probed?".
 *
 * Gated on DATABASE_URL only; the hermetic run skips it.
 */

// VeloExpense (w6-04): VeloExpense's auth and tenant-host modules, as the other ported suites.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
/**
 * Redis is mocked away on purpose. Gating this file on REDIS_URL would mean 14 tests that
 * silently do not run in CI — the trap #241 fixed for the db project. The limiter's own
 * counting logic is unit-tested against a fake counter in `apiKeyRateLimit.test.ts`; what
 * matters here is that the guard WIRES a refusal to RATE_LIMITED.
 */
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(async (_db: unknown, s: { userId: string; roleLabel: string }) => ({
    id: s.userId,
    roleId: 'role',
    roleLabel: s.roleLabel,
    permissions: [],
  })),
  getRbacRedis: vi.fn(),
}));
const rateVerdict = vi.hoisted(() => ({ value: { allowed: true, retryAfterSec: 0 } }));
vi.mock('./rateLimit', async () => {
  const actual = await vi.importActual<typeof import('./rateLimit')>('./rateLimit');
  // Only the counter is stubbed. `ipFromHeaders` and the rest stay real, so a change to
  // them still breaks this file rather than being hidden behind a whole-module mock.
  return { ...actual, throttle: vi.fn(async () => rateVerdict.value) };
});

const REPORT = 'expense_management.expense_report';

describe.skipIf(!process.env.DATABASE_URL)('apiKeyGuard (integration)', () => {
  let db: any;
  // VeloExpense (w6-04): one tenant (the harness), and the guard run in it statement at a time,
  // as `/api/mcp` runs it — ExpenseOS's guard runs against its one global client.
  let h: TenantHarness;
  let inTenant: <T>(fn: (tenantDb: any) => Promise<T>) => Promise<T>;
  let guard: typeof import('./apiKeyGuard');
  let aliceId: string;
  let bobId: string;
  const keyIds: string[] = [];

  const seedKey = async (over: Record<string, unknown> = {}) => {
    const kind = (over.kind as 'USER' | 'PLATFORM') ?? 'USER';
    const minted = mintToken(kind);
    const row = await db.apiKey.create({
      data: {
        kind,
        name: 'guard key',
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        userId: kind === 'USER' ? aliceId : null,
        createdById: aliceId,
        scopes: [REPORT],
        ...over,
      },
    });
    keyIds.push(row.id);
    return { row, token: minted.token };
  };

  const call = (token: string | null, over: Record<string, unknown> = {}) =>
    inTenant((tenantDb) => guard.guardApiRequest(tenantDb, {
      authorization: token ? `Bearer ${token}` : null,
      onBehalfOf: null,
      ip: '203.0.113.9',
      userAgent: 'vitest',
      operation: 'tools/call',
      toolName: 'get_expense_report',
      requiredScope: REPORT as never,
      access: 'read',
      body: { reportId: 'r1' },
      ...over,
    }));

  const logFor = (id: string) => db.apiKeyRequest.findUnique({ where: { id } });

  beforeAll(async () => {
    // VeloExpense (w6-04): a fresh tenant with two people, instead of ExpenseOS's seeded one.
    h = await createTenantHarness({
      slug: 'api-key-guard',
      name: 'API Key Guard Co',
      people: [{ email: 'bob@api-key-guard.test', name: 'Bob' }],
    });
    db = h.db;
    const { db: tenantDb, withTenantStatements } = await import('@/lib/db/prisma');
    inTenant = (fn) => withTenantStatements(h.orgId, () => fn(tenantDb));
    guard = await import('./apiKeyGuard');
    aliceId = h.people[0].id;
    bobId = h.people[1].id;
  });

  afterAll(async () => {
    await db.apiKeyRequest.deleteMany({ where: { apiKeyId: { in: keyIds } } });
    await db.apiKeyRequest.deleteMany({ where: { userAgent: 'vitest' } });
    await db.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await h?.end();
  });

  beforeEach(() => {
    rateVerdict.value = { allowed: true, retryAfterSec: 0 };
  });

  it('admits a valid key and resolves the acting person', async () => {
    const { token, row } = await seedKey();
    const res = await call(token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.principal.actingUserId).toBe(aliceId);
    expect(res.principal.auditDetails).toMatchObject({ viaApiKey: { id: row.id } });
    expect((await logFor(res.requestLogId)).outcome).toBe('OK');
  });

  it('writes lastUsedAt, which is what the key list shows', async () => {
    // The field existed and nothing wrote it in the first cut of this feature; the list
    // said "Never" forever.
    const { token, row } = await seedKey();
    await call(token);
    const after = await db.apiKey.findUnique({ where: { id: row.id } });
    expect(after.lastUsedAt).toBeTruthy();
  });

  it('logs a call made with no credential at all', async () => {
    const res = await call(null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome).toBe('INVALID_KEY');
    expect(res.status).toBe(401);
    expect((await logFor(res.requestLogId)).outcome).toBe('INVALID_KEY');
  });

  it('logs an unknown key WITH the prefix that was tried', async () => {
    // This is the row that makes a brute-force sweep visible.
    const stranger = mintToken('USER');
    const res = await call(stranger.token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const log = await logFor(res.requestLogId);
    expect(log.outcome).toBe('INVALID_KEY');
    expect(log.prefixTried).toBe(stranger.prefix);
    expect(log.apiKeyId).toBeNull();
  });

  it('coalesces a sweep of unknown keys into one counted row', async () => {
    // The write-amplification bound: unauthenticated traffic is adversary-controlled, so a
    // sweep must not let anybody insert a row per attempt.
    //
    // The clock is pinned for the three calls. Coalescing is keyed on the MINUTE
    // (`floor(now / 60_000)`), and these are three sequential database round trips — on a
    // slow runner they straddle a boundary, the third opens a new row, and the assertion
    // fails on a property that never broke. It did exactly that in CI, on a PR that had
    // touched none of this.
    const ip = '198.51.100.77';
    const pinned = Date.UTC(2026, 7, 25, 12, 30, 15);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pinned);
    let first: Awaited<ReturnType<typeof call>>;
    let second: Awaited<ReturnType<typeof call>>;
    let third: Awaited<ReturnType<typeof call>>;
    try {
      first = await call(mintToken('USER').token, { ip });
      second = await call(mintToken('USER').token, { ip });
      third = await call(mintToken('USER').token, { ip });
    } finally {
      clock.mockRestore();
    }
    expect(first.requestLogId).toBe(second.requestLogId);
    expect(second.requestLogId).toBe(third.requestLogId);

    const row = await logFor(first.requestLogId);
    expect(row.count).toBe(3);
    expect(row.outcome).toBe('INVALID_KEY');
    expect(row.windowStart).toBeTruthy();
  });

  it('keeps sweeps from different addresses apart', async () => {
    // Volume per address is the whole signal; merging addresses would erase it.
    const a = await call(mintToken('USER').token, { ip: '198.51.100.1' });
    const b = await call(mintToken('USER').token, { ip: '198.51.100.2' });
    expect(a.requestLogId).not.toBe(b.requestLogId);
  });

  it('keeps sweeps against different operations apart', async () => {
    const a = await call(mintToken('USER').token, { ip: '198.51.100.9', operation: 'tools/call' });
    const b = await call(mintToken('USER').token, { ip: '198.51.100.9', operation: 'tools/list' });
    expect(a.requestLogId).not.toBe(b.requestLogId);
  });

  it('stores no body on a coalesced row', async () => {
    // The row stands for many attempts, so any single payload would misrepresent the rest.
    const res = await call(mintToken('USER').token, { ip: '198.51.100.55' });
    const row = await logFor(res.requestLogId);
    expect(row.request).toBeNull();
    expect(row.response).toBeNull();
  });

  it('never coalesces an authenticated call', async () => {
    // A bulk load is exactly when per-call records are wanted; collapsing them would destroy
    // the answer to "which record failed?".
    const { token } = await seedKey();
    const first = await call(token, { ip: '198.51.100.200' });
    const second = await call(token, { ip: '198.51.100.200' });
    expect(first.requestLogId).not.toBe(second.requestLogId);
    expect((await logFor(first.requestLogId)).windowStart).toBeNull();
    expect((await logFor(first.requestLogId)).count).toBe(1);
  });

  it('never coalesces a refusal that identifies a real key', async () => {
    // REVOKED is somebody's operational history, not adversary noise.
    const a = await seedKey({ revokedAt: new Date() });
    const b = await seedKey({ revokedAt: new Date() });
    const first = await call(a.token, { ip: '198.51.100.201' });
    const second = await call(b.token, { ip: '198.51.100.201' });
    expect(first.requestLogId).not.toBe(second.requestLogId);
  });

  it('refuses and logs a scope denial, recording which scope was needed', async () => {
    const { token } = await seedKey({ scopes: [`${REPORT}.readonly`] });
    const res = await call(token, { access: 'write' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome).toBe('DENIED_SCOPE');
    const log = await logFor(res.requestLogId);
    expect(log.scopeRequired).toBe(REPORT);
  });

  it('lets a read-only scope read', async () => {
    const { token } = await seedKey({ scopes: [`${REPORT}.readonly`] });
    expect((await call(token, { access: 'read' })).ok).toBe(true);
  });

  it('denies a key with no scopes at all', async () => {
    const { token } = await seedKey({ scopes: [] });
    const res = await call(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome).toBe('DENIED_SCOPE');
  });

  it('enforces the IP allowlist', async () => {
    const { token } = await seedKey({ allowedIps: ['198.51.100.0/24'] });
    const blocked = await call(token);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.outcome).toBe('IP_BLOCKED');
    expect((await call(token, { ip: '198.51.100.7' })).ok).toBe(true);
  });

  it('turns a refusing limiter verdict into RATE_LIMITED', async () => {
    const { token } = await seedKey({ rateLimitPerMinute: 1 });
    rateVerdict.value = { allowed: false, retryAfterSec: 42 };
    const res = await call(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome).toBe('RATE_LIMITED');
    expect(res.status).toBe(429);
    // Surfaced so the transport can send Retry-After. A 429 without it produces either a
    // tight retry loop or an arbitrary sleep.
    expect(res.retryAfterSeconds).toBe(42);
  });

  it('redacts request bodies for an operation not declared loggable', async () => {
    // Default-deny on bodies: a tool that returns a card number must never be able to
    // write it here by nobody having thought about it.
    const { token } = await seedKey();
    const res = await call(token);
    expect((await logFor(res.requestLogId)).request).toEqual({ redacted: true });
  });

  it('stores a body for an operation that is declared loggable', async () => {
    const { token } = await seedKey();
    const res = await call(token, {
      operation: 'tools/list',
      requiredScope: null,
      body: { a: 1 },
    });
    expect((await logFor(res.requestLogId)).request).toEqual({ a: 1 });
  });

  it('a platform key acts as the named subject and logs it', async () => {
    const { token } = await seedKey({ kind: 'PLATFORM' });
    const res = await call(token, { onBehalfOf: bobId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.principal.actingUserId).toBe(bobId);
    expect(res.principal.auditDetails).toMatchObject({ viaApiKey: { onBehalfOf: bobId } });
    expect((await logFor(res.requestLogId)).actingUserId).toBe(bobId);
  });

  it('refuses a platform key with no subject named', async () => {
    const { token } = await seedKey({ kind: 'PLATFORM' });
    const res = await call(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome).toBe('SUBJECT_REQUIRED');
    expect(res.status).toBe(400);
  });

  it('completes the log row with the eventual outcome', async () => {
    const { token } = await seedKey();
    const res = await call(token);
    await inTenant((tenantDb) =>
      guard.completeRequestLog(tenantDb, res.requestLogId, {
        operation: 'tools/call',
        outcome: 'ERROR',
        response: { boom: true },
      }),
    );
    const log = await logFor(res.requestLogId);
    expect(log.outcome).toBe('ERROR');
    expect(log.response).toEqual({ redacted: true });
  });
});
