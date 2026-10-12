/**
 * The audit chain records who PUT A REPORT FORWARD and who TOOK IT BACK, and
 * marks a decision that went round the ladder.
 *
 * Own org slug ('audtr-co'), like every other db suite in this project.
 *
 * Two gaps, both found by reading rather than by a failure:
 *
 *   · `REPORT_SUBMITTED` / `REPORT_RECALLED` were not in `AUDIT_ACTIONS`. A
 *     submit and a recall wrote only `expense_report_event` — the report's own
 *     history — so the tamper-evident chain could say who approved a report and
 *     never who submitted it.
 *   · An ADMIN deciding a task assigned to somebody else left a
 *     `REPORT_APPROVED` row identical to the assigned manager's. ExpenseOS #507
 *     fixed the same gap with `details.override`; this is that, minus the half
 *     about read permissions that does not apply to a role-based override.
 *
 * w4-00c: on ExpenseOS's engine. A decision goes through `decideThroughEngine`
 * (server/lib/reportLifecycle.ts) with the `decide.any` override where the ladder took the
 * ADMIN role; the run's own APPROVAL_RUN_OPENED row went with the ladder — ExpenseOS writes
 * none — so the submit is the one row a submit adds.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
// w4-00c: the lifecycle starts the approval engine, which needs the tenant's Prisma
// transaction (test/support/tenant-tx.ts) — the same `QueryRunner`, under the same name.
import { seedDefaultFlow, withTenantTx as withOrg } from './support/tenant-tx';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { decideThroughEngine } from '@/server/lib/reportLifecycle';
import { verifyChain } from '@/lib/audit/verify';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let categoryId: string;
let submitterId: string;
let managerId: string;
let adminId: string;
const SUBMITTER = 'sub@audtr.test';

async function submitted(): Promise<{ reportId: string; taskId: string }> {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, { title: 'Audit', currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 12_34 });
    return report.id as string;
  });
  await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
  const t = await admin.query(
    `SELECT t.id FROM approval_instance_task t JOIN approval_instance i ON i.id = t.instance_id
      WHERE i.subject_id = $1 AND t.status = 'PENDING'`,
    [reportId],
  );
  return { reportId, taskId: t.rows[0].id as string };
}

async function entries(reportId: string, action: string) {
  const r = await admin.query(
    `SELECT actor_id, details FROM audit_entry
      WHERE organization_id = $1 AND action = $2 AND entity_id = $3 ORDER BY sequence`,
    [orgId, action, reportId],
  );
  return r.rows as Array<{ actor_id: string | null; details: Record<string, unknown> }>;
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('audtr-co','Audit Transitions Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  // w4-00c: the default approval flow a provisioned tenant starts with (d54); without it a
  // submit is refused (d58).
  await seedDefaultFlow(orgId);
  await withOrg(orgId, async (tx) => {
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@audtr.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    managerId = m.rows[0].id;
    const s = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id)
       VALUES ($1,$2,'Sub',$3) RETURNING id`,
      [orgId, SUBMITTER, managerId],
    );
    submitterId = s.rows[0].id;
    const a = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'admin@audtr.test','Admin','ADMIN') RETURNING id`,
      [orgId],
    );
    adminId = a.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('submit and recall reach the audit chain', () => {
  it('a submit appends REPORT_SUBMITTED, as the submitter', async () => {
    const { reportId } = await submitted();
    const rows = await entries(reportId, 'REPORT_SUBMITTED');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(submitterId);
    expect(rows[0].details).toMatchObject({ totalMinor: '1234', currencyCode: 'CAD' });
  });

  it('a recall appends REPORT_RECALLED, naming what it was recalled from', async () => {
    const { reportId } = await submitted();
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId, 'wrong receipt'));
    const rows = await entries(reportId, 'REPORT_RECALLED');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(submitterId);
    expect(rows[0].details).toMatchObject({
      fromStatus: 'SUBMITTED',
      note: 'wrong receipt',
      // w4-00c: the instance it voided, which ExpenseOS writes no row for.
      cancelledTasks: 1,
    });
  });

  it('a refused submit leaves no REPORT_SUBMITTED behind', async () => {
    const reportId = await withOrg(orgId, async (tx) => {
      const r = await expenses.createReport(tx, SUBMITTER, { title: 'Empty', currencyCode: 'CAD' });
      return r.id as string;
    });
    await expect(
      withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId)),
    ).rejects.toThrow(/no line items/);
    expect(await entries(reportId, 'REPORT_SUBMITTED')).toHaveLength(0);
  });

  it('the chain still verifies with the new rows in it', async () => {
    const { reportId } = await submitted();
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId));
    const result = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(result.ok).toBe(true);
  });
});

describe('an override is marked', () => {
  it('the ASSIGNED manager deciding is not an override', async () => {
    const { reportId, taskId } = await submitted();
    await withOrg(orgId, (_tx, db) =>
      decideThroughEngine(db, { taskId, actorId: managerId, approve: true, note: null, mayOverride: false }),
    );
    const rows = await entries(reportId, 'REPORT_APPROVED');
    expect(rows).toHaveLength(1);
    expect(rows[0].details.override).toBe(false);
  });

  it('an ADMIN deciding somebody else’s task is', async () => {
    const { reportId, taskId } = await submitted();
    await withOrg(orgId, (_tx, db) =>
      decideThroughEngine(db, { taskId, actorId: adminId, approve: true, note: null, mayOverride: true }),
    );
    const rows = await entries(reportId, 'REPORT_APPROVED');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(adminId);
    expect(rows[0].details.override).toBe(true);
  });

  it('an admin who IS the assignee is recorded as the approver, not an override', async () => {
    const { reportId, taskId } = await submitted();
    await admin.query('UPDATE approval_instance_task SET assignee_user_id = $2 WHERE id = $1', [
      taskId,
      adminId,
    ]);
    await withOrg(orgId, (_tx, db) =>
      decideThroughEngine(db, { taskId, actorId: adminId, approve: true, note: null, mayOverride: true }),
    );
    const rows = await entries(reportId, 'REPORT_APPROVED');
    expect(rows[0].details.override).toBe(false);
  });
});
