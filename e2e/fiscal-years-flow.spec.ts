/**
 * Wave 1 — ExpenseOS's fiscal-year screen, ported, in a real browser against the real
 * server (`appSettings.fiscalYears`, migration 0050).
 *
 * What only this proves is the WIRING, and one thing a unit test cannot: the browser runs
 * in Toronto, and the days picked are the days stored (`date` columns) and the days shown
 * back — no slip to the previous day across the UTC offset. Also the menu entry and title,
 * "current" reaching `is_current`, the audit row, and the refusal an employee meets.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E FY ${RUN}`;
// Far from any year a seed or another spec would make, so the prefill does not matter.
const START = '2061-04-01';
const END = '2062-03-31';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE, timezoneId: 'America/Toronto' });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Fiscal Years' }).first().click();
    await expect(page).toHaveURL(/\/admin\/fiscal-years$/);
    await expect(page.getByRole('heading', { name: /fiscal years/i, level: 1 })).toBeVisible();
  });

  test('creates a year whose days survive the round trip, and audits it', async ({ page }) => {
    await page.goto('/admin/fiscal-years');
    await page.getByRole('button', { name: 'Add fiscal year' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByLabel('Label (Français)')).toHaveCount(0);
    await drawer.getByLabel('Label (English)').fill(NAME);
    await drawer.getByLabel('Start date').fill(START);
    await drawer.getByLabel('End date').fill(END);
    await drawer.getByRole('button', { name: 'Create' }).click();
    await expect(drawer).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(START);
    await expect(row).toContainText(END);

    const db = await admin.query(
      `SELECT id, start_date::text AS s, end_date::text AS e, is_current FROM fiscal_year WHERE label ->> 'en' = $1`,
      [NAME],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ s: START, e: END, is_current: false });

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [db.rows[0].id],
    );
    expect(audit.rows).toEqual([{ action: 'FISCAL_YEAR_CREATED', actor_role: 'ADMIN' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/fiscal-years');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Fiscal Years' })).toHaveCount(0);
  });
});
