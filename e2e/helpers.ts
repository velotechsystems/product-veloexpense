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

export const CONTROL = `http://127.0.0.1:${process.env.E2E_LEDGER_CONTROL_PORT ?? 9412}`;
export const LEDGER = `http://127.0.0.1:${process.env.E2E_LEDGER_PORT ?? 9411}`;
export const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

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
 * Submit and approve a one-line report.
 *
 * Every interaction here is COPIED from `expense-flow.spec.ts`,
 * `approval-flow.spec.ts` and `approval-panel.tsx` rather than invented. The first
 * version guessed — `getByLabel(/title/i)`, `getByRole('button', {name: /add an
 * expense/i})`, a report number scraped with `getByText(/EXP-\d+/)` — and would
 * have failed on almost every line: the real labels are exact ('Title', 'Merchant'), the real
 * buttons are 'Create draft' / 'Add expense' / 'Add line item' / 'Submit for
 * approval', the line-item inputs are id-prefixed locators rather than labels, and
 * merchant is FILLED BEFORE the add button is clicked, not after.
 *
 * The lesson, since it cost a CI round trip: when a flow already has a passing
 * spec, take its selectors — and its FIXTURES. Two of the four defects found on
 * the second read were not selectors at all: a category called 'Travel' that the
 * seed does not have, and an approver who is somebody else. Guessing at markup and
 * data you cannot run is the one part of this job with no feedback loop.
 */
export async function submitAndApprove(
  page: Page,
  browser: Browser,
  title: string,
  amount: string,
) {
  await page.goto('/expenses/new');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();

  await page.getByLabel('Merchant').first().fill('Beck Taxi');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('heading', { name: 'Beck Taxi' })).toBeVisible();

  // 'Ground Transportation', and NOT 'Travel' — there is no category by that
  // name. The seed's six are Meals & Entertainment, Airfare, Lodging, Ground
  // Transportation, Office Supplies and Software & Subscriptions; 'Travel (100%
  // deductible)' is the ACCOUNT's name, because three ways of travelling are one
  // line in the general ledger. That distinction is the whole reason VX3-1 stopped
  // treating the category list as a chart of accounts, and picking the account's
  // name out of the category dropdown was walking straight back into it.
  //
  // Ground Transportation maps to 68100, which the sink's `list_accounts` returns,
  // so the adapter's pre-flight passes rather than refusing the bill.
  await page
    .locator('select[id^="categoryId-"]')
    .selectOption({ label: 'Ground Transportation' });
  await page.locator('input[id^="description-"]').fill('Airport taxi');
  await page.locator('input[id^="amount-"]').fill(amount);
  await page.getByRole('button', { name: 'Add line item' }).click();

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('report-status')).toHaveText('SUBMITTED');

  // ── the decision, in the APPROVER's session ───────────────────────────────
  const approver = await browser.newContext({ storageState: APPROVER_STATE });
  const approverPage = await approver.newPage();
  try {
    await approverPage.goto('/approvals');
    // The inbox links to the report by TITLE; the decide controls live on the
    // report page, not on /approvals.
    await approverPage.getByRole('link', { name: title }).first().click();

    // WAIT FOR THE PANEL BEFORE ASKING WHAT IS ON IT.
    //
    // `count()` does not auto-wait. It answers about the DOM as it stands right
    // now, and the line above is a client-side Next navigation — so the first
    // version's `if ((await ack.count()) > 0)` was answered about the /approvals
    // page it had just left, found no checkbox, and skipped it. The Approve click
    // then auto-waited, landed on a fully rendered panel, and the server refused
    // with "this approval step requires you to confirm you reviewed the receipts".
    // The report stayed SUBMITTED and the failure surfaced ten lines later.
    //
    // An auto-waiting assertion first, and the conditional is then a question about
    // the right page. The conditional itself stays: the acknowledgement is a
    // per-rung setting (`requireReceiptViewAck`), and the SERVER enforces it on
    // APPROVED specifically — hard-coding it on breaks the day a tenant turns it
    // off, and hard-coding it off is the version that just failed.
    const approve = approverPage.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeVisible();
    const ack = approverPage.locator('input[name="receiptViewAcknowledged"]');
    if ((await ack.count()) > 0) await ack.check();

    await approve.click();
    // `decideFromForm` redirects back to `/expenses/<id>`, so the status the
    // approver is looking at is the report's own.
    await expect(approverPage.getByTestId('report-status')).toHaveText('APPROVED');
  } finally {
    await approver.close();
  }
}
