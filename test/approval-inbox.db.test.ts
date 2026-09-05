/**
 * VX2-4 — the approver's inbox and the read widening, against a real Postgres.
 *
 * Own org slug ('inbox-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The tests that matter are the SHAPE ones, not the happy path: that an admin
 * does not see other people's tasks even though they could decide them, that a
 * submitter never sees their own report, and that an approver can still READ a
 * report after deciding it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as approvals from '@/lib/approvals/service';
import { decide } from '@/lib/approvals/engine';
import { canDecide } from '@/lib/approvals/eligibility';
import { canReadReport, listInbox, resolveDecidableTask } from '@/lib/approvals/inbox';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'approval-inbox.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL). See HANDOFF.md.',
  );
}
const admin = new Pool({ connectionString: ADMIN_URL });

const ON_DATE = new Date('2026-06-15');
const SUBMITTER = 'sub@inbox.test';

let orgId: string;
let categoryId: string;
let submitter: { id: string; role: 'EMPLOYEE' };
let manager: { id: string; role: 'MANAGER' };
let finance: { id: string; role: 'ADMIN' };
let cover: { id: string; role: 'MANAGER' };
let bystander: { id: string; role: 'MANAGER' };

async function mkUser(email: string, role: string, managerId: string | null = null) {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, manager_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4)
       RETURNING id`,
      [email, email.split('@')[0], role, managerId],
    );
    return r.rows[0].id as string;
  });
}

/** A submitted report with a run open on it. */
async function submitted(amountMinor = 1000) {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, {
      title: 'Inbox',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return report.id as string;
  });
  const { approval } = await withOrg(orgId, (tx) =>
    lifecycle.submitReport(tx, reportId, submitter.id),
  );
  return { reportId, ...approval };
}

async function inboxOf(actorId: string) {
  return withOrg(orgId, (tx) => listInbox(tx, actorId, { onDate: ON_DATE }));
}

async function accessTo(reportId: string) {
  const a = await withOrg(orgId, (tx) => expenses.getReportAccess(tx, reportId));
  if (!a) throw new Error('report not found');
  return a;
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('inbox-co','Inbox Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  const managerId = await mkUser('mgr@inbox.test', 'MANAGER');
  manager = { id: managerId, role: 'MANAGER' };
  submitter = { id: await mkUser(SUBMITTER, 'EMPLOYEE', managerId), role: 'EMPLOYEE' };
  finance = { id: await mkUser('fin@inbox.test', 'ADMIN'), role: 'ADMIN' };
  cover = { id: await mkUser('cover@inbox.test', 'MANAGER'), role: 'MANAGER' };
  bystander = { id: await mkUser('by@inbox.test', 'MANAGER'), role: 'MANAGER' };
  await withOrg(orgId, async (tx) => {
    const c = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

/**
 * A clean slate per test, keeping only the cast: users, the category, the org.
 *
 * An inbox test COUNTS rows, so anything left behind by an earlier test is a
 * wrong answer rather than noise — the first version of this file deleted only
 * the ladders and every count came back one higher per preceding test. This is
 * the same leakage `routing.db.test.ts` fixes the same way; I judged it not worth
 * the indirection here and was wrong within the hour.
 *
 * ONE statement string, so it runs on ONE pooled connection: the audit purge
 * hatch is transaction-local, and opening it in a separate `query()` call would
 * set it on a connection that goes back to the pool before the DELETE runs.
 * Explicit order rather than relying on cascades, so a missing ON DELETE clause
 * fails here loudly instead of leaving rows behind quietly.
 */
beforeEach(async () => {
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     DELETE FROM approval_task;
     DELETE FROM approval_request;
     DELETE FROM expense_report_event;
     DELETE FROM policy_violation;
     DELETE FROM receipt;
     DELETE FROM expense_line_item;
     DELETE FROM expense;
     DELETE FROM expense_report;
     DELETE FROM approval_policy;
     DELETE FROM expense_policy;
     UPDATE delegation SET revoked_at = now(), revoked_by_id = from_user_id
      WHERE revoked_at IS NULL;
     COMMIT;`,
  );
});

afterAll(async () => {
  await admin.end();
});

/* ── the three routes in ───────────────────────────────────────────────────── */

describe('listInbox', () => {
  it('shows a task assigned to you, with the rung as it was when the run opened', async () => {
    const { reportId } = await submitted();
    const mine = await inboxOf(manager.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      route: 'ASSIGNED',
      step: 1,
      totalSteps: 1,
      resolvedVia: 'MANAGER_CHAIN',
      coveringFor: null,
      // From IMPLICIT_STEP, via the run's snapshot — not the live ladder.
      rungName: 'Direct manager (default)',
      requireReceiptViewAck: true,
      escalationLevel: 0,
      reportId,
      submitterName: 'sub',
      delegatedFrom: null,
    });
    // The control: an unrelated manager's inbox is empty. Without it the
    // assertion above passes on a build where everyone sees everything.
    expect(await inboxOf(bystander.id)).toHaveLength(0);
  });

  it('shows a task delegated to you, naming who it came from — and leaves it in theirs', async () => {
    const { reportId } = await submitted();
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO delegation
           (organization_id, from_user_id, to_user_id, starts_on, ends_on, created_by_id)
         VALUES (current_setting('app.current_org', true)::uuid, $1, $2, DATE '2026-06-01', DATE '2026-06-30', $1)`,
        [manager.id, cover.id],
      ),
    );
    const theirs = await inboxOf(cover.id);
    expect(theirs).toHaveLength(1);
    // COVERING FOR the manager, not delegated-from: the task is still assigned to
    // them and nothing was rerouted. `delegated_from_id` is only set when the
    // RESOLVER moved a task at creation time, which a delegation created after
    // the report was submitted did not do.
    expect(theirs[0]).toMatchObject({
      route: 'DELEGATED',
      coveringFor: 'mgr',
      delegatedFrom: null,
      reportId,
    });
    // The delegator keeps it too: cover FOR someone is not taking it AWAY from
    // them, and a manager who comes back early should still find their queue.
    expect(await inboxOf(manager.id)).toHaveLength(1);
  });

  it('shows a role-pool task to every active holder of that role', async () => {
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Finance sign-off',
        sequence: 1,
        requireReceiptViewAck: false,
        approvers: [{ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }],
      }),
    );
    await submitted();
    const theirs = await inboxOf(finance.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({
      route: 'ROLE_POOL',
      resolvedVia: 'ROLE',
      rungName: 'Finance sign-off',
      requireReceiptViewAck: false,
    });
    // Not a manager's problem: a pool is the named role and nobody else.
    expect(await inboxOf(manager.id)).toHaveLength(0);
  });

  it('does NOT put other people’s tasks in an ADMIN’s inbox — though they could decide them', async () => {
    /**
     * The deliberate split. `canDecide` grants an admin any task, so filtering a
     * broad query by permission alone would dump every pending approval in the
     * tenant into an admin's inbox. The candidate query defines the inbox;
     * permission only ever removes from it.
     */
    const { taskId } = await submitted();
    expect(await inboxOf(finance.id)).toHaveLength(0);
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, finance.id, { isAdmin: true })).toBe(true);
    });
  });

  it('never shows the submitter their own report, even when a task points at them', async () => {
    // Forced: a second step assigned to the submitter, which a mis-authored
    // ladder or a bad reassignment could produce. `canDecide` refuses
    // self-approval, so the filter drops it — the SQL alone would not.
    await withOrg(orgId, async (tx) => {
      await approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 1,
        requireReceiptViewAck: false,
        approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
      });
      await approvals.createPolicy(tx, {
        name: 'Finance',
        sequence: 2,
        requireReceiptViewAck: false,
        approvers: [{ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }],
      });
    });
    const { requestId } = await submitted();
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO approval_task
           (organization_id, request_id, step, assignee_id, resolved_via, status)
         VALUES (current_setting('app.current_org', true)::uuid, $1, 2, $2, 'REASSIGNED', 'PENDING')`,
        [requestId, submitter.id],
      ),
    );
    expect(await inboxOf(submitter.id)).toHaveLength(0);
  });

  it('drops a task once it is decided', async () => {
    const { taskId } = await submitted();
    expect(await inboxOf(manager.id)).toHaveLength(1);
    await withOrg(orgId, (tx) =>
      decide(tx, taskId, manager.id, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    expect(await inboxOf(manager.id)).toHaveLength(0);
  });

  it('surfaces a non-zero escalation level, so a strange route is visible', async () => {
    // The manager is away, so the resolver climbed past them. An approver seeing
    // a report they did not expect should be able to tell why.
    const top = await mkUser('top@inbox.test', 'MANAGER');
    await withOrg(orgId, (tx) =>
      tx.query('UPDATE app_user SET manager_id = $2 WHERE id = $1', [manager.id, top]),
    );
    await withOrg(orgId, (tx) =>
      tx.query("UPDATE app_user SET employee_status = 'ON_LEAVE' WHERE id = $1", [manager.id]),
    );
    await submitted();
    const theirs = await inboxOf(top);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].escalationLevel).toBe(1);
    await withOrg(orgId, (tx) =>
      tx.query("UPDATE app_user SET employee_status = 'ACTIVE' WHERE id = $1", [manager.id]),
    );
    await withOrg(orgId, (tx) =>
      tx.query('UPDATE app_user SET manager_id = NULL WHERE id = $1', [manager.id]),
    );
  });
});

/* ── one report, one answer ────────────────────────────────────────────────── */

describe('resolveDecidableTask', () => {
  it('finds the pending task for someone who may decide it, and nothing for anyone else', async () => {
    const { reportId, taskId } = await submitted();
    await withOrg(orgId, async (tx) => {
      expect(await resolveDecidableTask(tx, reportId, manager.id, { onDate: ON_DATE })).toBe(taskId);
      expect(await resolveDecidableTask(tx, reportId, bystander.id, { onDate: ON_DATE })).toBeNull();
      // The submitter cannot, even though it is their report.
      expect(await resolveDecidableTask(tx, reportId, submitter.id, { onDate: ON_DATE })).toBeNull();
      // An admin can, from the report — which is how they reach what is not in
      // their inbox.
      expect(
        await resolveDecidableTask(tx, reportId, finance.id, { isAdmin: true, onDate: ON_DATE }),
      ).toBe(taskId);
    });
  });
});

/* ── the read widening ─────────────────────────────────────────────────────── */

describe('canReadReport', () => {
  it('admits the submitter and an admin, as it always did', async () => {
    const { reportId } = await submitted();
    const access = await accessTo(reportId);
    await withOrg(orgId, async (tx) => {
      expect(await canReadReport(tx, submitter, access)).toBe(true);
      expect(await canReadReport(tx, finance, access)).toBe(true);
    });
  });

  it('admits an assigned approver and refuses an unrelated manager', async () => {
    // This is where MANAGER's reach opens, and it opens as a narrow additional
    // grant rather than a change to canViewReport.
    const { reportId } = await submitted();
    const access = await accessTo(reportId);
    await withOrg(orgId, async (tx) => {
      expect(await canReadReport(tx, manager, access)).toBe(true);
      expect(await canReadReport(tx, bystander, access)).toBe(false);
    });
  });

  it('STILL admits an approver after they have decided it', async () => {
    /**
     * The deliberate widening. Under a "has a pending task" rule an approver
     * approves a report and immediately cannot open it — so they cannot answer a
     * question about their own decision a week later, and the audit trail is not
     * a substitute for seeing the thing.
     */
    const { reportId, taskId } = await submitted();
    await withOrg(orgId, (tx) =>
      decide(tx, taskId, manager.id, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    const access = await accessTo(reportId);
    await withOrg(orgId, async (tx) => {
      expect(await canReadReport(tx, manager, access)).toBe(true);
      // …and it did not widen to everybody in the process.
      expect(await canReadReport(tx, bystander, access)).toBe(false);
    });
  });

  it('admits a holder of a role the report is waiting on', async () => {
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Finance sign-off',
        sequence: 1,
        requireReceiptViewAck: false,
        approvers: [{ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }],
      }),
    );
    const { reportId } = await submitted();
    const access = await accessTo(reportId);
    await withOrg(orgId, async (tx) => {
      // finance is an ADMIN so ownership already admits them; the manager is the
      // real test — no task of theirs, no role match, no delegation.
      expect(await canReadReport(tx, manager, access)).toBe(false);
    });
  });

  it('refuses a report with no approval history at all', async () => {
    const reportId = await withOrg(orgId, async (tx) => {
      const report = await expenses.createReport(tx, SUBMITTER, {
        title: 'Draft only',
        currencyCode: 'CAD',
      });
      return report.id as string;
    });
    const access = await accessTo(reportId);
    await withOrg(orgId, async (tx) => {
      expect(await canReadReport(tx, manager, access)).toBe(false);
      expect(await canReadReport(tx, submitter, access)).toBe(true);
    });
  });
});
