import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The notification preferences screen: email is a channel a person can actually set.
 *
 * Found by w5-00 (the digest). The digest only ever carries comment emails, and comment
 * emails are off by default, so the digest reaches somebody only once they turn comment
 * emails on — and this screen kept every EMAIL control disabled from VX2-8 onwards, with a
 * note saying email had not shipped. Nobody could opt in, and nobody could opt out of any
 * email either. Slack stays disabled until Slack is connected (w5-02).
 *
 * The default storage state is the admin's, who has the screen like everybody else.
 */

/** One channel's form inside one event's section. */
function cell(page: Page, event: string, channel: 'In-app' | 'Email' | 'Slack'): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: event, exact: true }) })
    .locator('form')
    .filter({ hasText: new RegExp(`^${channel}`) });
}

test('a person can turn comment emails on, and back to the default', async ({ page }) => {
  await page.goto('/notifications/preferences');
  const email = cell(page, 'Comment on a report', 'Email');
  await expect(email).toHaveCount(1);

  await email.getByRole('radio', { name: 'On', exact: true }).check();
  await email.getByRole('button', { name: 'Save' }).click();
  await expect(cell(page, 'Comment on a report', 'Email')).toContainText('Your choice: on');

  // Put it back, so no later spec inherits an opted-in admin.
  const again = cell(page, 'Comment on a report', 'Email');
  await again.getByRole('radio', { name: /^Default/ }).check();
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(cell(page, 'Comment on a report', 'Email')).toContainText(
    'Following the default (off)',
  );
});

test('Slack is shown but not settable until it is connected', async ({ page }) => {
  await page.goto('/notifications/preferences');
  const slack = cell(page, 'Comment on a report', 'Slack');
  await expect(slack).toContainText('not connected for your organization yet');
  await expect(slack.getByRole('button', { name: 'Save' })).toBeDisabled();
  // And email is not: the note is Slack's alone.
  await expect(cell(page, 'Comment on a report', 'Email')).not.toContainText('not connected');
});
