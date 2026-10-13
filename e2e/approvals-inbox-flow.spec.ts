/**
 * w4-05/w4-07 (d71) — ExpenseOS's approvals inbox, ported in place of VeloExpense's /approvals,
 * in a real browser against the real server and engine.
 *
 * What only this proves is the WIRING:
 *   · the old addresses — /approvals, and the /approve an old email link lands on — reach the
 *     new inbox, which the top bar titles;
 *   · a row opens the approver's drawer with the report's lines in it, so an approver sees
 *     what they are approving before the button (the concern VeloExpense's own inbox answered
 *     by sending them to the report);
 *   · the group action approves several reports at once, each through the engine, each
 *     audited as part of a bulk action, and the queue empties of them.
 *
 * (Approving one report from the drawer is `approveAs` in helpers.ts, which every flow that
 * submits and approves goes through.)
 *
 * Amounts stay under the $25 receipt threshold, so the flow is about approvals, not policy.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { addExpenseLine, APPROVER_STATE, createDraftReport, submitOpenReport } from './helpers';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

const stamp = Date.now();
const titles = [`Inbox bulk A ${stamp}`, `Inbox bulk B ${stamp}`];

test.describe.configure({ mode: 'serial' });

test('the old addresses reach the inbox, which the top bar titles', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: APPROVER_STATE });
  const page = await ctx.newPage();
  try {
    await page.goto('/approvals');
    await expect(page).toHaveURL(/\/expenses\/approvals$/);
    await expect(page.getByRole('heading', { name: /approvals/i, level: 1 })).toBeVisible();
    await page.goto('/approve');
    await expect(page).toHaveURL(/\/expenses\/approvals$/);
  } finally {
    await ctx.close();
  }
});

test('the drawer shows the report before Approve, and bulk approve decides several', async ({
  page,
  browser,
}) => {
  for (const title of titles) {
    await createDraftReport(page, title);
    await addExpenseLine(page, { vendor: 'Beck Taxi', category: 'Ground Transportation', amount: '12.50' });
    await submitOpenReport(page);
  }

  const ctx = await browser.newContext({ storageState: APPROVER_STATE });
  const approver = await ctx.newPage();
  try {
    await approver.goto('/expenses/approvals');
    const rowOf = (title: string) => approver.getByRole('row', { name: new RegExp(title) });

    // The drawer: the report's expense is in it, above the decision.
    await rowOf(titles[0]).click();
    const drawer = approver.getByRole('dialog');
    await expect(drawer).toContainText('Beck Taxi');
    await expect(drawer.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    // The footer's Close (the header carries an ✕ of the same name).
    await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(drawer).toBeHidden();

    // The group action.
    for (const title of titles) {
      await rowOf(title).getByRole('checkbox', { name: 'Select row' }).check();
    }
    // The group actions sit behind the selection count, as in ExpenseOS's own test.
    await approver.getByRole('button', { name: '2 selected' }).click();
    await approver.getByText('Approve 2 reports').click();
    await expect(approver.getByText('Approved 2 reports.')).toBeVisible();
    for (const title of titles) await expect(rowOf(title)).toHaveCount(0);
  } finally {
    await ctx.close();
  }

  const rows = await admin.query(
    `SELECT r.status, a.details->>'bulk' AS bulk
       FROM expense_report r
       JOIN audit_entry a ON a.entity_id = r.id AND a.action = 'REPORT_APPROVED'
      WHERE r.title = ANY($1::text[])`,
    [titles],
  );
  expect(rows.rows).toEqual([
    { status: 'APPROVED', bulk: 'true' },
    { status: 'APPROVED', bulk: 'true' },
  ]);
});
