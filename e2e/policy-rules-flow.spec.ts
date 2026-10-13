/**
 * w4-02b — ExpenseOS's Rule Builder, ported, in a real browser against the real server
 * (`policies.policyRule`, migration 0064).
 *
 * What only this proves is the WIRING: the menu entry and title; the drawer's kind picker
 * and money param reaching the TENANT's own `policy_rule`, the threshold typed in major
 * units and stored in minor units of the policy currency; the row's delete reaching the
 * server; the audit rows; and the refusal an employee meets. What a rule then does to a
 * submit is expense-flow.spec.ts's.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

// A threshold no other run or fixture uses, so the row and the stored rule are this run's.
const CENTS = 1000 + (Date.now() % 89_000);
const TYPED = (CENTS / 100).toFixed(2);

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Policy Rules' }).first().click();
    await expect(page).toHaveURL(/\/admin\/policy-rules$/);
    await expect(page.getByRole('heading', { name: /policy rules/i, level: 1 })).toBeVisible();
  });

  test('adds a receipt threshold in major units, then deletes it, each on the record', async ({ page }) => {
    await page.goto('/admin/policy-rules');
    await page.getByRole('button', { name: 'New Rule' }).click();
    const drawer = page.getByRole('dialog');
    // The first picker is the rule type.
    await drawer.getByRole('combobox').first().click();
    await page.keyboard.type('RECEIPT_TH');
    await page.getByRole('option', { name: 'RECEIPT_THRESHOLD' }).click();
    await drawer.getByLabel(/^Threshold \(/).fill(TYPED);
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();

    const rows = (
      await admin.query(
        `SELECT r.id, r.organization_id, r.scope, r.params->>'thresholdMinor' AS minor, u.organization_id AS admin_org
           FROM policy_rule r, app_user u
          WHERE r.kind_code = 'RECEIPT_THRESHOLD' AND r.params->>'thresholdMinor' = $1
            AND u.email = 'admin@demo.test'`,
        [String(CENTS)],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(rows[0].admin_org);
    expect(rows[0]).toMatchObject({ scope: 'AGGREGATE', minor: String(CENTS) });
    const id = rows[0].id as string;

    const row = page.getByRole('row', { name: new RegExp(TYPED.replace('.', '\\.')) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(async () => (await admin.query('SELECT count(*)::int AS n FROM policy_rule WHERE id = $1', [id])).rows[0].n)
      .toBe(0);

    const audit = await admin.query(
      `SELECT action, actor_role, details->>'op' AS op FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
      [id],
    );
    expect(audit.rows).toEqual([
      { action: 'POLICY_RULE_CHANGED', actor_role: 'ADMIN', op: 'create' },
      { action: 'POLICY_RULE_CHANGED', actor_role: 'ADMIN', op: 'delete' },
    ]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/policy-rules');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Policy Rules' })).toHaveCount(0);
  });
});
