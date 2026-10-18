import { expect, test } from '@playwright/test';

/**
 * w5-04 — /admin/directory-sync: an administrator connects the organization's own Google
 * Workspace, and the screen never shows the key back.
 *
 * The key is a made-up service-account file: it parses (a `client_email` and something that
 * looks like a private key) and nothing here calls Google. Test connection and Sync now are
 * not pressed for that reason — they would reach Google and the queue; the client is
 * `packages/integrations-google/src/client.test.ts`, the sync is
 * `worker/src/handlers/directory-sync.db.test.ts`.
 *
 * One test, connect → change → disconnect, so no later spec inherits a connection. The
 * default storage state is the admin's.
 */
const FAKE_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'e2e-sync@e2e-project.iam.gserviceaccount.com',
  // Split so no secret scanner mistakes this made-up value for a key.
  private_key: ['-----BEGIN ', 'PRIVATE KEY-----\nnot-a-real-key-e2e\n-----END ', 'PRIVATE KEY-----\n'].join(''),
});

test('an admin connects Google Workspace, the key is never shown, and disconnecting deletes it', async ({ page }) => {
  await page.goto('/admin/directory-sync');
  await expect(page.getByRole('heading', { name: 'Connect Google Workspace' })).toBeVisible();
  // The setup steps, and what the sync will and will not do, before anything is pasted.
  await expect(page.getByText('First, in Google:')).toBeVisible();
  await expect(page.getByText(/admin\.directory\.user\.readonly/).first()).toBeVisible();
  await expect(page.getByText(/It never adds anybody/)).toBeVisible();

  await page.getByLabel(/Service account key file/).fill(FAKE_KEY);
  await page.getByLabel('Workspace administrator to act as').fill('it-admin@example.test');
  await page.getByRole('button', { name: 'Connect Google Workspace' }).click();
  try {
    await expect(page.getByText(/Connected\. Press/)).toBeVisible();
    // The account's address is shown — the admin needs it for domain-wide delegation…
    await expect(page.getByText('e2e-sync@e2e-project.iam.gserviceaccount.com')).toBeVisible();
    // …and the key is not, anywhere.
    await expect(page.getByLabel(/Service account key file \(JSON\) · already set/)).toHaveValue('');
    expect(await page.content()).not.toContain('not-a-real-key-e2e');
    await expect(page.getByText('No sync has run yet.')).toBeVisible();
    await expect(page.getByText('never tested')).toBeVisible();

    // Changing the administrator alone keeps the stored key.
    await page.getByLabel('Workspace administrator to act as').fill('other-admin@example.test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/^Saved\./)).toBeVisible();
    await expect(page.getByText('other-admin@example.test').first()).toBeVisible();
    await expect(page.getByText('e2e-sync@e2e-project.iam.gserviceaccount.com')).toBeVisible();
  } finally {
    await page.goto('/admin/directory-sync');
    await page.getByRole('button', { name: 'Disconnect and delete the key' }).click();
  }
  await expect(page.getByText(/Disconnected, and the stored key was deleted/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect Google Workspace' })).toBeVisible();
});

test('a paste that is not a key file says so, without echoing it', async ({ page }) => {
  await page.goto('/admin/directory-sync');
  await page.getByLabel(/Service account key file/).fill('{"hello": "not-a-key-e2e"}');
  await page.getByLabel('Workspace administrator to act as').fill('it-admin@example.test');
  await page.getByRole('button', { name: 'Connect Google Workspace' }).click();
  await expect(page.getByText(/That is not a service account key file/)).toBeVisible();
  expect(await page.content()).not.toContain('not-a-key-e2e');
  await expect(page.getByRole('heading', { name: 'Connect Google Workspace' })).toBeVisible();
});
