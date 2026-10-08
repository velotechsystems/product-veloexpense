/**
 * Wave 1 — ExpenseOS's business-unit screen, ported, in a real browser against the real
 * server: the first screen on ExpenseOS's shared admin-lookup page (legal entities and
 * departments follow on the same component).
 *
 * The unit suites prove the page against a stub tRPC and the router against Postgres.
 * What only this proves is the WIRING: the schema form (react-jsonschema-form) rendering
 * and submitting in a browser, the External IDs editor creating the tenant's own source,
 * tRPC over HTTP with the session cookie, the list re-reading what was saved, the soft
 * deactivation from the row menu — and the audit rows those writes left in the chain.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E Atlantic ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('lists the seeded unit, titled in the top bar and reachable from the menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Business Units' }).first().click();
    await expect(page).toHaveURL(/\/admin\/business-units$/);
    await expect(page.getByRole('heading', { name: 'Business Units', level: 1 })).toBeVisible();
    await expect(page.getByText('Head Office')).toBeVisible();
  });

  test('creates a unit with an external ID, then deactivates it, and audits both', async ({ page }) => {
    await page.goto('/admin/business-units');
    await page.getByRole('button', { name: 'Add business unit' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Label (English)').fill(NAME);
    // English only while French is switched off: no French name is asked for.
    await expect(drawer.getByText(/Français/)).toHaveCount(0);

    // A first external ID: no source exists yet, so the row starts as a free-form key.
    await drawer.getByRole('button', { name: /Add an external ID/i }).click();
    await drawer.getByPlaceholder('System').last().fill('ledger');
    await drawer.getByPlaceholder('Value').last().fill(`BU-${RUN}`);
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    await expect(row.getByText(`BU-${RUN}`)).toBeVisible();

    const db = await admin.query(
      `SELECT bu.id, bu.label, s.code, x.source_value
         FROM business_unit bu
         JOIN business_unit_external_id x ON x.business_unit_id = bu.id
         JOIN external_id_source s ON s.id = x.source_id
        WHERE bu.label ->> 'en' = $1`,
      [NAME],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].label).toEqual({ en: NAME });
    expect(db.rows[0].code).toBe('ledger');
    const id = db.rows[0].id as string;

    // Deactivate from the row menu; the default view hides inactive rows.
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByText('Deactivate').click();
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toHaveCount(0);
    expect((await admin.query('SELECT active FROM business_unit WHERE id = $1', [id])).rows[0].active).toBe(false);

    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [id],
    );
    expect(audit.rows).toEqual([
      { action: 'BUSINESS_UNIT_CREATED', actor_role: 'ADMIN' },
      { action: 'BUSINESS_UNIT_DEACTIVATED', actor_role: 'ADMIN' },
    ]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/business-units');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Business Units' })).toHaveCount(0);
  });
});
