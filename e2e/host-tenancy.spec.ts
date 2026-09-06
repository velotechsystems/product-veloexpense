/**
 * VX5-5 — tenant subdomains, in a real browser, against real hostnames.
 *
 * ── WHY THIS SPEC LAUNCHES ITS OWN BROWSER ──────────────────────────────────
 *
 * Two things had to be true before any of this could be tested, and one of them
 * was measured rather than assumed:
 *
 *   1. The hostnames must resolve. `--host-resolver-rules` maps `*.velo.test` to
 *      127.0.0.1 inside this browser only, so nothing is added to `/etc/hosts`
 *      and no DNS is needed — which matters because CI has no network and a
 *      wildcard-DNS service would be a dependency for a string substitution.
 *   2. **The session cookie must reach the subdomain, and on `localhost` it
 *      cannot.** A Playwright probe against `demo.localhost:3000` showed the
 *      apex rendering and the subdomain redirecting to `/login`: a cookie with
 *      no `Domain` is host-only, and browsers will not scope one to `localhost`.
 *      A resolvable domain like `velo.test` can carry `Domain=velo.test`, which
 *      is exactly what a deployment does with `AUTH_COOKIE_DOMAIN`.
 *
 * Both are per-BROWSER settings, and the rest of the suite has 150 tests happily
 * on `localhost`. Launching one browser here is contained; a second Playwright
 * project would re-run everything, and changing the shared config would put the
 * whole suite on a new origin to prove one thing.
 *
 * ── WHAT IT CANNOT REACH, SAID PLAINLY ──────────────────────────────────────
 *
 * The app server for this suite runs with the default `APP_URL` and no
 * `AUTH_COOKIE_DOMAIN` — one server, shared with every other spec. So the
 * cookie the app ITSELF would set is not exercised here; this spec mints one
 * scoped the way a configured deployment would and proves the app behaves
 * correctly when it arrives. `test/tenant-host.db.test.ts` covers the
 * `originForTenant` half, where the env can be set per assertion.
 */
import { test, expect, chromium, type Browser, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { Pool } from 'pg';

const APEX = 'velo.test';
const PORT = process.env.E2E_PORT ?? '3000';
const COOKIE_NAME = 'authjs.session-token';

const url = (sub: string | null, path = '/') =>
  `http://${sub === null ? APEX : `${sub}.${APEX}`}:${PORT}${path}`;

let browser: Browser;

/**
 * Give the demo tenant a real logo.
 *
 * A one-pixel PNG, written as bytes rather than through the admin screen: this
 * spec is about hosts, and the upload path has its own coverage in
 * `branding.db.test.ts`. `0023`'s CHECKs want the three columns to move
 * together and the mime to be a raster type, which is what this satisfies.
 */
async function setDemoLogo(): Promise<void> {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `UPDATE organization
          SET logo_bytes = $1, logo_mime = 'image/png', logo_updated_at = clock_timestamp()
        WHERE slug = 'demo'`,
      [png],
    );
  } finally {
    await pool.end();
  }
}

test.beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: [`--host-resolver-rules=MAP *.${APEX} 127.0.0.1, MAP ${APEX} 127.0.0.1`],
  });
});

test.afterAll(async () => {
  await browser?.close();
});

/**
 * A session for one tenant's admin, scoped to the APEX so it is sent to every
 * subdomain — which is what `AUTH_COOKIE_DOMAIN` does in a deployment, and the
 * thing the mismatch guard exists to make safe.
 */
async function contextFor(orgSlug: string, email: string): Promise<BrowserContext> {
  const secret = process.env.AUTH_SECRET;
  expect(secret, 'AUTH_SECRET must be set for the e2e run').toBeTruthy();

  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  let user: { id: string; organization_id: string; display_name: string | null };
  try {
    const r = await pool.query(
      `SELECT u.id, u.organization_id, u.display_name
         FROM app_user u JOIN organization o ON o.id = u.organization_id
        WHERE o.slug = $1 AND lower(u.email) = lower($2)`,
      [orgSlug, email],
    );
    expect(r.rows.length, `${email} is missing from '${orgSlug}' — run \`npm run seed\``).toBe(1);
    user = r.rows[0];
  } finally {
    await pool.end();
  }

  const maxAge = 60 * 60;
  const token = await encode({
    token: {
      name: user.display_name ?? email,
      email,
      sub: user.id,
      orgId: user.organization_id,
      role: 'ADMIN',
      subjectId: user.id,
    },
    secret: secret!,
    salt: COOKIE_NAME,
    maxAge,
  });

  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      // The APEX, with a leading dot, so it reaches every tenant subdomain.
      domain: `.${APEX}`,
      path: '/',
      expires: Math.floor(Date.now() / 1000) + maxAge,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  return ctx;
}

test.describe('tenant subdomains', () => {
  test('a session reaches its OWN tenant address and reads its own data', async () => {
    const ctx = await contextFor('demo', 'admin@demo.test');
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url('demo', '/expenses'));
      expect(res!.status()).toBe(200);
      // Not bounced to /login: the apex-scoped cookie arrived, which is the
      // thing `localhost` could not do.
      await expect(page).toHaveURL(new RegExp(`demo\\.${APEX}:${PORT}/expenses$`));
      await expect(page.getByTestId('wrong-tenant-host')).toBeHidden();
    } finally {
      await ctx.close();
    }
  });

  test('the same session at ANOTHER tenant’s address is refused, not served', async () => {
    const ctx = await contextFor('demo', 'admin@demo.test');
    const page = await ctx.newPage();
    try {
      await page.goto(url('second', '/expenses'));
      // THE CLAIM. Not redirected to demo's host, and — the part that matters —
      // not quietly showing demo's expense reports at second's address.
      await expect(page.getByTestId('wrong-tenant-host')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'This is not your organization' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
      // Neither organization is named — the page renders on a host somebody else
      // typed, and it is not an oracle for who our customers are.
      const body = await page.locator('body').innerText();
      expect(body.toLowerCase()).not.toContain('demo co');
      expect(body.toLowerCase()).not.toContain('second');
    } finally {
      await ctx.close();
    }
  });

  test('an address naming NOBODY is refused too, rather than falling back', async () => {
    const ctx = await contextFor('demo', 'admin@demo.test');
    const page = await ctx.newPage();
    try {
      await page.goto(url('not-a-tenant', '/expenses'));
      await expect(page.getByTestId('wrong-tenant-host')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  /* THE GUARD, AS OPPOSED TO THE PAGE.
   *
   * A sabotage that removed the mismatch check from `withCurrentOrg` failed NO
   * test until this one existed — `app/layout.tsx` renders the refusal for every
   * PAGE before its tenant read ever runs, so the layout was doing all the work
   * and the guard was covered by nothing.
   *
   * A route handler never sees a layout. This is the case that proves the guard
   * is on the data path, and the route it uses had been bypassing both: on
   * another tenant's host a session fetched its own logo bytes quite happily. */
  test('a route handler, which has no layout, is guarded too', async () => {
    const ctx = await contextFor('demo', 'admin@demo.test');
    const page = await ctx.newPage();
    try {
      /* DEMO MUST ACTUALLY HAVE A LOGO, or this test proves nothing.
       *
       * The first version asserted a 404 on the mismatched host — and got one
       * with the guard removed too, because neither tenant had uploaded a logo
       * and the route 404s for that reason anyway. Two sabotages passed against
       * it. Giving demo real bytes is what makes the two outcomes different:
       * 200-with-bytes on its own host, 404-with-nothing on somebody else's. */
      await setDemoLogo();

      /* Fetched THROUGH THE PAGE, not with `page.request`. Playwright's API
       * request context resolves hostnames in Node, which knows nothing about
       * this browser's `--host-resolver-rules` — the first version of this test
       * failed with `ENOTFOUND demo.velo.test` and would have been easy to
       * misread as the route being broken. Same-origin each time, so CORS is not
       * in the way of reading the status either. */
      const fetchHere = async () =>
        page.evaluate(async () => {
          const r = await fetch('/api/branding/logo');
          return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
        });

      // On demo's own host: the bytes, as always.
      await page.goto(url('demo', '/'));
      const own = await fetchHere();
      expect(own.status, 'demo serves its own logo on its own host').toBe(200);
      expect(own.bytes).toBeGreaterThan(0);

      // On second's host, the same session must get nothing. 404 rather than a
      // refusal page: what a tenant has uploaded is not something this route
      // confirms or denies.
      await page.goto(url('second', '/'));
      const wrong = await fetchHere();
      expect(wrong.status, 'a mismatched host must not serve tenant bytes').toBe(404);
      expect(wrong.bytes).toBeLessThan(64);
    } finally {
      await ctx.close();
    }
  });

  test('the apex still works, which is where signup and generic sign-in live', async () => {
    const ctx = await contextFor('demo', 'admin@demo.test');
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url(null, '/expenses'));
      expect(res!.status()).toBe(200);
      await expect(page.getByTestId('wrong-tenant-host')).toBeHidden();
      // And the public pages, with no session in play.
      const anon = await browser.newContext();
      const anonPage = await anon.newPage();
      const signup = await anonPage.goto(url(null, '/signup'));
      expect(signup!.status()).toBe(200);
      await expect(anonPage.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
      await anon.close();
    } finally {
      await ctx.close();
    }
  });

});
