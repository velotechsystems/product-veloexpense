import { type Browser, expect, type Page } from '@playwright/test';
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
  await asEmployeeAtDesk(browser, async (desk) => {
    await createReport(desk, titles.draftTitle);
    await addExpense(desk, { vendor: 'Harbour Hotel', amount: '180.00', category: /Lodging/ });
    await submitTaxiReport(desk, titles.queuedTitle);
  });
}

/**
 * One SUBMITTED report of the employee's, waiting on whoever the workflow routes it to, and its
 * id. The subject a spec may DECIDE: `e2e/expenses-approvals.mobile.spec.ts` rejects it, where
 * ExpenseOS mints one with `mintDisposableApproval` (Prisma and the engine in-process, which
 * Playwright cannot load here — `e2e/support/test-db.ts` says why).
 */
export async function submitQueuedReport(browser: Browser, title: string): Promise<string> {
  let id = '';
  await asEmployeeAtDesk(browser, async (desk) => {
    id = await submitTaxiReport(desk, title);
  });
  return id;
}

/** The vendor on the queued report's one line, for a spec that wants to find it on screen. */
export const QUEUED_VENDOR = 'Harbour Taxi';

async function submitTaxiReport(desk: Page, title: string): Promise<string> {
  const id = await createReport(desk, title);
  await addExpense(desk, { vendor: QUEUED_VENDOR, amount: '20.00', category: /Ground Transportation/ });
  const submit = desk.getByRole('button', { name: 'Submit report' });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await expect(desk.getByRole('banner').getByText('Submitted', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return id;
}

async function asEmployeeAtDesk(browser: Browser, work: (desk: Page) => Promise<void>) {
  const context = await browser.newContext({
    storageState: stateFileFor('employee'),
    viewport: { width: 1280, height: 900 },
  });
  try {
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
