/**
 * VX3-9a — TWO TENANTS, TWO LEDGERS, side by side. Phase 3's exit criterion.
 *
 * ── What this proves that nothing else does ─────────────────────────────────
 *
 * Before this file, NOTHING in the e2e touched Phase 3. Nine tests covered submit,
 * policy, approve, notify and reimburse; zero covered the chart of accounts,
 * connecting an integration, the posting queue, or posting. Every Phase-3
 * assertion lived in vitest, in one process, against one tenant.
 *
 * So the gap was not "more coverage". It was that three claims had never been
 * tested together in a running system:
 *
 *   1. `resolveCapability` picks the RIGHT ADAPTER PER TENANT — the property that
 *      makes the Plan's exit criterion (VeloLedger in one tenant, QuickBooks in a
 *      second) reachable without a branch in core.
 *   2. A report posts to ITS OWN tenant's far end and nowhere else. The sink holds
 *      exactly one bill afterwards, and that single number is the isolation
 *      assertion — if the second tenant's report leaked into the first tenant's
 *      ledger it would hold two.
 *   3. THE PAYLOAD is what the ledger should have received: the account the line
 *      was coded to, the amount in minor units, the idempotency key, the entity.
 *
 * ── Why the connections are made through the FORM ───────────────────────────
 *
 * Not for UI coverage, though it is the first coverage the connect screen has ever
 * had — the "nobody has clicked these screens" item has been open since Phase 1.
 * The seed CANNOT do it: a `secret`-typed field is encrypted on write by
 * TypeScript a `.mjs` seed cannot import, and `decryptSecret` REFUSES an unmarked
 * value rather than trusting it (AC-4). A seeded plaintext key is not "insecure
 * but working", it is a row that throws the moment the app reads it. Verified, not
 * assumed. So the form does it, through the shipping encryption path.
 *
 * ── The far end is a real HTTP server ───────────────────────────────────────
 *
 * `scripts/e2e-ledger.mjs`, started by `playwright.config.ts`. The demo tenant
 * uses the REAL VeloLedger adapter against it — its `resolve_period`, its account
 * pre-flight, its `draft_bill` shape, its idempotency key — because two stubs
 * would satisfy the criterion's letter and prove nothing extra.
 */
import { test, expect } from '@playwright/test';
import {
  CONTROL,
  LEDGER,
  billsAtSink,
  connectLedger,
  connectionAudits,
  drainLedger,
  drainNotifications,
  resetSink,
  submitAndApprove,
  wipeIntegrations,
} from './helpers';

const ENTITY_ID = process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';
/** The second tenant's admin, minted by `e2e/auth.setup.ts`. */
const SECOND_STATE = 'e2e/.auth/second.json';

/**
 * Each connection gets a UNIQUE label, and that is load-bearing rather than tidy.
 *
 * The first version asserted on `getByText('VeloLedger')` and hit a strict-mode
 * violation: six elements matched, because the adapter's NAME appears in the
 * connect form's heading, its description, two field labels, a help text and the
 * submit button. A label nothing else on the page uses gives one target — and it
 * doubles as the cross-tenant assertion, since a tenant seeing the other's label
 * would be seeing the other's connection.
 */
const LABEL_A = 'Demo ledger via sink';
const LABEL_B = 'Second ledger via stub';

/**
 * A per-run id on every report title, for the reason `expense-flow.spec.ts` and
 * `approval-flow.spec.ts` both give: the seeded demo tenant is NOT reset between
 * runs and CI retries once, so a fixed title accumulates rows.
 *
 * It matters more here than in either of those files. A report left APPROVED but
 * unposted by an earlier run becomes a SECOND bill at the sink the moment this
 * file drains, and `posted: 1` / `count: 1` is this file's whole isolation
 * assertion. The flush-then-reset below handles the backlog; the stamp keeps the
 * inbox lookup unambiguous.
 */
const RUN = Date.now().toString(36);
const TITLE_POSTED = `E2E ledger post ${RUN}`;
const TITLE_REFUSED = `E2E ledger refusal ${RUN}`;

test.describe('two tenants, two ledgers', () => {
  test.describe.configure({ mode: 'serial' });

  // Both tenants start with nothing connected and an empty queue — see
  // `wipeIntegrations` for why the seed cannot do this and why it matters twice as
  // much since AC-22.
  test.beforeAll(async () => {
    await wipeIntegrations(['demo', 'second']);
  });

  // Two reports were submitted and approved here, and each enqueued mail. Left
  // undrained it becomes the next run's input — the hole that broke
  // `approval-flow.spec.ts` once already.
  test.afterAll(async ({ request }) => {
    await drainNotifications(request);
  });

  test('each tenant connects its OWN ledger, and cannot see the other', async ({
    page,
    browser,
  }) => {
    const since = new Date(Date.now() - 5_000);
    // Tenant A (demo) → the real VeloLedger adapter, pointed at the sink.
    await connectLedger(page, 'VeloLedger', LABEL_A, {
      baseUrl: LEDGER,
      apiKey: 'e2e-only-not-a-real-key',
      entityId: ENTITY_ID,
      vendorRef: 'V-REIMB',
    });

    // Tenant B (second) → the in-process stub. A DIFFERENT adapter, so
    // `resolveCapability` has to choose per tenant rather than per build.
    const second = await browser.newContext({ storageState: SECOND_STATE });
    const secondPage = await second.newPage();
    await connectLedger(secondPage, 'Stub ledger (testing)', LABEL_B, {
      ledgerUrl: LEDGER,
      apiToken: 'e2e-only-not-a-real-token',
    });

    // THE isolation assertion on this screen: neither tenant's connection list
    // mentions the other's. A leak here would be a tenant seeing whose accounting
    // system somebody else uses.
    // Each tenant sees its OWN label and not the other's. The previous version
    // checked for 'V-REIMB' here, which is a config VALUE rendered as an input's
    // `defaultValue` — `getByText` never matches an input's value, so that
    // assertion could not have failed and proved nothing.
    await secondPage.goto('/admin/integrations');
    await expect(secondPage.getByText(LABEL_B, { exact: true })).toBeVisible();
    await expect(secondPage.getByText(LABEL_A, { exact: true })).toHaveCount(0);

    await page.goto('/admin/integrations');
    await expect(page.getByText(LABEL_A, { exact: true })).toBeVisible();
    await expect(page.getByText(LABEL_B, { exact: true })).toHaveCount(0);

    // f50: each connection is in its own tenant's audit chain, and the API key is not.
    const rows = await connectionAudits('demo', 'veloledger', since);
    expect(rows.map((r) => r.action)).toEqual(['INTEGRATION_INSTALLED']);
    expect(rows[0].raw).not.toContain('e2e-only-not-a-real-key');
    // The second tenant's stub connection is in the second tenant's chain, not demo's.
    expect(await connectionAudits('demo', 'stub-ledger', since)).toHaveLength(0);
    const second_ = await connectionAudits('second', 'stub-ledger', since);
    expect(second_.map((r) => r.action)).toEqual(['INTEGRATION_INSTALLED']);
    expect(second_[0].raw).not.toContain('e2e-only-not-a-real-token');

    await second.close();
  });

  test('a report posts to its own tenant\'s ledger, with the right payload', async ({
    page,
    browser,
    request,
  }) => {
    // FLUSH, then reset, then measure.
    //
    // The `beforeAll` wipe is what actually makes the queue empty. This is the
    // belt to its braces, and it is here because of what it guards against:
    // `approval-flow.spec.ts` approves a report before this file runs, and
    // approving ENQUEUES a post in the same transaction (VX3-4) — one that stays
    // PENDING rather than failing, because no ledger was connected yet and VX3-4
    // deliberately does not burn an attempt ("a tenant that connects next week
    // must find last week's approvals still waiting"). The moment the previous
    // test connected a ledger, such a row becomes due, and `posted: 1` below would
    // be counting somebody else's report. Any future spec that approves something
    // between the wipe and here reintroduces exactly that, so the flush stays.
    await drainLedger(request);
    await resetSink(request);

    // UNDER $25, deliberately, and `approval-flow.spec.ts` set the precedent with
    // the same note: the starter rules include RECEIPT_REQUIRED at BLOCK severity
    // above $25.00, `expense-flow.spec.ts` restores them in a `beforeAll`, and it
    // runs before this file. A $125.50 report with no receipt does not get
    // submitted at all — it collects a blocking violation and stays DRAFT. This
    // file is about posting, not about the policy gate that expense-flow owns.
    await submitAndApprove(page, browser, TITLE_POSTED, '21.50');
    const summary = await drainLedger(request);
    // Exactly one, because the queue was flushed and the sink reset a moment ago.
    expect(summary, 'the drain did not post exactly this one report').toMatchObject({ posted: 1 });

    const received = await billsAtSink(request);
    // ONE bill. This single number is the isolation assertion: two would mean
    // another tenant's report reached this tenant's ledger.
    expect(received.count).toBe(1);
    const bill = received.bills[0];

    // It came through the REAL adapter, authenticated with the key the form stored
    // and the app decrypted.
    expect(bill.via).toBe('veloledger');
    expect(bill.authorization).toBe('Bearer e2e-only-not-a-real-key');
    expect(bill.externalAccount).toBe(ENTITY_ID);

    // THE PAYLOAD, which is what the ticket asks for and what neither the database
    // nor the in-process stub can show.
    const payload = bill.payload as {
      vendorRef: string;
      idempotencyKey: string;
      periodId: string;
      description: string;
      lines: Array<{ expenseAccountNumber: string; unitPriceMinor: string }>;
    };
    expect(payload.vendorRef).toBe('V-REIMB');
    // Stable for the life of the row, which is what makes a retry safe (VX3-4).
    expect(payload.idempotencyKey).toMatch(/^veloexpense-report-[0-9a-f-]{36}$/);
    // `resolve_period` was called first and its answer used — the adapter does not
    // carry a configured period, because that would go stale every month.
    expect(payload.periodId).toBeTruthy();
    // The adapter builds `<number> — <title> (<submitter>)`, so the title is in
    // there and does not require scraping a number off the page.
    expect(payload.description).toContain(TITLE_POSTED);
    expect(payload.lines).toHaveLength(1);
    // The account the line was CODED to, and the amount in minor units — 21.50
    // arriving as 2150 rather than 21.5 is the whole of `lib/money.ts`'s job.
    expect(payload.lines[0].expenseAccountNumber).toBe('68100');
    expect(payload.lines[0].unitPriceMinor).toBe('2150');

    // And the queue says so in words, on the screen an operator reads.
    await page.goto('/admin/ledger-queue');
    await expect(page.getByText('drafted in the ledger').first()).toBeVisible();
    // VX3-7's wording: drafted is not posted, and the screen has to say which.
    await expect(page.getByText('Drafted is not posted.')).toBeVisible();
  });

  test('the second tenant sees NOTHING of the first tenant\'s queue', async ({ browser }) => {
    // The report above is APPROVED, POSTED and visible to tenant A. Tenant B's
    // queue must be empty — the same claim `test/rls-isolation.test.ts` makes in
    // SQL, made here through the app, with a session and a browser.
    const second = await browser.newContext({ storageState: SECOND_STATE });
    const secondPage = await second.newPage();
    await secondPage.goto('/admin/ledger-queue');
    await expect(secondPage.getByText('Nothing has been queued yet')).toBeVisible();
    await secondPage.goto('/expenses');
    await expect(secondPage.getByText(TITLE_POSTED)).toHaveCount(0);
    await second.close();
  });

  test('a ledger that refuses is retried, not silently dropped', async ({
    page,
    browser,
    request,
  }) => {
    // The retry path against a REAL 502 rather than a thrown JavaScript error —
    // a status code and an exception are not the same thing to the code that
    // classifies them (AC-8, AC-17).
    // Flush before arming the failure, for the same reason as above: a leftover
    // PENDING row would consume the single injected 502 and this test would then
    // watch its own report succeed.
    await drainLedger(request);
    await resetSink(request);
    // Aimed at `draft_bill` BY NAME. A post is three tool calls — `resolve_period`,
    // `list_accounts`, then `draft_bill` — and an unaimed `fail-next` lands on the
    // first of them, where a 502 is a read that failed and nothing was ever sent.
    // The classifier reaches NEEDS_REVIEW either way, so the assertion below would
    // pass while testing the wrong thing: "5xx on the WRITE, which may have
    // applied" is the case AC-8 exists for, and it is the one worth pinning.
    await request.post(`${CONTROL}/fail-next`, {
      data: { count: 1, status: 502, tool: 'draft_bill' },
    });

    await submitAndApprove(page, browser, TITLE_REFUSED, '18.00');
    await drainLedger(request);

    // A 5xx is AMBIGUOUS — the far end may have applied it — so this must NOT be a
    // retryable FAILED. It is the state no automatic path will touch.
    await page.goto('/admin/ledger-queue');
    await expect(page.getByText('needs review').first()).toBeVisible();

    // Nothing reached the ledger, which is what makes "may or may not have applied"
    // the honest description rather than a guess.
    expect((await billsAtSink(request)).count).toBe(0);
  });
});
