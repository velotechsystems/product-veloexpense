/**
 * Wave 1 — ExpenseOS's department screen, ported, in a real browser against the real
 * server: the shared admin-lookup page with its parent picker (a SchemaForm `select`
 * field, whose empty "no parent" branch is the default).
 *
 * What only this proves is the WIRING: the parent options built from the tenant's own
 * departments, the choice reaching `parent_department_id`, the drawer's read view naming
 * the parent, and the audit row the save left.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E Payroll ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('lists the seeded department, titled in the top bar and reachable from the menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Departments' }).first().click();
    await expect(page).toHaveURL(/\/admin\/departments$/);
    await expect(page.getByRole('heading', { name: 'Departments', level: 1 })).toBeVisible();
    await expect(page.getByText('General & Admin')).toBeVisible();
  });

  test('creates a sub-department under a parent, and audits it', async ({ page }) => {
    await page.goto('/admin/departments');
    await page.getByRole('button', { name: 'Add department' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Label (English)').fill(NAME);
    await drawer.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'General & Admin' }).click();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toBeVisible();
    const db = await admin.query(
      `SELECT d.id, p.label ->> 'en' AS parent
         FROM department d JOIN department p ON p.id = d.parent_department_id
        WHERE d.label ->> 'en' = $1`,
      [NAME],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].parent).toBe('General & Admin');

    // The read view names the parent.
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    await expect(page.getByRole('dialog').getByText('General & Admin')).toBeVisible();

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [db.rows[0].id],
    );
    expect(audit.rows).toEqual([{ action: 'DEPARTMENT_CREATED', actor_role: 'System Administrator' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/departments');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Departments' })).toHaveCount(0);
  });
});
