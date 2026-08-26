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

async function createReportWithLine(page: Page, title: string, amount: string) {
  await page.goto('/expenses/new');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);

  await page.getByLabel('Merchant').first().fill('Test Cafe');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('heading', { name: 'Test Cafe' })).toBeVisible();

  await page.locator('select[id^="categoryId-"]').selectOption({ label: 'Meals & Entertainment' });
  await page.locator('input[id^="description-"]').fill('Team lunch');
  await page.locator('input[id^="amount-"]').fill(amount);
  await page.getByRole('button', { name: 'Add line item' }).click();
}

async function uploadReceipt(page: Page) {
  await page.getByRole('button', { name: /^Receipts \(\d+\)$/ }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'receipt.png',
    mimeType: 'image/png',
    buffer: RECEIPT_PNG,
  });
  // The drawer lists it only after confirmUpload() has come back, which is the
  // proof the PUT reached storage and the server HEADed a real object.
  await expect(page.getByText('receipt.png')).toBeVisible();
  // exact: the drawer's scrim is a button labelled "Close receipts".
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

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
  await expect(page.getByTestId('report-total')).toHaveText('$75.00');

  // Starter rules: receipts are required above $25, at BLOCK severity.
  const blocking = page.locator('[data-testid="policy-violation"][data-severity="BLOCK"]');
  await expect(blocking).toHaveCount(1);
  await expect(blocking.first()).toContainText('no receipt attached');

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  // Not getByRole('alert') — Next renders a route announcer with that role too.
  await expect(page.getByTestId('error-banner')).toContainText(/blocking policy violation/i);
  await expect(page.getByTestId('report-status')).toHaveText('DRAFT');

  await uploadReceipt(page);

  // Attaching a receipt re-runs the engine, so the panel clears without any
  // other save (app/receipts/actions.ts).
  await expect(page.getByTestId('policy-clean')).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('report-status')).toHaveText('SUBMITTED');

  // Submitted reports are frozen — the editing affordances are gone.
  await expect(page.getByRole('button', { name: 'Add line item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add expense' })).toHaveCount(0);

  // …and the transition is on the record.
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByText('DRAFT → SUBMITTED')).toBeVisible();

  await page.getByRole('button', { name: 'Recall to draft' }).click();
  await expect(page.getByTestId('report-status')).toHaveText('DRAFT');
  await expect(page.getByText('SUBMITTED → DRAFT')).toBeVisible();
});

test('a warning is acknowledged with a justification and does not block', async ({ page }) => {
  // $600 clears the $500 per-transaction limit (WARNING); the receipt keeps the
  // BLOCK rule quiet so this test is only about the warning.
  await createReportWithLine(page, `E2E over-limit dinner ${RUN}`, '600.00');
  await uploadReceipt(page);

  const warning = page.locator('[data-testid="policy-violation"][data-severity="WARNING"]');
  await expect(warning).toHaveCount(1);
  await expect(warning.first()).toContainText('per-transaction limit');

  await warning.first().getByPlaceholder('Why is this exception acceptable?').fill('Client dinner, pre-approved by Finance');
  await warning.first().getByRole('button', { name: 'Acknowledge' }).click();

  await expect(page.getByRole('heading', { name: 'Acknowledged' })).toBeVisible();
  await expect(page.getByText('Client dinner, pre-approved by Finance')).toBeVisible();

  // A warning never blocked submission in the first place — Module 9 has it
  // propagate to the approver instead.
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('report-status')).toHaveText('SUBMITTED');
});

test('the report list shows what was just submitted', async ({ page }) => {
  await page.goto('/expenses');
  const row = page.getByRole('row', { name: new RegExp(`E2E over-limit dinner ${RUN}`) });
  await expect(row).toContainText('SUBMITTED');
  await expect(row).toContainText('$600.00');
  await expect(row).toContainText('EXP-');
});
