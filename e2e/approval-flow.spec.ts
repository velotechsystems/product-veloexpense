/**
 * VX2-10 — Phase 2's exit criterion, in a real browser and through a real mail
 * server: submit → approve → reimburse.
 *
 * This is the only test in the repo that exercises what VX2-7 through VX2-9
 * depend on and no unit test can reach:
 *
 *   - a notification email actually LEAVING the app, over SMTP, and arriving
 *     with its approve link intact. Every VX2-8 vitest runs on the in-memory
 *     transport, which proves the message was composed and nothing about whether
 *     mail works — the same trap VX1-9 recorded for MemoryStorage. In particular
 *     it is the only thing that can catch quoted-printable breaking a token
 *     across two lines, which would kill every approve link in production while
 *     24 tests stayed green.
 *   - an approver deciding from that link with NO SESSION AT ALL. The whole
 *     point of the feature is a person who never signs in, so the spec opens the
 *     link in a context with no cookies.
 *   - the confirm step. Nothing may happen on the GET — mail scanners prefetch
 *     links — so the spec asserts the report is still SUBMITTED after loading
 *     the page and only moves once the button is pressed.
 *   - the outbox draining through its real entry point, the same `drainOutbox`
 *     the route and the admin button call.
 *
 * Runs FIRST (alphabetically before expense-flow.spec.ts) and is deliberately
 * self-contained: it does not rely on that file's starter-rule restore, and the
 * amount is kept under the $25 receipt threshold so the flow is about approvals
 * rather than about policy.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
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


/** Per-run id, for the same reason expense-flow.spec.ts has one: the demo tenant
 *  is not reset between runs, and CI retries once. */
const RUN = Date.now().toString(36);
const TITLE = `E2E approval flow ${RUN}`;

const MAIL_HTTP = `http://127.0.0.1:${process.env.E2E_MAIL_HTTP_PORT ?? 2526}`;
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

/** The seeded reporting line: owner is admin's manager, and both are ADMIN. */
const SUBMITTER = 'admin@demo.test';
const APPROVER = 'owner@demo.test';

/**
 * IS THIS MESSAGE FROM THIS RUN?
 *
 * Every lookup below goes through this, and it is not defensive tidying — the
 * suite failed without it. `beforeAll` empties the mail SINK, but the OUTBOX is a
 * database table and `expense-flow.spec.ts` submits three reports and never
 * drains: those rows sit in the demo tenant until the next run's first `drain()`
 * flushes them. So on any laptop the sink's first message to the approver is the
 * PREVIOUS run's, `find(to)` returned it, and `toContain(TITLE)` failed against
 * mail that was real, correct, and about something else.
 *
 * CI never saw it because CI gets a fresh database every run. That is the shape to
 * watch for: an assertion that holds only because the environment is disposable.
 */
function mine(message: Captured, to: string): boolean {
  return message.to.includes(to) && message.text.includes(TITLE);
}

interface Captured {
  to: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
}

async function inbox(request: APIRequestContext): Promise<Captured[]> {
  const res = await request.get(`${MAIL_HTTP}/messages`);
  expect(res.ok(), 'the e2e mail sink should be reachable').toBeTruthy();
  return (await res.json()) as Captured[];
}

/**
 * Drain the outbox through the route a scheduler would call.
 *
 * Deliberately the ROUTE and not a direct library call: this is the only place
 * the bearer-secret gate is exercised, and the gate is fail-closed, so a broken
 * `WORKER_SECRET` wiring would otherwise show up as "no mail ever arrives" with
 * nothing pointing at why.
 */
async function drain(request: APIRequestContext) {
  const res = await request.post('/api/internal/notifications/drain', {
    headers: { authorization: `Bearer ${WORKER_SECRET}` },
  });
  expect(res.status(), 'the drain route should accept the worker secret').toBe(200);
  return res.json() as Promise<{ sent: number; failed: number; dead: number }>;
}

/** Poll the sink until a message to `to` carries an approve link. */
async function waitForApproveLink(request: APIRequestContext, to: string): Promise<string> {
  let last: Captured[] = [];
  await expect
    .poll(
      async () => {
        last = await inbox(request);
        return last.some((m) => mine(m, to) && m.text.includes('/approve?token='));
      },
      {
        message: `no approve link mailed to ${to}`,
        timeout: 15_000,
      },
    )
    .toBe(true);
  const message = last.find((m) => mine(m, to) && m.text.includes('/approve?token='))!;
  const match = message.text.match(/(https?:\/\/\S*\/approve\?token=[\w-]+)/);
  expect(match, 'the mail should carry an absolute approve URL').not.toBeNull();

  // TWO DISTINCT TOKENS, not two occurrences.
  //
  // The first version of this counted matches and expected 2; CI found 4, and it
  // was right. The message is multipart and the sink deliberately keeps every
  // part in one blob (scripts/e2e-mail.mjs says why it does not split them), so
  // each link appears once in text/plain and once in text/html. Counting
  // occurrences was asserting the MIME structure by accident. Counting DISTINCT
  // tokens asserts the thing that matters: Approve and Reject are two separate
  // single-use credentials.
  const tokens = [...message.text.matchAll(/\/approve\?token=([\w-]+)/g)].map((m) => m[1]);
  const distinct = new Set(tokens);
  expect(distinct.size, 'approve and reject should be two different tokens').toBe(2);

  // And each appears more than once — which is the useful half of what the old
  // assertion was checking by accident: BOTH MIME parts carry the links. A
  // recipient whose client prefers text/plain and one whose client prefers
  // text/html must each get something to click.
  for (const token of distinct) {
    expect(
      tokens.filter((t) => t === token).length,
      'each link should appear in both the text and the HTML part',
    ).toBeGreaterThan(1);
  }
  // The FIRST occurrence is Approve — dispatch.ts writes them in that order, in
  // both parts. Asserted so a change to that order fails here rather than
  // silently rejecting things somebody meant to approve.
  expect(match![1], 'the first link should be the approve one').toContain(tokens[0]);
  return match![1];
}

async function statusOf(reportTitle: string): Promise<string> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const r = await pool.query('SELECT status FROM expense_report WHERE title = $1', [reportTitle]);
    expect(r.rows.length, `exactly one report titled "${reportTitle}"`).toBe(1);
    return r.rows[0].status as string;
  } finally {
    await pool.end();
  }
}

async function createAndSubmit(page: Page) {
  await page.goto('/expenses/new');
  await page.getByLabel('Title').fill(TITLE);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
  const reportUrl = page.url();

  await page.getByLabel('Merchant').first().fill('Taxi');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('heading', { name: 'Taxi' })).toBeVisible();

  await page.locator('select[id^="categoryId-"]').selectOption({ label: 'Meals & Entertainment' });
  await page.locator('input[id^="description-"]').fill('Airport transfer');
  // Under the $25 receipt threshold, so no BLOCK finding and no receipt needed.
  // This spec is about approvals; expense-flow.spec.ts owns the policy gate.
  await page.locator('input[id^="amount-"]').fill('18.50');
  await page.getByRole('button', { name: 'Add line item' }).click();
  await expect(page.getByTestId('report-total')).toHaveText('$18.50');

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('report-status')).toHaveText(status('SUBMITTED'));
  return reportUrl;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  // A clean sink, so a rerun on a laptop does not match last run's mail.
  await request.delete(`${MAIL_HTTP}/messages`);
});

test('an approver decides from an emailed link, without ever signing in', async ({
  page,
  request,
  browser,
}) => {
  const reportUrl = await createAndSubmit(page);

  // Nothing has been sent yet: submit only ENQUEUES. If this ever fails, the
  // outbox has started sending inline and the retry/queue behaviour is bypassed.
  expect(await inbox(request)).toHaveLength(0);

  const summary = await drain(request);
  expect(summary).toMatchObject({ failed: 0, dead: 0 });
  expect(summary.sent).toBeGreaterThanOrEqual(1);

  const approveUrl = await waitForApproveLink(request, APPROVER);

  // The mail says what it is about, so an approver can triage without opening it.
  const mail = (await inbox(request)).find((m) => mine(m, APPROVER))!;
  expect(mail.subject).toBeTruthy();
  expect(mail.text).toContain(TITLE);
  expect(mail.text).toContain('18.50');
  // RFC 3834 — without it a well-behaved out-of-office responder answers this
  // and the two of them keep going (GAP-AUDIT NT-18).
  expect(mail.headers['auto-submitted']).toBe('auto-generated');
  // The link is absolute. An empty APP_URL produced relative-to-nothing links in
  // ExpenseOS and every deployed notification went out unusable (NT-14).
  expect(approveUrl).toMatch(/^http:\/\/localhost:\d+\/approve\?token=/);

  // ── the approver, with NO session ─────────────────────────────────────────
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonymous.newPage();
  try {
    await anonPage.goto(approveUrl);

    // It renders a QUESTION and did not decide anything. Mail clients and
    // security gateways prefetch links; a GET that approved would be approved by
    // Outlook. This assertion is the guard on that.
    await expect(anonPage.getByRole('heading', { name: /Approve this expense report/ })).toBeVisible();
    await expect(anonPage.getByText(TITLE)).toBeVisible();
    await expect(anonPage.getByText('$18.50')).toBeVisible();
    expect(await statusOf(TITLE)).toBe('SUBMITTED');

    // The default rung asks the approver to confirm they reviewed the receipts,
    // and there are none — so the page says so rather than letting the box be
    // ticked over nothing.
    await expect(anonPage.getByText(/no receipts attached/i)).toBeVisible();
    await anonPage.getByLabel(/reviewed the receipts/i).check();

    await anonPage.getByRole('button', { name: /Yes, approve it/i }).click();
    await expect(anonPage.getByRole('heading', { name: 'Approved' })).toBeVisible();

    // Single use: the same URL is now spent.
    await anonPage.goto(approveUrl);
    await expect(anonPage.getByRole('heading', { name: /no longer works/i })).toBeVisible();
  } finally {
    await anonymous.close();
  }

  expect(await statusOf(TITLE)).toBe('APPROVED');

  // And the submitter's own view agrees.
  await page.goto(reportUrl);
  await expect(page.getByTestId('report-status')).toHaveText(status('APPROVED'));
  await expect(page.getByText('SUBMITTED → APPROVED')).toBeVisible();
});

test('the submitter is notified in-app, and by mail', async ({ page, request }) => {
  await drain(request);

  await page.goto('/notifications');
  const row = page.getByRole('row', { name: new RegExp('APPROVED') });
  await expect(row.first()).toContainText(TITLE);

  // The same event went out by email as well, to the submitter this time.
  await expect
    .poll(async () => (await inbox(request)).some((m) => mine(m, SUBMITTER)), {
      message: 'the submitter should have been mailed about the approval',
      timeout: 15_000,
    })
    .toBe(true);
  const theirs = (await inbox(request)).find((m) => mine(m, SUBMITTER))!;
  expect(theirs.text).toContain(TITLE);
  // No action links: the submitter has nothing to decide, and a button that
  // always fails is worse than no button.
  expect(theirs.text).not.toContain('/approve?token=');
});

test('finance marks it reimbursed, and the queue empties', async ({ browser, request }) => {
  // The APPROVER's session, not the submitter's. Reimbursement refuses your own
  // report (GAP-AUDIT RB-3), and the demo tenant has the break-glass ON — so
  // using the submitter here would exercise the exception rather than the normal
  // path, and quietly stop testing the control.
  const finance = await browser.newContext({ storageState: 'e2e/.auth/approver.json' });
  const page = await finance.newPage();
  try {
    await page.goto('/admin/reimbursements');
    const row = page.getByRole('row', { name: new RegExp(TITLE) });
    await expect(row).toContainText('$18.50');
    await expect(row).toContainText('Demo Admin');

    await row.getByLabel(new RegExp(`Payment reference for ${TITLE}`)).fill(`EFT-${RUN}`);
    await row.getByRole('button', { name: 'Mark reimbursed' }).click();

    // Gone from the queue, because the queue is "approved and unpaid".
    await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toHaveCount(0);
  } finally {
    await finance.close();
  }

  expect(await statusOf(TITLE)).toBe('REIMBURSED');

  // The whole criterion, on the record: every transition in the report's own
  // timeline, and the payment in the hash chain.
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const events = await pool.query(
      `SELECT e.action FROM expense_report_event e
         JOIN expense_report r ON r.id = e.report_id
        WHERE r.title = $1 ORDER BY e.created_at`,
      [TITLE],
    );
    expect(events.rows.map((r) => r.action)).toEqual(['SUBMIT', 'APPROVE', 'REIMBURSE']);

    const paid = await pool.query(
      `SELECT a.details FROM audit_entry a
         JOIN expense_report r ON r.id = a.entity_id
        WHERE r.title = $1 AND a.action = 'REPORT_REIMBURSED'`,
      [TITLE],
    );
    expect(paid.rows).toHaveLength(1);
    expect(paid.rows[0].details).toMatchObject({
      reference: `EFT-${RUN}`,
      selfReimbursedUnderBreakGlass: false,
    });
  } finally {
    await pool.end();
  }

  // And one last drain, so the REIMBURSED notification is delivered too and the
  // outbox is left empty rather than holding work the next run inherits.
  const last = await drain(request);
  expect(last).toMatchObject({ failed: 0, dead: 0 });
});

test('the drain route refuses a caller with no secret', async ({ request }) => {
  // Fail-closed, and 404 rather than 401: an endpoint that says "wrong password"
  // confirms it exists. This is the only place that gate is exercised at all.
  expect((await request.post('/api/internal/notifications/drain')).status()).toBe(404);
  const wrong = await request.post('/api/internal/notifications/drain', {
    headers: { authorization: 'Bearer not-the-secret' },
  });
  expect(wrong.status()).toBe(404);
});
