/**
 * Wave 1 — ExpenseOS's legal-entity screen, ported, in a real browser against the real
 * server: the shared admin-lookup page with its first picker fields.
 *
 * What only this proves is the WIRING of what legal entities add to business units: the
 * country and currency pickers registered as SchemaForm widgets (`ADMIN_PICKER_WIDGETS`),
 * the currency list served by `appSettings.currencies.list`, the ITC checkbox defaulting
 * to on, and the row the save left — with its audit entry.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E Holdings ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('lists the seeded entity, titled in the top bar and reachable from the menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Legal Entities' }).first().click();
    await expect(page).toHaveURL(/\/admin\/legal-entities$/);
    await expect(page.getByRole('heading', { name: 'Legal Entities', level: 1 })).toBeVisible();
    await expect(page.getByText('Demo Co Inc.')).toBeVisible();
  });

  test('creates an entity with a country and a currency from the pickers, and audits it', async ({ page }) => {
    await page.goto('/admin/legal-entities');
    await page.getByRole('button', { name: 'Add legal entity' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Label (English)').fill(NAME);

    // The country picker: a searchable list of every ISO country, by name.
    const [country, currency] = await drawer.getByRole('combobox').all();
    await country.click();
    await page.keyboard.type('France');
    await page.getByRole('option', { name: /France/ }).click();
    // The currency picker: the system's own currency rows.
    await currency.click();
    await page.keyboard.type('USD');
    await page.getByRole('option', { name: /USD/ }).click();
    // ExpenseOS's default for a new entity: it reclaims input tax.
    await expect(drawer.getByRole('checkbox', { name: /Reclaims ITCs/ })).toBeChecked();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    await expect(row.getByText('USD')).toBeVisible();

    const db = await admin.query(
      `SELECT id, label, country, currency_code, itc_recoverable FROM legal_entity WHERE label ->> 'en' = $1`,
      [NAME],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      label: { en: NAME },
      country: 'FR',
      currency_code: 'USD',
      itc_recoverable: true,
    });
    const audit = await admin.query(
      `SELECT action, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [db.rows[0].id],
    );
    expect(audit.rows).toEqual([{ action: 'LEGAL_ENTITY_CREATED', actor_role: 'System Administrator' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/legal-entities');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Legal Entities' })).toHaveCount(0);
  });
});
