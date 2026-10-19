import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/actors';

/**
 * ExpenseOS's two journeys #469 opened (VeloExpense keeps the trip; see below), driven end to end by a model.
 *
 * The tools are unit-tested and every path resolves against `appRouter`, and neither of
 * those answers the question that matters: can a person ASK for a card, or for a trip, and
 * get one. A tool the model cannot assemble the inputs for is a tool that does not exist —
 * which is the whole reason the lookup tools were added alongside the creates, and the
 * reason this test drives a real model rather than asserting a fixture back at itself.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 600_000, mode: 'serial' });

const ASK = 'Ask about VeloExpense…';
const CONFIRM_TITLE = 'Confirm before this runs';
const TAG = `QA-MCP-${Date.now().toString(36)}`;

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: 'Open the assistant' }).click();
  await expect(page.getByPlaceholder(ASK)).toBeVisible({ timeout: 30_000 });
}

async function ask(page: Page, text: string): Promise<string> {
  const input = page.getByPlaceholder(ASK);
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toBeEnabled({ timeout: 300_000 });
  await page.waitForTimeout(1500);
  return page.locator('body').innerText();
}

/** Press Confirm and wait for the run to land. Returns false when nothing was proposed. */
async function confirm(page: Page): Promise<boolean> {
  const btn = page.getByRole('button', { name: 'Confirm', exact: true }).first();
  if (!(await btn.isVisible({ timeout: 10_000 }).catch(() => false))) return false;
  await btn.click();
  await expect(page.getByText('Done.').first()).toBeVisible({ timeout: 240_000 });
  return true;
}

// VeloExpense (w6-03): no integration or module to switch on — the assistant is CORE (d89) and
// its key is the server's ANTHROPIC_API_KEY (d40, d90). Real model calls, so this runs only with
// a key. ExpenseOS's virtual-card journey is not here: VeloExpense has no virtual cards (d50),
// and Assistant 1 removed their tools.
test.skip(!process.env.ANTHROPIC_API_KEY, 'needs ANTHROPIC_API_KEY: these spend real model calls');

test('a person can ask the assistant to create and submit a trip', async ({ page }) => {
  await signIn(page, 'employee');
  await page.goto('/travel');
  await openAssistant(page);

  const out = await ask(
    page,
    `Create a travel request for me: purpose "${TAG} client visit", flying from Vancouver ` +
      `to Toronto, departing in 30 days and returning 4 days later, round trip. ` +
      `Pick my default currency. Create it as a draft first.`,
  );
  console.log('TRIP proposed >>>', out.replace(/\n+/g, ' | ').slice(-900));
  expect(out, 'a trip must be proposed, not performed').toContain(CONFIRM_TITLE);

  const ran = await confirm(page);
  console.log('TRIP confirmed:', ran);
  expect(ran).toBe(true);
  console.log(
    'TRIP after >>>',
    (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(-700),
  );
});
