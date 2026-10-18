import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/actors';
import { clearFilters } from './support/rows';
import { createReport } from './support/workbench';

/**
 * The two things an admin could not do from a person's record.
 *
 * **The access flag.** `hasExpenseOSAccess` decides whether somebody may sign in at all —
 * the NextAuth `signIn` callback refuses on it — and it shipped with no surface anywhere in
 * the product. Production then spent a release with every real person locked out while nine
 * QA accounts held access, and the only way to learn that was to query the database. So
 * this spec insists on operating it the way an admin would: read it in the row, filter on
 * it, flip it in the drawer.
 *
 * **The activity section.** Both halves of it said "coming soon" for months after expense
 * reports and delegations had shipped, so an admin looking into an account was told to wait
 * for something that already existed, then had to go searching two other screens for the
 * same person.
 *
 * The money and the direction of the delegation are both asserted, because those are the
 * two things a plausible-looking wrong answer gets wrong: somebody else's total, or
 * "delegates to" where it should read "acts for".
 *
 * Ported from ExpenseOS (1e682dd6), People 4. VeloExpense, marked below: no locale in a URL;
 * the access flag is `has_access` (0072), refused at sign-in AND on every request; the demo
 * tenant's people (`scripts/seed.mjs`) stand in for ExpenseOS's QA accounts; and the
 * delegation is arranged on VeloExpense's own cover screen (`/approvals/delegations`), whose
 * form and "End it" button differ from ExpenseOS's dialog and row menu.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 180_000 });

/**
 * Open one person's drawer.
 *
 * The listing holds 873 people, pages at 50, and sorts by name — so no QA account is ever
 * on the first page and there is no free-text search on this screen. Narrowing by the
 * Access facet is what makes them reachable, which is convenient: it drives the new filter
 * on the way to the drawer that the rest of the test is about.
 *
 * VeloExpense: the demo tenant holds a handful of people, so everybody is on the first page;
 * the filter is kept because driving it is half of what this spec is for.
 */
async function openPerson(page: Page, name: string, email: string) {
  await page.goto('/users');
  await expect.poll(() => page.locator('tbody tr').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  await clearFilters(page);

  /**
   * Through the pill bar, which is the only surface that can express this: the facet rail
   * deliberately does not carry `access` (its cards all show counts, and a boolean column
   * cannot supply them yet — see `FACET_FIELDS`).
   */
  await page.getByRole('button', { name: 'Add filter' }).click();
  const combos = page.getByRole('combobox');
  await combos.nth(0).selectOption('access');
  await combos.nth(1).selectOption('equals');
  await page.getByRole('combobox').nth(2).selectOption('granted');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The filter has to BITE, not just render as a pill — it did exactly that once.
  await expect.poll(() => page.locator('tbody tr').count(), { timeout: 30_000 }).toBeLessThan(50);

  /**
   * VeloExpense: the row is found by the person's ADDRESS, then opened by their name. In the
   * demo tenant a name is also somebody else's Manager cell — `Demo Manager` sits in Demo
   * Employee's row — so a row found by name can be the wrong person's, and the first run
   * opened Demo Employee and read "No delegations".
   */
  // By the Email cell's own link, exactly: `admin@demo.test` is also the tail of
  // `expense-admin@demo.test`, so a substring match on the row would not do.
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: email, exact: true }) })
    .first();
  await expect(row, `${name} should be reachable by filtering on Access`).toBeVisible({
    timeout: 30_000,
  });
  /**
   * The NAME, not the row. A row-wide click lands wherever the row's centre happens to
   * be — which on this table is the Email column, and that cell holds a `mailto` link
   * that swallows the click. The row highlights, nothing opens, and the failure reads as
   * "the drawer does not exist".
   */
  // `.first()`: the name column comes before Manager, so it is this person's own name.
  await row.getByText(name, { exact: true }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  return drawer;
}

test.describe('the access flag', () => {
  test('reads in the row, and can be hidden from table settings', async ({ page }) => {
    await signIn(page, 'admin');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/users');
    await expect
      .poll(() => page.locator('tbody tr').count(), { timeout: 30_000 })
      .toBeGreaterThan(1);

    const header = page.getByRole('columnheader', { name: 'Access' });
    await expect(header, 'the column that told nobody anything is on the listing').toBeVisible();

    /**
     * Words, not `true`/`false`. The column exists so somebody can tell at a glance who
     * can get in; a raw boolean makes the reader work out which way round it is.
     */
    const cells = page.locator('tbody tr td').filter({ hasText: /^(Can sign in|No access)$/ });
    await expect.poll(() => cells.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // And it is a column like any other — offered in settings, so it can be put away.
    await page.getByRole('button', { name: 'Table settings' }).click();
    const toggle = page.locator('label', { hasText: 'Access' }).getByRole('checkbox');
    await expect(toggle, 'Access should appear in table settings').toBeVisible({
      timeout: 15_000,
    });
    await toggle.uncheck();
    await page.keyboard.press('Escape');
    await expect(header).toHaveCount(0);
  });

  test('can be revoked and granted again from the drawer', async ({ page }) => {
    await signIn(page, 'admin');
    await page.setViewportSize({ width: 1600, height: 900 });
    // Somebody expendable: a seeded demo account, never a real person's sign-in.
    // VeloExpense: `Demo Employee` stands in for ExpenseOS's `QA Employee`.
    const drawer = await openPerson(page, 'Demo Employee', 'employee@demo.test');

    await expect(drawer.getByText('Can sign in', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await drawer.getByRole('button', { name: 'Revoke' }).click();
    await expect(
      drawer.getByText('No access', { exact: true }),
      'revoking should show without a reload',
    ).toBeVisible({ timeout: 20_000 });

    // Put it back — the rest of the suite signs in as this account, and with access off
    // every one of its requests is refused (VeloExpense checks on every request).
    await drawer.getByRole('button', { name: 'Grant' }).click();
    await expect(drawer.getByText('Can sign in', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('the activity section', () => {
  test("lists the person's real expense reports, not a promise of them", async ({ page }) => {
    await signIn(page, 'admin');
    await page.setViewportSize({ width: 1600, height: 900 });
    /**
     * VeloExpense: no seed files a report, so ExpenseOS's "a seeded report is there" is
     * arranged — one draft, through the workbench, as `support/seed-activity.ts` builds the
     * phone specs' rows. On a fresh database this file found "No expense reports." otherwise.
     */
    // Not "…activity…": the title is listed in the drawer, and ExpenseOS's `getByText('Activity')`
    // below then matched the report's link as well as the heading — a strict-mode failure
    // whenever the list loaded first (found on a full run, 17 Oct).
    await createReport(page, `People drawer ${Date.now()}`);
    const drawer = await openPerson(page, 'Demo Admin', 'admin@demo.test');

    await expect(drawer.getByText('Activity')).toBeVisible({ timeout: 20_000 });
    // The defect itself.
    await expect(drawer.getByText(/coming soon/i)).toHaveCount(0);

    /**
     * ANY report, not a named one.
     *
     * This asserted on a specific seeded title and passed for exactly as long as the
     * database stayed fresh. `users.activity` returns the ten most RECENT, and the rest of
     * this suite files reports as `qa.employee` — a full run leaves dozens of newer drafts,
     * which push the seeded report out of the ten and fail a test about a feature that is
     * working perfectly. Caught by running the whole suite in one go, where the shared
     * database is what every earlier spec left behind.
     *
     * What is worth pinning survives the change: that real reports are listed at all, that
     * each carries its currency, and that the row goes where it says.
     */
    const link = drawer
      .locator('a')
      .filter({ hasText: /(CAD|USD)/ })
      .first();
    await expect(link, "the person's reports should be listed").toBeVisible({ timeout: 20_000 });

    /**
     * With the CODE, not just the glyph. This list can hold more than one currency and CAD
     * and USD both print `$`, so a bare `$884.50` does not say which it is — the same
     * ambiguity that once had two currencies silently added together on the reports list.
     */
    await expect(link).toContainText(/(CAD|USD)/);

    /**
     * And it goes where it says it goes.
     *
     * The URL is the assertion. Re-matching the report's TITLE on the page it opens looks
     * stronger and is not: the row renders the title and its date together, so the text
     * pulled off the link never matches the heading, and the check fails on a navigation
     * that worked perfectly. Landing on `/expenses/<uuid>` from a row in this list is the
     * behaviour worth pinning.
     */
    await link.click();
    await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}/, { timeout: 30_000 });
  });

  test('names a delegation and says which way it runs', async ({ page }) => {
    /**
     * Nothing seeds a delegation, so it is created through the delegations screen by the
     * person themselves and then read back from the admin's view of their record. Two
     * readers, one row: the direction has to be right from whichever side you look at it.
     *
     * VeloExpense: `manager` (Demo Manager) arranges cover on VeloExpense's own screen —
     * a plain form, "Who stands in" and "Arrange cover" — where ExpenseOS's `cardAdmin` uses
     * a dialog with a directory search. `Demo Executive` stands in.
     */
    await signIn(page, 'manager');
    await page.goto('/approvals/delegations');
    await page.getByLabel('Who stands in').selectOption({ label: 'Demo Executive' });
    // `First day` defaults to today in the reader's zone; `Last day` blank is open-ended.
    await page.getByRole('button', { name: 'Arrange cover' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Demo Executive' }).first()).toBeVisible({
      timeout: 20_000,
    });

    // ── Now read it from the admin's side ────────────────────────
    await page.context().clearCookies();
    await signIn(page, 'admin');
    await page.setViewportSize({ width: 1600, height: 900 });
    const drawer = await openPerson(page, 'Demo Manager', 'manager@demo.test');

    // VeloExpense: exact, because an empty list says "No delegations." and a substring
    // match on the heading is then two elements.
    await expect(drawer.getByText('Delegations', { exact: true })).toBeVisible({ timeout: 20_000 });

    /**
     * `manager` is the DELEGATOR, so from their record it runs outward. A bare
     * counterparty name would leave the reader unable to tell that from the reverse.
     */
    const outgoing = drawer.getByText('Delegates to').first();
    await expect(outgoing).toBeVisible({ timeout: 20_000 });
    await expect(outgoing.locator('..')).toContainText('Demo Executive');
    await expect(drawer.getByText('Acts for')).toHaveCount(0);

    /**
     * ── Put it back ──────────────────────────────────────────────
     *
     * A delegation is not inert state: `scope: ALL` routes this person's approvals to
     * somebody else for as long as it is active, so leaving one behind changes what every
     * later spec in a shared database sees.
     *
     * Ended through the screen rather than deleted, because that is the operation the
     * product offers — and it leaves the history. Every live one is ended, not just this
     * run's, so a database an earlier failed run left behind is repaired too.
     * VeloExpense: the button is "End it", a plain form post per row.
     */
    await page.context().clearCookies();
    await signIn(page, 'manager');
    await page.goto('/approvals/delegations');
    const endIt = page.getByRole('button', { name: 'End it' });
    for (let left = await endIt.count(); left > 0; left -= 1) {
      await endIt.first().click();
      await expect.poll(() => endIt.count(), { timeout: 20_000 }).toBe(left - 1);
    }
    await expect(
      endIt,
      "no delegation may stay live — `scope: ALL` reroutes this person's approvals for every later spec",
    ).toHaveCount(0);
  });
});
