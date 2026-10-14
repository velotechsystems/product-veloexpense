/**
 * w4-02e — ExpenseOS's policy-violation register, ported, in a real browser against the
 * real server (`policies.policyRule.violations` / `resolveViolation`).
 *
 * What only this proves is the WIRING: the menu entry and title; a stored finding read as
 * the reader's sentence with its amount; a row click opening the drawer, which restates
 * that sentence; the note reaching the TENANT's own `policy_violation` with its audit row;
 * a BLOCK offering nothing to acknowledge; and the refusal an employee meets.
 *
 * The findings are inserted rather than produced by a submit: a live rule would fire on
 * every other flow's reports. The rule they cite exists but is DISABLED, so the register
 * can resolve its kind while validate never runs it, and the report belongs to a submitter
 * of this file's own, so no other flow's lists see it.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const TITLE = `Register check ${Date.now()}`;
let reportId: string;
let warningId: string;
let blockId: string;
let ruleId: string;
let userId: string;

test.beforeAll(async () => {
  const org = (await admin.query(`SELECT organization_id FROM app_user WHERE email = 'admin@demo.test'`)).rows[0]
    .organization_id as string;
  userId = (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, 'Register Submitter', '019e3000-0000-7000-8000-000000000004') RETURNING id`,
      [org, `register-${Date.now()}@demo.test`],
    )
  ).rows[0].id;
  ruleId = (
    await admin.query(
      `INSERT INTO policy_rule (organization_id, kind_code, scope, severity, params, message_key, enabled, effective_from)
       VALUES ($1, 'RECEIPT_THRESHOLD', 'AGGREGATE', 'WARNING', '{"thresholdMinor":"2500"}', 'receiptThreshold', false, '2000-01-01')
       RETURNING id`,
      [org],
    )
  ).rows[0].id;
  reportId = (
    await admin.query(
      `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id, number)
       VALUES ($1, $2, 'CAD', $3, $4) RETURNING id`,
      [org, TITLE, userId, `EXP-REG-${Date.now() % 1_000_000}`],
    )
  ).rows[0].id;
  const insert = (severity: string, message: string) =>
    admin
      .query(
        `INSERT INTO policy_violation (organization_id, report_id, rule_code, severity, message, data)
         VALUES ($1, $2, $3, $4, $5, '{"thresholdMinor":"2500","policyCurrency":"CAD"}') RETURNING id`,
        [org, reportId, ruleId, severity, message],
      )
      .then((r) => r.rows[0].id as string);
  warningId = await insert('WARNING', 'receiptThresholdWarn');
  blockId = await insert('BLOCK', 'receiptThresholdBlock');
});

test.afterAll(async () => {
  await admin.query('DELETE FROM expense_report WHERE id = $1', [reportId]).catch(() => {});
  await admin.query('DELETE FROM policy_rule WHERE id = $1', [ruleId]).catch(() => {});
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is reachable from the menu and titled in the top bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Policy Violations' }).first().click();
    await expect(page).toHaveURL(/\/admin\/policy-violations$/);
    await expect(page.getByRole('heading', { name: /policy violations/i, level: 1 })).toBeVisible();
  });

  test('reads a stored finding as its sentence, and acknowledges a warning on the record', async ({ page }) => {
    await page.goto('/admin/policy-violations');
    const warning = page.getByRole('row').filter({ hasText: TITLE }).filter({ hasText: 'Receipt expected over' });
    await expect(warning).toHaveCount(1);
    await expect(warning).toContainText('Receipt expected over CAD 25.00');
    await expect(warning).toContainText('Receipt threshold');
    await expect(warning).toContainText('Register Submitter');

    await warning.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Receipt expected over CAD 25.00');
    await drawer.getByRole('textbox').fill('Client dinner, pre-approved');
    await drawer.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(drawer).toBeHidden();
    await expect(warning).toContainText('Acknowledged');

    const stored = await admin.query(`SELECT resolve_note FROM policy_violation WHERE id = $1`, [warningId]);
    expect(stored.rows).toEqual([{ resolve_note: 'Client dinner, pre-approved' }]);
    const audit = await admin.query(
      `SELECT action, entity_type, actor_role FROM audit_entry WHERE entity_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [warningId],
    );
    expect(audit.rows).toEqual([{ action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyViolation', actor_role: 'System Administrator' }]);
  });

  test('offers nothing to acknowledge on a BLOCK', async ({ page }) => {
    await page.goto('/admin/policy-violations');
    const block = page.getByRole('row').filter({ hasText: TITLE }).filter({ hasText: 'Receipt required over' });
    await expect(block).toHaveCount(1);
    await expect(block.getByRole('button', { name: 'Actions' })).toHaveCount(0);
    await block.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const stored = await admin.query(`SELECT resolved_at FROM policy_violation WHERE id = $1`, [blockId]);
    expect(stored.rows).toEqual([{ resolved_at: null }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/policy-violations');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Policy Violations' })).toHaveCount(0);
  });
});
