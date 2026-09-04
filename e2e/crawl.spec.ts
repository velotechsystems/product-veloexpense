/**
 * VX4-7 part 3 / UD-3 — every page, as every role.
 *
 * ── WHY THIS IS THE LAST THING THE TICKET NEEDED ────────────────────────────
 *
 * `ce053ccd` in the ExpenseOS delta review is "crawl every page as every role",
 * and the audit's verdict is **Adopt the technique** with the note that it found
 * two real bugs upstream. Adopting it turned up something first: every session
 * `e2e/auth.setup.ts` minted before part 3 was an ADMIN. Thirteen specs, four
 * phases, and no page in this product had ever been loaded as a MANAGER or as an
 * EMPLOYEE.
 *
 * ── WHAT IT ASSERTS, AND WHY EACH ONE IS NOT OBVIOUS ────────────────────────
 *
 * 1. NOTHING THROWS. A page that 500s for an employee and works for an admin is
 *    the shape of bug this finds: `page.tsx` reads something only an admin's
 *    query returns, and no spec ever asked. Next renders its error boundary for
 *    an uncaught throw, so the check is that the boundary is absent — a status
 *    check alone would pass, because Next still answers 200 for a caught render
 *    error inside a segment.
 *
 * 2. AN ADMIN-ONLY PAGE REFUSES THE SAME WAY FOR BOTH. `/admin/*` is ADMIN-only
 *    (VX1-2), and "refuses" has to mean one thing: a redirect to a page they can
 *    see, or a refusal that says so. What it must NOT do is render the screen
 *    with the data missing, which reads as "there is nothing here" rather than
 *    "this is not yours" — and is how AC-14's `glAccountId IS NULL` control
 *    turned a cross-tenant reference into "correctly mapped".
 *
 * 3. NO PAGE LEAKS A RECORD ID INTO ITS VISIBLE TEXT. Parts 2b and 2c removed
 *    UUIDs from violation sentences and refusal copy; this is the standing check
 *    that they stay out, across every screen and every role at once, rather than
 *    per-message in a unit test.
 *
 * The PSEUDO-LOCALE half of the crawl is `e2e/pseudo-crawl.spec.ts`, which needs
 * its own server (the flag is read at boot) and so has its own config. This file
 * runs in the normal suite.
 */
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE, EMPLOYEE_STATE, MANAGER_STATE } from './helpers';

/**
 * Every route with a `page.tsx`, minus the ones a crawl cannot ask for.
 *
 * Listed rather than globbed on purpose: a route added without a thought about
 * who may see it should fail this file, and a glob would silently absorb it.
 * `test/…` has no equivalent — this is the only place the product's route list
 * is written down as a list.
 */
const PAGES = [
  '/',
  '/expenses',
  '/expenses/new',
  '/approvals',
  '/approvals/delegations',
  '/notifications',
  '/notifications/preferences',
  '/preferences',
  '/admin/modules',
  '/admin/employees',
  '/admin/employees/new',
  '/admin/expense-policies',
  '/admin/approval-ladder',
  '/admin/budgets',
  '/admin/chart-of-accounts',
  '/admin/compliance',
  '/admin/branding',
  '/admin/locale',
  '/admin/integrations',
  '/admin/ledger-queue',
  '/admin/notification-templates',
  '/admin/notification-delivery',
  '/admin/reimbursements',
  '/admin/analytics',
] as const;

/**
 * Excluded, each for a reason rather than because it failed:
 *   `/login`      — the only page with no session, and `auth.setup.ts` is the
 *                   spec that owns it.
 *   `/approve`     — reached by a signed token from an email, not by a signed-in
 *                   person; `oauth-flow` and the token specs own it.
 *   `/expenses/[reportId]`, `/admin/employees/[employeeId]` — need an id, so
 *                   they are crawled below from what each role can actually see,
 *                   which is a better test than a fixture id anyway.
 */

const ROLES = [
  // `state.json` is `admin@demo.test`, who OWNS the seeded reports. The first
  // draft used `approver.json` (`owner@demo.test`), who owns none — so the
  // report-opening test below skipped for all three roles and asserted nothing.
  // A skip that fires for every case is a test that does not exist.
  { name: 'ADMIN', state: ADMIN_STATE },
  { name: 'MANAGER', state: MANAGER_STATE },
  { name: 'EMPLOYEE', state: EMPLOYEE_STATE },
] as const;

const ADMIN_ONLY = (path: string) => path.startsWith('/admin/');

/**
 * ── WHAT THIS SPEC FOUND ON ITS FIRST RUN, BOARDED AS VX4-9 ────────────────
 *
 * **Every one of the fifteen `/admin/*` pages answers HTTP 500 to a MANAGER or
 * an EMPLOYEE.** `asAdmin` throws a bare `Error('forbidden: admin role
 * required')` inside a server component, nothing catches it, and Next renders
 * its error boundary. True since VX1-2, across four phases, and invisible
 * because until this file there was no non-admin session to load a page with.
 *
 * Authorization itself is INTACT — nothing leaks, the page never renders. What
 * is wrong is the shape of the refusal:
 *
 *   · an ordinary permission denial is indistinguishable from the product being
 *     broken. Somebody with a stale bookmark gets "Application error".
 *   · monitoring sees a 500 for every such click, so real 500s are buried in
 *     noise generated by the product working correctly.
 *
 * **And `asAdmin` is copy-pasted into fourteen action files.** All fourteen
 * predicates were diffed and are identical (`actor.role !== 'ADMIN' ||
 * actor.deleted_at !== null`), so there is no hole today — stated plainly
 * because "fourteen copies of an authorization check" invites the assumption
 * that one of them differs. It is fourteen places for the NEXT one to diverge,
 * which is MT-3's shape: a gate at the edge is a gate the next caller forgets.
 *
 * Not fixed here, by John's call on 3 Sep: the fix is one shared helper plus a
 * refusal path across fifteen pages, and choosing between a redirect and a 403
 * screen is a product decision rather than a mechanical change. Folding it into
 * a localisation PR would also bury it.
 */

/** Next's error boundary, and the dev overlay. Either means the page threw. */
async function assertNoRenderError(page: Page, where: string) {
  // `getByText` on the boundary's own copy rather than a status check: Next
  // answers 200 for an error caught inside a segment, so the status says
  // nothing. Both spellings, because the production boundary and the dev overlay
  // word it differently.
  const boundary = page.getByText(
    /Application error|a client-side exception|Internal Server Error|Unhandled Runtime Error/i,
  );
  await expect(boundary, `${where} rendered an error boundary`).toHaveCount(0);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function assertNoIdInText(page: Page, where: string) {
  const body = (await page.locator('body').innerText()).trim();
  const hit = UUID.exec(body);
  expect(hit?.[0], `${where} shows a record id in its visible text`).toBeUndefined();
}

for (const role of ROLES) {
  test.describe(`crawl as ${role.name}`, () => {
    test.use({ storageState: role.state });

    for (const path of PAGES) {
      const refusalExpected = ADMIN_ONLY(path) && role.name !== 'ADMIN';

      test(`${path}`, async ({ page }) => {
        if (refusalExpected) {
          // ── EXPECTED TO FAIL, and this is a FINDING rather than a known-bad
          // test. See the block below the loop for what it found and why the fix
          // is its own ticket. `test.fail` is the right marker precisely because
          // Playwright reports "expected to fail but passed" — so the day the
          // 500 is fixed, this file goes red and somebody has to come back and
          // delete this branch. A `skip` would rot silently.
          test.fail(
            true,
            'VX4-9: every /admin/* page answers 500 for a non-admin instead of refusing',
          );
        }

        const response = await page.goto(path);
        // A redirect is a legitimate answer — an employee sent away from an
        // admin screen lands somewhere they can see, and `page.goto` follows it.
        expect(response?.status(), `${path} as ${role.name}`).toBeLessThan(500);
        await assertNoRenderError(page, `${path} as ${role.name}`);
        await assertNoIdInText(page, `${path} as ${role.name}`);

        if (refusalExpected) {
          // Either sent away, or told. NOT the screen with its data missing —
          // see the header. `url()` is post-redirect.
          const url = new URL(page.url());
          const refused =
            url.pathname !== path ||
            (await page.getByTestId('error-banner').count()) > 0 ||
            (await page.getByText(/not allowed|administrator|do not have access/i).count()) > 0;
          expect(refused, `${path} as ${role.name} rendered rather than refusing`).toBe(true);
        }
      });
    }

    test('what this role sees on /expenses, and opens from it', async ({ page }) => {
      // The `[reportId]` route, reached from what this role can actually see
      // rather than from a fixture id — so it exercises the ownership predicate
      // (VX1-6) rather than bypassing it.
      await page.goto('/expenses');
      await assertNoRenderError(page, '/expenses');

      // NOT `a[href^="/expenses/"]` — that matches the "New report" link at
      // `/expenses/new`, which is how the first run of this spec failed.
      const links = await page.locator('a[href^="/expenses/"]').all();
      const hrefs = (await Promise.all(links.map((l) => l.getAttribute('href')))).filter(
        (h): h is string => h !== null && /\/expenses\/[0-9a-f-]{36}$/.test(h),
      );

      if (hrefs.length === 0) {
        // NOT a skip. Only the demo admin owns seeded reports, so a manager and
        // an employee legitimately see none — and "sees none" has a correct
        // rendering that is worth asserting. The first draft skipped here, which
        // meant the test asserted nothing for any of the three roles.
        await expect(
          page.getByText(/No reports yet/i),
          `${role.name} sees neither a report nor the empty state`,
        ).toBeVisible();
        return;
      }

      await page.goto(hrefs[0]);
      await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
      await assertNoRenderError(page, '/expenses/[reportId]');
      await assertNoIdInText(page, '/expenses/[reportId]');
    });
  });
}
