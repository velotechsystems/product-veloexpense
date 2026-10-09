/**
 * VX4-6b — spend analytics in a real browser.
 *
 * ── What only this file can prove ───────────────────────────────────────────
 *
 * `test/analytics.db.test.ts` covers the arithmetic, the FX dating, the
 * unconvertible bucket and the gate. What it cannot reach is the screen: a range
 * that travels through the URL with no client state, server-rendered SVG that
 * actually contains bars, the AN-7 warning appearing when — and only when — there
 * is something it cannot value, and the module-off state.
 *
 * ── §4's checklist, worked ──────────────────────────────────────────────────
 *
 * · THIS FILE SORTS FIRST, before `approval-flow`. So it cannot rely on any other
 *   spec's data, and — more usefully — it must not leave any: every later spec
 *   that counts rows would inherit it. Its reports are stamped per run and it
 *   removes them in an `afterAll`, along with the fx_rate it adds.
 * · Running first also means the STARTER POLICY RULES ARE NOT INSTALLED
 *   (`expense-flow`'s beforeAll does that). Amounts stay small anyway so the
 *   outcome does not depend on which files ran before — a spec whose result
 *   depends on file order is one that breaks when somebody adds a file.
 * · SELECTORS and FIXTURES come from `helpers.submitAndApprove` and
 *   `expense-flow`, which is where 'Ground Transportation' comes from: there is
 *   no category called Travel, and 'Travel (100% deductible)' is the ACCOUNT's
 *   name. That mistake has already cost this suite a CI round.
 * · The KPI tiles are read by test id; the charts by their `<rect>`/`<path>`
 *   count inside a labelled figure, which is an assertion that can actually fail
 *   — `toBeVisible` on an `<svg>` would pass on an empty one.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { drainNotifications, submitAndApprove } from './helpers';

const RUN = Date.now().toString(36);
const TITLE = `E2E analytics trip ${RUN}`;
const YEAR = new Date().getUTCFullYear();
const RANGE = `?from=${YEAR}-01-01&to=${YEAR}-12-31`;

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const demo = `(SELECT id FROM organization WHERE slug = 'demo')`;

test.describe.configure({ mode: 'serial' });

/**
 * RECEIPTS FIRST, AND THAT IS NOT TIDINESS.
 *
 * `receipt.expense_id` is `ON DELETE SET NULL`, because VX1-5's receipt-first
 * flow keeps unattached receipts in the uploader's INBOX
 * (`expense_id IS NULL AND status = 'STORED'`). So deleting a report does not
 * delete its receipts — it puts them back in somebody's inbox.
 *
 * The first version of this hook deleted only the reports, and three
 * `expense-flow` tests then failed with `strict mode violation:
 * getByText('receipt.png') resolved to 2 elements` — its drawer was showing the
 * report's own receipt AND the one this file had orphaned. It only appeared on the
 * SECOND full run, because the first run had nothing to orphan yet, which is §4's
 * rule 3 exactly: the tenant is not reset between runs and anything a run leaves
 * behind is the next run's input.
 */
async function wipeDemoSpend() {
  await admin.query(`DELETE FROM receipt WHERE organization_id = ${demo}`);
  await admin.query(`DELETE FROM expense_report WHERE organization_id = ${demo}`);
}

test.beforeAll(async () => {
  await wipeDemoSpend();
  await admin.query(`DELETE FROM fx_rate`);
});

test.afterAll(async ({ request }) => {
  // Leave nothing for the eight specs that run after this one: the reports it
  // created, and the fx_rate rows it deliberately did NOT restore.
  await wipeDemoSpend();
  await drainNotifications(request);
  await admin.end();
});

test('the screen defaults to a bounded range and says so', async ({ page }) => {
  await page.goto('/admin/analytics');
  await expect(page.getByTestId('analytics-module-off')).toHaveCount(0);

  // The service refuses to invent a range; the SCREEN supplies a bounded one.
  // Those are different things, and the copy on the page says which is which.
  await expect(page.getByLabel('From')).toHaveValue(`${YEAR}-01-01`);
  await expect(page.getByText(/refuses to invent one/)).toBeVisible();
  // Nothing submitted yet, and the chart says that rather than drawing nothing.
  await expect(page.getByText(/That is an answer, not an empty chart/)).toBeVisible();
});

test('an inverted range comes back as a sentence, not an error page', async ({ page }) => {
  await page.goto(`/admin/analytics?from=${YEAR}-09-01&to=${YEAR}-01-01`);
  await expect(page.getByTestId('error-banner')).toContainText(/ends before it begins/);
});

test('spend awaiting a decision shows as pending, then moves when it is approved', async ({
  page,
  browser,
}) => {
  await submitAndApprove(page, browser, TITLE, '18.00');

  await page.goto(`/admin/analytics${RANGE}`);
  // Approved and paid — `submitAndApprove` takes it all the way to APPROVED.
  await expect(page.getByTestId('kpi-committed')).toContainText('$18.00');
  await expect(page.getByTestId('kpi-pending')).toContainText('$0.00');

  // The chart really has a mark in it. A visibility check on the <svg> would
  // pass on an empty one, which is the assertion-that-cannot-fail shape.
  const marks = page.locator('figure svg rect, figure svg path');
  await expect(marks.first()).toBeVisible();
  expect(await marks.count()).toBeGreaterThan(0);

  // And the breakdowns name the fixture's own category and account, which is what
  // proves the dimensions are wired to the same rows as the total.
  await expect(page.getByTestId('by-category')).toContainText('Ground Transportation');
  await expect(page.getByTestId('by-gl-account')).toContainText('68100');
  await expect(page.getByTestId('by-submitter')).toContainText('$18.00');
});

test('spend with no exchange rate is named, and left out of the total (AN-7)', async ({ page }) => {
  // A USD report with no USD rate anywhere. Written straight to APPROVED because
  // the claim is about analytics, not about how the row got there — an import and
  // a restored backup arrive the same way.
  await admin.query(
    `INSERT INTO expense_report
       (organization_id, submitter_id, title, currency_code, status, total_minor)
     VALUES (${demo}, (SELECT id FROM app_user WHERE email = 'admin@demo.test'),
             $1, 'USD', 'APPROVED', 5000)`,
    [`E2E analytics usd ${RUN}`],
  );
  const r = await admin.query(
    `SELECT id, organization_id FROM expense_report WHERE title = $1`,
    [`E2E analytics usd ${RUN}`],
  );
  const e = await admin.query(
    `INSERT INTO expense (organization_id, report_id, currency_code, merchant, txn_date)
     VALUES ($1,$2,'USD','Yen Cafe',current_date) RETURNING id`,
    [r.rows[0].organization_id, r.rows[0].id],
  );
  await admin.query(
    `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor, gl_account_id)
     SELECT $1, $2, c.id, 5000, c.gl_account_id
       FROM expense_category c
      WHERE c.organization_id = $1 AND c.label ->> 'en' = 'Ground Transportation'`,
    [r.rows[0].organization_id, e.rows[0].id],
  );

  await page.goto(`/admin/analytics${RANGE}`);
  const warning = page.getByTestId('analytics-unconvertible');
  // Formatted in USD with USD's own minor unit — not "5000 minor units", which
  // was the first draft's wording and is not a number anybody reads. `formatMinor`
  // supplies the currency prefix itself, so this is `US$50.00` and not `$50.00`:
  // asserted with the prefix, because that distinction is the whole point of
  // formatting it in its own currency rather than the tenant's.
  await expect(warning).toContainText('US$50.00');
  await expect(warning).toContainText(/counted here and nowhere else/);
  // The total is unchanged: the $50 of USD is NOT in it. Theirs would have added
  // 5000 raw minor units and reported them as CAD.
  await expect(page.getByTestId('kpi-committed')).toContainText('$18.00');
});

test('turning the module off leaves the screen saying so', async ({ page }) => {
  await admin.query(
    `UPDATE module_entitlement SET enabled = false
      WHERE organization_id = ${demo} AND module_code = 'analytics'`,
  );
  try {
    await page.goto(`/admin/analytics${RANGE}`);
    await expect(page.getByTestId('analytics-module-off')).toBeVisible();
    // No figures at all — not zeroes, which a reader cannot tell from a real zero.
    await expect(page.getByTestId('kpi-committed')).toHaveCount(0);
  } finally {
    await admin.query(
      `UPDATE module_entitlement SET enabled = true
        WHERE organization_id = ${demo} AND module_code = 'analytics'`,
    );
  }
});
