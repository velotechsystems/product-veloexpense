/**
 * w4-08 — ExpenseOS's saved views, ported, in a real browser against the real server
 * (`savedViews`, migration 0067), on the approvals inbox.
 *
 * What only this proves is the WIRING: the dropdown saves the reader's current filters under
 * the name they type, the view is still there after a reload (it lives in the database, not
 * the tab), choosing it puts its filters back, and deleting it — once confirmed — takes it out
 * of the list and soft-deletes the row, with an audit row for each write.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE } from './helpers';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
test.afterAll(async () => {
  await admin.end();
});

test.use({ storageState: ADMIN_STATE });

test('a view is saved, survives a reload, restores its filters, and is deleted on confirm', async ({ page }) => {
  const name = `E2E decided ${Date.now()}`;
  await page.goto('/expenses/approvals');

  // Switch the queue to "Decided by me" with the queue pill, so the view has something of
  // its own to remember.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByLabel('Field').selectOption('queue');
  await page.getByLabel('Operator').selectOption('equals');
  await page.getByLabel('Value').selectOption('decided');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Save it: the dropdown opens on the active view's name; the name comes from a prompt.
  page.once('dialog', (d) => d.accept(name));
  await page.getByRole('button', { name: /Pending|Decided by me|Untitled/ }).first().click();
  await page.getByRole('button', { name: 'Save current as new view' }).click();
  await expect(page.getByRole('button', { name })).toBeVisible();

  const stored = await admin.query(
    `SELECT resource, state->'filters' AS filters, deleted_at FROM saved_view WHERE name = $1`,
    [name],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].resource).toBe('approvals');
  expect(stored.rows[0].filters).toEqual([expect.objectContaining({ field: 'queue', value: 'decided' })]);

  // A reload opens on the default queue; the saved view is still in the list and puts its
  // filter back.
  await page.reload();
  await page.getByRole('button', { name: /Pending/ }).first().click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decided by me' }).first()).toBeVisible();

  // Delete, on confirm.
  await page.getByRole('button', { name }).first().click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).last().click();
  await expect
    .poll(async () =>
      (await admin.query(`SELECT deleted_at IS NOT NULL AS gone FROM saved_view WHERE name = $1`, [name])).rows[0],
    )
    .toEqual({ gone: true });

  const audit = await admin.query(
    `SELECT action FROM audit_entry
      WHERE action LIKE 'SAVED_VIEW_%' AND (details->>'name' = $1 OR entity_id IN (SELECT id FROM saved_view WHERE name = $1))
      ORDER BY sequence`,
    [name],
  );
  expect(audit.rows.map((r) => r.action)).toEqual(['SAVED_VIEW_CREATED', 'SAVED_VIEW_DELETED']);
});
