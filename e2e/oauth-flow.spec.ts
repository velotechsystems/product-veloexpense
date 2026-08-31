/**
 * VX3-9b — THE OAUTH REDIRECT, WALKED IN A BROWSER.
 *
 * ── What this proves that 26 vitest assertions cannot ───────────────────────
 *
 * `test/integration-oauth.db.test.ts` covers the state row, the exchange, the
 * rotation, the re-consent path and the tenancy of all of it — by calling
 * `completeAuthorisation` directly. What no test in this repo has ever done is the
 * part that defines the feature: **the round trip leaves the product and comes
 * back**. An admin presses a button, the browser goes somewhere else, a person
 * consents at a far end, and the far end sends them back to a route that has NO
 * SESSION and must work anyway.
 *
 * That gap is not theoretical. VX2-10's `/approve` form had been merged, reviewed
 * and shipped, and was dead on arrival — the same shape of flow, discovered the
 * same way. Until this file, `/api/integrations/[slug]/callback` had never been
 * reached by a browser at all.
 *
 * ── The far end is a real HTTP server serving a real page ───────────────────
 *
 * `stub-oauth`'s authorize URL is `https://stub.invalid` by default — unreachable
 * ON PURPOSE, so a vitest suite that reaches for the network fails loudly. VX3-9b
 * added `INTEGRATIONS_STUB_AUTHORIZE_URL`, pointed by `playwright.config.ts` at
 * `scripts/e2e-ledger.mjs`, which serves a consent page with an Allow button and a
 * Deny button. Both redirect with a GET, because that is what every real provider
 * does and what the callback route has to survive.
 *
 * ── And it is the first exercise of the buttons #66 fixed ───────────────────
 *
 * AC-20 (a disconnect could never be undone) and AC-21 (a disconnect left the
 * refresh token in the row) were both closed one PR ago, by code and by vitest.
 * Nobody had pressed Disconnect. The last test here does.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  LEDGER,
  authorizationsAtSink,
  billsAtSink,
  drainLedger,
  drainNotifications,
  resetSink,
  submitAndApprove,
  wipeIntegrations,
} from './helpers';

const ADAPTER = 'Stub ledger via authorisation (testing)';
const LABEL = 'Demo ledger by consent';

/** Per-run id, because the demo tenant is not reset between runs. */
const RUN = Date.now().toString(36);
const TITLE = `E2E oauth post ${RUN}`;

/** Connect the OAUTH2 adapter. It has NO config fields — the whole point. */
async function connectByConsent(page: Page) {
  await page.goto('/admin/integrations');
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: `Connect ${ADAPTER}` }),
  });
  await expect(form, `no connect form for ${ADAPTER} — is INTEGRATIONS_ENABLE_STUB set?`)
    .toHaveCount(1);
  await form.locator('[name="label"]').fill(LABEL);
  await form.getByRole('button', { name: `Connect ${ADAPTER}` }).click();
  await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
}

/** The row for our connection, so a button can be pressed on it and no other. */
function ourRow(page: Page) {
  return page.getByRole('row').filter({ hasText: LABEL });
}

test.describe('connecting a ledger by authorisation', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Nothing connected in the demo tenant. Required twice over since AC-22: a
    // leftover ledger would not merely hide the connect form, it would make the
    // posting path REFUSE to choose — correctly, and confusingly.
    await wipeIntegrations(['demo']);
  });

  test.afterAll(async ({ request }) => {
    await drainNotifications(request);
  });

  test('an OAUTH2 connection arrives INACTIVE, and says so', async ({ page, request }) => {
    await resetSink(request);
    await connectByConsent(page);

    // Not connected yet, and the screen must not pretend otherwise: nothing is
    // authorised, there is no refresh token, and `0020`'s `oauth_complete` CHECK
    // would refuse a row claiming active. The primary action is a redirect, so the
    // button says "Connect" rather than "Save".
    await expect(ourRow(page)).toContainText('disconnected');
    await expect(ourRow(page).getByRole('button', { name: 'Connect', exact: true })).toBeVisible();

    // And the Test button tells the truth about it — this is AC-19's regression
    // surface: it once said "Not authorised yet" forever, including AFTER a
    // successful authorisation.
    await ourRow(page).getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('The test failed.')).toBeVisible();
    await expect(page.getByText(/no refresh token|Authorise it again|Not authorised/i).first())
      .toBeVisible();
  });

  test('the admin consents at the far end and comes back connected', async ({ page, request }) => {
    await page.goto('/admin/integrations');
    await ourRow(page).getByRole('button', { name: 'Connect', exact: true }).click();

    // ── We are now at the FAR END, in the same browser ────────────────────────
    await expect(page).toHaveURL(new RegExp(`^${LEDGER}/oauth/authorize\\?`));
    await expect(page.getByRole('heading', { name: 'Stub Ledger' })).toBeVisible();

    // The app built the redirect_uri, and that is the one thing on this page which
    // is the product's own doing: APP_URL plus the adapter's slug. A wrong one is
    // how every OAuth integration fails in a deployed environment (NT-14 is the
    // same defect for emailed links).
    const asked = await authorizationsAtSink(request);
    expect(asked.count).toBe(1);
    expect(asked.requests[0].redirectUri).toMatch(
      /^http:\/\/localhost:\d+\/api\/integrations\/stub-oauth\/callback$/,
    );
    // The state is a credential, so it is long and it is not the installation id.
    expect(asked.requests[0].state.length).toBeGreaterThan(30);

    await page.getByRole('button', { name: 'Allow' }).click();

    // ── …and back, through a route with no session at all ────────────────────
    //
    // ON THE ORIGIN THE ADMIN STARTED FROM, which is the assertion that found
    // AC-23. The callback built its way onward from `req.nextUrl.origin` while the
    // redirect_uri had been built from APP_URL, and in a standalone server bound to
    // 0.0.0.0 those differ: this landed on `http://0.0.0.0:3000/admin/integrations`
    // — an origin the session cookie does not cover — and middleware bounced the
    // admin to /login AFTER a successful authorisation. Anchored at ^, because a
    // pattern that only looked for the path passed while the origin was wrong.
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/admin\/integrations\?/);
    await expect(page.getByText(/is connected/)).toBeVisible();
    await expect(ourRow(page)).not.toContainText('disconnected');

    // The Test button now holds a real token. Before VX3-9a's fix it said "Not
    // authorised yet" at exactly this point, which is the defect this asserts
    // against in the one place that exercises the whole stack.
    await ourRow(page).getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('The connection works.')).toBeVisible();
    await expect(page.getByText(/access-1/)).toBeVisible();
  });

  test('an approved report posts with the token that authorisation produced', async ({
    page,
    browser,
    request,
  }) => {
    // The end-to-end claim: a browser consented, and an approved report reaches the
    // far end carrying the access token that consent produced. Nothing in vitest
    // spans those two facts, because the app under test is another process.
    await drainLedger(request);
    await resetSink(request);

    await submitAndApprove(page, browser, TITLE, '19.50');
    expect(await drainLedger(request)).toMatchObject({ posted: 1 });

    const received = await billsAtSink(request);
    expect(received.count).toBe(1);
    // Through the OAUTH2 adapter, with the token in the header a far end reads.
    expect(received.bills[0].via).toBe('stub-oauth');
    expect(received.bills[0].authorization).toBe('Bearer access-1');
    // And the company the admin chose at the consent screen came back with the
    // callback and was stored — vendor-neutrally, as `external_account_id`.
    expect(received.bills[0].externalAccount).toBe('e2e-company');
  });

  test('Deny is a normal outcome, and changes nothing', async ({ page, request }) => {
    await resetSink(request);
    // Re-authorising an already-connected OAUTH2 row is offered as "Re-authorise",
    // which is the button an admin presses when a connection stopped working.
    await page.goto('/admin/integrations');
    await ourRow(page).getByRole('button', { name: /Re-authorise|Authorise again/ }).click();
    await expect(page.getByRole('heading', { name: 'Stub Ledger' })).toBeVisible();

    await page.getByRole('button', { name: 'Deny' }).click();

    // A sentence on the screen, not a stack trace and not a JSON body: a person is
    // looking at this mid-task.
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/admin\/integrations\?/);
    await expect(page.getByText(/declined at Stub Ledger|refused the connection/)).toBeVisible();
    // And the connection that already worked still works: a refusal at the far end
    // must not deactivate what was there.
    await ourRow(page).getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('The connection works.')).toBeVisible();
  });

  test('a REPLAYED callback does nothing, and says the same thing as an unknown one', async ({
    page,
  }) => {
    // The state is single-use, which is the whole of the callback's security: the
    // route trusts nothing but that row. Replaying a real, already-consumed
    // callback URL is the attack this is shaped against, and "unknown", "used" and
    // "expired" deliberately share one message so the wording cannot be used to
    // probe for valid states.
    let callbackUrl: string | null = null;
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/api/integrations/stub-oauth/callback?')) callbackUrl = u;
    });

    await page.goto('/admin/integrations');
    await ourRow(page).getByRole('button', { name: /Re-authorise|Authorise again/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByText(/is connected/)).toBeVisible();

    expect(callbackUrl, 'the callback URL should have been observed').not.toBeNull();
    await page.goto(callbackUrl!);
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/admin\/integrations\?/);
    await expect(page.getByText(/no longer valid|not valid|expired|already/i).first())
      .toBeVisible();
  });

  test('a second ledger cannot be connected while this one can post (AC-22)', async ({ page }) => {
    // The guard, through the UI it exists to protect. `0016` allows one active
    // installation per INTEGRATION and this is a different integration, so before
    // AC-22 both would have been active and `resolveCapability` would have picked
    // whichever row Postgres returned first — physical heap order.
    await page.goto('/admin/integrations');
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Connect Stub ledger (testing)' }),
    });
    await expect(form).toHaveCount(1);
    await form.locator('[name="config.ledgerUrl"]').fill(LEDGER);
    await form.locator('[name="config.apiToken"]').fill('e2e-only-not-a-real-token');
    await form.getByRole('button', { name: 'Connect Stub ledger (testing)' }).click();

    // Refused, naming the connection that is already doing the job — "a conflict
    // exists" is not something anybody can act on.
    await expect(page.getByTestId('error-banner')).toContainText(LABEL);
    await expect(page.getByTestId('error-banner')).toContainText('Disconnect');
    // And nothing was half-connected: the connections table still holds one row
    // plus its header. Counting rows rather than matching the adapter's name,
    // because the name is rendered joined to the code by a middot and asserting on
    // that is asserting on punctuation.
    await expect(page.getByRole('row')).toHaveCount(2);
  });

  test('Disconnect destroys the authorisation, and it can be connected again', async ({ page }) => {
    // #66 closed AC-20 and AC-21 in code and in vitest. This is the first time
    // anybody has pressed these two buttons in order.
    await page.goto('/admin/integrations');
    await ourRow(page).getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('Disconnected, and the stored credentials were deleted.'))
      .toBeVisible();
    await expect(ourRow(page)).toContainText('disconnected');

    // AC-21: the token is gone, so the Test button can no longer authenticate.
    await ourRow(page).getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('The test failed.')).toBeVisible();

    // AC-20: and the same integration can be connected AGAIN. Before #66 this was
    // impossible — the connect form sends the slug as the `code`, which collided
    // with the row the disconnect kept, and the admin was told "the code
    // 'stub-oauth' is already used here" forever.
    await connectByConsent(page);
    await ourRow(page).getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByText(/is connected/)).toBeVisible();
    await ourRow(page).getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('The connection works.')).toBeVisible();
  });
});
