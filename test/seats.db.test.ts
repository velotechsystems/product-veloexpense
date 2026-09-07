/**
 * VX5-20 — the seat push.
 *
 * ── WHAT THESE TESTS ARE FOR, AND WHAT THEY ARE NOT ────────────────────────
 *
 * They cover the DECISIONS: what is skipped, what is an error, what number is
 * reported, and that nothing throws into a caller. Every one runs against a real
 * database and a real HTTP server on a loopback port, because the two things most
 * worth checking are exactly the two a mocked `fetch` cannot see — that the
 * platform's own header went out, and that a tenant with no account sends
 * NOTHING.
 *
 * "Nothing arrived" is the assertion a mock is worst at: a mock that was never
 * called and a mock that was never wired up look identical, and the second is the
 * more likely mistake.
 *
 * What is NOT here: that a push happens when an employee is deactivated through
 * the UI. That crosses a server action, a transaction boundary and a floating
 * promise, and it belongs in `e2e/seat-push.spec.ts` against the standalone
 * server. Two different strengths of evidence for two halves of one feature.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { withOrg } from '@/lib/tenant/context';
import {
  observeSeats,
  pushSeatCount,
  reconcileAllTenants,
  seatPushConfigured,
} from '@/lib/billing/seats';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/* ── a real platform on a loopback port ───────────────────────────────────── */

interface Received {
  path: string;
  key: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
/** Status the next request gets. 200 unless a test says otherwise. */
let nextStatus = 200;
/** When set, the server hangs for this long — for the timeout test. */
let hangMs = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (hangMs > 0) await new Promise((r) => setTimeout(r, hangMs));
    received.push({
      path: req.url ?? '',
      key: req.headers['x-platform-key'] as string | undefined,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {},
    });
    res.writeHead(nextStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { accepted: nextStatus === 200 } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await admin.end();
});

beforeEach(() => {
  received = [];
  nextStatus = 200;
  hangMs = 0;
  process.env.PLATFORM_API_URL = baseUrl;
  process.env.PLATFORM_SERVICE_TOKEN = 'test-token';
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function newOrg(slug: string, accountId: string | null): Promise<string> {
  const r = await admin.query(
    'INSERT INTO organization (slug, name, account_id) VALUES ($1, $2, $3) RETURNING id',
    [slug, slug, accountId],
  );
  return r.rows[0].id as string;
}

async function addUser(orgId: string, email: string): Promise<string> {
  const r = await withOrg(orgId, (tx) =>
    tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1, $2, $2, 'EMPLOYEE') RETURNING id`,
      [orgId, email],
    ),
  );
  return r.rows[0].id as string;
}

const ACCOUNT = '11111111-1111-1111-1111-111111111111';

/* ── the tests ────────────────────────────────────────────────────────────── */

describe('whether the integration is on at all', () => {
  it('is disabled with either env var missing, and pushes nothing', async () => {
    const org = await newOrg('seats-disabled', ACCOUNT);
    await addUser(org, 'a@seats-disabled.test');

    delete process.env.PLATFORM_API_URL;
    expect(seatPushConfigured()).toBe(false);
    expect(await pushSeatCount(org)).toEqual({ state: 'disabled' });

    process.env.PLATFORM_API_URL = baseUrl;
    delete process.env.PLATFORM_SERVICE_TOKEN;
    expect(seatPushConfigured()).toBe(false);
    expect(await pushSeatCount(org)).toEqual({ state: 'disabled' });

    // BOTH halves matter: a URL with no token would send an unauthenticated push
    // the platform answers 401 to, and this product would swallow it.
    expect(received).toEqual([]);
  });
});

describe('a tenant the platform has never heard of', () => {
  it('is SKIPPED, and sends nothing at all', async () => {
    // The case that is normal rather than exceptional: a tenant that signed up
    // through VeloExpense's own front door has no `account_id`. Pushing for it
    // would mean sending `accountId: null` at a schema that requires a UUID, and
    // the platform would answer 400 forever.
    const org = await newOrg('seats-no-account', null);
    await addUser(org, 'a@seats-no-account.test');

    expect(await pushSeatCount(org)).toEqual({ state: 'skipped', reason: 'no_account' });
    // The assertion a mock cannot make honestly.
    expect(received).toEqual([]);
  });
});

describe('what a push actually contains', () => {
  it('the platform’s own header, the product, the count, and when it was taken', async () => {
    const org = await newOrg('seats-payload', ACCOUNT);
    await addUser(org, 'a@seats-payload.test');
    await addUser(org, 'b@seats-payload.test');

    const before = Date.now();
    const result = await pushSeatCount(org);
    const after = Date.now();

    expect(result).toEqual({ state: 'sent', seatCount: 2 });
    expect(received).toHaveLength(1);
    const [sent] = received;

    expect(sent.path).toBe('/api/v1/platform/seats');
    // The header the platform authenticates on. Getting this wrong is a 401 the
    // product swallows, so nothing else would notice.
    expect(sent.key).toBe('test-token');
    expect(sent.body.accountId).toBe(ACCOUNT);
    expect(sent.body.product).toBe('veloexpense');
    expect(sent.body.seatCount).toBe(2);

    // `observedAt` survived JSON as a parseable instant, taken during the call.
    // A level endpoint has no idempotency key, so this is the only thing that lets
    // the platform reject an out-of-order push — see the header of seats.ts.
    const observedAt = Date.parse(String(sent.body.observedAt));
    expect(Number.isNaN(observedAt)).toBe(false);
    expect(observedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(observedAt).toBeLessThanOrEqual(after + 1000);
  });

  it('counts the same thing the meter counts — not its own definition', async () => {
    // The property, not the number. What a seat IS lives in
    // `lib/billing/metering.ts` and `test/metering.db.test.ts` pins it to being
    // able to sign in. This asserts the push AGREES with that, which is the thing
    // that breaks if somebody writes a second COUNT(*) here.
    const org = await newOrg('seats-agree', ACCOUNT);
    const a = await addUser(org, 'a@seats-agree.test');
    await addUser(org, 'b@seats-agree.test');

    await withOrg(org, (tx) => tx.query('UPDATE app_user SET deleted_at = now() WHERE id = $1', [a]));

    const observed = await withOrg(org, observeSeats);
    expect(observed.seatCount).toBe(1);
    expect((await pushSeatCount(org)) as unknown).toEqual({ state: 'sent', seatCount: 1 });
  });
});

describe('when the platform refuses', () => {
  it('reports an error and does not throw', async () => {
    const org = await newOrg('seats-refused', ACCOUNT);
    await addUser(org, 'a@seats-refused.test');
    nextStatus = 500;

    const result = await pushSeatCount(org);
    expect(result.state).toBe('error');
    expect(result).toMatchObject({ message: expect.stringContaining('500') });
  });

  it('a 404 is an error too, which is TODAY’s expected outcome', async () => {
    // The `/seats` route does not exist on the real platform yet. Until it does,
    // every push in production gets a 404 — so this asserts the shape of the state
    // this feature ships in, rather than only the state it is meant to reach.
    const org = await newOrg('seats-404', ACCOUNT);
    await addUser(org, 'a@seats-404.test');
    nextStatus = 404;

    expect((await pushSeatCount(org)).state).toBe('error');
  });

  it('a platform that HANGS is abandoned, not waited on forever', async () => {
    // The property that decides whether a slow platform is an annoyance or an
    // outage. `pushSeatCount` runs behind a server action a person is waiting on
    // (and inside NextAuth's signIn callback), so an unbounded fetch would mean
    // adding an employee hangs for as long as the platform does.
    //
    // This test is deliberately one of the slower in the suite — it waits out the
    // real timeout rather than asserting the constant, because a test that reads
    // TIMEOUT_MS and checks it is 4000 would pass with the signal not wired up at
    // all. That was the first draft, and it proved nothing.
    const org = await newOrg('seats-hang', ACCOUNT);
    await addUser(org, 'a@seats-hang.test');
    hangMs = 30_000;

    const started = Date.now();
    const result = await pushSeatCount(org);
    const elapsed = Date.now() - started;

    expect(result.state).toBe('error');
    // Comfortably under the server's 30s hang, so it was OUR timeout that fired.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it('an unreachable platform is an error, not a crash', async () => {
    const org = await newOrg('seats-unreachable', ACCOUNT);
    await addUser(org, 'a@seats-unreachable.test');
    // A port nothing is listening on.
    process.env.PLATFORM_API_URL = 'http://127.0.0.1:1';

    const result = await pushSeatCount(org);
    expect(result.state).toBe('error');
  });
});

describe('the reconcile sweep', () => {
  it('covers every tenant, and counts the ones with no account separately', async () => {
    await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
    const withAccount = await newOrg('sweep-a', '22222222-2222-2222-2222-222222222222');
    await addUser(withAccount, 'a@sweep-a.test');
    const alsoWith = await newOrg('sweep-b', '33333333-3333-3333-3333-333333333333');
    await addUser(alsoWith, 'a@sweep-b.test');
    await addUser(alsoWith, 'b@sweep-b.test');
    await newOrg('sweep-none', null);

    const result = await reconcileAllTenants();

    expect(result.organizations).toBe(3);
    expect(result.sent).toBe(2);
    // The number that says how much of the estate the platform has never heard
    // of — worth reading during the cutover, which is why it is not folded into
    // failures.
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);

    expect(received.map((r) => r.body.seatCount).sort()).toEqual([1, 2]);
  });

  it('one unreachable tenant does not stop the others', async () => {
    // The reason the sweep returns 200 with a body rather than throwing: a sweep
    // that dies on the first failure tells an operator nothing about the rest,
    // and a cron that retries the whole thing re-pushes everything that was
    // already right.
    await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
    const org = await newOrg('sweep-fail', '44444444-4444-4444-4444-444444444444');
    await addUser(org, 'a@sweep-fail.test');
    const ok = await newOrg('sweep-ok', '55555555-5555-5555-5555-555555555555');
    await addUser(ok, 'a@sweep-ok.test');

    nextStatus = 503;
    const result = await reconcileAllTenants();

    expect(result.organizations).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.sent).toBe(0);
  });
});
