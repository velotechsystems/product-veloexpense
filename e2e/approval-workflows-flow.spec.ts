/**
 * w4-01 — ExpenseOS's workflow builder, ported, in a real browser against the real server
 * (`approvalWorkflows`, migration 0058).
 *
 * What only this proves is the WIRING: the top-bar title, the create dialog
 * reaching `approval_workflow` with a first DRAFT version, the editor's canvas drawing that
 * draft, a saved draft and its audit rows, and the refusal an employee meets.
 *
 * Until the cutover (w4-00c, d55) nothing routes through what is authored here; the ladder
 * still decides. This spec does not publish, so it leaves no live workflow behind.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `E2E Workflow ${RUN}`;

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('is where the menu leads, titled at its own path', async ({ page }) => {
    // w4-00c: the cutover retired the ladder, so the menu's "Approval Workflows" opens the
    // builder. (Its old address, /admin/approval-ladder, went with its tables in w4-00d.)
    await page.goto('/');
    await page.getByRole('link', { name: 'Approval Workflows' }).first().click();
    await expect(page).toHaveURL(/\/admin\/approval-workflows$/);
    await expect(page.getByRole('heading', { name: /approval workflows/i, level: 1 })).toBeVisible();
  });

  test('creates a workflow as a draft, opens it on the canvas, and saves it', async ({ page }) => {
    await page.goto('/admin/approval-workflows');
    await page.getByRole('button', { name: 'New workflow' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Name/).first().fill(NAME);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(NAME)).toBeVisible();

    const wf = await admin.query(
      `SELECT w.id, w.key, w.subject_type, v.version, v.status
         FROM approval_workflow w JOIN approval_workflow_version v ON v.workflow_id = w.id
        WHERE w.name = $1`,
      [NAME],
    );
    expect(wf.rows).toHaveLength(1);
    expect(wf.rows[0]).toMatchObject({ subject_type: 'EXPENSE_REPORT', version: 1, status: 'DRAFT' });
    const created = await admin.query(
      `SELECT actor_role FROM audit_entry WHERE action = 'APPROVAL_WORKFLOW_CREATED' AND details->>'key' = $1`,
      [wf.rows[0].key],
    );
    expect(created.rows).toEqual([{ actor_role: 'ADMIN' }]);

    // The editor draws the seeded draft: a start wired to an approved terminal.
    await page.goto(`/admin/approval-workflows/${wf.rows[0].id}`);
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect
      .poll(async () =>
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM audit_entry
              WHERE action = 'APPROVAL_WORKFLOW_DRAFT_SAVED' AND entity_id = $1`,
            [wf.rows[0].id],
          )
        ).rows[0].n,
      )
      .toBe(1);
    // Still one draft: saving edits it rather than stacking a second version.
    const versions = await admin.query(
      `SELECT version, status FROM approval_workflow_version WHERE workflow_id = $1`,
      [wf.rows[0].id],
    );
    expect(versions.rows).toEqual([{ version: 1, status: 'DRAFT' }]);
  });
});

test.describe('as an employee', () => {
  test.use({ storageState: EMPLOYEE_STATE });

  test('is refused, with the reason, and the menu does not offer it', async ({ page }) => {
    const response = await page.goto('/admin/approval-workflows');
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId('forbidden-reason')).toHaveCount(1);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Approval Workflows' })).toHaveCount(0);
  });
});
