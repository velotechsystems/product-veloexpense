/**
 * VX5-2b — self-serve signup, end to end, through the mail sink.
 *
 * ── WHY THIS SPEC IS THE POINT OF THE TICKET ────────────────────────────────
 *
 * `lib/onboarding/provision.ts` (VX5-1) and `lib/onboarding/signup.ts` (VX5-2)
 * both shipped with nothing able to call them, and `test/signup.db.test.ts`
 * proves what they do when called correctly. What no test could reach was the
 * wiring: whether middleware lets a stranger in, whether the form's field names
 * match what the action reads, whether the link in the email points at a route
 * that exists. Every one of those is invisible to a unit test and fatal in
 * production, and `startSignup` has been mailing a link to `/signup/verify`
 * since #103 — a page that did not exist until this ticket.
 *
 * ── NO STORAGE STATE, DELIBERATELY ──────────────────────────────────────────
 *
 * Every other spec runs with a minted admin session. This one clears it, because
 * a signed-in browser would prove nothing about the page a stranger sees — and
 * `proxy.ts` is exactly the thing being tested. With a session cookie present,
 * `/signup` would render whether or not it were listed as public.
 *
 * ── NO DRAIN ────────────────────────────────────────────────────────────────
 *
 * `approval-flow.spec.ts` has to POST the drain route before its mail appears.
 * Signup mail does not go through the outbox at all — `notification_delivery` is
 * tenant-scoped and there is no tenant yet, which `lib/onboarding/signup.ts`
 * explains at length — so `startSignup` calls `sendEmail` directly and the sink
 * has it as soon as the POST returns.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';

// The one spec in the suite that is signed OUT. See the header.
test.use({ storageState: { cookies: [], origins: [] } });

/** Per-run id: `organization` is never reset between runs and CI retries once. */
const RUN = Date.now().toString(36);
const EMAIL = `founder-${RUN}@signup.e2e`;
const ORG_NAME = `E2E Signup ${RUN}`;
const SLUG = `e2e-signup-${RUN}`;

const MAIL_HTTP = `http://127.0.0.1:${process.env.E2E_MAIL_HTTP_PORT ?? 2526}`;

interface Captured {
  to: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
}

async function inbox(request: APIRequestContext): Promise<Captured[]> {
  const res = await request.get(`${MAIL_HTTP}/messages`);
  expect(res.ok(), 'the e2e mail sink should be reachable').toBeTruthy();
  return (await res.json()) as Captured[];
}

/**
 * Poll the sink for the confirmation link sent to `to`.
 *
 * Filtered by RECIPIENT and by this run's organization name, for the reason
 * `approval-flow.spec.ts`'s `mine()` gives: the sink is emptied in `beforeAll`
 * but a retry within a run is not a fresh sink, and matching the first message
 * that merely contains `/signup/verify` would happily return the previous
 * attempt's.
 */
async function waitForVerifyLink(request: APIRequestContext, to: string): Promise<string> {
  let last: Captured[] = [];
  const mine = (m: Captured) => m.to.includes(to) && m.text.includes(ORG_NAME);
  await expect
    .poll(
      async () => {
        last = await inbox(request);
        return last.some((m) => mine(m) && m.text.includes('/signup/verify?token='));
      },
      { message: `no confirmation link mailed to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  const message = last.filter((m) => mine(m) && m.text.includes('/signup/verify?token=')).pop()!;
  const match = message.text.match(/(https?:\/\/\S*\/signup\/verify\?token=[\w-]+)/);
  expect(match, 'the mail should carry an absolute confirmation URL').not.toBeNull();

  // ONE credential, in BOTH MIME parts. The sink keeps the parts in one blob, so
  // a single link mailed correctly appears twice; a recipient whose client
  // prefers text/plain and one whose client prefers text/html must each have
  // something to click. Distinct tokens would mean two credentials for one
  // signup, which `0035`'s unique index says cannot happen.
  const tokens = [...message.text.matchAll(/\/signup\/verify\?token=([\w-]+)/g)].map((m) => m[1]);
  expect(new Set(tokens).size, 'a signup has exactly one live token').toBe(1);
  expect(tokens.length, 'the link should be in both the text and the HTML part').toBeGreaterThan(1);
  return match![1];
}

async function db<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const orgCount = (slug: string) =>
  db(async (pool) =>
    Number(
      (await pool.query('SELECT count(*)::int AS n FROM organization WHERE slug = $1', [slug]))
        .rows[0].n,
    ),
  );

test.beforeAll(async ({ request }) => {
  await request.delete(`${MAIL_HTTP}/messages`);
});

test.describe('self-serve signup', () => {
  test('a stranger can create an organization, and only by clicking the mailed link', async ({
    page,
    request,
  }) => {
    /* ── the form is reachable with no session at all ───────────────────────
     * `proxy.ts` redirects anyone without a session cookie to /login. If
     * `/signup` were not listed public — in BOTH the PUBLIC array and the
     * matcher — this first assertion is where it shows. */
    await page.goto('/signup');
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();

    await page.getByLabel('Your work email').fill(EMAIL);
    await page.getByLabel('Organization name').fill(ORG_NAME);
    await page.getByLabel('Web address (optional)').fill(SLUG);
    await page.getByRole('button', { name: 'Send the confirmation link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    // NOTHING EXISTS YET. This is the assertion VX5-2's whole design is for: an
    // address nobody has proven they hold has not created a company.
    expect(await orgCount(SLUG), 'the tenant must not exist before verification').toBe(0);

    const link = await waitForVerifyLink(request, EMAIL);

    /* ── the GET asks; it does not act ──────────────────────────────────────
     * A link scanner fetching this URL must not provision the tenant. Visiting
     * it and then re-checking the count is what says so. */
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    // `exact` because the name is on the page twice — in the sentence and in the
    // button — and this assertion is about the SENTENCE: naming the organization
    // is the only thing that lets somebody tell this page from a copy of it.
    await expect(page.getByText(ORG_NAME, { exact: true })).toBeVisible();
    expect(await orgCount(SLUG), 'a GET on the link must create nothing').toBe(0);

    // Fetching it a second time is still safe and still offers the button — a
    // scanner does not burn the link for the person it was sent to.
    const scanned = await request.get(link);
    expect(scanned.ok(), 'a plain GET should render, not fail').toBeTruthy();
    expect(await orgCount(SLUG), 'a second GET must still create nothing').toBe(0);

    /* ── the POST creates it ────────────────────────────────────────────────*/
    await page.getByRole('button', { name: `Create ${ORG_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Your organization is ready' })).toBeVisible();
    expect(await orgCount(SLUG), 'exactly one tenant, after the POST').toBe(1);

    // The token is gone from the address bar; what is left is a public slug.
    await expect(page).toHaveURL(new RegExp(`/signup/verify\\?created=${SLUG}$`));

    // The founder is an ADMIN of the new tenant, which is what makes it usable.
    const admins = await db(async (pool) =>
      (
        await pool.query(
          // w4-10b: the role's label (0068), where the text role ADMIN was.
          `SELECT r.label ->> 'en' AS role
             FROM app_user u JOIN organization o ON o.id = u.organization_id
             JOIN role r ON r.organization_id = u.organization_id AND r.id = u.role_id
            WHERE o.slug = $1`,
          [SLUG],
        )
      ).rows.map((r) => r.role as string),
    );
    expect(admins, 'the founder is the tenant’s first administrator').toEqual(['System Administrator']);

    /* ── and the seam this ticket exists to close ───────────────────────────
     * Sign-in asks for the web address. The button carries it, so nobody has to
     * read their slug on one screen and retype it on the next. */
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/login\\?org=${SLUG}$`));
    await expect(page.getByLabel('Organization')).toHaveValue(SLUG);
  });

  test('the link is single-use: a second confirmation is refused, not repeated', async ({
    page,
    request,
  }) => {
    const email = `second-${RUN}@signup.e2e`;
    const slug = `e2e-second-${RUN}`;
    const name = `${ORG_NAME} second`;

    await page.goto('/signup');
    await page.getByLabel('Your work email').fill(email);
    await page.getByLabel('Organization name').fill(name);
    await page.getByLabel('Web address (optional)').fill(slug);
    await page.getByRole('button', { name: 'Send the confirmation link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    let last: Captured[] = [];
    await expect
      .poll(async () => {
        last = await inbox(request);
        return last.some((m) => m.to.includes(email) && m.text.includes('/signup/verify?token='));
      }, { message: `no confirmation link mailed to ${email}`, timeout: 15_000 })
      .toBe(true);
    const link = last
      .filter((m) => m.to.includes(email))
      .pop()!
      .text.match(/(https?:\/\/\S*\/signup\/verify\?token=[\w-]+)/)![1];

    await page.goto(link);
    await page.getByRole('button', { name: `Create ${name}` }).click();
    await expect(page.getByRole('heading', { name: 'Your organization is ready' })).toBeVisible();

    // Back to the same link. The row is consumed, so it is INVISIBLE under the
    // narrow gate — the page cannot even offer the button.
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'That link is not usable' })).toBeVisible();
    await expect(page.getByTestId('error-banner')).toContainText('no longer valid');
    expect(await orgCount(slug), 'still exactly one tenant').toBe(1);
  });

  test('a web address somebody else holds is refused, and the form comes back', async ({
    page,
  }) => {
    // `demo` is seeded and is NOT in RESERVED_SLUGS, so this exercises the
    // UNIQUE constraint rather than the reserved list — the case a signup can
    // actually lose, and only at verification.
    await page.goto('/signup');
    await page.getByLabel('Your work email').fill(`clash-${RUN}@signup.e2e`);
    await page.getByLabel('Organization name').fill(`${ORG_NAME} clash`);
    await page.getByLabel('Web address (optional)').fill('admin');
    await page.getByRole('button', { name: 'Send the confirmation link' }).click();

    // `admin` is reserved, and reserved is refused at REQUEST time — no mail is
    // sent for an address that could never become a tenant.
    await expect(page.getByTestId('error-banner')).toContainText('reserved');
    await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  });

  test('a link with no token, and a made-up one, both say the same thing', async ({ page }) => {
    for (const url of ['/signup/verify', '/signup/verify?token=nobody-issued-this']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'That link is not usable' })).toBeVisible();
    }
  });

  test('a hand-edited ?created= does not get to congratulate anybody', async ({ page }) => {
    // The success state is chosen by a query parameter, so the parameter is
    // whatever is in the address bar. It is echoed into the page and into the
    // sign-in link, and `checkSlug` is what stops that being a place to put
    // something else.
    for (const bogus of ['Not A Slug', '-nope-', 'x'.repeat(80), '../admin']) {
      await page.goto(`/signup/verify?created=${encodeURIComponent(bogus)}`);
      await expect(
        page.getByRole('heading', { name: 'Your organization is ready' }),
      ).toBeHidden();
      await expect(page.getByRole('heading', { name: 'That link is not usable' })).toBeVisible();
    }
  });
});
