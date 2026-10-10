/**
 * VX4-8 part 4 — the compliance screen, in a running system.
 *
 * ── WHAT THIS PROVES THAT NO VITEST CAN ────────────────────────────────────
 *
 * Four PRs have shipped four detectors, six controls, four tables and two
 * runners, and until this file NOTHING RAN ANY OF IT. The gap between "the
 * functions are tested" and "a person can reach them" is exactly what this spec
 * closes, so it deliberately drives the whole path through the UI: press the
 * button, read the queue, decide a flag, and see the decision stick.
 *
 * It also covers the two things a db test cannot:
 *   · the SCHEDULED routes actually answer, and refuse without the worker secret;
 *   · a dismissal with no reason is refused BY THE SCREEN, with the sentence the
 *     catalogue holds rather than an exception's own text.
 */
import { test, expect } from '@playwright/test';
import {
  ADMIN_STATE,
  WORKER_SECRET,
  addExpenseLine,
  createDraftReport,
  drainNotifications,
  openFirstReport,
  submitAndApprove,
} from './helpers';

const RUN = Date.now().toString(36);
/**
 * The merchant is STAMPED PER RUN, and it has to be.
 *
 * A flag's sentence is made of the merchant, the amount and the date — not the
 * report title — so two runs of this file produce two indistinguishable rows and
 * a row lookup hits a strict-mode violation on the second. The demo tenant is not
 * reset between runs and CI retries once, which is the same reason
 * `expense-flow` and `ledger-flow` stamp their titles.
 */
const MERCHANT = `Beck Taxi ${RUN}`;

test.use({ storageState: ADMIN_STATE });

test.describe('compliance', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ request }) => {
    await drainNotifications(request);
  });

  test('the module is on, and the screen says what it is for', async ({ page }) => {
    await page.goto('/admin/compliance');
    // The module's first design constraint, on the screen where a person meets it.
    await expect(page.getByText(/Nothing here is an accusation/i)).toBeVisible();
    // Reachable from the Modules hub — a surface nothing points at is a surface
    // nobody finds (UD-4's neighbour).
    await page.goto('/admin/modules');
    await expect(page.getByRole('link', { name: 'Compliance' })).toBeVisible();
  });

  test('a duplicate charge is found, appears in the queue, and can be decided', async ({
    page,
    browser,
  }) => {
    // Two identical entries on one report, under $25 so the starter receipt rule
    // does not block the submit (budget-flow.spec.ts's header states that rule).
    const title = `E2E duplicate ${RUN}`;
    await createDraftReport(page, title);
    for (let i = 0; i < 2; i += 1) {
      // w2-02b: two expenses on ExpenseOS's workbench (helpers.ts `addExpenseLine`). Each
      // "Add expense" opens a NEW expense in the editor, so the second pass fills the second
      // entry and not the first — the trap the old form's `#new-merchant` was avoiding.
      //
      // THE DATE IS REQUIRED FOR THIS RULE: `detectDuplicates` and `detectAmountOutliers`
      // both bound on `expense.txn_date`, and an entry with none is invisible to them
      // (VX4-11). The workbench dates a new expense today, so both entries carry one.
      await addExpenseLine(page, {
        vendor: MERCHANT,
        category: 'Ground Transportation',
        amount: '18.25',
      });
      // WAIT ON THE REPORT TOTAL, which is the one number that means what this rule needs:
      // the line, the expense and the report all show '$18.25' after one line, so a count of
      // that string says nothing; the total is unambiguous and it is what the rule compares.
      await expect(page.getByRole('banner')).toContainText(`$${(18.25 * (i + 1)).toFixed(2)}`);
    }

    await page.goto('/admin/compliance');
    await page.getByRole('button', { name: 'Look for problems now' }).click();

    // THE SENTENCE, rendered from a code and its numbers — not a stored string,
    // and with no record id in it.
    const row = page.getByRole('row', { name: new RegExp(MERCHANT) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('$18.25');
    await expect(row).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}/);
    await expect(row.getByTestId('status-badge')).toHaveText('open');

    // A dismissal with no reason is REFUSED, by the screen, in catalogue copy.
    await row.getByRole('button', { name: 'Set aside' }).click();
    await expect(page.getByTestId('error-banner')).toContainText(/Say why you are setting this aside/i);

    // With a reason it sticks, and the decision is not reversible.
    const again = page.getByRole('row', { name: new RegExp(MERCHANT) });
    await again.getByLabel('Why').fill('One fare, entered twice. Removed the copy.');
    await again.getByRole('button', { name: 'Set aside' }).click();
    const decided = page.getByRole('row', { name: new RegExp(MERCHANT) });
    await expect(decided.getByTestId('status-badge')).toHaveText('set aside');
    await expect(decided).toContainText('One fare, entered twice');
    await expect(decided).toContainText(/not reversible/i);
    await expect(decided.getByRole('button', { name: 'Set aside' })).toHaveCount(0);

    // AND THE SCAN DOES NOT UNDO IT. This is part 2's ON CONFLICT … WHERE
    // status = 'ACTIVE', proven end to end rather than in one statement.
    await page.getByRole('button', { name: 'Look for problems now' }).click();
    const after = page.getByRole('row', { name: new RegExp(MERCHANT) });
    await expect(after.getByTestId('status-badge')).toHaveText('set aside');
    await expect(after).toContainText('One fare, entered twice');
  });

  test('a person can raise a flag the rules cannot see', async ({ page }) => {
    // A REAL REPORT ID, taken from the product rather than invented: a manual
    // flag has to name a subject (`fraud_flag_subject_chk`), and the raise form
    // says so. Read off /expenses, which is where a person would get it too.
    // w2-05: the ported list opens a report by its row, so the id is read off the report
    // the row opens rather than off a link.
    const reportId = (await openFirstReport(page)) ?? '';
    expect(reportId, 'no report to hang a manual flag on').toMatch(/^[0-9a-f-]{36}$/);

    await page.goto('/admin/compliance');
    const note = `Tip from the Vancouver office ${RUN}`;
    // A `<summary>`, not a button — `getByRole('button')` does not match one, and
    // the first version of this line timed out waiting for an element that was
    // never going to have that role. The fields inside a closed `<details>` are
    // not visible, so it does have to be opened rather than skipped.
    await page.locator('summary').filter({ hasText: 'Raise one yourself' }).click();
    await page.getByLabel('What is the concern?').fill(note);
    await page.getByLabel('Which report?').fill(reportId);
    await page.getByRole('button', { name: 'Raise it' }).click();
    /**
     * Matched on the WHOLE NOTE, which took two attempts to get right and both
     * failures were the same lesson from opposite ends.
     *
     * `/RUN/` alone matches the stamped merchant too, so it found the duplicate
     * row from the previous test. `/Vancouver office/` alone matches THIS run's
     * flag and every earlier run's, because the demo tenant is not reset — a
     * strict-mode violation on the second run of the file. The note carries both
     * the words and the stamp, so it is the only thing here that is unique.
     */
    const row = page.getByRole('row', { name: new RegExp(note) });
    // The person's own words, passed through by the catalogue unchanged.
    await expect(row).toContainText(note);
    await expect(row.getByTestId('status-badge')).toHaveText('open');
  });

  test('a flag with no subject is refused, and says what to do', async ({ page }) => {
    await page.goto('/admin/compliance');
    await page.locator('summary').filter({ hasText: 'Raise one yourself' }).click();
    await page.getByLabel('What is the concern?').fill('a concern about nothing in particular');
    // The field is `required`, so the browser would normally stop this — removing
    // the attribute is what tests the SERVER's refusal rather than the form's.
    await page.locator('input[name="reportId"]').evaluate((el) => el.removeAttribute('required'));
    await page.getByRole('button', { name: 'Raise it' }).click();
    await expect(page.getByTestId('error-banner')).toContainText(/Say which report this is about/i);
  });

  test('an evaluation runs, and a completed run with nothing wrong is still a row', async ({
    page,
  }) => {
    await page.goto('/admin/compliance');
    await page.getByRole('button', { name: 'Evaluate the controls now' }).click();
    // 0032's whole point: "no findings" and "never ran" must not look alike.
    const run = page.getByRole('row', { name: /completed/ }).first();
    await expect(run).toBeVisible();
    await expect(run.getByTestId('status-badge')).toHaveText('completed');
  });

  test('a threshold is this tenant\'s own, and it changes what is found', async ({ page }) => {
    /**
     * RE-READ FROM THE SERVER BETWEEN STEPS, and the reason is a trap worth
     * naming because it made this test pass a check that proved nothing.
     *
     * The first version typed 45, clicked Save, and asserted the field held 45.
     * That assertion succeeds INSTANTLY against the pre-navigation DOM — the
     * value it waits for is the value it just typed — so it says nothing about
     * whether the save happened. The next `fill('')` then landed on that same
     * doomed DOM, the redirect replaced it, and Save submitted 45 again. The
     * stored config still said 45 and the test failed two lines later pointing at
     * the wrong thing.
     *
     * `goto` is what makes the assertion mean something: the value rendered is
     * the value the database holds.
     */
    const field = () => page.getByLabel('Duplicate window (days)');

    /**
     * AND WAIT FOR THE POST, which the first version did not.
     *
     * `click()` returns as soon as the click is dispatched, not when the server
     * action finishes — so the `goto` on the next line could start while the
     * action's POST was still in flight, and the redirect that followed would
     * replace the page `goto` had just loaded. Green almost always; red on a
     * loaded machine, which is how it failed once in a full-suite run and then
     * passed on its own twice.
     *
     * A server action POSTs to the page's own URL, so waiting for that response
     * is waiting for the save to have actually happened. Same family as the trap
     * this test's header already describes — an assertion that outruns the thing
     * it is asserting about.
     */
    const save = async () => {
      await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().includes('/admin/compliance'),
        ),
        page.getByRole('button', { name: 'Save thresholds' }).click(),
      ]);
    };

    await page.goto('/admin/compliance');
    await field().fill('45');
    await save();
    await page.goto('/admin/compliance');
    await expect(field()).toHaveValue('45');

    // Blank means "the shipped default", not zero — and the field then shows the
    // default rather than an empty box, which is how a person can tell which they
    // are looking at.
    await field().fill('');
    await save();
    await page.goto('/admin/compliance');
    await expect(field()).toHaveValue('3');
  });

  test('the scheduled routes answer, and refuse without the worker secret', async ({ request }) => {
    for (const path of [
      '/api/internal/compliance/scan',
      '/api/internal/compliance/evaluate',
    ] as const) {
      // 404, not 401 — an endpoint that says "wrong password" confirms it exists.
      const unauthorized = await request.post(path);
      expect(unauthorized.status(), `${path} without a secret`).toBe(404);

      const ok = await request.post(path, {
        headers: { authorization: `Bearer ${WORKER_SECRET}` },
      });
      expect(ok.status(), `${path} with the secret`).toBe(200);
      const body = await ok.json();
      // The sweep reports how many tenants it touched — the demo tenant at least,
      // because the seed enables every available module.
      expect(body.organizations).toBeGreaterThanOrEqual(1);
      expect(body.failed).toEqual([]);
    }
  });
});
