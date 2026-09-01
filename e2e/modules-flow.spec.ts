/**
 * VX4-1 part 2 — A MODULE TURNED OFF, IN A BROWSER, WITH THE POSTING STOPPING.
 *
 * ── What this proves that 18 vitest assertions cannot ──────────────────────
 *
 * `test/modules.db.test.ts` proves the gate refuses and the guard proves there are
 * no gaps in it. Neither can show the thing an admin actually experiences: press a
 * toggle, and a tenant's accounting stops — the screens explain themselves, an
 * approved report waits instead of failing, and turning it back on lets the same
 * report go. Three layers have to agree for that to be true (the RLS policy from
 * `0022`, the service gate from part 1, and the queue's no-attempt-burnt rule from
 * VX3-4), and this is the only place they are exercised together.
 *
 * ── Ordering, and why this file does not depend on being last ──────────────
 *
 * Alphabetically this lands between `ledger-flow` and `oauth-flow`, so a spec that
 * left the module off would break the file after it. It restores the module in an
 * `afterAll` — and, because a spec that relies on another spec's cleanup fails the
 * day somebody adds a file whose name sorts between them, `wipeIntegrations()` in
 * `e2e/helpers.ts` also re-enables accounting for the tenants it wipes. Belt and
 * braces, one line, and the coupling is gone.
 */
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  LEDGER,
  billsAtSink,
  connectLedger,
  drainLedger,
  drainNotifications,
  resetSink,
  submitAndApprove,
  wipeIntegrations,
} from './helpers';

const LABEL = 'Demo ledger for the module test';
const RUN = Date.now().toString(36);
const TITLE = `E2E module gate ${RUN}`;

/** Put the module back however this file exits — see the header on ordering. */
async function setAccounting(enabled: boolean) {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
       SELECT id, 'accounting', $1, clock_timestamp() FROM organization WHERE slug = 'demo'
       ON CONFLICT (organization_id, module_code)
       DO UPDATE SET enabled = $1, updated_at = clock_timestamp()`,
      [enabled],
    );
  } finally {
    await pool.end();
  }
}

function moduleRow(page: Page) {
  return page.getByRole('row').filter({ hasText: 'Accounting integrations' });
}

test.describe('turning a module off', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await wipeIntegrations(['demo']);
  });

  test.afterAll(async ({ request }) => {
    // Whatever happened above, the tenant leaves with accounting ON.
    await setAccounting(true);
    await drainNotifications(request);
  });

  test('the Modules screen shows what is enabled, and what this build cannot serve', async ({
    page,
  }) => {
    await page.goto('/admin/modules');
    await expect(moduleRow(page)).toContainText('enabled');
    await expect(moduleRow(page).getByRole('button', { name: 'Turn off' })).toBeVisible();

    // An unavailable module is SHOWN, greyed, not hidden: a customer asking for
    // Budgets is a sales answer and an empty list is not one.
    const budgets = page.getByRole('row').filter({ hasText: 'Budgets' });
    await expect(budgets).toContainText('not in this build');
    await expect(budgets.getByRole('button')).toHaveCount(0);

    // And the screen warns what a toggle does before it is pressed, because
    // "hides, does not delete" is the thing an admin needs to know first.
    await expect(page.getByText(/hides its data; it does not delete it/i)).toBeVisible();
  });

  test('an approved report is queued while the module is OFF, and posts when it is back on', async ({
    page,
    browser,
    request,
  }) => {
    // A connected ledger first, so the only thing changing below is the module.
    await connectLedger(page, 'VeloLedger', LABEL, {
      baseUrl: LEDGER,
      apiKey: 'e2e-only-not-a-real-key',
      entityId: process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1',
      vendorRef: 'V-MOD',
    });
    await drainLedger(request);
    await resetSink(request);

    // ── OFF, through the screen ─────────────────────────────────────────────
    await page.goto('/admin/modules');
    await moduleRow(page).getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
    await expect(moduleRow(page)).toContainText('off');

    // The accounting screens now EXPLAIN themselves rather than looking empty,
    // which is the AC-22 property this part of the ticket exists for.
    await page.goto('/admin/integrations');
    await expect(
      page.getByText('Accounting integrations are not enabled for this organization.'),
    ).toBeVisible();
    // …and the connection is genuinely gone from view: `0022` makes the row
    // invisible, not just the button absent.
    await expect(page.getByText(LABEL, { exact: true })).toHaveCount(0);

    await page.goto('/admin/chart-of-accounts');
    await expect(
      page.getByText('Accounting integrations are not enabled for this organization.'),
    ).toBeVisible();
    // The seeded 28-account chart is hidden while the module is off.
    await expect(page.getByText('68100')).toHaveCount(0);

    // ── a report approved while the module is off ──────────────────────────
    await submitAndApprove(page, browser, TITLE, '17.25');
    const off = await drainLedger(request);
    // NOT posted, NOT failed: waiting. VX3-4's rule, extended to modules — a
    // tenant who buys accounting next month must find this month's approvals
    // still queued, so no attempt is burnt.
    expect(off).toMatchObject({ posted: 0 });
    expect((await billsAtSink(request)).count).toBe(0);

    await page.goto('/admin/ledger-queue');
    // The BANNER, by its exact headline. The first version matched
    // /not enabled for this organization/ and hit a strict-mode violation on two
    // elements — which was the test failing while the feature worked, and the second
    // element is worth asserting on its own terms, below.
    await expect(
      page.getByText('Accounting is turned off, so nothing is posting.'),
    ).toBeVisible();

    // THE REASON IS ON THE ROW, which is the part-1 claim made visible: the drain
    // writes why it skipped rather than leaving an operator with a silent queue.
    // Scoped to a cell, because the banner carries the same sentence.
    const reasonCell = page
      .getByRole('cell')
      .filter({ hasText: /not enabled for this organization/ });
    await expect(reasonCell).toHaveCount(1);

    // And NO ATTEMPT WAS BURNT — the row still says "waiting", not "failed, will
    // retry" or "out of attempts". VX3-4's rule is the whole reason a tenant can buy
    // the module next month and still find this month's approvals here.
    await expect(page.getByText('waiting').first()).toBeVisible();
    await expect(page.getByText(/\d+ attempts?/)).toHaveCount(0);

    // ── ON again, and the SAME report goes ─────────────────────────────────
    await page.goto('/admin/modules');
    await moduleRow(page).getByRole('button', { name: 'Turn on' }).click();
    await expect(moduleRow(page)).toContainText('enabled');

    // Nothing was lost by the round trip: the connection is back, and so is the
    // chart. That is what "hides, does not delete" means in practice.
    await page.goto('/admin/integrations');
    await expect(page.getByText(LABEL, { exact: true })).toBeVisible();

    const back = await drainLedger(request);
    expect(back).toMatchObject({ posted: 1 });
    const received = await billsAtSink(request);
    expect(received.count).toBe(1);
    expect(received.bills[0].payload).toMatchObject({ vendorRef: 'V-MOD' });
  });
});
