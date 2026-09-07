/**
 * VX5-20 part 2 — the platform's provision call gets through.
 *
 * ── WHAT ONLY THIS FILE CAN PROVE, AND IT IS ONE THING ─────────────────────
 *
 * `test/platform-provision.db.test.ts` covers the decisions and
 * `test/platform-provision-route.db.test.ts` covers the status codes by calling
 * the handler directly. Both import the module. Neither crosses the piece of
 * this ticket most likely to be wrong in production: **edge middleware.**
 *
 * `proxy.ts` redirects anything without a session cookie to `/login`, and its
 * `matcher` decides whether it runs at all. An orchestrator has no cookie and
 * never will. So without this route in BOTH lists, a correct provision request
 * gets a **307 to `/login`** — measured, not assumed — and a client that follows
 * redirects, which is every client, receives the login page with a 200. That is
 * the worst kind of failure: plausible, silent, and it looks like the platform's
 * bug rather than ours.
 *
 * ── WHY EVERY REQUEST HERE IS `fetch` AND NOT PLAYWRIGHT'S `request` ───────
 *
 * THIS IS THE IMPORTANT NOTE IN THE FILE, and it cost three sabotage runs to
 * find. **Playwright's `APIRequestContext` does not go through Next middleware.**
 * Measured, in one test run, against one server, at one moment:
 *
 *   plain `fetch` POST, redirect:'manual'  → 307, location /login?callbackUrl=…
 *   `anon.post(…, { maxRedirects: 0 })`    → 401 JSON, from the route itself
 *   `anon.get('/expenses')` with NO cookies → **200**, a page `proxy.ts` guards
 *
 * That last line is the proof: an anonymous client cannot render `/expenses`
 * through middleware, and Playwright's did. So an assertion made with `request`
 * is an assertion about the ROUTE, never about whether the route is REACHABLE.
 *
 * The first version of this spec used `request`, said in its own header that
 * every assertion was really about middleware, and passed with `/api/platform/`
 * deleted from both lists in `proxy.ts`. The sabotage came back green and the
 * sabotage was not the thing that was wrong.
 *
 * So: `fetch`, with `redirect: 'manual'` so a redirect is reported rather than
 * followed and disguised as a 200. It is also closer to the real caller — an
 * orchestrator is an ordinary HTTP client, not a browser automation library.
 *
 * ── AND NO COOKIES, WHICH IS THE OTHER HALF ────────────────────────────────
 *
 * `fetch` sends none by default. Worth stating because the chromium project sets
 * `storageState: 'e2e/.auth/state.json'`, so anything using the built-in fixture
 * is carrying the demo admin's session — which would sail past `proxy.ts` and
 * make the refusal assertions pass for the wrong reason a second time.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

/** The value `scripts/patch-harness-vx520p2.py` puts in the app server's env. */
const INBOUND_TOKEN = 'e2e-inbound-token-not-a-real-secret';

const PATH = '/api/platform/provision';

/** Own accounts and own slugs, so nothing here collides with the seed. */
const ACCOUNT = '9c7e4a11-0000-4000-8000-00000000e2e1';
const ACCOUNT_TWO = '9c7e4a11-0000-4000-8000-00000000e2e2';
const SLUG_PREFIX = 'e2e-prov';

const db = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/** Set in `beforeAll` from the `baseURL` fixture, so the port stays configurable. */
let base = '';

/** A POST the way the orchestrator makes it: no cookies, redirects not followed. */
async function post(data: unknown, key?: string): Promise<Response> {
  return fetch(`${base}${PATH}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'x-platform-key': key }),
    },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
}

function body(over: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    product: 'veloexpense',
    plan: 'veloexpense-team-monthly',
    adminEmail: 'ada@e2e-prov.test',
    adminName: 'Ada Admin',
    companyName: 'E2E Provision Co',
    slug: `${SLUG_PREFIX}-co`,
    allowedEmailDomains: ['e2e-prov.test'],
    idempotencyKey: 'e2e-idem-1',
    ...over,
  };
}

/**
 * Remove only what this spec created.
 *
 * ── WHY THIS IS TWENTY LINES AND NOT A `DELETE` ────────────────────────────
 *
 * NOT a TRUNCATE: the db suites own the database, but an e2e spec shares it with
 * the seed and with every other spec. `seat-push.spec.ts` learned that cost —
 * it depended on state a sibling had left and passed exactly once.
 *
 * AND CLEANING UP IS NOT OPTIONAL HERE, which is the part worth knowing. This is
 * the only spec in the suite that CREATES tenants, and the tenants it creates
 * carry an `account_id`. Leaving them behind would put them in
 * `reconcileAllTenants`' sweep, which `seat-push.spec.ts` asserts exact counts
 * from — so an uncleaned run of this file makes a different file fail, in a way
 * that points nowhere near here.
 *
 * ── AND WHY IT NEEDS THE AUDIT HATCH ───────────────────────────────────────
 *
 * `audit_entry` is append-only, enforced by a trigger rather than by a
 * convention, so a tenant's genesis row cannot be deleted by an ordinary
 * caller — and every tenant has one. `app.audit_purge = 'on'` is the hatch the
 * trigger itself documents for a retention purge, and this is a legitimate use
 * of it: removing a tenant entirely, not editing history. It is set
 * transaction-locally, so it dies with this statement batch.
 *
 * The child tables are read from the catalogue rather than listed, because a
 * hardcoded list rots the moment a migration adds a tenant table — and it rots
 * silently, as a cleanup that leaves rows behind. Passes with savepoints handle
 * children that reference each other without needing a dependency order.
 */
async function cleanup() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.audit_purge', 'on', true)");

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organization_id'
        ORDER BY table_name`,
    );
    let pending = tables.rows.map((r) => r.table_name);

    for (let pass = 0; pass < 6 && pending.length > 0; pass += 1) {
      const failed: string[] = [];
      for (const table of pending) {
        await client.query('SAVEPOINT del');
        try {
          await client.query(
            `DELETE FROM ${table} WHERE organization_id IN (
               SELECT id FROM organization WHERE account_id = ANY($1::uuid[]) OR slug LIKE $2)`,
            [[ACCOUNT, ACCOUNT_TWO], `${SLUG_PREFIX}%`],
          );
          await client.query('RELEASE SAVEPOINT del');
        } catch {
          // A child of a child. Roll back just this statement and try it again
          // on the next pass, once whatever referenced it is gone.
          await client.query('ROLLBACK TO SAVEPOINT del');
          failed.push(table);
        }
      }
      pending = failed;
    }

    if (pending.length > 0) {
      throw new Error(`e2e/platform-provision cleanup could not empty: ${pending.join(', ')}`);
    }

    await client.query(
      `DELETE FROM organization WHERE account_id = ANY($1::uuid[]) OR slug LIKE $2`,
      [[ACCOUNT, ACCOUNT_TWO], `${SLUG_PREFIX}%`],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

test.beforeAll(({ baseURL }) => {
  base = baseURL ?? 'http://localhost:3000';
});

test.beforeEach(cleanup);

test.afterAll(async () => {
  await cleanup();
  await db.end();
});

test('a provision request reaches the route and creates a usable tenant', async () => {
  const res = await post(body(), INBOUND_TOKEN);

  // 201 and not 200: a 200 here would mean the request was redirected to /login
  // and followed, which is exactly what happens if `proxy.ts` does not list this
  // path. The body assertion is what makes that unambiguous.
  expect(res.status).toBe(201);
  const created = (await res.json()) as { tenantId: string; slug: string; status: string };
  expect(created.status).toBe('provisioned');
  expect(created.tenantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.slug).toBe(`${SLUG_PREFIX}-co`);

  // The tenant is complete, through the same path self-serve signup uses.
  const org = await db.query(
    `SELECT o.slug, o.account_id,
            (SELECT count(*)::int FROM app_user u WHERE u.organization_id = o.id) AS users,
            (SELECT count(*)::int FROM expense_category c WHERE c.organization_id = o.id) AS categories
       FROM organization o WHERE o.id = $1`,
    [created.tenantId],
  );
  expect(org.rows[0]).toMatchObject({
    slug: `${SLUG_PREFIX}-co`,
    account_id: ACCOUNT,
    users: 1,
  });
  expect(org.rows[0].categories).toBeGreaterThan(0);
});

test('a retry is answered 200 and creates nothing', async () => {
  const first = await post(body(), INBOUND_TOKEN);
  expect(first.status).toBe(201);
  const { tenantId } = (await first.json()) as { tenantId: string };

  const retry = await post(body({ idempotencyKey: 'e2e-idem-2' }), INBOUND_TOKEN);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ tenantId, status: 'already_exists' });

  const n = await db.query('SELECT count(*)::int AS n FROM organization WHERE account_id = $1', [
    ACCOUNT,
  ]);
  expect(n.rows[0].n).toBe(1);
});

test('an unauthenticated caller is refused, and refused rather than redirected', async () => {
  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  //
  // With `/api/platform/` missing from either list in `proxy.ts`, this is a 307
  // to `/login?callbackUrl=%2Fapi%2Fplatform%2Fprovision`. `redirect: 'manual'`
  // is what makes that visible: followed, it is a 200 and an HTML login page,
  // and a status assertion would be the only thing between that and a pass.
  //
  // So all three checks matter and none is decoration — the status says it was
  // not redirected, the content-type says a route answered rather than a page,
  // and the code says WHICH route.
  const res = await post(body());

  expect(res.status).toBe(401);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

  const n = await db.query('SELECT count(*)::int AS n FROM organization WHERE account_id = $1', [
    ACCOUNT,
  ]);
  expect(n.rows[0].n).toBe(0);
});

test('a wrong key is refused the same way', async () => {
  const res = await post(body(), 'not-the-inbound-token');
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
});

test('a schema refusal names the fields, through the real server', async () => {
  const res = await post(body({ accountId: 'not-a-uuid' }), INBOUND_TOKEN);
  expect(res.status).toBe(422);
  const parsed = (await res.json()) as { error: { details: Record<string, string[]> } };
  expect(Object.keys(parsed.error.details)).toEqual(['accountId']);
});

test('the slug the platform asked for can be taken, and the answer says so', async () => {
  const first = await post(body(), INBOUND_TOKEN);
  expect(first.status).toBe(201);

  const second = await post(
    body({ accountId: ACCOUNT_TWO, companyName: 'Second Co', idempotencyKey: 'e2e-idem-3' }),
    INBOUND_TOKEN,
  );

  // VeloLedger returns 400 here and leaves the orchestrator guessing at a free
  // name it cannot see. This reports the one that was used.
  expect(second.status).toBe(201);
  expect(await second.json()).toMatchObject({
    slug: `${SLUG_PREFIX}-co-2`,
    status: 'provisioned',
  });
});
