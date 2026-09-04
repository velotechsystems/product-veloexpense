/**
 * VX4-8 part 1 / UD-8 — the AP_QUEUE half, in a running system.
 *
 * ── WHY THIS IS AN E2E AND NOT ANOTHER DB TEST ──────────────────────────────
 *
 * `test/posting-trigger.db.test.ts` already proves the mechanism: HELD is what an
 * approval writes under AP_QUEUE, `duePosts` cannot see it, `claimPost` refuses
 * it, `releaseHold` moves it. What no vitest can prove is the part a finance team
 * actually depends on:
 *
 *   1. THE POLLER, RUNNING, LEAVES IT ALONE. The db test asserts `duePosts()`
 *      returns nothing. This drains the real drain route against a real ledger
 *      sink and asserts the sink is still empty — which is the difference between
 *      "the query excludes it" and "nothing sent it".
 *   2. A PERSON CAN RELEASE IT FROM THE SCREEN. The setting form and the release
 *      button are new UI with no unit test, and this product's standing lesson is
 *      that nobody had ever clicked these screens.
 *
 * ── THE SEEDED TENANT IS AUTOMATIC, AND THIS FILE PUTS IT BACK ──────────────
 *
 * `scripts/seed.mjs` sets the demo tenant to AUTOMATIC explicitly, because ten
 * specs across VX3-4, VX3-9 and VX4-1 approve a report and then assert something
 * reached the ledger. This file flips it, and restores it in `afterAll` — with
 * `workers: 1` and `fullyParallel: false`, a spec that leaves the fixture changed
 * is a spec that breaks whichever file happens to run next, and the failure lands
 * somewhere with no connection to the cause.
 */
import { test, expect } from '@playwright/test';
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

const ENTITY_ID = process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';
const LABEL = 'Demo ledger for the AP queue';
const RUN = Date.now().toString(36);
const TITLE = `E2E AP queue ${RUN}`;

/** The radio labels on /admin/ledger-queue. */
const HOLD_FOR_A_PERSON = 'Somebody here sends it';
const POST_ON_APPROVAL = 'Approval sends it';

async function setTrigger(page: import('@playwright/test').Page, label: string) {
  await page.goto('/admin/ledger-queue');
  await page.getByLabel(label).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel(label)).toBeChecked();
}

test.describe('who sends an approved report', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await wipeIntegrations(['demo']);
  });

  test.afterAll(async ({ browser, request }) => {
    // Put the fixture back. See the header — this is not tidiness.
    const context = await browser.newContext({ storageState: 'e2e/.auth/state.json' });
    const page = await context.newPage();
    await setTrigger(page, POST_ON_APPROVAL);
    await context.close();
    await drainNotifications(request);
  });

  test('an approval holds instead of posting, and a person releases it', async ({
    page,
    browser,
    request,
  }) => {
    await connectLedger(page, 'VeloLedger', LABEL, {
      baseUrl: LEDGER,
      apiKey: 'e2e-only-not-a-real-key',
      entityId: ENTITY_ID,
      vendorRef: 'V-REIMB',
    });

    // Flush anything an earlier file left queued, THEN reset the sink, so the
    // count below belongs to this test. Same order and same reason as
    // `ledger-flow.spec.ts`.
    await drainLedger(request);
    await resetSink(request);

    await setTrigger(page, HOLD_FOR_A_PERSON);

    // UNDER $25, and this file learned it the hard way rather than by reading
    // `budget-flow.spec.ts`'s header, which states the rule: the starter rules
    // include RECEIPT_REQUIRED at BLOCK severity above $25.00, and whether they
    // are installed depends on whether `expense-flow.spec.ts` has run yet. At
    // $41.50 this spec PASSED in the full suite — it sorts before the file that
    // installs them — and failed the moment it was run on its own. A spec whose
    // outcome depends on which files ran first is a spec that passes for the
    // wrong reason, and it passed for the wrong reason here.
    await submitAndApprove(page, browser, TITLE, '23.75');

    // ── 1. it is queued, and it is not going anywhere ───────────────────────
    await page.goto('/admin/ledger-queue');
    const row = page.getByRole('row', { name: new RegExp(TITLE) });
    await expect(row).toContainText('waiting for someone to send it');

    // THE ASSERTION THIS FILE EXISTS FOR. The drain route is the poller; it runs
    // against a real sink; the sink stays empty. A query that merely excluded HELD
    // would pass the db test and could still fail here.
    const drained = await drainLedger(request);
    expect(drained.posted ?? 0).toBe(0);
    expect((await billsAtSink(request)).count).toBe(0);

    // ── 2. a person releases it, and only then does it go ───────────────────
    await row.getByRole('button', { name: 'Send to the ledger' }).click();
    await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toContainText(
      'drafted in the ledger',
    );

    expect((await billsAtSink(request)).count).toBe(1);

    // The release button is gone, because the row is no longer held — asserted
    // rather than assumed, since a button that stays clickable on a posted row is
    // how a double-post starts.
    await expect(
      page.getByRole('row', { name: new RegExp(TITLE) }).getByRole('button', {
        name: 'Send to the ledger',
      }),
    ).toHaveCount(0);
  });

  test('switching back to automatic does not send what is already held', async ({
    page,
    browser,
    request,
  }) => {
    await drainLedger(request);
    await resetSink(request);
    await setTrigger(page, HOLD_FOR_A_PERSON);

    const title = `${TITLE} still held`;
    // Under $25 for the same reason as above.
    await submitAndApprove(page, browser, title, '17.25');

    await setTrigger(page, POST_ON_APPROVAL);

    // The surprising half, and the one the screen states in so many words: this
    // report was approved while a person was meant to decide, so it keeps waiting
    // for one. Posting a week of these because a setting changed is the "wrong
    // posting in a general ledger" the setting exists to prevent.
    await page.goto('/admin/ledger-queue');
    await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText(
      'waiting for someone to send it',
    );
    await drainLedger(request);
    expect((await billsAtSink(request)).count).toBe(0);
  });
});
