import { expect, type Page, test } from '@playwright/test';
import { receiptFile } from './fixtures/receiptImage';
import { signIn } from './support/actors';

/**
 * The assistant, driven the way a person drives it: typed into, read, and pressed.
 *
 * Everything else about it is covered off the browser — 23 router tests, 17 on the confirm
 * gate, 14 on the turn loop. What none of that could tell us is whether the PANEL works:
 * whether a question reaches a tool, whether the answer is the asker's own data, and above
 * all whether a mutation the model proposes can reach the database without somebody
 * pressing something. That last one is a security property, and it had no browser test.
 *
 * ## Why this spends real model calls
 *
 * There is no useful stub. The thing under test IS the model deciding to call a tool and
 * the product refusing to let it land unattended; a fake model would assert our own
 * fixture back at us. The calls are few and the questions are blunt on purpose.
 *
 * ## Why it builds its own report
 *
 * Submitting is a state change, and the seeded `qa-activity` reports are what
 * `dashboard.spec.ts` counts. This creates a QA- tagged report of its own, acts on that,
 * and leaves the fixtures alone.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 420_000, mode: 'serial' });

const OPEN = 'Open the assistant';
const ASK = 'Ask about VeloExpense…';
const CONFIRM_TITLE = 'Confirm before this runs';
const NOTHING_YET = 'Nothing has happened yet. This will run only when you confirm it.';

/** Ask, and wait for the turn to settle rather than for a fixed number of seconds. */
async function ask(page: Page, text: string): Promise<string> {
  const input = page.getByPlaceholder(ASK);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(text);
  await input.press('Enter');
  // The composer re-enables when the turn is done; that is the signal, not a sleep.
  await expect(input).toBeEnabled({ timeout: 180_000 });
  await expect
    .poll(async () => (await page.locator('body').innerText()).length, { timeout: 180_000 })
    .toBeGreaterThan(0);
  return page.locator('body').innerText();
}

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: OPEN }).click();
  await expect(page.getByPlaceholder(ASK)).toBeVisible({ timeout: 30_000 });
}

/** A DRAFT report of our own, with one coded, receipted expense, ready to submit. */
async function createSubmittableReport(page: Page, title: string): Promise<void> {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'New report' }).first().click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create report' }).click();
  await page.waitForURL(/\/expenses\/[0-9a-f-]{36}/, { timeout: 60_000 });

  await page.getByRole('button', { name: 'Add expense' }).first().click();
  await page.getByLabel('Vendor').fill('Corner Bistro');
  await page.getByRole('button', { name: 'Add line', exact: true }).first().click();
  await page.getByPlaceholder('Select a category').click();
  await page.getByRole('option').first().click();
  const amount = page.getByLabel('Amount', { exact: true });
  await amount.fill('24.00');
  await amount.blur();
  await page.locator('input[type=file]').last().setInputFiles(receiptFile());
  await expect(page.getByRole('button', { name: 'Submit report' }).first()).toBeEnabled({
    timeout: 60_000,
  });
}

test.describe('the assistant', () => {
  const tag = `QA-ASSIST-${Date.now().toString(36)}`;

  // VeloExpense (w6-03): ExpenseOS switches its `anthropic` integration and `assistant` module on
  // here and off afterwards. VeloExpense has neither: the assistant is CORE (d89) and its key is
  // the server's ANTHROPIC_API_KEY (d40, d90), which playwright.config.ts passes through only
  // when the shell has one. So these real-model cases run with a key and skip without one;
  // assistant-panel.spec.ts covers the panel when there is none.
  test.skip(!process.env.ANTHROPIC_API_KEY, 'needs ANTHROPIC_API_KEY: these spend real model calls');

  test('answers from the asker’s own data', async ({ page }) => {
    await signIn(page, 'employee');
    await page.goto('/expenses');
    await openAssistant(page);
    const text = await ask(page, 'List my expense reports. Show the report numbers.');
    // A real report number, not a paraphrase — the read tool reached the database.
    expect(text, 'the answer should carry real report numbers').toMatch(/EXP-\d{6}/);
  });

  test('a mutation it proposes does NOT run until somebody presses Confirm', async ({ page }) => {
    /**
     * The security property, and the reason this file exists. `requiresConfirmation` is
     * unit-tested; that it holds through the panel, in a browser, was not.
     */
    await signIn(page, 'employee');
    await createSubmittableReport(page, tag);
    await openAssistant(page);

    const text = await ask(page, `Submit my expense report titled "${tag}" for approval.`);
    expect(text, 'a mutation must be proposed, not performed').toContain(CONFIRM_TITLE);
    expect(text).toContain(NOTHING_YET);

    // And it really has not run: the report is still submittable by hand.
    await page.goto('/expenses');
    await expect(page.getByRole('row').filter({ hasText: tag }).first()).toContainText(/Draft/i, {
      timeout: 60_000,
    });
  });

  test('declining leaves it alone', async ({ page }) => {
    await signIn(page, 'employee');
    await page.goto('/expenses');
    await openAssistant(page);
    await ask(page, `Submit my expense report titled "${tag}" for approval.`);

    await page.getByRole('button', { name: 'Not now' }).first().click();
    await expect(page.getByText('Left alone.').first()).toBeVisible({ timeout: 30_000 });

    await page.goto('/expenses');
    await expect(page.getByRole('row').filter({ hasText: tag }).first()).toContainText(/Draft/i, {
      timeout: 60_000,
    });
  });

  test('confirming runs it, and the change is real', async ({ page }) => {
    await signIn(page, 'employee');
    await page.goto('/expenses');
    await openAssistant(page);
    await ask(page, `Submit my expense report titled "${tag}" for approval.`);

    await page.getByRole('button', { name: 'Confirm', exact: true }).first().click();
    await expect(page.getByText('Done.').first()).toBeVisible({ timeout: 120_000 });

    // The state actually moved — read from the list, not from the assistant's own claim.
    await page.goto('/expenses');
    await expect(page.getByRole('row').filter({ hasText: tag }).first()).toContainText(
      /Submitted|Approved/i,
      { timeout: 90_000 },
    );
  });
});
