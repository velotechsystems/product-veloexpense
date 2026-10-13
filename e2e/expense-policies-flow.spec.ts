/**
 * w4-02c — ExpenseOS's per-category policy screen, ported, in a real browser against the
 * real server (`policies.expensePolicy`, migration 0065).
 *
 * What only this proves is the WIRING: the menu entry and title; a row click opening the
 * drawer; the limit typed in major units reaching the TENANT's own
 * `expense_category_policy` in minor units; the audit row; the drawer's checkboxes having
 * accessible names (f10); and the refusal an employee meets. Nothing enforces these limits
 * until the cutover (w4-02d).
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Expense Policies' }).first().click();
    await expect(page).toHaveURL(/\/admin\/policies$/);
    await expect(page.getByRole('heading', { name: /expense policies/i, level: 1 })).toBeVisible();
  });

  test('sets a category’s per-transaction limit in major units, on the record', async ({ page }) => {
    // The first category row of the admin's tenant, whatever the seed names it.
    const { rows } = await admin.query(
      `SELECT c.id, c.label->>'en' AS name, c.organization_id
         FROM expense_category c JOIN app_user u ON u.organization_id = c.organization_id
        WHERE u.email = 'admin@demo.test' AND c.active
        ORDER BY c.sort_order, c.id LIMIT 1`,
    );
    const category = rows[0] as { id: string; name: string; organization_id: string };
    // A limit no earlier run left, so the assertion is this run's.
    const cents = 10_000 + (Date.now() % 80_000);
    const typed = (cents / 100).toFixed(2);

    await page.goto('/admin/policies');
    await page.getByRole('row', { name: new RegExp(category.name) }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('checkbox', { name: 'Receipt required' })).toBeVisible();
    await expect(drawer.getByRole('checkbox', { name: 'Approval required' })).toBeVisible();
    await drawer.getByLabel('Per-transaction limit').fill(typed);
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    await expect
      .poll(async () =>
        (
          await admin.query(
            `SELECT organization_id, per_transaction_limit_minor::text AS ptl FROM expense_category_policy WHERE category_id = $1`,
            [category.id],
          )
        ).rows[0],
      )
      .toEqual({ organization_id: category.organization_id, ptl: String(cents) });
    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [category.id],
    );
    expect(audit.rows).toEqual([{ action: 'EXPENSE_POLICY_CHANGED', actor_role: 'ADMIN' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/policies');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Expense Policies' })).toHaveCount(0);
  });
});
