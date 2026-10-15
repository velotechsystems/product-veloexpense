import { type Browser, expect } from '@playwright/test';
import { stateFileFor } from './actors';
import { addExpense, createReport } from './workbench';

/**
 * VeloExpense: the rows ExpenseOS's phone specs read out of its QA seed
 * (`seed-data/qa-activity.json`), which VeloExpense does not have. Built through the workbench
 * instead, once per spec file, on a desktop-sized page of its own — the phone projects' own
 * page never leaves its phone metrics.
 *
 * Two reports, both the employee's (who reports to the manager in `scripts/seed.mjs`):
 *
 *   · `draftTitle` — a DRAFT with one hotel line (Lodging, receipted);
 *   · `queuedTitle` — SUBMITTED, with one taxi line, so the manager's `/expenses/approvals`
 *     queue and the dashboard's "Reports to approve" card have a row to render.
 *
 * The specs that call this stay READ-ONLY over the rows, as ExpenseOS's are over its seed.
 * First written inside `e2e/tap-targets.mobile.spec.ts` (phone e2e 2); moved here when the
 * route specs needed the same two rows.
 */
export async function seedEmployeeActivity(
  browser: Browser,
  titles: { draftTitle: string; queuedTitle: string },
): Promise<void> {
  const context = await browser.newContext({
    storageState: stateFileFor('employee'),
    viewport: { width: 1280, height: 900 },
  });
  const desk = await context.newPage();
  try {
    await createReport(desk, titles.draftTitle);
    await addExpense(desk, { vendor: 'Harbour Hotel', amount: '180.00', category: /Lodging/ });

    await createReport(desk, titles.queuedTitle);
    await addExpense(desk, {
      vendor: 'Harbour Taxi',
      amount: '20.00',
      category: /Ground Transportation/,
    });
    const submit = desk.getByRole('button', { name: 'Submit report' });
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await submit.click();
    await expect(desk.getByRole('banner').getByText('Submitted', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
}
