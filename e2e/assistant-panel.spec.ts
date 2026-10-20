import { expect, test } from '@playwright/test';
import { signIn } from './support/actors';

/**
 * VeloExpense (w6-03) — the assistant with no key. Not ported: ExpenseOS has no such spec,
 * because ExpenseOS's e2e always switches an `anthropic` integration on before it opens the
 * panel (assistant-actions.spec.ts). VeloExpense's key is the server's ANTHROPIC_API_KEY (d40,
 * d90), which the e2e server has only when the shell does, so this is the panel most runs see.
 *
 * What it pins: the assistant is CORE (d89), so the launcher is in every member's top bar with
 * no module to switch on; opening it with no key says what is wrong and who can fix it, rather
 * than offering a composer whose every turn would fail; and the review queue is an admin screen.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!!process.env.ANTHROPIC_API_KEY, 'the server has a key: assistant-actions.spec.ts drives the panel');

test('with no key, the panel says the assistant is not configured, and offers no composer', async ({
  page,
}) => {
  await signIn(page, 'employee');
  await page.goto('/expenses');
  const launcher = page.getByRole('button', { name: 'Open the assistant' });
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(page.getByText('The assistant is not available in this workspace.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/The Claude API key is not set for this deployment/)).toBeVisible();
  await expect(page.getByPlaceholder('Ask about VeloExpense…')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('The assistant is not available in this workspace.')).toBeHidden();
});

test('the chat route answers 503 "not configured" rather than failing a turn', async ({ page }) => {
  await signIn(page, 'employee');
  const res = await page.request.post('/api/assistant/chat', {
    data: { message: 'hello' },
  });
  expect(res.status()).toBe(503);
});

test('the review queue is an admin screen', async ({ page }) => {
  await signIn(page, 'admin');
  const ok = await page.goto('/admin/assistant-feedback');
  expect(ok?.status()).toBe(200);
  await expect(page.getByText('Assistant feedback').first()).toBeVisible();

  await signIn(page, 'employee');
  const refused = await page.goto('/admin/assistant-feedback');
  expect(refused?.status()).toBe(403);
});
