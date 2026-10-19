import { type Browser, expect, type Page } from '@playwright/test';
import { stateFileFor } from './actors';
import { addExpense, createReport } from './workbench';
import { testDb } from './test-db';

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

/**
 * VeloExpense (w6-02): a DRAFT travel request of `actor`'s, and its id — the trips
 * ExpenseOS's QA seed gives `qa.employee` (`qa-activity.json`), one at a time and only where
 * a spec reads them. Written with SQL, as `e2e/travel.mobile.spec.ts` writes its own: the
 * generated Prisma client cannot load in the Playwright process (`test-db.ts`). A DRAFT is
 * the traveller's alone — no workflow starts — so nothing else in the run sees it but the
 * traveller's own lists.
 */
export async function seedDraftTrip(
  destination: string,
  actor: 'employee' | 'admin' | 'manager' = 'employee',
): Promise<string> {
  const db = await testDb('seedDraftTrip');
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const row = (
    await db.query(
      `INSERT INTO travel_request
           (organization_id, submitter_id, purpose, destination_label, destination_city,
            depart_date, return_date, status, currency_code)
       SELECT u.organization_id, u.id, $2, $3, $3, $4, $5, 'DRAFT', 'CAD'
         FROM app_user u WHERE lower(u.email) = lower($1)
       RETURNING id`,
      [`${actor}@demo.test`, `e2e fixture — ${destination}`, destination, `${day(30)}T00:00:00.000Z`, `${day(34)}T00:00:00.000Z`],
    )
  ).rows[0] as { id: string } | undefined;
  if (!row) throw new Error(`seedDraftTrip: no seeded ${actor}@demo.test — run the seed (scripts/seed.mjs).`);
  return row.id;
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
