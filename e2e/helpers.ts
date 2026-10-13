/**
 * VX3-9b — the e2e helpers two ledger specs share.
 *
 * Extracted from `e2e/ledger-flow.spec.ts` when `e2e/oauth-flow.spec.ts` needed the
 * same three things: the sink's control port, the queue drain, and "get one report
 * approved". Every selector below is COPIED from a passing spec rather than
 * invented — `expense-flow.spec.ts` owns the workbench, `approval-flow.spec.ts`
 * owns submit-to-approve — and the comments say which, because guessing at markup
 * that cannot be run locally is the one part of this job with no feedback loop.
 *
 * Not a `.spec.ts`, so Playwright does not collect it as a test file.
 */
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
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



export const CONTROL = `http://127.0.0.1:${process.env.E2E_LEDGER_CONTROL_PORT ?? 9412}`;
export const LEDGER = `http://127.0.0.1:${process.env.E2E_LEDGER_PORT ?? 9411}`;
export const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

// VX5-20. The platform sink's two ports — see scripts/e2e-platform.mjs for why
// the seat push has to leave the process to be checkable.
export const PLATFORM_CONTROL = `http://127.0.0.1:${process.env.E2E_PLATFORM_CONTROL_PORT ?? 9522}`;

/**
 * THE APPROVER, WHO IS NOT THE SUBMITTER.
 *
 * Approval is not self-service in the seeded demo tenant: the reporting line makes
 * owner@demo.test the manager of admin@demo.test, so a report the default session
 * submits routes to the OWNER and the submitter's own /approvals inbox stays
 * empty. `approval-flow.spec.ts` states the relationship at the top of the file,
 * and the first version of the ledger spec approved as the submitter anyway.
 */
export const APPROVER_STATE = 'e2e/.auth/approver.json';
/** VX4-7 part 3 — the roles the crawl signs in as. */
export const ADMIN_STATE = 'e2e/.auth/state.json';
export const MANAGER_STATE = 'e2e/.auth/manager.json';
export const EMPLOYEE_STATE = 'e2e/.auth/employee.json';

/**
 * A KNOWN-EMPTY integration state for the tenants a spec is about to use.
 *
 * `scripts/seed.mjs` deliberately connects no ledger, but it does not DISCONNECT
 * one either, and the demo tenant is never reset — so a connection made by an
 * earlier run survives, `availableAdapters()` then hides the connect form, and
 * every test that expected to connect fails on a missing form. That is exactly how
 * the ledger spec failed on its first local run.
 *
 * Since AC-22 there is a second reason, and it is the stronger one: two ACTIVE
 * adapters that both claim POST_EXPENSE_REPORT now make the posting path REFUSE
 * rather than pick one. A leftover ledger would therefore stop the spec's own
 * ledger from posting, correctly and confusingly.
 *
 * Queue rows go too, so `posted: 1` and `count: 1` are about this run's report and
 * nothing else. `integration_post` survives a deleted installation by design
 * (`ON DELETE SET NULL (installation_id)`), which is why the posts go first.
 *
 * Superuser connection, the same one `approval-flow.spec.ts` uses — RLS is
 * bypassed, so one statement reaches every tenant named.
 */
export async function wipeIntegrations(orgSlugs: string[]) {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `DELETE FROM integration_post
        WHERE organization_id IN (SELECT id FROM organization WHERE slug = ANY($1))`,
      [orgSlugs],
    );
    await pool.query(
      `DELETE FROM integration_installation
        WHERE organization_id IN (SELECT id FROM organization WHERE slug = ANY($1))`,
      [orgSlugs],
    );
    // VX4-1 part 2: and the accounting module is ON. `modules-flow.spec.ts` toggles
    // it off to prove the gate, and restores it in an afterAll — but a spec that
    // depends on another spec's cleanup is a spec that fails when somebody adds a
    // file whose name sorts between them. One line here and the ordering coupling
    // is gone.
    await pool.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
       SELECT o.id, m.code, true, clock_timestamp()
         FROM organization o CROSS JOIN (VALUES ('accounting'),('budgets')) AS m(code)
        WHERE o.slug = ANY($1)
       ON CONFLICT (organization_id, module_code)
       DO UPDATE SET enabled = true, updated_at = clock_timestamp()`,
      [orgSlugs],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Leave the notification outbox empty, which is `approval-flow.spec.ts`'s own
 * closing convention: "so the outbox is left empty rather than holding work the
 * next run inherits". A spec that approves reports enqueues mail, and the next
 * run's first drain would otherwise deliver it into that spec's assertions — which
 * is a hole that has already broken it once.
 */
export async function drainNotifications(request: APIRequestContext) {
  await request.post('/api/internal/notifications/drain', {
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
}

/** What the sink's consent screen was asked for (VX3-9b). */
export async function authorizationsAtSink(request: APIRequestContext) {
  const r = await request.get(`${CONTROL}/authorizations`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as {
    count: number;
    requests: Array<{ state: string; redirectUri: string; query: Record<string, string> }>;
  };
}

export async function resetSink(request: APIRequestContext) {
  const r = await request.post(`${CONTROL}/reset`);
  expect(r.ok(), 'the e2e ledger sink is not answering — is scripts/e2e-ledger.mjs up?').toBe(true);
}

export async function billsAtSink(request: APIRequestContext) {
  const r = await request.get(`${CONTROL}/bills`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as {
    count: number;
    bills: Array<{
      billId: string;
      via: string;
      authorization: string | null;
      externalAccount: string | null;
      payload: Record<string, unknown>;
    }>;
  };
}

/* ── VX5-20: the platform sink ─────────────────────────────────────────────── */

export interface SeatReport {
  at: string;
  key: string | null;
  contentType: string | null;
  body: { accountId?: string; product?: string; seatCount?: number; observedAt?: string };
}

/** Every seat report the platform sink has received, in order. */
export async function seatReportsAtSink(request: APIRequestContext): Promise<SeatReport[]> {
  const r = await request.get(`${PLATFORM_CONTROL}/seats`);
  expect(
    r.ok(),
    'the e2e platform sink is not answering — is scripts/e2e-platform.mjs up?',
  ).toBe(true);
  return ((await r.json()) as { reports: SeatReport[] }).reports;
}

export async function resetPlatformSink(request: APIRequestContext) {
  const r = await request.post(`${PLATFORM_CONTROL}/reset`);
  expect(r.ok(), 'the e2e platform sink is not answering').toBe(true);
}

/** Make the sink refuse the next seat report with a 500. */
export async function platformFailsNextSeatPush(request: APIRequestContext) {
  const r = await request.post(`${PLATFORM_CONTROL}/fail-next`);
  expect(r.ok()).toBe(true);
}

/**
 * Run the reconcile sweep the way a scheduler would.
 *
 * Returns the body, because the sweep REPORTS rather than refuses — a test that
 * only checked the status could not tell a clean sweep from one where every
 * tenant failed.
 */
export async function reconcileSeats(request: APIRequestContext) {
  const r = await request.post('/api/internal/billing/seats', {
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  expect(r.status(), 'the seat reconcile route refused the worker secret').toBe(200);
  return (await r.json()) as {
    configured: boolean;
    organizations?: number;
    sent?: number;
    skipped?: number;
    failures?: { organizationId: string; message: string }[];
  };
}

/**
 * Wait for a seat report to arrive.
 *
 * The push is FIRE-AND-FORGET — `pushSeatCountInBackground` is deliberately not
 * awaited, so the server action returns before the POST lands. A test that
 * asserted immediately after the click would be racing the feature it is testing
 * and would fail perhaps one run in ten, which is worse than not having the test.
 */
export async function waitForSeatReports(
  request: APIRequestContext,
  atLeast: number,
  timeoutMs = 10_000,
): Promise<SeatReport[]> {
  const deadline = Date.now() + timeoutMs;
  let reports = await seatReportsAtSink(request);
  while (reports.length < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    reports = await seatReportsAtSink(request);
  }
  expect(
    reports.length,
    `expected at least ${atLeast} seat report(s) at the sink within ${timeoutMs}ms`,
  ).toBeGreaterThanOrEqual(atLeast);
  return reports;
}

/** Drain the posting queue the way a scheduler would. */
export async function drainLedger(request: APIRequestContext) {
  const r = await request.post('/api/internal/ledger/drain', {
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  expect(r.status(), 'the ledger drain route refused the worker secret').toBe(200);
  return r.json();
}

/**
 * Connect a ledger through the real form.
 *
 * Selectors are scoped to the adapter's own `<form>` rather than to the input ids,
 * because those ids are `new-<fieldName>` and NOT adapter-scoped — two adapters
 * sharing a field name would collide today. No collision exists yet; relying on it
 * would be relying on an accident.
 */
export async function connectLedger(
  page: Page,
  adapterName: string,
  label: string,
  fields: Record<string, string>,
) {
  await page.goto('/admin/integrations');

  // No guard here for "already connected", because `beforeAll` guarantees it is
  // not: `availableAdapters()` hides an adapter that already has an ACTIVE
  // installation, so a leftover connection makes this form ABSENT rather than
  // duplicated. That is the failure this file hit twice — once as CI's retry
  // reporting "no connect form for VeloLedger" three tests away from the real
  // problem, once as a laptop inheriting a connection from a run in March. The
  // clean slate is the fix; a guard here would only have papered over it.
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: `Connect ${adapterName}` }),
  });
  await expect(form, `no connect form for ${adapterName} — is its adapter registered?`).toHaveCount(1);
  await form.locator('[name="label"]').fill(label);
  for (const [name, value] of Object.entries(fields)) {
    await form.locator(`[name="config.${name}"]`).fill(value);
  }
  await form.getByRole('button', { name: `Connect ${adapterName}` }).click();
  await expect(page.getByText('Connected.', { exact: false })).toBeVisible();
  // The connection is in the list, under the label just given it.
  await expect(page.getByText(label, { exact: true })).toBeVisible();
}

/**
 * Create a DRAFT report and land on it — the step every report-building spec starts with.
 *
 * Wave 2 (w2-05) replaced `/expenses/new` with ExpenseOS's reports list, whose "New report"
 * control opens a dialog: a title, a currency (CAD by default) and "Create report", which
 * opens the new report. One helper rather than six copies of the dialog's selectors, so the
 * next change to that dialog is one edit.
 */
export async function createDraftReport(page: Page, title: string) {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'New report' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create report' }).click();
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
}

/**
 * Open the first report the list shows and return its id, or null when the list is empty.
 *
 * The ported list (w2-05) opens a report by clicking its row — there is no link to read an
 * href from — so this clicks the first row carrying a report number and reads the id off the
 * URL it lands on.
 */
export async function openFirstReport(page: Page): Promise<string | null> {
  await page.goto('/expenses');
  const row = page.getByRole('row').filter({ hasText: /EXP-\d+/ }).first();
  // The list loads its rows client-side: wait for a report row or the empty state before
  // deciding there is nothing to open.
  await expect(row.or(page.getByText('No expense reports', { exact: true }))).toBeVisible();
  if ((await row.count()) === 0) return null;
  await row.click();
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop() ?? null;
}

/**
 * Submit and approve a one-line report.
 *
 * Every interaction here is COPIED from `expense-flow.spec.ts`,
 * `approval-flow.spec.ts` and `approval-panel.tsx` rather than invented. The first
 * version guessed — `getByLabel(/title/i)`, `getByRole('button', {name: /add an
 * expense/i})`, a report number scraped with `getByText(/EXP-\d+/)` — and would
 * have failed on almost every line.
 *
 * The lesson, since it cost a CI round trip: when a flow already has a passing
 * spec, take its selectors — and its FIXTURES. Two of the four defects found on
 * the second read were not selectors at all: a category called 'Travel' that the
 * seed does not have, and an approver who is somebody else. Guessing at markup and
 * data you cannot run is the one part of this job with no feedback loop.
 *
 * w2-02b: the report page is now ExpenseOS's workbench, and its selectors are taken the
 * same way — from ExpenseOS's own `e2e/expense-lifecycle.spec.ts` (`addExpense`,
 * `decide`) — rather than guessed. The pieces are exported for the specs that build a
 * report and stop short of approving it.
 */
export async function submitAndApprove(
  page: Page,
  browser: Browser,
  title: string,
  amount: string,
) {
  await createDraftReport(page, title);
  await addExpenseLine(page, { vendor: 'Beck Taxi', category: 'Ground Transportation', amount });
  await submitOpenReport(page);
  await approveAs(browser, APPROVER_STATE, title);
}

/**
 * Add one expense with one line to the open report, on the workbench.
 *
 * As ExpenseOS's `expense-lifecycle.spec.ts` does it: the EXPENSE carries the vendor (and the
 * date — the workbench creates it dated today, which `submitReport` requires); its LINE carries
 * the category and the amount, and the amount field does not exist until a category is chosen.
 * The amount is blurred, not merely filled: the field commits on blur.
 *
 * 'Ground Transportation', and NOT 'Travel' — there is no category by that name. The seed's
 * six are Meals & Entertainment, Airfare, Lodging, Ground Transportation, Office Supplies and
 * Software & Subscriptions; Ground Transportation maps to 68100, which the ledger sink's
 * `list_accounts` returns, so the adapter's pre-flight passes rather than refusing the bill.
 *
 * The category picker is the kit Combobox: a button, found by the placeholder it keeps as
 * `data-placeholder`, whose options are `role="option"`.
 */
export async function addExpenseLine(
  page: Page,
  { vendor, category, amount, date }: { vendor: string; category: string; amount: string; date?: string },
) {
  // Wait for the NEW expense to be the one open before typing: "Add expense" creates it on
  // the server and only then selects it, so a vendor typed at once lands in the expense that
  // was open before — on a second pass, the first one (compliance-flow found this: its second
  // entry saved with no merchant). The list grows by one, and the editor's vendor is empty.
  const rows = page.getByRole('checkbox', { name: 'Select expense' });
  const before = await rows.count();
  const named = page.getByRole('listitem').filter({ hasText: vendor });
  const namedBefore = await named.count();
  await page.getByRole('button', { name: 'Add expense' }).first().click();
  await expect(rows).toHaveCount(before + 1);
  const vendorField = page.getByLabel('Vendor');
  await expect(vendorField).toHaveValue('');
  await vendorField.fill(vendor);
  await vendorField.blur();
  // The expense list names the vendor once the header has saved.
  await expect(named).toHaveCount(namedBefore + 1);
  if (date) {
    const dateField = page.getByLabel('Date', { exact: true });
    await dateField.fill(date);
    await dateField.blur();
  }
  await addLine(page, category, amount);
}

/**
 * Add one line to the expense open in the editor.
 *
 * The draft row commits the moment its category is picked, and the editor then re-renders it
 * as a saved line — so the amount is typed only once the saved row's field exists. Typed into
 * the draft's field instead, it is lost in that re-render; waiting on the COUNT of amount
 * fields is what makes the wait real (the same lesson as compliance-flow's form count).
 */
export async function addLine(page: Page, category: string, amount: string) {
  const amounts = page.getByLabel('Amount', { exact: true });
  const before = await amounts.count();
  await page.getByRole('button', { name: 'Add line', exact: true }).first().click();
  await page.locator('[data-placeholder="Select a category"]').last().click();
  await page.getByRole('option', { name: category }).click();
  await expect(amounts).toHaveCount(before + 1);
  const field = amounts.last();
  await field.fill(amount);
  await field.blur();
}

/**
 * Submit the open report and wait until the top bar says Submitted.
 *
 * Waits for the button to be ENABLED first, as ExpenseOS's suite does: the reasons it is
 * disabled (no expenses yet, a figure still saving) are states the specs create, and a bare
 * click turns "not ready" into a timeout pointing at the press.
 */
export async function submitOpenReport(page: Page) {
  const submit = page.getByRole('button', { name: 'Submit report' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expectReportStatus(page, 'SUBMITTED');
}

/** The open report's status, as the workbench's top bar shows it. */
export async function expectReportStatus(page: Page, member: string) {
  await expect(page.getByRole('banner').getByText(status(member), { exact: true })).toBeVisible();
}

/**
 * Approve a report in another person's session, from their approvals inbox.
 *
 * w4-05/w4-07 (d71): the inbox is ExpenseOS's (/expenses/approvals). A row opens the
 * approver's drawer — the report's lines and receipts, read-only — and Approve there decides
 * it. Then the report has left the pending queue, and the Decided queue lists it as approved,
 * which is the approver's own record that it happened. (Before d71 the inbox linked to the
 * report and the decision was made on the workbench — `decideOnWorkbench`, still used by the
 * specs that decide there.)
 */
export async function approveAs(browser: Browser, storageState: string, title: string) {
  const ctx = await browser.newContext({ storageState });
  const approverPage = await ctx.newPage();
  try {
    await approverPage.goto('/expenses/approvals');
    await approverPage.getByRole('row', { name: new RegExp(escapeRegExp(title)) }).first().click();
    const drawer = approverPage.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(approverPage.getByRole('row', { name: new RegExp(escapeRegExp(title)) })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide the open report from the workbench's top bar.
 *
 * Approve answers the receipt acknowledgement when the step asks for it. Reject and Return
 * open a note and a second, differently-labelled button — and a rejection REQUIRES the note,
 * so its confirm stays disabled until one is typed (ExpenseOS's `decide`).
 */
export async function decideOnWorkbench(
  page: Page,
  action: 'Approve' | 'Reject' | 'Return for edits',
  note = 'Checked by the end-to-end suite.',
) {
  const bar = page.getByRole('banner');
  const button = bar.getByRole('button', { name: action, exact: true });
  await expect(button).toBeVisible();
  await button.click();
  if (action === 'Approve') {
    const confirm = page.getByRole('button', { name: 'Confirm approval' });
    // Either the decision went on the press, or the acknowledgement panel opened.
    await expect(confirm.or(bar.getByText(status('APPROVED'), { exact: true }))).toBeVisible();
    if (await confirm.isVisible()) {
      await page.getByRole('checkbox', { name: /I reviewed the/ }).check();
      await confirm.click();
    }
    return;
  }
  await page.getByPlaceholder(/Reason for rejection|What needs to change/).fill(note);
  await page
    .getByRole('button', { name: action === 'Reject' ? 'Confirm reject' : 'Confirm return' })
    .click();
}
