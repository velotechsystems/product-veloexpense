import { expect, test } from '@playwright/test';
import { connectionAudits } from './helpers';

/**
 * w5-02a — /admin/slack: an administrator connects the organization's own Slack app, and
 * Slack becomes a channel people can choose.
 *
 * The token is a made-up `xoxb-` string: nothing here calls Slack. The Test connection
 * button is not pressed for that reason — it would reach slack.com — and is covered by
 * `lib/notifications/slack.test.ts` (`verifySlackToken`). The DM itself is
 * `test/slack-delivery.db.test.ts`.
 *
 * One test, connect → use → disconnect, so no later spec inherits a connected Slack
 * (`e2e/notification-preferences.spec.ts` asserts the disconnected screen). The default
 * storage state is the admin's.
 */
test('an admin connects Slack, people can choose it, and disconnecting takes it away', async ({ page }) => {
  const since = new Date(Date.now() - 5_000);
  await page.goto('/admin/slack');
  await expect(page.getByRole('heading', { name: 'Connect Slack' })).toBeVisible();
  // ExpenseOS's setup steps, before anything is pasted.
  await expect(page.getByText('First, in Slack:')).toBeVisible();
  await expect(page.getByText(/Bot Token Scopes: add chat:write/)).toBeVisible();
  // w5-02b: where Slack sends replies — this organization's own address, or a plain
  // statement that this deployment has none.
  await expect(page.getByRole('heading', { name: 'Events Request URL' })).toBeVisible();

  await page.getByLabel(/Bot User OAuth Token/).fill('xoxb-e2e-not-a-real-token');
  await page.getByRole('button', { name: 'Connect Slack' }).click();
  try {
    await expect(page.getByText(/Connected\. Press/)).toBeVisible();
    // A secret is never rendered back, only that it is set.
    await expect(page.getByLabel(/Bot User OAuth Token · already set/)).toHaveValue('');
    expect(await page.content()).not.toContain('xoxb-e2e-not-a-real-token');
    // No signing secret yet, and the screen says what that costs.
    await expect(page.getByText(/replies in Slack will be refused without it/)).toBeVisible();

    // Slack is now a channel people can set, with the "Slack account" section under it.
    await page.goto('/notifications/preferences');
    const slack = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Comment on a report', exact: true }) })
      .locator('form')
      .filter({ hasText: /^Slack/ });
    await expect(slack).not.toContainText('not connected');
    await expect(slack.getByRole('button', { name: 'Save' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Slack account' })).toBeVisible();
    await expect(page.getByText(/hasn't been looked up yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/^Cleared\./)).toBeVisible();
  } finally {
    await page.goto('/admin/slack');
    await page.getByRole('button', { name: 'Disconnect and delete the token' }).click();
  }
  await expect(page.getByText(/Disconnected, and the stored token/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect Slack' })).toBeVisible();

  // f50: connecting and disconnecting are in the audit chain — and the token is not.
  const rows = await connectionAudits('demo', 'slack', since);
  expect(rows.map((r) => r.action)).toEqual(['INTEGRATION_REMOVED', 'INTEGRATION_INSTALLED']);
  for (const r of rows) expect(r.raw).not.toContain('xoxb-e2e-not-a-real-token');

  await page.goto('/notifications/preferences');
  await expect(page.getByRole('heading', { name: 'Slack account' })).toHaveCount(0);
});

test('saving without a token says what is missing', async ({ page }) => {
  await page.goto('/admin/slack');
  // `required` stops the browser first; remove it to reach the server's own refusal.
  await page.getByLabel(/Bot User OAuth Token/).evaluate((el) => el.removeAttribute('required'));
  await page.getByRole('button', { name: 'Connect Slack' }).click();
  await expect(page.getByText('Paste the Bot User OAuth Token (xoxb-…) to connect Slack.')).toBeVisible();
});
