/**
 * Wave 1 — ExpenseOS's per-diem-rate screen, ported, in a real browser against the real
 * server (`policies.perDiemRate`, migration 0053).
 *
 * What only this proves is the WIRING: the menu entry and title; the drawer's location,
 * category picker and amount reaching the TENANT's own `per_diem_rate`, the amount in
 * minor units of the policy currency; the row's delete reaching the server; the audit
 * rows VeloExpense adds; and the refusal an employee meets.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const CITY = `E2E Halifax ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Per Diem Rates' }).first().click();
    await expect(page).toHaveURL(/\/admin\/per-diem-rates$/);
    await expect(page.getByRole('heading', { name: /per.diem/i, level: 1 })).toBeVisible();
  });

  test('adds a rate for a city and category, then deletes it, each on the record', async ({ page }) => {
    await page.goto('/admin/per-diem-rates');
    await page.getByRole('button', { name: 'Add rate' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Country (ISO-2)').fill('CA');
    await drawer.getByLabel('City').fill(CITY);
    // The pickers in order: currency, category.
    await drawer.getByRole('combobox').nth(1).click();
    await page.keyboard.type('Ground');
    await page.getByRole('option', { name: /Ground Transportation/ }).click();
    await drawer.getByLabel('Allowance / day').fill('75.00');
    await drawer.getByLabel('Effective from').fill('2026-01-01');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    const rows = (
      await admin.query(
        `SELECT p.id, p.organization_id, p.amount_minor::text AS amount, p.currency_code, u.organization_id AS admin_org
           FROM per_diem_rate p, app_user u
          WHERE p.city = $1 AND u.email = 'admin@demo.test'`,
        [CITY],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(rows[0].admin_org);
    expect(rows[0]).toMatchObject({ amount: '7500', currency_code: null });
    const id = rows[0].id as string;

    const row = page.getByRole('row', { name: new RegExp(CITY) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(async () => (await admin.query('SELECT count(*)::int AS n FROM per_diem_rate WHERE id = $1', [id])).rows[0].n)
      .toBe(0);

    const audit = await admin.query(`SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [id]);
    expect(audit.rows).toEqual([
      { action: 'PER_DIEM_RATE_CREATED', actor_role: 'System Administrator' },
      { action: 'PER_DIEM_RATE_DELETED', actor_role: 'System Administrator' },
    ]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/per-diem-rates');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Per Diem Rates' })).toHaveCount(0);
  });
});
