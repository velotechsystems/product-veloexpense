/**
 * Wave 1 — ExpenseOS's mileage-rate screen, ported, in a real browser against the real
 * server (`policies.mileageRate`, migration 0052).
 *
 * What only this proves is the WIRING: the menu entry and title; the drawer's country
 * picker, unit radio (named, VeloExpense) and band reaching the TENANT's own
 * `mileage_rate` and `mileage_rate_tier`; the row's retire (a prompt) and delete (a
 * confirm) reaching the server; the audit rows; and the refusal an employee meets.
 *
 * The demo tenant is never reset between local runs, so the spec clears its own country
 * first: a German default left by the last run would make this run's start date a
 * rewrite of history, which the router rightly refuses.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

async function demoOrg(): Promise<string> {
  return (await admin.query(`SELECT organization_id FROM app_user WHERE email = 'admin@demo.test'`)).rows[0]
    .organization_id;
}

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test.beforeAll(async () => {
    await admin.query(`DELETE FROM mileage_rate WHERE organization_id = $1 AND country = 'DE'`, [await demoOrg()]);
  });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Mileage Rates' }).first().click();
    await expect(page).toHaveURL(/\/admin\/mileage-rates$/);
    await expect(page.getByRole('heading', { name: /mileage rates/i, level: 1 })).toBeVisible();
  });

  test('creates a rule, then retires and deletes it, each on the record', async ({ page }) => {
    const org = await demoOrg();
    await page.goto('/admin/mileage-rates');
    await page.getByRole('button', { name: 'Add rate' }).click();
    const drawer = page.getByRole('dialog');

    await drawer.getByRole('combobox').first().click();
    await page.keyboard.type('Germany');
    await page.getByRole('option', { name: /Germany/ }).click();
    await drawer.getByRole('radio', { name: 'Per mile' }).click();
    await expect(drawer.getByRole('radio', { name: 'Per mile' })).toBeChecked();
    await drawer.getByLabel('Rate per unit 1').fill('0.70');
    await drawer.getByRole('button', { name: 'Create' }).click();
    await expect(drawer).toBeHidden();

    const rule = (
      await admin.query(
        `SELECT r.id, r.unit, r.effective_to, t.from_distance::text AS from_distance, t.rate_minor::text AS rate_minor
           FROM mileage_rate r JOIN mileage_rate_tier t ON t.rate_id = r.id
          WHERE r.organization_id = $1 AND r.country = 'DE'`,
        [org],
      )
    ).rows;
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatchObject({ unit: 'MI', effective_to: null, from_distance: '0.00', rate_minor: '70' });
    const id = rule[0].id as string;
    await expect(page.getByRole('row', { name: /Germany/ })).toBeVisible();

    // Retire: the row menu asks for the date in a prompt.
    page.once('dialog', (d) => d.accept('2099-12-31'));
    await page.getByRole('row', { name: /Germany/ }).getByRole('button', { name: 'Row actions' }).click();
    await page.getByRole('button', { name: 'Retire…' }).click();
    await expect
      .poll(async () => (await admin.query('SELECT effective_to FROM mileage_rate WHERE id = $1', [id])).rows[0]?.effective_to)
      .not.toBeNull();

    // Delete: nothing was priced under it, so it goes, after a confirm.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('row', { name: /Germany/ }).getByRole('button', { name: 'Row actions' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(async () => (await admin.query('SELECT count(*)::int AS n FROM mileage_rate WHERE id = $1', [id])).rows[0].n)
      .toBe(0);

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE organization_id = $1 AND entity_id = $2 ORDER BY sequence`,
      [org, id],
    );
    expect(audit.rows).toEqual([
      { action: 'MILEAGE_RATE_CHANGED', actor_role: 'ADMIN' },
      { action: 'MILEAGE_RATE_CHANGED', actor_role: 'ADMIN' },
      { action: 'MILEAGE_RATE_DELETED', actor_role: 'ADMIN' },
    ]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/mileage-rates');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Mileage Rates' })).toHaveCount(0);
  });
});
