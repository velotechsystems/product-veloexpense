/**
 * VX4-5 part 3b — a budget, configured in a browser, warning on a real report
 * and putting an alert in a real bell.
 *
 * ── What only this file can prove ───────────────────────────────────────────
 *
 * The db tests drive `lib/budgets/*` directly and cover the arithmetic, the
 * claim and the gate. What they cannot reach is the wiring: server actions
 * posted from plain <form> elements on a screen that has none of its own client
 * JS, a threshold typed as a PERCENTAGE arriving as basis points, and the alert
 * landing in the recipient's notification list rather than merely in a table.
 *
 * ── §4's checklist, worked ──────────────────────────────────────────────────
 *
 * · SELECTORS come from `expense-flow` (the workbench, the policy panel) and
 *   `modules-flow` (the /admin screens). Nothing here was invented from reading
 *   a component once.
 * · FIXTURES checked against `scripts/seed.mjs`, not guessed: the demo category
 *   'Meals & Entertainment' maps to account **68200**, not 68100 — meals are
 *   split from travel because they are 50% deductible (0014's note). A budget on
 *   68100 would attribute nothing and every assertion below would pass vacuously
 *   on an empty rollup.
 * · AMOUNTS STAY UNDER $25. This file sorts BEFORE `expense-flow`, which is what
 *   installs the starter rules, so RECEIPT_REQUIRED may or may not exist when
 *   this runs — and $18 is under its threshold either way. A spec whose outcome
 *   depends on which files ran first is a spec that breaks when somebody adds one.
 * · THE TENANT IS NOT RESET between runs, so the budget is stamped per run and
 *   the `beforeAll` wipes budgets and any BUDGET_OVERAGE rule this file left
 *   behind. A leftover budget would make the "no budgets yet" state unreachable
 *   and the second run's totals somebody else's.
 * · The alert is asserted on the notifications TABLE by its text, because that
 *   page has no test ids and inventing one here would be a selector nothing else
 *   in the suite uses.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { drainNotifications } from './helpers';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { enumLabel, REPORT_STATUS_COPY } from '@/lib/i18n/catalog/enums';
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


const RUN = Date.now().toString(36);
const BUDGET = `E2E Meals budget ${RUN}`;
/** The account 'Meals & Entertainment' is mapped to — see the header. */
const ACCOUNT = '68200 — Meals and Entertainment (50% deductible)';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Superuser pool, as `ledger-flow` does: RLS-scoped connections cannot clear
  // another run's rows, and `withOrg` is not available to a spec.
  await admin.query(
    `DELETE FROM budget WHERE organization_id IN (SELECT id FROM organization WHERE slug = 'demo')`,
  );
  await admin.query(
    `DELETE FROM expense_policy
      WHERE kind = 'BUDGET_OVERAGE'
        AND organization_id IN (SELECT id FROM organization WHERE slug = 'demo')`,
  );
});

test.afterAll(async ({ request }) => {
  // THE RULE HAS TO GO, and this is the second half of §4's "anything a run
  // leaves behind is the next run's input". This file sorts before
  // `expense-flow`, whose `beforeAll` restores the starter set and then asserts
  // the table holds exactly four rules — a BUDGET_OVERAGE row left here makes it
  // five, and that spec fails somewhere unrelated to anything it is testing.
  // It happened on the first run of this file.
  await admin.query(
    `DELETE FROM expense_policy
      WHERE kind = 'BUDGET_OVERAGE'
        AND organization_id IN (SELECT id FROM organization WHERE slug = 'demo')`,
  );
  await admin.query(
    `DELETE FROM budget WHERE organization_id IN (SELECT id FROM organization WHERE slug = 'demo')`,
  );
  // Submitting enqueued mail — the approval task's, and the budget alert's. Left
  // undrained it is the next run's input, which is the hole that broke
  // `approval-flow` once already.
  await drainNotifications(request);
  await admin.end();
});

test('an admin configures a budget, and the screen says what it does not yet know', async ({
  page,
}) => {
  await page.goto('/admin/budgets');

  // The module is on for the demo tenant (scripts/seed.mjs), so neither
  // off-state banner is showing — asserted, because a screen stuck in an
  // off-state would make every later assertion here fail for the wrong reason.
  await expect(page.getByTestId('budgets-module-off')).toHaveCount(0);
  await expect(page.getByTestId('budgets-accounting-off')).toHaveCount(0);

  await page.getByLabel('Name').fill(BUDGET);
  await page.getByLabel('GL account').selectOption({ label: ACCOUNT });
  await page.getByLabel('Currency').selectOption('CAD');
  await page.getByLabel('Fiscal year').fill(String(new Date().getUTCFullYear()));
  // The owner is the ADMIN — who is also the person who will submit the report
  // below. That is deliberate: `includeActor` is the one place this product
  // notifies somebody about their own action, because a budget owner who files
  // the claim that breaks their own budget is exactly who needs telling.
  await page.getByLabel('Owner').selectOption({ label: 'Demo Admin' });
  await page.getByRole('button', { name: 'Add budget' }).click();

  const row = page.getByRole('row').filter({ hasText: BUDGET });
  await expect(row).toHaveCount(1);
  // No periods yet, and the screen says so rather than showing an empty table
  // that reads as "nothing spent".
  await expect(row).toContainText('No periods yet');
  await expect(row).toContainText('No thresholds');
});

test('periods carry their own dates, and an uncalculated one says so', async ({ page }) => {
  await page.goto('/admin/budgets');
  const row = page.getByRole('row').filter({ hasText: BUDGET });

  // One period covering THIS month, because the demo expenses this file creates
  // are dated today. A twelve-month seed starting in January would leave today's
  // spend in a period the report does not touch.
  const firstOfMonth = new Date();
  firstOfMonth.setUTCDate(1);
  await row.getByLabel(`First period start for ${BUDGET}`).fill(
    firstOfMonth.toISOString().slice(0, 10),
  );
  await row.getByLabel(`How many periods for ${BUDGET}`).fill('1');
  await row.getByLabel(`Amount per period for ${BUDGET}`).fill('20.00');
  await row.getByRole('button', { name: 'Add periods' }).click();

  const period = page.getByRole('row').filter({ hasText: BUDGET }).getByTestId('budget-period');
  await expect(period).toHaveCount(1);
  // `rolled_up_at IS NULL` is "never calculated", which 0024 is explicit is NOT
  // the same as zero spend. A confident "$0.00 spent" here is the exact lie that
  // column exists to prevent.
  await expect(period).toContainText('not yet calculated');
  await expect(period).toContainText('$20.00');
});

test('a threshold is typed as a percentage and stored as basis points', async ({ page }) => {
  await page.goto('/admin/budgets');
  const row = page.getByRole('row').filter({ hasText: BUDGET });

  await row.getByLabel(`Alert threshold percent for ${BUDGET}`).fill('90');
  await row.getByRole('button', { name: 'Alert at' }).click();

  const threshold = page.getByRole('row').filter({ hasText: BUDGET }).getByTestId('budget-threshold');
  await expect(threshold).toHaveCount(1);
  await expect(threshold).toContainText('90.00%');
  await expect(threshold).toContainText('Owner only');

  // The units trap, asserted where it is actually decided. Somebody typing 90 and
  // getting 90 basis points — 0.9%, alerting on the first dollar — is the failure
  // no CHECK constraint can catch, so the conversion has exactly one home and
  // this is the proof it is wired to the form.
  const stored = await admin.query(
    `SELECT t.threshold_bp FROM budget_alert_threshold t
       JOIN budget b ON b.id = t.budget_id WHERE b.name = $1`,
    [BUDGET],
  );
  expect(stored.rows.map((r) => Number(r.threshold_bp))).toEqual([9000]);
});

test('an over-budget report warns without blocking, and the alert reaches the owner', async ({
  page,
}) => {
  // The rule instance, added through the same picker an admin would use — which
  // is also what proves BUDGET_OVERAGE reached `RULE_KINDS` and the screen.
  await page.goto('/admin/expense-policies');
  await page.getByLabel('Rule').selectOption({ label: 'Over budget' });
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByRole('table')).toContainText('Over budget');

  // $18 of a $20 period is 90%: over the threshold, under the budget. Under $25
  // too, so the starter receipt rule cannot interfere whether or not it exists
  // yet (see the header).
  await page.goto('/expenses/new');
  await page.getByLabel('Title').fill(`E2E budget trip ${RUN}`);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);

  await page.getByLabel('Merchant').first().fill('Budget Cafe');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('heading', { name: 'Budget Cafe' })).toBeVisible();

  await page.locator('select[id^="categoryId-"]').selectOption({ label: 'Meals & Entertainment' });
  await page.locator('input[id^="description-"]').fill('Team lunch');
  await page.locator('input[id^="amount-"]').fill('18.00');
  await page.getByRole('button', { name: 'Add line item' }).click();

  // 90% is not over budget, so no finding yet — the rule answers "does this take
  // the period PAST its budget", and the 90% threshold is the ALERT's concern.
  await expect(page.getByTestId('report-total')).toHaveText('$18.00');

  // Now take it over: a second $18 line is $36 against a $20 budget.
  await page.locator('input[id^="description-"]').last().fill('Second lunch');
  await page.locator('input[id^="amount-"]').last().fill('18.00');
  await page.getByRole('button', { name: 'Add line item' }).click();

  const warning = page.locator('[data-testid="policy-violation"][data-severity="WARNING"]');
  await expect(warning.filter({ hasText: BUDGET })).toHaveCount(1);
  await expect(warning.filter({ hasText: BUDGET })).toContainText('over by');
  // A BUDGET NEVER BLOCKS, and this is the assertion that says so end to end.
  await expect(page.locator('[data-testid="policy-violation"][data-severity="BLOCK"]')).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('report-status')).toHaveText(status('SUBMITTED'));

  // The rollup moved on the transition, and the screen can now say a real number
  // instead of "not yet calculated".
  await page.goto('/admin/budgets');
  const period = page.getByRole('row').filter({ hasText: BUDGET }).getByTestId('budget-period');
  await expect(period).not.toContainText('not yet calculated');
  await expect(period).toContainText('awaiting a decision');

  // And the alert is in the owner's own bell — the owner being the person who
  // submitted it.
  await page.goto('/notifications');
  await expect(page.getByRole('table')).toContainText(BUDGET);
  await expect(page.getByRole('table')).toContainText('crossed 90%');
});
