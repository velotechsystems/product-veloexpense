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
  // w4-09 (d72): ExpenseOS's dashboard, in place of VeloExpense's `/` (which redirects here).
  '/dashboard',
  '/expenses',
  // w2-06: ExpenseOS's cross-report view, AP / admin only (see ADMIN_ONLY).
  '/expenses/all',
  // w4-05/w4-07 (d71): ExpenseOS's inbox, in place of VeloExpense's /approvals.
  '/expenses/approvals',
  '/approvals/delegations',
  '/notifications',
  '/notifications/preferences',
  '/preferences',
  // People 3: ExpenseOS's People directory. Every member may open it — what they see is
  // scoped (themselves and their reporting chain; everyone for an admin), so not ADMIN_ONLY.
  '/users',
  '/admin/modules',
  '/admin/employees',
  '/admin/employees/invite',
  '/admin/budgets',
  '/admin/chart-of-accounts',
  '/admin/compliance',
  '/admin/branding',
  // VX5-11. Added by hand because this list is deliberately not a glob: a route
  // added without a thought about who may see it should fail this file.
  '/admin/billing',
  '/admin/locale',
  '/admin/integrations',
  '/admin/ledger-queue',
  '/admin/notification-templates',
  '/admin/notification-delivery',
  '/admin/reimbursements',
  '/admin/analytics',
  // Wave 0: the first ExpenseOS screen ported to its own path (app/(app)/admin/).
  '/admin/expense-categories',
  '/admin/business-units',
  '/admin/legal-entities',
  '/admin/departments',
  '/admin/job-levels',
  '/admin/fiscal-years',
  '/admin/fx-rates',
  '/admin/mileage-rates',
  '/admin/per-diem-rates',
  // w4-01: ExpenseOS's workflow builder (the editor itself needs an id, as the report page does).
  '/admin/approval-workflows',
  // w4-02b: ExpenseOS's Rule Builder; w4-02c: its per-category policies.
  '/admin/policy-rules',
  '/admin/policies',
  // w4-02e: ExpenseOS's policy-violation register.
  '/admin/policy-violations',
  // w4-10c: ExpenseOS's Role Builder.
  '/admin/roles',
] as const;

/**
 * Excluded, each for a reason rather than because it failed:
 *   `/login`      — the only page with no session, and `auth.setup.ts` is the
 *                   spec that owns it.
 *   `/`           — renders nothing: since w4-09 it only redirects to /dashboard,
 *                   which the crawl visits.
 *   `/approve`     — renders nothing: since d62 it only redirects an old emailed
 *                   link to /approvals, which the crawl visits.
 *   `/signup`, `/signup/verify`, `/invite/accept` — same reason: reached with no
 *                   session, from a link in a mailbox. `signup-flow.spec.ts` and
 *                   `invite-flow.spec.ts` own them.
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

// w2-06: `/expenses/all` too. It crosses submitters, so it needs `expense.report.read.all`
// or `expense.report.reimburse` — held by the admin role and by neither of the others.
const ADMIN_ONLY = (path: string) => path.startsWith('/admin/') || path === '/expenses/all';

/**
 * ── WHAT THIS SPEC FOUND ON ITS FIRST RUN, AND WHAT VX4-9 DID ABOUT IT ─────
 *
 * On its first run: **every one of the fifteen `/admin/*` pages answered HTTP
 * 500 to a MANAGER or an EMPLOYEE.** `asAdmin` threw a bare `Error('forbidden:
 * admin role required')` inside a server component, nothing caught it, and Next
 * rendered its error boundary. True since VX1-2, across four phases, and
 * invisible because until this file there was no non-admin session to load a
 * page with.
 *
 * Authorization itself was INTACT — nothing leaked, the page never rendered.
 * What was wrong was the shape of the refusal:
 *
 *   · an ordinary permission denial was indistinguishable from the product being
 *     broken. Somebody with a stale bookmark got "Application error".
 *   · monitoring saw a 500 for every such click, so real 500s were buried in
 *     noise generated by the product working correctly.
 *
 * **And `asAdmin` was copy-pasted into fifteen action files** — fourteen
 * byte-identical, the fifteenth already refactored into a different shape. No
 * hole; fifteen places for the NEXT one to diverge, which is MT-3's shape: a
 * gate at the edge is a gate the next caller forgets.
 *
 * VX4-9 fixed both halves. `lib/auth/admin-guard.ts` is the only gate, with two
 * exits — `asAdminPage` calls Next's `forbidden()` and renders `app/forbidden.tsx`
 * with a **403**, and `asAdmin` throws a `ForbiddenError` carrying a catalogued
 * sentence for a form to show. `scripts/check-admin-gate.mjs` fails the build on
 * a sixteenth copy or on a caller taking the wrong exit.
 *
 * So the refusal assertion below is now EXACT rather than a disjunction of
 * "redirected, or said something denial-shaped". Two things are asserted, one
 * per audience: the status code the operator filters on, and the sentence the
 * person reads. A 200 with a polite page would satisfy only half the ticket and
 * must fail here.
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
        // A `test.fail(true, 'VX4-9: …')` stood here while the 500 was open, and
        // it is gone rather than flipped to a skip: Playwright reports "expected
        // to fail but passed", so fixing the bug turned this file red and forced
        // somebody back to this line. That is what the marker was for.
        const response = await page.goto(path);
        // A redirect is a legitimate answer — an employee sent away from an
        // admin screen lands somewhere they can see, and `page.goto` follows it.
        expect(response?.status(), `${path} as ${role.name}`).toBeLessThan(500);
        await assertNoRenderError(page, `${path} as ${role.name}`);
        await assertNoIdInText(page, `${path} as ${role.name}`);

        if (refusalExpected) {
          // FOR THE OPERATOR: the status code. `forbidden()` answers 403, which
          // is also the check that `experimental.authInterrupts` is still on in
          // `next.config.ts` — with the flag off, `forbidden()` throws and this
          // is a 500 again.
          expect(response?.status(), `${path} as ${role.name} must answer 403`).toBe(403);

          // FOR THE PERSON: the sentence. `app/forbidden.tsx` renders it from
          // the error catalogue, so this is not asserting on hard-coded English
          // in a page — it is asserting the refusal screen rendered at all, and
          // NOT the admin screen with its data quietly missing.
          await expect(
            page.getByTestId('forbidden-reason'),
            `${path} as ${role.name} rendered rather than refusing`,
          ).toHaveCount(1);

          // Still on the URL they asked for. A redirect was considered and
          // rejected with John on 4 Sep: somebody following a colleague's link
          // lands somewhere else with no explanation and concludes the link was
          // wrong.
          expect(new URL(page.url()).pathname, `${path} as ${role.name}`).toBe(path);
        }
      });
    }

    test('what this role sees on /expenses, and opens from it', async ({ page }) => {
      // The `[reportId]` route, reached from what this role can actually see
      // rather than from a fixture id — so it exercises the ownership predicate
      // (VX1-6) rather than bypassing it.
      await page.goto('/expenses');
      await assertNoRenderError(page, '/expenses');

      // w2-05: the ported list opens a report by clicking its row — there is no link to
      // collect — so the first row carrying a report number is the one opened.
      const row = page.getByRole('row').filter({ hasText: /EXP-\d+/ }).first();
      const empty = page.getByText('No expense reports', { exact: true });
      // The list loads its rows client-side: wait for one of the two before deciding.
      await expect(row.or(empty)).toBeVisible();

      if ((await row.count()) === 0) {
        // NOT a skip. Only the demo admin owns seeded reports, so a manager and
        // an employee legitimately see none — and "sees none" has a correct
        // rendering that is worth asserting. The first draft skipped here, which
        // meant the test asserted nothing for any of the three roles.
        // w2-05: the ported list's empty state (`expenses.list.emptyTitle`).
        await expect(empty, `${role.name} sees neither a report nor the empty state`).toBeVisible();
        return;
      }

      await row.click();
      await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
      await assertNoRenderError(page, '/expenses/[reportId]');
      await assertNoIdInText(page, '/expenses/[reportId]');
    });
  });
}
