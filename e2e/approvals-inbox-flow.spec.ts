/**
 * w4-05/w4-07 (d71) — ExpenseOS's approvals inbox, ported in place of VeloExpense's /approvals,
 * in a real browser against the real server and engine.
 *
 * What only this proves is the WIRING:
 *   · the old addresses — /approvals, and the /approve an old email link lands on — reach the
 *     new inbox, which the top bar titles;
 *   · a row shows the approver the report's lines before the button: at a desktop width it
 *     opens the report page, the workbench in approver mode (eos-573, ExpenseOS #573); at a
 *     phone's width it opens the drawer, as it always has;
 *   · the group action approves several reports at once, each through the engine, each
 *     audited as part of a bulk action, and the queue empties of them.
 *
 * (Approving one report from its page is `approveAs` in helpers.ts, which every flow that
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

test('the report is shown before Approve — on its page, or in the drawer on a phone — and bulk approve decides several', async ({
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

    // eos-573: at this (desktop) width the row opens the report page, in approver mode — the
    // report's expense on it, and Approve in its top bar. Nothing is decided by opening it.
    await rowOf(titles[0]).click();
    await expect(approver).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
    await expect(approver.getByText('Beck Taxi').first()).toBeVisible();
    await expect(
      approver.getByRole('banner').getByRole('button', { name: 'Approve', exact: true }),
    ).toBeVisible();
    await approver.goto('/expenses/approvals');

    // On a phone the same report opens in the drawer, as it always has — the report's
    // expense in it, above the decision — and the address stays the queue's. Reached by the
    // queue's deep link, as an emailed link reaches it (ExpenseOS's dashboard.mobile.spec): a
    // phone draws the queue as cards, not table rows.
    const id = (
      await admin.query(`SELECT id FROM expense_report WHERE title = $1`, [titles[0]])
    ).rows[0].id as string;
    await approver.setViewportSize({ width: 390, height: 844 });
    await approver.goto(`/expenses/approvals?report=${id}`);
    const drawer = approver.getByRole('dialog');
    await expect(drawer).toContainText('Beck Taxi');
    // Not Approve: a deep link's drawer takes its task from the queue rows loaded when it
    // opens, and on a cold load there are none yet — ExpenseOS's own phone spec
    // (dashboard.mobile) asserts the drawer and its address, as this does.
    expect(new URL(approver.url()).pathname).toBe('/expenses/approvals');
    // The footer's Close (the header carries an ✕ of the same name).
    await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(drawer).toBeHidden();
    await approver.setViewportSize({ width: 1280, height: 720 });

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
