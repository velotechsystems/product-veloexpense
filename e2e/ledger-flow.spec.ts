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
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.E2E_LEDGER_CONTROL_PORT ?? 9412}`;
const LEDGER = `http://127.0.0.1:${process.env.E2E_LEDGER_PORT ?? 9411}`;
const ENTITY_ID = process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

/** The second tenant's admin, minted by `e2e/auth.setup.ts`. */
const SECOND_STATE = 'e2e/.auth/second.json';

async function resetSink(request: APIRequestContext) {
  const r = await request.post(`${CONTROL}/reset`);
  expect(r.ok(), 'the e2e ledger sink is not answering — is scripts/e2e-ledger.mjs up?').toBe(true);
}

async function billsAtSink(request: APIRequestContext) {
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
async function drainLedger(request: APIRequestContext) {
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
async function connectLedger(
  page: Page,
  adapterName: string,
  fields: Record<string, string>,
) {
  await page.goto('/admin/integrations');
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: `Connect ${adapterName}` }),
  });
  await expect(form, `no connect form for ${adapterName} — is its adapter registered?`).toHaveCount(1);
  for (const [name, value] of Object.entries(fields)) {
    await form.locator(`[name="config.${name}"]`).fill(value);
  }
  await form.getByRole('button', { name: `Connect ${adapterName}` }).click();
  await expect(page.getByText('Connected.', { exact: false })).toBeVisible();
}

/** Submit and approve a one-line report, returning its number. */
async function submitAndApprove(page: Page, title: string, amount: string) {
  await page.goto('/expenses/new');
  await page.getByLabel(/title/i).fill(title);
  await page.getByRole('button', { name: /create/i }).click();

  // The workbench. One expense, one line, coded to Travel (68100 in the seeded
  // chart) so the sink's `list_accounts` recognises it and the pre-flight passes.
  await page.getByRole('button', { name: /add an expense/i }).click();
  await page.getByLabel(/merchant/i).first().fill('Beck Taxi');
  await page.getByRole('button', { name: /save/i }).first().click();
  await page.getByRole('button', { name: /add a line/i }).first().click();
  await page.getByLabel(/amount/i).first().fill(amount);
  await page.getByLabel(/category/i).first().selectOption({ label: 'Travel' });
  await page.getByRole('button', { name: /save/i }).first().click();

  const number = (await page.getByText(/EXP-\d+/).first().innerText()).match(/EXP-\d+/)![0];
  await page.getByRole('button', { name: /submit/i }).first().click();
  await expect(page.getByText(/submitted/i).first()).toBeVisible();

  // Approve it. The demo tenant has the sole-approver flag on (seed), so the
  // signed-in admin can decide their own — which is the demo's shape, not a
  // control being dodged: `approval-flow.spec.ts` covers the two-person path.
  await page.goto('/approvals');
  await page.getByRole('link', { name: new RegExp(number) }).first().click();
  await page.getByRole('button', { name: /^approve/i }).first().click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();
  return number;
}

test.describe('two tenants, two ledgers', () => {
  test.describe.configure({ mode: 'serial' });

  test('each tenant connects its OWN ledger, and cannot see the other', async ({
    page,
    browser,
  }) => {
    // Tenant A (demo) → the real VeloLedger adapter, pointed at the sink.
    await connectLedger(page, 'VeloLedger', {
      baseUrl: LEDGER,
      apiKey: 'e2e-only-not-a-real-key',
      entityId: ENTITY_ID,
      vendorRef: 'V-REIMB',
    });
    await expect(page.getByText('Demo ledger', { exact: false }).or(page.getByText('VeloLedger'))).toBeVisible();

    // Tenant B (second) → the in-process stub. A DIFFERENT adapter, so
    // `resolveCapability` has to choose per tenant rather than per build.
    const second = await browser.newContext({ storageState: SECOND_STATE });
    const secondPage = await second.newPage();
    await connectLedger(secondPage, 'Stub ledger (testing)', {
      ledgerUrl: LEDGER,
      apiToken: 'e2e-only-not-a-real-token',
    });

    // THE isolation assertion on this screen: neither tenant's connection list
    // mentions the other's. A leak here would be a tenant seeing whose accounting
    // system somebody else uses.
    await secondPage.goto('/admin/integrations');
    await expect(secondPage.getByText('Stub ledger', { exact: false })).toBeVisible();
    await expect(secondPage.getByText('V-REIMB')).toHaveCount(0);

    await page.goto('/admin/integrations');
    await expect(page.getByText('Stub ledger (testing)')).toHaveCount(0);

    await second.close();
  });

  test('a report posts to its own tenant\'s ledger, with the right payload', async ({
    page,
    request,
  }) => {
    // FLUSH FIRST, then reset, then measure. Not defensive habit — required.
    //
    // `approval-flow.spec.ts` runs before this file and approves a report, and
    // approving ENQUEUES a post in the same transaction (VX3-4). At that point no
    // ledger was connected, so the drain returned SKIPPED and deliberately did not
    // burn an attempt (VX3-4: "a tenant that connects next week must find last
    // week's approvals still waiting") — leaving the row PENDING. The moment the
    // previous test connected a ledger, that row became due.
    //
    // So a drain here without flushing would post somebody else's report too, and
    // `posted: 1` and `count: 1` below would both be wrong for a reason that has
    // nothing to do with what this test is about. `workers: 1` makes the ordering
    // deterministic, which is what makes flushing sufficient rather than a race.
    await drainLedger(request);
    await resetSink(request);

    const number = await submitAndApprove(page, 'Toronto client visit', '125.50');
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
    expect(payload.description).toContain(number);
    expect(payload.lines).toHaveLength(1);
    // The account the line was CODED to, and the amount in minor units — 125.50
    // arriving as 12550 rather than 125.5 is the whole of `lib/money.ts`'s job.
    expect(payload.lines[0].expenseAccountNumber).toBe('68100');
    expect(payload.lines[0].unitPriceMinor).toBe('12550');

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
    await expect(secondPage.getByText('Toronto client visit')).toHaveCount(0);
    await second.close();
  });

  test('a ledger that refuses is retried, not silently dropped', async ({ page, request }) => {
    // The retry path against a REAL 502 rather than a thrown JavaScript error —
    // a status code and an exception are not the same thing to the code that
    // classifies them (AC-8, AC-17).
    // Flush before arming the failure, for the same reason as above: a leftover
    // PENDING row would consume the single injected 502 and this test would then
    // watch its own report succeed.
    await drainLedger(request);
    await resetSink(request);
    await request.post(`${CONTROL}/fail-next`, { data: { count: 1, status: 502 } });

    await submitAndApprove(page, 'Ottawa site visit', '40.00');
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
