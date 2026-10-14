/**
 * VX2-10 — Phase 2's exit criterion, in a real browser and through a real mail
 * server: submit → approve → reimburse.
 *
 * This is the only test in the repo that exercises what VX2-7 through VX2-9
 * depend on and no unit test can reach:
 *
 *   - a notification email actually LEAVING the app, over SMTP, and arriving
 *     with its link intact. Every VX2-8 vitest runs on the in-memory transport,
 *     which proves the message was composed and nothing about whether mail works —
 *     the same trap VX1-9 recorded for MemoryStorage. Quoted-printable can break a
 *     long URL across two lines; this is the only place that would show.
 *   - d62 (13 Oct 2026): the approver decides ON THE REPORT, signed in, having read
 *     it. The mail carries one link — to the report — and no approve or reject link.
 *     So the spec follows that link twice: with no session, where it must end at
 *     sign-in and decide nothing, and in the approver's session, where the
 *     workbench offers Approve. (Until d62 this spec decided from a one-click
 *     emailed token with no session at all.)
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
import { enumLabel, EVENT_TYPE_COPY } from '@/lib/i18n/catalog/enums';
import {
  addExpenseLine,
  APPROVER_STATE,
  createDraftReport,
  decideOnWorkbench,
  expectReportStatus,
  submitOpenReport,
} from './helpers';
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
// w2-02b: the report's status is read through `expectReportStatus` (helpers.ts), which
// asserts the same catalogued label on the workbench's top bar.

/**
 * The same idea for a notification's event type.
 *
 * VX4-7 part 3. The row assertion below used to read `new RegExp('APPROVED')` —
 * the RAW enum member — and passed for four phases because the notifications
 * page was rendering it. Part 2a catalogued `EVENT_TYPE_COPY` and moved eleven
 * screens onto it; that site was missed, and no gate could see it, because
 * rendering an enum directly is a valid program. The pseudo-locale crawl found
 * it, the fix broke this line, and that is the correct order of events: a test
 * pinned to a defect should fail when the defect is fixed.
 */
const event = (member: string) => enumLabel(EVENT_TYPE_COPY, member, DEFAULT_LOCALE);


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

/** Poll the sink until a message to `to` from this run arrives; return the report link in it. */
async function waitForReportLink(
  request: APIRequestContext,
  to: string,
  reportId: string,
): Promise<string> {
  let last: Captured[] = [];
  await expect
    .poll(
      async () => {
        last = await inbox(request);
        return last.some((m) => mine(m, to));
      },
      { message: `nothing mailed to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  const message = last.find((m) => mine(m, to))!;
  const links = [...message.text.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]);
  const toReport = links.filter((l) => l.endsWith(`/expenses/${reportId}`));
  // In BOTH MIME parts — a client that prefers text/plain and one that prefers
  // text/html must each get something to click. (The sink keeps every part in one
  // blob; scripts/e2e-mail.mjs says why.)
  expect(toReport.length, 'the report link should be in the text and the HTML part').toBeGreaterThan(1);
  // And it is the ONLY kind of link: nothing in the mail can decide anything.
  expect(message.text).not.toMatch(/\/approve\b|token=/);
  return toReport[0];
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
  await createDraftReport(page, TITLE);
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
  const reportUrl = page.url();

  // w2-02b: on ExpenseOS's workbench (helpers.ts `addExpenseLine`). The workbench dates a new
  // expense today, which `submitReport` requires (VX4-11).
  //
  // Under the $25 receipt threshold, so no BLOCK finding and no receipt needed.
  // This spec is about approvals; expense-flow.spec.ts owns the policy gate.
  //
  // Ground Transportation, not Meals: a Meals line here lands in the same fiscal period as
  // `budget-flow.spec.ts`'s Meals budget, and on the w2-02b run it had already taken that
  // budget over before budget-flow added anything. This spec is about approvals, so it keeps
  // out of that GL account.
  await addExpenseLine(page, { vendor: 'Taxi', category: 'Ground Transportation', amount: '18.50' });
  await expect(page.getByRole('banner')).toContainText('$18.50');

  await submitOpenReport(page);
  return reportUrl;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  // A clean sink, so a rerun on a laptop does not match last run's mail.
  await request.delete(`${MAIL_HTTP}/messages`);
});

test('the approver is mailed a link to the report, and decides there, signed in', async ({
  page,
  request,
  browser,
}) => {
  const reportUrl = await createAndSubmit(page);
  const reportId = reportUrl.split('/').pop()!;

  // Nothing has been sent yet: submit only ENQUEUES. If this ever fails, the
  // outbox has started sending inline and the retry/queue behaviour is bypassed.
  expect(await inbox(request)).toHaveLength(0);

  const summary = await drain(request);
  expect(summary).toMatchObject({ failed: 0, dead: 0 });
  expect(summary.sent).toBeGreaterThanOrEqual(1);

  const link = await waitForReportLink(request, APPROVER, reportId);

  // The mail says what it is about, so an approver can triage without opening it.
  const mail = (await inbox(request)).find((m) => mine(m, APPROVER))!;
  expect(mail.subject).toBeTruthy();
  expect(mail.text).toContain(TITLE);
  expect(mail.text).toContain('18.50');
  expect(mail.text).toContain('Review and approve');
  // RFC 3834 — without it a well-behaved out-of-office responder answers this
  // and the two of them keep going (GAP-AUDIT NT-18).
  expect(mail.headers['auto-submitted']).toBe('auto-generated');
  // The link is absolute. An empty APP_URL produced relative-to-nothing links in
  // ExpenseOS and every deployed notification went out unusable (NT-14).
  expect(link).toMatch(/^http:\/\/localhost:\d+\/expenses\//);

  // ── with NO session: the link asks you to sign in, and decides nothing ───
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonymous.newPage();
  try {
    await anonPage.goto(link);
    await expect(anonPage).toHaveURL(/\/login/);
    expect(await statusOf(TITLE)).toBe('SUBMITTED');
  } finally {
    await anonymous.close();
  }

  // ── the approver, signed in: the link opens the report, and Approve is on it ─
  const approver = await browser.newContext({ storageState: APPROVER_STATE });
  const approverPage = await approver.newPage();
  try {
    await approverPage.goto(link);
    await expect(approverPage).toHaveURL(new RegExp(`/expenses/${reportId}$`));
    // Opening it decided nothing.
    expect(await statusOf(TITLE)).toBe('SUBMITTED');
    // eos-573: the decision returns the approver to the queue (see `decideOnWorkbench`).
    await decideOnWorkbench(approverPage, 'Approve');
  } finally {
    await approver.close();
  }

  expect(await statusOf(TITLE)).toBe('APPROVED');

  // And the submitter's own view agrees.
  await page.goto(reportUrl);
  await expectReportStatus(page, 'APPROVED');
  // w2-02b: the report's history is its discussion now — the approval is an event in it.
  await expect(page.getByText('approved this')).toBeVisible();
});

test('the submitter is notified in-app, and by mail', async ({ page, request }) => {
  await drain(request);

  await page.goto('/notifications');
  // Through the catalogue, not the raw member — see `event` above.
  const row = page.getByRole('row', { name: new RegExp(event('APPROVED')) });
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
  // A plain link to the report: the submitter has nothing to decide.
  expect(theirs.text).toContain('Open the report');
  expect(theirs.text).not.toContain('Review and approve');
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
