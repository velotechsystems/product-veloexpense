import { expect, test } from '@playwright/test';

/**
 * f26 — the receipts address on /preferences and under the expense report list.
 *
 * The e2e server runs WITHOUT `INBOUND_EMAIL_DOMAIN` (playwright.config.ts sets no inbound
 * mail, as prod has none today), so this drives the not-configured state end to end: the card
 * says receipts by email is not set up, rather than vanishing or showing an address that would
 * drop mail, and the list's hint stays silent. The configured state — the address, the copy
 * button, the send-from email — is pinned by `components/receipts/ReceiptsEmailAddress.test.tsx`
 * and `server/routers/receiptsEmail.db.test.ts`, the latter against a real database.
 *
 * The default storage state is the admin's, who can create reports.
 */

test('Preferences says receipts by email is not set up where this server receives no mail', async ({
  page,
}) => {
  await page.goto('/preferences');
  const card = page.getByTestId('receipts-email-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('Email your receipts', { exact: true })).toBeVisible();
  await expect(page.getByTestId('receipts-email-not-configured')).toHaveText(
    'Receipts by email is not set up here yet. Upload receipts from your expense reports instead.',
  );
  await expect(page.getByTestId('receipts-email-address')).toHaveCount(0);
});

test('the expense report list shows no receipts-email hint where there is no address', async ({
  page,
}) => {
  // Wait for the procedure's answer rather than asserting absence before it could arrive.
  const answered = page.waitForResponse((r) => r.url().includes('receiptsEmail.mine'));
  await page.goto('/expenses');
  await answered;
  await expect(page.getByTestId('receipts-email-hint')).toHaveCount(0);
});
