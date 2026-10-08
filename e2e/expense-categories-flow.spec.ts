/**
 * Wave 0 — ExpenseOS's expense-category screen, ported, in a real browser against the
 * real server: the first ExpenseOS screen VeloExpense serves at its own path.
 *
 * The unit suites prove the screen's behaviour against a stub tRPC and the router's
 * against Postgres. What only this proves is the WIRING between them: tRPC over HTTP
 * with the session cookie, the tenant scope, the GL account picker searching the demo
 * tenant's real chart, the drawer saving, and the list re-reading what was saved — plus
 * the audit row the save left in the tenant's chain.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E client dinners ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('lists the starter categories, titled in the top bar and reachable from the menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Expense categories' }).first().click();
    await expect(page).toHaveURL(/\/admin\/expense-categories$/);
    await expect(page.getByRole('heading', { name: 'Expense categories', level: 1 })).toBeVisible();
    await expect(page.getByText('Meals & Entertainment')).toBeVisible();
    await expect(page.getByText('Software & Subscriptions')).toBeVisible();
  });

  test('creates a category with a GL account from the chart, and audits it', async ({ page }) => {
    await page.goto('/admin/expense-categories');
    await page.getByRole('button', { name: 'Add category' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name (EN)').fill(NAME);
    // English only while French is switched off: no French name is asked for.
    await expect(drawer.getByText(/Name \(FR/)).toHaveCount(0);

    await drawer.getByRole('combobox').first().click();
    await page.keyboard.type('6820');
    await page.getByRole('option', { name: /68200/ }).click();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    await expect(row.getByText('68200')).toBeVisible();

    const db = await admin.query(
      `SELECT c.id, c.code, c.label, g.number
         FROM expense_category c LEFT JOIN gl_account g ON g.id = c.gl_account_id
        WHERE c.label ->> 'en' = $1`,
      [NAME],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].number).toBe('68200');
    expect(db.rows[0].code).toMatch(/^c-[0-9a-f]{8}$/);
    const audit = await admin.query(
      `SELECT actor_role FROM audit_entry WHERE action = 'EXPENSE_CATEGORY_CREATED' AND entity_id = $1`,
      [db.rows[0].id],
    );
    expect(audit.rows).toEqual([{ actor_role: 'ADMIN' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/expense-categories');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Expense categories' })).toHaveCount(0);
  });
});
