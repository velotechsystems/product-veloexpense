/**
 * VX1-9 — the Phase-1 happy path, in a real browser.
 *
 * This is the only test in the repo that exercises what VX1-5 through VX1-8
 * actually depend on and unit tests cannot reach:
 *   - server actions posted from plain <form> elements, including the rows
 *     wired up with the HTML `form="id"` attribute
 *   - a receipt uploaded by the BROWSER straight to object storage with a
 *     presigned URL — signature and CORS preflight included. Every vitest suite
 *     runs on MemoryStorage and stays green when this is broken.
 *   - the submit gate refusing on a BLOCK finding and letting the same report
 *     through once it is satisfied
 *
 * The session cookie is minted in auth.setup.ts (SSO cannot run in CI).
 * Storage is scripts/e2e-storage.mjs. Both are started by playwright.config.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { enumLabel, REPORT_STATUS_COPY } from '@/lib/i18n/catalog/enums';
import { addExpenseLine, createDraftReport, expectReportStatus } from './helpers';
/**
 * VX4-7 part 2a: a report's status is asserted through the CATALOGUE, not as the
 * enum's own spelling.
 *
 * These read `toHaveText('SUBMITTED')` until part 2a, which is what the screen
 * literally showed — the schema's word, shouted, on a page an employee reads.
 * Now the badge renders catalogued copy ("Submitted"), and pinning the new
 * STRING here would only move the problem: the assertion would break again the
 * next time somebody improves the wording, which is exactly the change nobody
 * should have to touch an e2e for.
 *
 * Asserting `enumLabel(REPORT_STATUS_COPY, 'SUBMITTED', DEFAULT_LOCALE)` says
 * the thing worth saying — THE SCREEN GOES THROUGH THE CATALOGUE — and it cannot
 * drift. That it does not also check the copy is non-empty is deliberate:
 * `test/i18n-enum-catalog.test.ts` refuses a blank default for any member, so
 * the pairing covers both halves and neither test repeats the other.
 */
const status = (member: string) => enumLabel(REPORT_STATUS_COPY, member, DEFAULT_LOCALE);


/**
 * Report titles are stamped with a per-run id. The e2e runs against the seeded
 * demo tenant, which is NOT reset between runs — a rerun on a laptop, or CI's
 * one retry, would otherwise leave several reports sharing a title and the list
 * assertions would match more than one row.
 */
const RUN = Date.now().toString(36);

/** A 1x1 PNG — small enough to inline, real enough to have a content type. */
const RECEIPT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A draft report with one $`amount` line, on ExpenseOS's workbench (w2-02b; helpers.ts
 * `addExpenseLine`). The workbench dates a new expense today, which `submitReport` requires
 * (VX4-11).
 */
async function createReportWithLine(page: Page, title: string, amount: string) {
  await createDraftReport(page, title);
  await addExpenseLine(page, { vendor: 'Test Cafe', category: 'Meals & Entertainment', amount });
}

/**
 * Attach a receipt to the open expense, straight from the browser to storage.
 *
 * w2-02b: as ExpenseOS's `expense-lifecycle.spec.ts` does it — the LAST file input is the
 * expense's own "Attach receipt"; the first is the report-level uploader, which creates a
 * NEW expense from the file instead. The receipt pane lists it only once `receiptCreate` has
 * read the object back, which is the proof the PUT reached storage.
 */
async function uploadReceipt(page: Page) {
  await page.locator('input[type="file"]').last().setInputFiles({
    name: 'receipt.png',
    mimeType: 'image/png',
    buffer: RECEIPT_PNG,
  });
  await expect(page.getByText('receipt.png').first()).toBeVisible();
}

/** The workbench's Submit, whose disabled state is the submit gate on the screen. */
const submitButton = (page: Page) => page.getByRole('button', { name: 'Submit report' });

test.beforeAll(async ({ browser }) => {
  // Rule instances are per tenant and seeded by nobody — scripts/seed.mjs
  // deliberately creates none. Restoring them here also covers the admin page.
  const page = await browser.newPage();
  await page.goto('/admin/expense-policies');
  await page.getByRole('button', { name: 'Restore starter rules' }).click();
  // Assert on the table, not on the label text: every rule name also appears as
  // an <option> in the "Add a rule" picker below, so a bare text match is
  // ambiguous. Header row + the four starter rules.
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
  await expect(page.getByText(/^4 rules/)).toBeVisible();
  await page.close();
});

test('a blocking violation stops the submit until the receipt is attached', async ({ page }) => {
  await createReportWithLine(page, `E2E blocked trip ${RUN}`, '75.00');

  // The total is recomputed server-side inside the same transaction as the write.
  await expect(page.getByRole('banner')).toContainText('$75.00');

  // Starter rules: receipts are required above $25, at BLOCK severity. w2-02b: on the
  // workbench the gate is the Submit button itself — disabled, with the reason as its title
  // — rather than a refusal after the press.
  await expect(page.getByRole('main').getByText('Policy warnings')).toBeVisible();
  await expect(submitButton(page)).toBeDisabled();
  await expect(submitButton(page)).toHaveAttribute('title', /must be resolved/);
  await expectReportStatus(page, 'DRAFT');

  await uploadReceipt(page);

  // Attaching a receipt re-runs the engine, so the finding clears without any other save.
  await expect(page.getByRole('main').getByText('Policy warnings')).toHaveCount(0);

  await submitButton(page).click();
  await expectReportStatus(page, 'SUBMITTED');

  // Submitted reports are frozen — the editing affordances are gone.
  await expect(page.getByRole('button', { name: 'Add line', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add expense' })).toHaveCount(0);

  // …and the transition is on the record: w2-02b, the report's discussion carries it.
  await expect(page.getByText('submitted this')).toBeVisible();

  await page.getByRole('banner').getByRole('button', { name: 'Recall' }).click();
  await expectReportStatus(page, 'DRAFT');
  await expect(page.getByText('recalled this')).toBeVisible();
});

test('a warning is justified with an explanation and does not block', async ({ page }) => {
  // $600 clears the $500 per-transaction limit (WARNING); the receipt keeps the
  // BLOCK rule quiet so this test is only about the warning.
  await createReportWithLine(page, `E2E over-limit dinner ${RUN}`, '600.00');
  await uploadReceipt(page);

  await expect(page.getByRole('main').getByText('Policy warnings')).toBeVisible();
  // w2-11 (d34): a warning needs a reason before the report goes, and on the workbench the
  // reason is the expense's own "Explain this charge" (ExpenseOS's rule).
  await expect(submitButton(page)).toBeDisabled();
  await expect(submitButton(page)).toHaveAttribute('title', /needs an explanation/);

  const explanation = page.getByLabel(/Explain this charge/);
  await explanation.fill('Client dinner, pre-approved by Finance');
  await explanation.blur();

  // A justified warning goes to the approver rather than blocking — Module 9.
  await expect(submitButton(page)).toBeEnabled();
  await submitButton(page).click();
  await expectReportStatus(page, 'SUBMITTED');
});

test('the report list shows what was just submitted', async ({ page }) => {
  await page.goto('/expenses');
  const row = page.getByRole('row', { name: new RegExp(`E2E over-limit dinner ${RUN}`) });
  await expect(row).toContainText(status('SUBMITTED'));
  // w2-05: the ported list prints the total with its ISO code, not the `$` symbol (ExpenseOS's
  // F54), so the amount is matched without the symbol.
  await expect(row).toContainText('600.00');
  await expect(row).toContainText('EXP-');
});
