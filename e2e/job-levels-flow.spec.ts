/**
 * Wave 1 — ExpenseOS's job-level screen, ported, in a real browser against the real
 * server (`appSettings.jobLevels`, migration 0050).
 *
 * What only this proves is the WIRING: the menu entry and top-bar title, the drawer's
 * code / track / English label reaching `job_level` with the ladder order the server
 * assigns, the audit row the save left, and the refusal an employee meets.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const CODE = `E2E-${RUN}`.slice(0, 40);
const NAME = `E2E Director ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Job Levels' }).first().click();
    await expect(page).toHaveURL(/\/admin\/job-levels$/);
    await expect(page.getByRole('heading', { name: /job levels/i, level: 1 })).toBeVisible();
  });

  test('creates a level on the English label alone, and audits it', async ({ page }) => {
    await page.goto('/admin/job-levels');
    await page.getByRole('button', { name: 'Add level' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Code').fill(CODE);
    await drawer.getByRole('radio', { name: 'Manager' }).click();
    await expect(drawer.getByRole('radio', { name: 'Manager' })).toBeChecked();
    // VeloExpense: French is off, so no French label is asked for.
    await expect(drawer.getByLabel('Label (Français)')).toHaveCount(0);
    await drawer.getByLabel('Label (English)').fill(NAME);
    await drawer.getByRole('button', { name: 'Create' }).click();
    await expect(drawer).toBeHidden();

    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toBeVisible();
    const db = await admin.query(
      `SELECT id, track, label, sort_order FROM job_level WHERE code = $1`,
      [CODE],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ track: 'MANAGER', label: { en: NAME } });
    expect(db.rows[0].sort_order).toBeGreaterThan(0);

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [db.rows[0].id],
    );
    expect(audit.rows).toEqual([{ action: 'JOB_LEVEL_CREATED', actor_role: 'System Administrator' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/job-levels');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Job Levels' })).toHaveCount(0);
  });
});
