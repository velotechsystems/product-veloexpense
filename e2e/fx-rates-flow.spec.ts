/**
 * Wave 1 — ExpenseOS's FX-rate screen, ported, in a real browser against the real
 * server (`policies.fxRate`, migration 0051).
 *
 * What only this proves is the WIRING: the menu entry and title, the add drawer reaching
 * the TENANT's own `fx_rate` (d18), a pair's history opening from its row, the deviation
 * refusal growing the reason field and the reasoned add landing on the record, and the
 * refusal an employee meets.
 *
 * The demo tenant is never reset between local runs, so each rate here is derived from
 * the pair's current one rather than hard-coded: a re-run measures against what the last
 * run left. Nor can it count on the seeded USD->CAD rate: `analytics-flow` sorts first
 * and deletes every rate.
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
async function latest(org: string, base: string, quote: string): Promise<string | null> {
  const r = await admin.query(
    `SELECT rate::text FROM fx_rate WHERE organization_id = $1 AND base = $2 AND quote = $3
      ORDER BY fetched_at DESC LIMIT 1`,
    [org, base, quote],
  );
  return r.rows[0]?.rate ?? null;
}

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'FX rates' }).first().click();
    await expect(page).toHaveURL(/\/admin\/fx-rates$/);
    await expect(page.getByRole('heading', { name: /fx rates/i, level: 1 })).toBeVisible();
  });

  test('adds a rate to the tenant’s own table, audited, and shows it in the pair’s history', async ({ page }) => {
    const org = await demoOrg();
    const rate = (await latest(org, 'CAD', 'USD')) ?? '0.7400';
    const before = (await admin.query(`SELECT count(*)::int AS n FROM fx_rate WHERE base = 'CAD'`)).rows[0].n;

    await page.goto('/admin/fx-rates');
    await page.getByRole('button', { name: 'Add rate' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Base currency').fill('CAD');
    await drawer.getByLabel('Quote currency').fill('USD');
    await drawer.getByLabel('Rate (quote per 1 base)').fill(rate);
    await drawer.getByRole('button', { name: 'Add rate' }).click();
    await expect(drawer).toBeHidden();

    // One new row, and it is the demo tenant's.
    const added = await admin.query(
      `SELECT organization_id, rate::text FROM fx_rate WHERE base = 'CAD' ORDER BY fetched_at DESC LIMIT 1`,
    );
    expect((await admin.query(`SELECT count(*)::int AS n FROM fx_rate WHERE base = 'CAD'`)).rows[0].n).toBe(before + 1);
    expect(added.rows[0].organization_id).toBe(org);
    const audit = await admin.query(
      `SELECT actor_role, details ->> 'base' AS base FROM audit_entry
        WHERE organization_id = $1 AND action = 'FX_RATE_ADDED' ORDER BY sequence DESC LIMIT 1`,
      [org],
    );
    expect(audit.rows[0]).toEqual({ actor_role: 'ADMIN', base: 'CAD' });

    await page.getByRole('row', { name: /CAD.*USD/ }).click();
    await expect(page.getByRole('dialog').getByText('CAD → USD history')).toBeVisible();
  });

  test('refuses a rate far from the last one until a reason is given, then records it', async ({ page }) => {
    const org = await demoOrg();
    // The bound measures against the pair's last rate, so make sure there is one.
    if ((await latest(org, 'USD', 'CAD')) === null) {
      await admin.query(
        `INSERT INTO fx_rate (organization_id, base, quote, rate, fetched_at)
         VALUES ($1, 'USD', 'CAD', 1.35, now() - interval '1 minute')`,
        [org],
      );
    }
    const current = Number(await latest(org, 'USD', 'CAD'));
    const far = (current * 2).toFixed(4);

    await page.goto('/admin/fx-rates');
    await page.getByRole('button', { name: 'Add rate' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Base currency').fill('USD');
    await drawer.getByLabel('Quote currency').fill('CAD');
    await drawer.getByLabel('Rate (quote per 1 base)').fill(far);
    await drawer.getByRole('button', { name: 'Add rate' }).click();
    await expect(drawer.getByText(/was last recorded at/)).toBeVisible();

    await drawer.getByLabel('Reason for the correction').fill('E2E: the previous rate was entered inverted.');
    await drawer.getByRole('button', { name: 'Add anyway, with reason' }).click();
    await expect(drawer).toBeHidden();
    expect(Number(await latest(org, 'USD', 'CAD'))).toBeCloseTo(Number(far), 6);

    // Put the pair back near where it was, so the seeded conversions stay sensible.
    await page.getByRole('button', { name: 'Add rate' }).click();
    const again = page.getByRole('dialog');
    await again.getByLabel('Base currency').fill('USD');
    await again.getByLabel('Quote currency').fill('CAD');
    await again.getByLabel('Rate (quote per 1 base)').fill(current.toFixed(4));
    await again.getByRole('button', { name: 'Add rate' }).click();
    await again.getByLabel('Reason for the correction').fill('E2E: restoring the rate before this test.');
    await again.getByRole('button', { name: 'Add anyway, with reason' }).click();
    await expect(again).toBeHidden();
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/fx-rates');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'FX rates' })).toHaveCount(0);
  });
});
