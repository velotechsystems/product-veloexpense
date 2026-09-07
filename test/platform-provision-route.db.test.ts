/**
 * VX5-20 part 2 — the one thing about the provision route that the e2e cannot
 * reach: what it does when `PLATFORM_INBOUND_TOKEN` is UNSET.
 *
 * ── WHY THIS FILE EXISTS AT ALL, WHEN ROUTES ARE E2E-TESTED HERE ───────────
 *
 * This is the first route handler imported directly by a unit test in this
 * codebase, and that is a deliberate exception rather than a new default. Every
 * other route is proved through Playwright, because what usually matters about a
 * route is that a real request reaches it through real middleware — which a unit
 * test cannot show and `e2e/platform-provision.spec.ts` does.
 *
 * The fail-closed branch is the exception: there is ONE app server in the e2e
 * and its env either has the token or it does not. `e2e/approval-flow.spec.ts`
 * hit the same wall on the drain route and settled for asserting the
 * wrong-secret refusal, leaving "unset means refuse" untested — the comment
 * there says as much ("this is the only place that gate is exercised at all").
 *
 * That gap is worth closing here rather than inheriting, because an unset token
 * is not a hypothetical: it is the state of every deployment that has not been
 * configured yet, and the failure mode if the guard were wrong is an
 * unauthenticated tenant-creation endpoint. So: one file, one branch, and the
 * status codes that need no server are checked alongside it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/platform/provision/route';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const TOKEN = 'route-test-inbound-token';
const URL = 'http://127.0.0.1/api/platform/provision';

const BODY = {
  accountId: '3f1c9b52-0000-4000-8000-0000000000b1',
  product: 'veloexpense',
  plan: 'veloexpense-team-monthly',
  adminEmail: 'ada@route.test',
  adminName: 'Ada Admin',
  companyName: 'Route Co',
  slug: 'route-co',
  allowedEmailDomains: ['route.test'],
  idempotencyKey: 'idem-1',
};

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  process.env.PLATFORM_INBOUND_TOKEN = TOKEN;
});

afterAll(async () => {
  delete process.env.PLATFORM_INBOUND_TOKEN;
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('POST /api/platform/provision — fail-closed', () => {
  it('503s with the token unset, and creates nothing', async () => {
    delete process.env.PLATFORM_INBOUND_TOKEN;

    const res = await POST(post(BODY, { 'x-platform-key': TOKEN }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
    // The assertion that makes this a security test rather than a status-code
    // test: an unconfigured deployment must not be a tenant factory.
    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(0);
  });

  it('503 takes precedence over a valid-looking body', async () => {
    // Ordering matters: parse-then-authenticate would let an unauthenticated
    // caller learn the schema from a 422.
    delete process.env.PLATFORM_INBOUND_TOKEN;
    const res = await POST(post({ nonsense: true }));
    expect(res.status).toBe(503);
  });

  it('401s on a wrong key and a missing one, and creates nothing', async () => {
    expect((await POST(post(BODY))).status).toBe(401);
    expect((await POST(post(BODY, { 'x-platform-key': 'nope' }))).status).toBe(401);
    // Same length as the real token, so the constant-time compare is what
    // refuses it rather than the length guard in front of it.
    expect(
      (await POST(post(BODY, { 'x-platform-key': 'x'.repeat(TOKEN.length) }))).status,
    ).toBe(401);

    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(0);
  });

  it('authenticates before parsing', async () => {
    const res = await POST(post('{ not json', { 'x-platform-key': 'wrong' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/platform/provision — the contract', () => {
  const auth = { 'x-platform-key': TOKEN };

  it('400s on unparseable JSON', async () => {
    const res = await POST(post('{ not json at all', auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('422s on a schema refusal and names the fields', async () => {
    const res = await POST(post({ ...BODY, accountId: 'not-a-uuid', adminEmail: 'nope' }, auth));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: Record<string, string[]> } };
    // `details` is what makes a 422 actionable to an orchestrator's operator
    // rather than a shrug.
    expect(Object.keys(body.error.details).sort()).toEqual(['accountId', 'adminEmail']);
  });

  it('422s when the product is another one in the suite', async () => {
    // The literal is not decoration: a misrouted VeloLedger provision must not
    // create a VeloExpense tenant that nobody is billed for.
    const res = await POST(post({ ...BODY, product: 'veloledger' }, auth));
    expect(res.status).toBe(422);
    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(0);
  });

  it('201 then 200 — the retry is not an error', async () => {
    const first = await POST(post(BODY, auth));
    expect(first.status).toBe(201);
    const created = (await first.json()) as { tenantId: string; slug: string; status: string };
    expect(created).toMatchObject({ slug: 'route-co', status: 'provisioned' });

    // A different idempotency key for the same Account, because the platform is
    // free to mint one per attempt and this product keys on the Account.
    const second = await POST(post({ ...BODY, idempotencyKey: 'idem-2' }, auth));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      tenantId: created.tenantId,
      status: 'already_exists',
    });
  });

  it('400s a reserved slug with the code, not a 500', async () => {
    const res = await POST(post({ ...BODY, slug: 'admin' }, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'SLUG_UNUSABLE' } });
  });

  it('reports the slug it actually used when the requested one is taken', async () => {
    await POST(post({ ...BODY, slug: 'route-co' }, auth));
    const res = await POST(
      post(
        {
          ...BODY,
          accountId: '3f1c9b52-0000-4000-8000-0000000000b2',
          companyName: 'Route Two',
          slug: 'route-co',
        },
        auth,
      ),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'route-co-2', status: 'provisioned' });
  });
});
