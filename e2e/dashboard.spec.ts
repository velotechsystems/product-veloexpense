/**
 * w4-09 — ExpenseOS's dashboard (`e2e/dashboard.spec.ts`, 550b2945), ported: the post-login
 * landing page, in a browser, as each seeded VeloExpense actor.
 *
 * What it owns, as in ExpenseOS: that the page renders at all, that `<main>` holds exactly
 * one `h1` and it is the reader's own name, that the identity chips resolved from the fresh
 * profile rather than degrading to the session, that a card's rows link where they claim,
 * that a deep link opens what it names, and that a deep link nobody meant to follow degrades
 * quietly instead of answering.
 *
 * VeloExpense, each marked below:
 *   · four actors, VeloExpense's seeded demo tenant (`scripts/seed.mjs`), where ExpenseOS has
 *     nine QA personas;
 *   · VeloExpense seeds no fixed-id reports (ExpenseOS's `qa-activity.json`), so the row-link
 *     and deep-link cases make their own draft — the one thing this file creates — and the
 *     empty-state persona case is not here: no seeded VeloExpense reader is guaranteed empty
 *     once the other specs have run;
 *   · no travel (w6): the three travel deep-link cases are not here, and the travel card is
 *     asserted absent for everybody;
 *   · `/` redirects here (d72), which ExpenseOS has no need to assert;
 *   · VeloExpense's setup checklist (d72) is `home-flow.spec.ts`'s.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ADMIN_STATE, APPROVER_STATE, createDraftReport, EMPLOYEE_STATE, MANAGER_STATE } from './helpers';

/** ── What the app says ─────────────────────────────────────────────────────────────────
 *
 * Read off `packages/i18n/src/catalogs/en/dashboard.json` and `.../common.json`, not
 * guessed. The catalog is the contract; a renamed key has to fail here.
 */
const COPY = {
  /** `dashboard.cards.*.title` */
  approvalsTitle: 'Reports to approve',
  expensesTitle: 'My expense reports',
  travelTitle: 'My travel requests',
  /** `common.panelUnavailable` — `PanelBoundary`'s fallback. */
  panelFailed: 'This section could not be loaded.',
  /** `common.errorBoundary` — the whole page went down. */
  errorBoundary: 'Something went wrong.',
  /** `nav.items.*` — the TopBar `h1` for the approvals deep-link destination. */
  approvalsPageTitle: 'Approvals',
  /** `expenses.list.loading` — the approver drawer's body while its by-id query is pending. */
  reportLoading: 'Loading reports…',
  /** `expenses.drawer.fallback` — the approver drawer's title when it has no report to name. */
  drawerFallback: 'Expense report',
  /** `common.notFound.recordTitle` — the face `/expenses/<id>` paints for an id it cannot resolve. */
  recordNotFound: 'This record no longer exists',
} as const;

/**
 * VeloExpense: the seeded demo tenant's people (`scripts/seed.mjs`), by the session each
 * signs in with. The name is `app_user.display_name`, which is what the session carries and
 * so what the band's `h1` must read.
 */
const ACTORS = {
  admin: { state: ADMIN_STATE, name: 'Demo Admin' },
  owner: { state: APPROVER_STATE, name: 'Demo Owner' },
  manager: { state: MANAGER_STATE, name: 'Demo Manager' },
  employee: { state: EMPLOYEE_STATE, name: 'Demo Employee' },
} as const;
type Actor = keyof typeof ACTORS;

/** How many rows each card draws — `PREVIEW_ROWS`, the same 5 in every card component. */
const PREVIEW_ROWS = 5;

/**
 * What a row link must look like, per card. The `$` anchor is the load-bearing character:
 * the LISTING each card footers to is `/expenses` and `/expenses/approvals`, and neither
 * matches, so a row that fell back to linking at its own list lands here as a missing
 * record link rather than as a passing test. (VeloExpense: no locale prefix in its paths.)
 */
const REPORT_LINK = /^\/expenses\/[0-9a-f-]{36}$/;
const APPROVAL_LINK = /^\/expenses\/approvals\?report=[0-9a-f-]{36}$/;

/**
 * A value nobody meant to type. Deliberately NOT a UUID and deliberately distinctive: the
 * assertion is that this exact string is nowhere in what the page renders.
 */
const MALFORMED = 'zz-not-an-id-echo-probe-4f81';
/** VeloExpense: a well-formed id that is nobody's report — see the last case. */
const NOBODYS = '019e9999-0000-7000-8000-000000000000';

/**
 * The dashboard's own root, and nothing else on the screen. `data-dashboard-approvals` is
 * stamped on the page's outermost div, so this is the app shell minus the sidebar and the
 * top bar — which keeps a card assertion off the sidebar's profile trigger, which carries
 * the reader's name too.
 */
function home(page: Page): Locator {
  return page.locator('[data-dashboard-approvals]');
}

/**
 * Wait until no card is still loading. `SectionCard`'s pending face is
 * `<div role="status" aria-busy="true">`, so zero of them means every card has settled into
 * rows, empty copy, or an error face. Every "nothing went wrong" assertion has to come after
 * this: `not.toContainText` passes instantly on a page that has not rendered the thing yet.
 */
async function settled(page: Page): Promise<void> {
  await expect(
    home(page).locator('[aria-busy="true"]'),
    'a dashboard card never left its loading skeleton',
  ).toHaveCount(0, { timeout: 20_000 });
}

/** Every anchor the dashboard rendered, as `{ name, href }`. Only safe after `settled()`. */
async function anchors(root: Locator): Promise<{ name: string; href: string }[]> {
  return root.locator('a[href]').evaluateAll((els) =>
    els.map((el) => ({
      name: (el.textContent ?? '').trim(),
      href: el.getAttribute('href') ?? '',
    })),
  );
}

test.describe('dashboard', () => {
  /**
   * The blast-radius test, one per actor. Card presence is asserted against the SERVER'S OWN
   * DECISION (the `data-dashboard-*` attributes `selectDashboardCards` published), so this
   * catches both halves of a gating mistake: a card that should be there and is missing,
   * and a card rendered for a reader the server excluded.
   */
  for (const actor of Object.keys(ACTORS) as Actor[]) {
    test(`renders for ${actor}, with the identity band, the right cards, and no panel fallen back`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ storageState: ACTORS[actor].state });
      const page = await context.newPage();
      await page.goto('/dashboard');
      const root = home(page);
      await expect(root, 'the dashboard root did not render').toBeVisible();

      // The one `h1` inside `<main>`, and it is this reader's name.
      const mainHeading = page.locator('#main-content').getByRole('heading', { level: 1 });
      await expect(mainHeading, `main does not hold exactly one h1 for ${actor}`).toHaveCount(1);
      await expect(mainHeading, `the dashboard h1 does not name ${actor}`).toHaveText(ACTORS[actor].name);

      // The identity chips fetched, and the FRESH profile is what answered — `session` would
      // mean `IdentityChips` caught its own profile-read failure and degraded.
      await expect(root.locator('[data-dashboard-identity]')).toHaveCount(1);
      await expect(
        root.locator('[data-dashboard-identity]'),
        `the identity chips fell back to the session for ${actor} — the profile read threw`,
      ).toHaveAttribute('data-dashboard-identity', 'fresh');

      await settled(page);

      const approvalsGate = await root.getAttribute('data-dashboard-approvals');
      const expensesGate = await root.getAttribute('data-dashboard-expenses');
      expect(
        [approvalsGate, expensesGate],
        'the server did not publish its gating decision — selectDashboardCards is not being read',
      ).toEqual([expect.stringMatching(/^(true|false)$/), expect.stringMatching(/^(true|false)$/)]);

      await expect(
        root.getByRole('heading', { name: COPY.approvalsTitle, exact: true }),
        `data-dashboard-approvals=${approvalsGate} but the card says otherwise`,
      ).toHaveCount(approvalsGate === 'true' ? 1 : 0);
      await expect(
        root.getByRole('heading', { name: COPY.expensesTitle, exact: true }),
        `data-dashboard-expenses=${expensesGate} but the card says otherwise`,
      ).toHaveCount(expensesGate === 'true' ? 1 : 0);
      // VeloExpense: every seeded reader holds read-own on an installed expense module.
      expect(expensesGate).toBe('true');
      // VeloExpense: no travel until w6, so no travel card for anybody.
      await expect(root.getByRole('heading', { name: COPY.travelTitle, exact: true })).toHaveCount(0);

      // Containment, in both directions: no panel fell back to its placeholder, and the page
      // did not go down as a whole.
      await expect(root, 'a panel fell back to PanelBoundary').not.toContainText(COPY.panelFailed);
      await expect(page.locator('body'), 'the app error boundary fired').not.toContainText(COPY.errorBoundary);
      await context.close();
    });
  }

  test.describe('as the employee', () => {
    test.use({ storageState: EMPLOYEE_STATE });

    test('VeloExpense: / lands here — sign-in, bookmarks and old links', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(home(page)).toBeVisible();
    });

    test('every row the cards render links to a record, not to a listing', async ({ page }) => {
      // VeloExpense: a draft of its own, so the card has at least one row whatever ran first.
      const title = `E2E dashboard row ${Date.now()}`;
      await createDraftReport(page, title);
      await page.goto('/dashboard');
      const root = home(page);
      await settled(page);

      const links = await anchors(root);
      const reportRows = links.filter((l) => REPORT_LINK.test(l.href));
      const found = () => `\n  ${links.map((l) => `${l.href}  (${l.name})`).join('\n  ')}`;

      expect(reportRows.length, `the expenses card drew no record links. Anchors found:${found()}`).toBeGreaterThan(0);
      expect(reportRows.length).toBeLessThanOrEqual(PREVIEW_ROWS);
      expect(
        reportRows.some((l) => l.name.includes(title)),
        `the draft just made is not among the card's rows. Anchors found:${found()}`,
      ).toBe(true);

      const names = reportRows.map((l) => l.name);
      expect(names.filter((n) => n.length === 0), 'a row link rendered with no name at all').toEqual([]);
      expect(new Set(names).size, `two row links share a name: ${JSON.stringify(names)}`).toBe(names.length);
    });

    test('the expense-report deep link opens the report it names', async ({ page }) => {
      // VeloExpense: the report is this test's own draft, opened from the card's row.
      const title = `E2E dashboard deep link ${Date.now()}`;
      await createDraftReport(page, title);
      const reportPath = new URL(page.url()).pathname;
      await page.goto('/dashboard');
      await settled(page);
      await home(page).locator(`a[href="${reportPath}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${reportPath}$`));

      await expect(
        page.getByText(title).first(),
        'the report deep link did not open the report it names',
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('body'), 'the reader was told their own report no longer exists').not.toContainText(
        COPY.recordNotFound,
      );
      await expect(page.locator('body')).not.toContainText(COPY.errorBoundary);
    });
  });

  test.describe('as the admin', () => {
    test.use({ storageState: ADMIN_STATE });

    test('every approvals row links to the report in the inbox', async ({ page }) => {
      // VeloExpense: `e2e/crawl-fixture.ts` keeps pending tasks in this reader's queue, but
      // the admin may have decided them by now, so the rows are checked when there are any.
      await page.goto('/dashboard');
      const root = home(page);
      await settled(page);
      const rows = (await anchors(root)).filter((l) => APPROVAL_LINK.test(l.href));
      expect(rows.length).toBeLessThanOrEqual(PREVIEW_ROWS);
      for (const row of rows) expect(row.name.length, `${row.href} has no name`).toBeGreaterThan(0);
      if (rows.length === 0) return;

      await page.goto(rows[0].href);
      const drawer = page.getByRole('dialog');
      await expect(drawer, 'the deep link landed on the inbox instead of opening the report').toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(COPY.reportLoading)).toHaveCount(0, { timeout: 20_000 });
      await expect(drawer).not.toContainText(COPY.drawerFallback);
    });
  });

  test.describe('as the manager', () => {
    test.use({ storageState: MANAGER_STATE });

    test('a bad ?report= discloses neither the id nor the report', async ({ page }) => {
      // VeloExpense: ExpenseOS's second needle is a real report the reader may not read,
      // from its fixed seed; VeloExpense has none, so it is a well-formed id that is nobody's —
      // the same refusal from `expenseApprovals.report`, which must look like the line above.
      for (const [label, needle] of [
        ['malformed', MALFORMED],
        ['nobody’s', NOBODYS],
      ] as const) {
        await page.goto(`/expenses/approvals?report=${needle}`);

        await expect(
          page.getByRole('heading', { level: 1, name: COPY.approvalsPageTitle, includeHidden: true }),
          `the ${label} case did not render the approvals page`,
        ).toBeVisible({ timeout: 20_000 });

        const drawer = page.getByRole('dialog');
        await expect(drawer, `the ${label} case never opened its drawer`).toBeVisible({ timeout: 20_000 });
        await expect(drawer, `the ${label} drawer is titled something other than the fallback`).toContainText(
          COPY.drawerFallback,
        );
        await expect(page.getByText(COPY.reportLoading), `the ${label} report query never settled`).toHaveCount(0, {
          timeout: 20_000,
        });

        const shown = await page.locator('body').innerText();
        expect(shown, `the ${label} report id was reflected into the page`).not.toContain(needle);
        expect(shown).not.toContain(COPY.errorBoundary);
      }
    });
  });
});
