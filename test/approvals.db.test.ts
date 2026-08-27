/**
 * VX2-1 — approvals schema + ladder, against a real Postgres.
 *
 * Own org slug ('approvals-co') because the DB suites share one database and
 * each TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * TWO kinds of test here, deliberately:
 *  1. the ladder through the service (CRUD, patch semantics, planning), and
 *  2. the CONSTRAINTS through raw SQL. VX2-1's acceptance is "migrates clean",
 *     and the guarantees this ticket actually ships are CHECK constraints and
 *     unique indexes — they have to be exercised as the database enforces them,
 *     not as the service politely avoids them, because VX2-3's engine and a
 *     future graph tier will write these rows through different code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as approvals from '@/lib/approvals/service';
import { ApprovalConfigError } from '@/lib/approvals/tiers';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let submitterId: string;
let managerId: string;
let categoryId: string;

const SUBMITTER = 's@approvals.test';

/** A DRAFT with one coded line, so the report has a real total to band on. */
async function draft(amountMinor = 1000) {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, {
      title: 'Approvable',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, report.id, {
      currencyCode: 'CAD',
      merchant: 'Merchant',
    });
    await expenses.addLineItem(tx, expense.id, { categoryId, amountMinor });
    return { reportId: report.id as string, expenseId: expense.id as string };
  });
}

/** Open a run + its first task by raw SQL — VX2-3 owns the real thing. */
async function openRun(
  reportId: string,
  over: { status?: string; totalSteps?: number; currentStep?: number } = {},
) {
  const status = over.status ?? 'RUNNING';
  // approval_request_closed_consistent: a running run has no closing time and a
  // closed one must have one. Computed here rather than in SQL because reusing
  // one placeholder as both the enum and a text comparison makes Postgres
  // refuse to deduce its type (42P08).
  const closedAt = status === 'RUNNING' ? null : new Date();
  return withOrg(orgId, async (tx) => {
    const q = await tx.query(
      `INSERT INTO approval_request
         (organization_id, report_id, policy_snapshot, status, current_step, total_steps,
          subject_total_minor, subject_currency_code, opened_by_id, closed_at)
       VALUES (current_setting('app.current_org', true)::uuid, $1, '[]'::jsonb, $2, $3, $4,
               1000, 'CAD', $5, $6)
       RETURNING id`,
      [reportId, status, over.currentStep ?? 1, over.totalSteps ?? 1, submitterId, closedAt],
    );
    return q.rows[0].id as string;
  });
}

async function clearLadder() {
  await withOrg(orgId, (tx) => tx.query('DELETE FROM approval_policy'));
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('approvals-co','Approvals Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'m@approvals.test','M','MANAGER') RETURNING id`,
      [orgId],
    );
    managerId = m.rows[0].id;
    const s = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id)
       VALUES ($1,$2,'S',$3) RETURNING id`,
      [orgId, SUBMITTER, managerId],
    );
    submitterId = s.rows[0].id;
    const c = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

/* ── the ladder, through the service ───────────────────────────────────────── */

describe('ladder CRUD', () => {
  it('restores the starter ladder, and is idempotent', async () => {
    await clearLadder();
    const first = await withOrg(orgId, (tx) => approvals.ensureDefaultLadder(tx));
    expect(first).toBe(3);
    // A second press must not duplicate or overwrite a tuned ladder.
    const second = await withOrg(orgId, (tx) => approvals.ensureDefaultLadder(tx));
    expect(second).toBe(0);

    const rungs = await withOrg(orgId, (tx) => approvals.listPolicies(tx));
    expect(rungs.map((r) => [r.sequence, r.threshold_minor, r.approver_kind])).toEqual([
      [1, '0', 'MANAGER'],
      [2, '100000', 'MANAGER'],
      [3, '500000', 'ROLE'],
    ]);
    // bigint columns come back as STRINGS. If this ever reads as a number,
    // something has widened the column type and cents are at risk.
    expect(typeof rungs[1].threshold_minor).toBe('string');
  });

  it('refuses a second rung at the same position', async () => {
    await clearLadder();
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'One',
        sequence: 1,
        approverKind: 'MANAGER',
        managerLevel: 1,
      }),
    );
    await expect(
      withOrg(orgId, (tx) =>
        approvals.createPolicy(tx, {
          name: 'Also one',
          sequence: 1,
          approverKind: 'MANAGER',
          managerLevel: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_TAKEN' });
  });

  it('refuses a named approver who is not an employee here', async () => {
    await clearLadder();
    await expect(
      withOrg(orgId, (tx) =>
        approvals.createPolicy(tx, {
          name: 'Named',
          sequence: 1,
          approverKind: 'USER',
          approverUserId: '00000000-0000-0000-0000-0000000000ff',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_APPROVER' });
  });

  it('switching the approver kind clears the companion columns', async () => {
    await clearLadder();
    const created = await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Second level',
        sequence: 1,
        approverKind: 'MANAGER',
        managerLevel: 2,
      }),
    );
    expect(created.manager_level).toBe(2);

    // ROLE without nulling manager_level would violate
    // approval_policy_approver_complete — the merge is what prevents that.
    const updated = await withOrg(orgId, (tx) =>
      approvals.updatePolicy(tx, created.id, { approverKind: 'ROLE', approverRole: 'ADMIN' }),
    );
    expect(updated.manager_level).toBeNull();
    expect(updated.approver_role).toBe('ADMIN');

    const back = await withOrg(orgId, (tx) =>
      approvals.updatePolicy(tx, created.id, { approverKind: 'USER', approverUserId: managerId }),
    );
    expect(back.approver_role).toBeNull();
    expect(back.approver_user_id).toBe(managerId);
    expect(back.approver_user_email).toBe('m@approvals.test');
  });

  it('leaves untouched fields alone (patch, not replace)', async () => {
    await clearLadder();
    const created = await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 4,
        thresholdMinor: '25000',
        approverKind: 'MANAGER',
        managerLevel: 1,
        requireReceiptViewAck: false,
      }),
    );
    const updated = await withOrg(orgId, (tx) =>
      approvals.updatePolicy(tx, created.id, { enabled: false }),
    );
    expect(updated).toMatchObject({
      name: 'Manager',
      sequence: 4,
      threshold_minor: '25000',
      manager_level: 1,
      require_receipt_view_ack: false,
      enabled: false,
    });
  });

  it('reports a missing rung rather than silently succeeding', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        approvals.deletePolicy(tx, '00000000-0000-0000-0000-0000000000aa'),
      ),
    ).rejects.toBeInstanceOf(ApprovalConfigError);
  });
});

describe('planApprovalForReport', () => {
  it('bands on the report total as stored, not on what a caller passes', async () => {
    await clearLadder();
    await withOrg(orgId, (tx) => approvals.ensureDefaultLadder(tx));
    const { reportId } = await draft(600000); // 6,000.00 -> all three rungs

    const planned = await withOrg(orgId, (tx) => approvals.planApprovalForReport(tx, reportId));
    expect(planned.totalMinor).toBe('600000');
    expect(planned.submitterId).toBe(submitterId);
    expect(planned.implicit).toBe(false);
    expect(planned.plan.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(planned.plan[2].approverRole).toBe('ADMIN');
  });

  it('sees a rung added moments earlier, because it reads inside the transaction', async () => {
    await clearLadder();
    const { reportId } = await draft(900000);
    const planned = await withOrg(orgId, async (tx) => {
      // Same reasoning as VX1-8's submit gate re-running the policy engine: a
      // ladder an admin changed thirty seconds ago has to apply.
      await approvals.createPolicy(tx, {
        name: 'Finance',
        sequence: 1,
        thresholdMinor: '500000',
        approverKind: 'ROLE',
        approverRole: 'ADMIN',
      });
      return approvals.planApprovalForReport(tx, reportId);
    });
    expect(planned.plan.map((s) => s.name)).toEqual(['Finance']);
  });

  it('falls back to the implicit direct-manager rung for an unconfigured tenant', async () => {
    await clearLadder();
    const { reportId } = await draft(750000);
    const planned = await withOrg(orgId, (tx) => approvals.planApprovalForReport(tx, reportId));
    // A tenant that configured nothing must not get free approval on a $7,500
    // report. One human, always.
    expect(planned.implicit).toBe(true);
    expect(planned.plan).toHaveLength(1);
    expect(planned.plan[0].policyId).toBeNull();
    expect(planned.plan[0].requireReceiptViewAck).toBe(true);
  });
});

describe('countStoredReceipts', () => {
  it('counts stored receipts and ignores unconfirmed ones', async () => {
    const { reportId, expenseId } = await draft();
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                              size_bytes, status, uploaded_by_id)
         VALUES (current_setting('app.current_org', true)::uuid, $1, $2, 'a.pdf',
                 'application/pdf', 10, 'STORED', $3),
                (current_setting('app.current_org', true)::uuid, $1, $4, 'b.pdf',
                 'application/pdf', NULL, 'PENDING', $3)`,
        [expenseId, `org/${orgId}/receipts/a/a.pdf`, submitterId, `org/${orgId}/receipts/b/b.pdf`],
      ),
    );
    // A PENDING receipt is an upload intent whose bytes may never have arrived
    // (VX1-5's two-phase upload) — it is not evidence an approver could look at.
    const count = await withOrg(orgId, (tx) => approvals.countStoredReceipts(tx, reportId));
    expect(count).toBe(1);
  });
});

/* ── the constraints, as the database enforces them ────────────────────────── */

describe('approval_request constraints', () => {
  it('allows only ONE running run per report', async () => {
    const { reportId } = await draft();
    await openRun(reportId);
    // The concurrency guard: two simultaneous submits cannot both open a run.
    await expect(openRun(reportId)).rejects.toThrow();
  });

  it('allows many CLOSED runs per report (return, then resubmit)', async () => {
    const { reportId } = await draft();
    await openRun(reportId, { status: 'RETURNED' });
    await openRun(reportId, { status: 'RETURNED' });
    await expect(openRun(reportId)).resolves.toBeTruthy();
  });

  it('refuses a running run with a closing time, and a closed one without', async () => {
    const { reportId } = await draft();
    await expect(
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_request
             (organization_id, report_id, policy_snapshot, status, total_steps,
              subject_total_minor, subject_currency_code, opened_by_id, closed_at)
           VALUES (current_setting('app.current_org', true)::uuid, $1, '[]'::jsonb, 'RUNNING', 1,
                   1000, 'CAD', $2, now())`,
          [reportId, submitterId],
        ),
      ),
    ).rejects.toThrow();

    await expect(
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_request
             (organization_id, report_id, policy_snapshot, status, total_steps,
              subject_total_minor, subject_currency_code, opened_by_id)
           VALUES (current_setting('app.current_org', true)::uuid, $1, '[]'::jsonb, 'APPROVED', 1,
                   1000, 'CAD', $2)`,
          [reportId, submitterId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses a current step past the total', async () => {
    const { reportId } = await draft();
    await expect(openRun(reportId, { totalSteps: 2, currentStep: 3 })).rejects.toThrow();
  });
});

describe('approval_task constraints', () => {
  async function insertTask(over: Record<string, unknown> = {}) {
    const { reportId } = await draft();
    const requestId = await openRun(reportId, { totalSteps: 1 });
    const row = {
      step: 1,
      assignee_id: managerId,
      resolved_via: 'MANAGER_CHAIN',
      delegated_from_id: null,
      escalation_level: 0,
      status: 'PENDING',
      decided_by_id: null,
      decided_at: null,
      receipt_view_acknowledged_at: null,
      ...over,
    };
    return withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO approval_task
           (organization_id, request_id, step, assignee_id, resolved_via, delegated_from_id,
            escalation_level, status, decided_by_id, decided_at, receipt_view_acknowledged_at)
         VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10)
         RETURNING id`,
        [
          requestId,
          row.step,
          row.assignee_id,
          row.resolved_via,
          row.delegated_from_id,
          row.escalation_level,
          row.status,
          row.decided_by_id,
          row.decided_at,
          row.receipt_view_acknowledged_at,
        ],
      ),
    );
  }

  it('accepts a pending task with no decision', async () => {
    await expect(insertTask()).resolves.toBeTruthy();
  });

  it('refuses a pending task that carries a decision', async () => {
    await expect(insertTask({ decided_at: new Date() })).rejects.toThrow();
    await expect(insertTask({ decided_by_id: managerId })).rejects.toThrow();
  });

  it('refuses a real decision missing its actor or its timestamp', async () => {
    await expect(
      insertTask({ status: 'APPROVED', decided_at: new Date(), decided_by_id: null }),
    ).rejects.toThrow();
    await expect(
      insertTask({ status: 'REJECTED', decided_by_id: managerId, decided_at: null }),
    ).rejects.toThrow();
  });

  it('accepts a system outcome with a timestamp and no actor', async () => {
    // A recall voids the pending tasks; a rung the resolver cannot fill is
    // skipped. Neither has a person behind it, but both happened at a time.
    await expect(
      insertTask({ status: 'CANCELLED', decided_at: new Date() }),
    ).resolves.toBeTruthy();
    await expect(insertTask({ status: 'SKIPPED', decided_at: new Date() })).resolves.toBeTruthy();
  });

  it('refuses a receipt acknowledgement on a task nobody has decided', async () => {
    await expect(insertTask({ receipt_view_acknowledged_at: new Date() })).rejects.toThrow();
  });

  it('keeps the acknowledgement and the receipt count on a decided task', async () => {
    const { reportId } = await draft();
    const requestId = await openRun(reportId, { totalSteps: 1 });
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO approval_task
           (organization_id, request_id, step, assignee_id, status, decided_by_id, decided_at,
            note, receipt_view_acknowledged_at, receipts_present_at_decision)
         VALUES (current_setting('app.current_org', true)::uuid, $1, 1, $2, 'APPROVED', $2, now(),
                 'looks fine', now(), 2)`,
        [requestId, managerId],
      ),
    );
    const read = await withOrg(orgId, (tx) => approvals.getReportApproval(tx, reportId));
    expect(read?.tasks).toHaveLength(1);
    expect(read?.tasks[0]).toMatchObject({
      step: 1,
      assignee_email: 'm@approvals.test',
      assignee_name: 'M',
      decided_by_name: 'M',
      status: 'APPROVED',
      note: 'looks fine',
      receipts_present_at_decision: 2,
      escalation_level: 0,
      resolved_via: 'MANAGER_CHAIN',
    });
    expect(read?.tasks[0].receipt_view_acknowledged_at).not.toBeNull();
  });

  it('refuses a DELEGATION task with no source approver', async () => {
    await expect(insertTask({ resolved_via: 'DELEGATION' })).rejects.toThrow();
    await expect(
      insertTask({ resolved_via: 'DELEGATION', delegated_from_id: submitterId }),
    ).resolves.toBeTruthy();
  });

  it('refuses an unknown resolution, and a negative escalation level', async () => {
    await expect(insertTask({ resolved_via: 'VIBES' })).rejects.toThrow();
    await expect(insertTask({ escalation_level: -1 })).rejects.toThrow();
  });

  it('allows only one task per step of a run', async () => {
    const { reportId } = await draft();
    const requestId = await openRun(reportId, { totalSteps: 1 });
    const insert = () =>
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_task (organization_id, request_id, step, assignee_id)
           VALUES (current_setting('app.current_org', true)::uuid, $1, 1, $2)`,
          [requestId, managerId],
        ),
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});

describe('approval_policy constraints', () => {
  it('refuses a rung that names both a role and a person', async () => {
    await clearLadder();
    await expect(
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_policy
             (organization_id, name, sequence, approver_kind, approver_role, approver_user_id)
           VALUES (current_setting('app.current_org', true)::uuid, 'Both', 1, 'ROLE', 'ADMIN', $1)`,
          [managerId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses a manager rung with no level, and a blank name', async () => {
    await clearLadder();
    await expect(
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_policy (organization_id, name, sequence, approver_kind)
           VALUES (current_setting('app.current_org', true)::uuid, 'No level', 1, 'MANAGER')`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO approval_policy
             (organization_id, name, sequence, approver_kind, manager_level)
           VALUES (current_setting('app.current_org', true)::uuid, '  ', 1, 'MANAGER', 1)`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('delegation constraints', () => {
  async function insertDelegation(over: Record<string, unknown> = {}) {
    const row = {
      from_user_id: managerId,
      to_user_id: submitterId,
      starts_on: '2026-09-01',
      ends_on: '2026-09-14',
      scope: 'ALL',
      revoked_at: null,
      revoked_by_id: null,
      ...over,
    };
    return withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO delegation
           (organization_id, from_user_id, to_user_id, starts_on, ends_on, scope,
            created_by_id, revoked_at, revoked_by_id)
         VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4, $5, $1, $6, $7)
         RETURNING id`,
        [
          row.from_user_id,
          row.to_user_id,
          row.starts_on,
          row.ends_on,
          row.scope,
          row.revoked_at,
          row.revoked_by_id,
        ],
      ),
    );
  }

  it('accepts a dated delegation, and an open-ended one', async () => {
    await expect(insertDelegation()).resolves.toBeTruthy();
    await expect(insertDelegation({ ends_on: null })).resolves.toBeTruthy();
  });

  it('refuses delegating to yourself', async () => {
    await expect(insertDelegation({ to_user_id: managerId })).rejects.toThrow();
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(insertDelegation({ ends_on: '2026-08-01' })).rejects.toThrow();
    // Same day is a one-day delegation, not an error.
    await expect(insertDelegation({ ends_on: '2026-09-01' })).resolves.toBeTruthy();
  });

  it('refuses an unknown scope', async () => {
    await expect(insertDelegation({ scope: 'TRAVEL' })).rejects.toThrow();
  });

  it('refuses a half-recorded revocation', async () => {
    await expect(insertDelegation({ revoked_at: new Date() })).rejects.toThrow();
    await expect(
      insertDelegation({ revoked_at: new Date(), revoked_by_id: managerId }),
    ).resolves.toBeTruthy();
  });
});
