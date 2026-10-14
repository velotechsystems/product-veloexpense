/**
 * w4-10c — ExpenseOS's Role Builder, ported, in a real browser against the real server
 * (`roles` router, migrations 0068–0070).
 *
 * What only this proves is the WIRING: the menu entry and title; the drawer's English name
 * and permission picker reaching the TENANT's own `role` row; the new role offered where a
 * role is given (the invite form); the row's delete reaching the server; the audit rows;
 * and the refusal an employee meets. What the guards refuse is roles.test.ts's and
 * roles.db.test.ts's.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E Auditor ${RUN}`;
const PERMISSION = 'expense.report.read.own';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.query(`DELETE FROM role WHERE label ->> 'en' = $1`, [NAME]).catch(() => {});
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Role Builder' }).first().click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await expect(page.getByRole('heading', { name: 'Role Builder', level: 1 })).toBeVisible();
    await expect(page.getByText('System Administrator').first()).toBeVisible();
  });

  test('builds a role, offers it on the invite form, then deletes it, each on the record', async ({ page }) => {
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'Add role' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Label (English)').fill(NAME);
    await drawer.getByRole('checkbox', { name: PERMISSION }).click();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toBeVisible();

    const rows = (
      await admin.query(
        `SELECT r.id, r.organization_id, r.permissions, r.is_system, u.organization_id AS admin_org
           FROM role r, app_user u
          WHERE r.label ->> 'en' = $1 AND u.email = 'admin@demo.test'`,
        [NAME],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(rows[0].admin_org);
    expect(rows[0]).toMatchObject({ permissions: [PERMISSION], is_system: false });
    const id = rows[0].id as string;

    // The invite form gives the tenant's roles by name (w4-10b), the new one among them.
    await page.goto('/admin/employees/invite');
    await expect(page.getByLabel('Role').locator('option', { hasText: NAME })).toHaveCount(1);

    await page.goto('/admin/roles');
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await row.getByRole('button', { name: 'Actions' }).click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(async () => (await admin.query('SELECT count(*)::int AS n FROM role WHERE id = $1', [id])).rows[0].n)
      .toBe(0);

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [id],
    );
    expect(audit.rows).toEqual([
      { action: 'ROLE_CREATED', actor_role: 'System Administrator' },
      { action: 'ROLE_DELETED', actor_role: 'System Administrator' },
    ]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/roles');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Role Builder' })).toHaveCount(0);
  });
});
