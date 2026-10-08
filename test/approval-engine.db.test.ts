/**
 * VX2-3 — the approval engine: opening a run and moving it, against a real
 * Postgres.
 *
 * Own org slug ('engine-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The tests that matter most here are not the happy path. They are: the atomic
 * claim (a double-decide), the audit entry being written in the SAME transaction
 * as the state change (and NOT being written when the decision fails), and the
 * authorization guard being unskippable because it lives inside `decide`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as approvals from '@/lib/approvals/service';
import { decide, openRun, ApprovalEngineError } from '@/lib/approvals/engine';
import { verifyChain } from '@/lib/audit/verify';
import { DecisionForbiddenError } from '@/lib/approvals/eligibility';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'approval-engine.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL). ' +
      'See the local-setup block in HANDOFF.md.',
  );
}
const admin = new Pool({ connectionString: ADMIN_URL });

let orgId: string;
let categoryId: string;
let submitterId: string;
let managerId: string;
let financeId: string;
let bystanderId: string;
const SUBMITTER = 'sub@engine.test';

/**
 * A DRAFT with one coded line at `amountMinor`, ready to submit.
 *
 * The chain is purged AFTER seeding, not only in `beforeEach`. UD-11 made
 * building this fixture an audited act — `addExpense` and `addLineItem` now
 * append `EXPENSE_ADDED` and `LINE_ITEM_ADDED` — and every `auditActions()`
 * assertion below states the chain EXHAUSTIVELY, which was true only for as long
 * as an edit recorded nothing. Eight of them failed the moment edits were
 * audited, which is the correct order of events: the tests were pinned to the
 * gap, the same way `approval-flow.spec.ts` was pinned to the raw-enum render in
 * VX4-7 part 2a.
 *
 * Purging beats filtering the setup's actions out of `auditActions()`: a filter
 * is a hand-kept list of action names that goes stale the next time an edit
 * action is added, and this suite is not the place that would notice.
 */
async function draft(amountMinor = 1000) {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, {
      title: 'Engine',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return report.id as string;
  });
  // One statement, one pooled connection — the trap `beforeEach` documents.
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
  return reportId;
}

/** Submit, which now opens the run in the same transaction. */
async function submit(reportId: string) {
  return withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
}

async function reportRow(reportId: string) {
  const r = await withOrg(orgId, (tx) =>
    tx.query('SELECT status, approved_at FROM expense_report WHERE id = $1', [reportId]),
  );
  return r.rows[0] as { status: string; approved_at: Date | null };
}

async function requestRow(reportId: string) {
  const r = await withOrg(orgId, (tx) =>
    tx.query(
      `SELECT id, status, current_step, total_steps, closed_at
         FROM approval_request WHERE report_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [reportId],
    ),
  );
  return r.rows[0];
}

async function tasksOf(requestId: string) {
  const r = await withOrg(orgId, (tx) =>
    tx.query(
      `SELECT id, step, status, assignee_id, claim_role, resolved_via,
              receipt_view_acknowledged_at, receipts_present_at_decision
         FROM approval_task WHERE request_id = $1 ORDER BY step, id`,
      [requestId],
    ),
  );
  return r.rows;
}

async function auditActions() {
  const r = await withOrg(orgId, (tx) =>
    tx.query('SELECT action FROM audit_entry ORDER BY sequence'),
  );
  return r.rows.map((x) => x.action as string);
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('engine-co','Engine Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@engine.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    managerId = m.rows[0].id;
    const s = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id)
       VALUES ($1,$2,'Sub',$3) RETURNING id`,
      [orgId, SUBMITTER, managerId],
    );
    submitterId = s.rows[0].id;
    const f = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'fin@engine.test','Fin','ADMIN') RETURNING id`,
      [orgId],
    );
    financeId = f.rows[0].id;
    const b = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'by@engine.test','By','MANAGER') RETURNING id`,
      [orgId],
    );
    bystanderId = b.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

beforeEach(async () => {
  // No rungs and no policy rules by default: the ladder falls back to
  // IMPLICIT_STEP (direct manager) and nothing blocks a submit. Each test that
  // wants a real ladder builds its own.
  await admin.query('DELETE FROM approval_policy');
  await admin.query('DELETE FROM expense_policy');
  // Explicit BEGIN/COMMIT so the transaction-local hatch and the DELETE are
  // unambiguously the same transaction on the same pooled connection — the trap
  // already fixed once in test/audit.db.test.ts's clearChain.
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
});

afterAll(async () => {
  await admin.end();
});

/* ── opening ───────────────────────────────────────────────────────────────── */

describe('openRun', () => {
  it('opens on submit, in the same transaction, with step 1 parked', async () => {
    const reportId = await draft();
    const result = await submit(reportId);

    expect(result.approval.totalSteps).toBe(1);
    expect((await reportRow(reportId)).status).toBe('SUBMITTED');

    const req = await requestRow(reportId);
    expect(req).toMatchObject({ status: 'RUNNING', current_step: 1, total_steps: 1 });
    expect(req.closed_at).toBeNull();

    const tasks = await tasksOf(req.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      step: 1,
      status: 'PENDING',
      assignee_id: managerId,
      resolved_via: 'MANAGER_CHAIN',
    });

    // The audit entry is part of the same transaction, and the chain verifies.
    expect(await auditActions()).toEqual(['REPORT_SUBMITTED', 'APPROVAL_RUN_OPENED']);
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true, scanned: 2 });
  });

  it('refuses a second run while one is open', async () => {
    const reportId = await draft();
    await submit(reportId);
    await expect(
      withOrg(orgId, (tx) => openRun(tx, reportId, submitterId)),
    ).rejects.toMatchObject({ code: 'RUN_ALREADY_OPEN' });
  });

  it('refuses to open on anything but a SUBMITTED report', async () => {
    const reportId = await draft();
    await expect(withOrg(orgId, (tx) => openRun(tx, reportId, submitterId))).rejects.toMatchObject({
      code: 'WRONG_STATUS',
    });
  });

  it('routes EVERY step at open, so an unroutable ladder refuses the SUBMIT', async () => {
    /**
     * The all-or-nothing contract earning its keep. An EMAIL approver is
     * storable but not routable until VX2-8, and it sits on step 2 — so nothing
     * about step 1 would reveal the problem. Catching it here means the employee
     * is told at submit time rather than the report parking after step 1 is
     * approved days later.
     */
    await withOrg(orgId, async (tx) => {
      await approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 1,
        approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
      });
      await approvals.createPolicy(tx, {
        name: 'External',
        sequence: 2,
        approvers: [{ position: 1, approverKind: 'EMAIL', externalEmail: 'ext@vendor.test' }],
      });
    });
    const reportId = await draft();
    await expect(submit(reportId)).rejects.toMatchObject({ code: 'EMAIL_APPROVER_UNSUPPORTED' });
    // Nothing committed: still a DRAFT, no run, no audit entry.
    expect((await reportRow(reportId)).status).toBe('DRAFT');
    expect(await auditActions()).toEqual([]);
  });
});

/* ── deciding ──────────────────────────────────────────────────────────────── */

describe('decide', () => {
  it('approves the last step: report APPROVED, approved_at stamped, run closed', async () => {
    const reportId = await draft();
    const { approval } = await submit(reportId);
    // IMPLICIT_STEP carries requireReceiptViewAck: true — the default ladder
    // demands the acknowledgement, same as a configured rung does by default.
    const out = await withOrg(orgId, (tx) =>
      decide(tx, approval.taskId, managerId, 'APPROVED', { receiptViewAcknowledged: true }),
    );

    expect(out).toMatchObject({
      decision: 'APPROVED',
      requestStatus: 'APPROVED',
      reportStatus: 'APPROVED',
      nextTaskId: null,
    });
    const rep = await reportRow(reportId);
    expect(rep.status).toBe('APPROVED');
    expect(rep.approved_at).not.toBeNull();

    const req = await requestRow(reportId);
    expect(req.status).toBe('APPROVED');
    expect(req.closed_at).not.toBeNull();

    // Both trails written, in the decision's own transaction.
    //
    // NEWEST FIRST: listEvents orders `created_at DESC, id DESC`, because it
    // feeds a timeline where the latest thing that happened belongs at the top.
    // The two rows are in different transactions and occurred_at is
    // clock_timestamp(), so the order is deterministic rather than incidental —
    // which is the whole point of 0007 choosing clock_timestamp() over now().
    const events = await withOrg(orgId, (tx) => lifecycle.listEvents(tx, reportId));
    expect(events.map((e) => e.action)).toEqual(['APPROVE', 'SUBMIT']);
    expect(await auditActions()).toEqual(['REPORT_SUBMITTED', 'APPROVAL_RUN_OPENED', 'REPORT_APPROVED']);
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true, scanned: 3 });
  });

  it('advances a two-rung ladder one step at a time', async () => {
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
    const reportId = await draft();
    const { approval } = await submit(reportId);
    expect(approval.totalSteps).toBe(2);

    const first = await withOrg(orgId, (tx) => decide(tx, approval.taskId, managerId, 'APPROVED'));
    expect(first).toMatchObject({ requestStatus: 'RUNNING', reportStatus: 'SUBMITTED' });
    expect(first.nextTaskId).not.toBeNull();
    expect((await requestRow(reportId)).current_step).toBe(2);

    // Step 2 is a ROLE rung, so it is a claim pool rather than a named assignee.
    const tasks = await tasksOf(approval.requestId);
    expect(tasks.map((t) => [t.step, t.status, t.claim_role])).toEqual([
      [1, 'APPROVED', null],
      [2, 'PENDING', 'ADMIN'],
    ]);

    const second = await withOrg(orgId, (tx) =>
      decide(tx, first.nextTaskId as string, financeId, 'APPROVED'),
    );
    expect(second).toMatchObject({ requestStatus: 'APPROVED', reportStatus: 'APPROVED' });
    expect(await auditActions()).toEqual([
      'REPORT_SUBMITTED',
      'APPROVAL_RUN_OPENED',
      'APPROVAL_STEP_APPROVED',
      'REPORT_APPROVED',
    ]);
  });

  it('rejects: report REJECTED, approved_at left NULL, no further step', async () => {
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
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await withOrg(orgId, (tx) =>
      decide(tx, approval.taskId, managerId, 'REJECTED', { note: 'not allowable' }),
    );

    const rep = await reportRow(reportId);
    expect(rep.status).toBe('REJECTED');
    // ExpenseOS's applyTerminal is explicit that a rejection leaves this null.
    expect(rep.approved_at).toBeNull();
    expect((await requestRow(reportId)).status).toBe('REJECTED');
    // Step 2 never materialized.
    expect((await tasksOf(approval.requestId)).map((t) => t.step)).toEqual([1]);
  });

  it('returns a report, and a resubmit opens a NEW run', async () => {
    /**
     * `approval_request_one_running_idx` plus 0008's stated reasoning: "a
     * report's total can move after a RETURN, so a resubmit opens a NEW run
     * rather than re-banding this one — otherwise an employee returned at three
     * sign-offs could trim a line and resubmit into one."
     */
    const reportId = await draft();
    const first = await submit(reportId);
    await withOrg(orgId, (tx) =>
      decide(tx, first.approval.taskId, managerId, 'RETURNED', { note: 'split this out' }),
    );
    expect((await reportRow(reportId)).status).toBe('RETURNED');
    expect((await requestRow(reportId)).status).toBe('RETURNED');

    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId));
    expect((await reportRow(reportId)).status).toBe('DRAFT');

    const second = await submit(reportId);
    expect(second.approval.requestId).not.toBe(first.approval.requestId);
    const runs = await withOrg(orgId, (tx) =>
      tx.query('SELECT status FROM approval_request WHERE report_id = $1', [reportId]),
    );
    expect(runs.rows.map((r) => r.status).sort()).toEqual(['RETURNED', 'RUNNING']);
  });

  it('REFUSES A DOUBLE-DECIDE — the atomic claim', async () => {
    /**
     * The guard that matters. Two decisions on one task — a double-click, or the
     * assignee and an admin racing — must not both advance the run. The
     * conditional write (`AND status = 'PENDING'`) is what stops it; the
     * read-check before it is only there for a good error message.
     */
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await withOrg(orgId, (tx) =>
      decide(tx, approval.taskId, managerId, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    await expect(
      withOrg(orgId, (tx) => decide(tx, approval.taskId, managerId, 'REJECTED')),
    ).rejects.toBeInstanceOf(DecisionForbiddenError);
    // The first decision stands and nothing was written twice.
    expect((await reportRow(reportId)).status).toBe('APPROVED');
    expect(await auditActions()).toEqual(['REPORT_SUBMITTED', 'APPROVAL_RUN_OPENED', 'REPORT_APPROVED']);
  });

  it('cancels a task waiting AHEAD of its turn when the run closes early', async () => {
    /**
     * `approval_task_step_idx` is UNIQUE on (request_id, step) — "a second task
     * at the same step is a bug, not a feature" — so the stranded task has to sit
     * at a LATER step, which is the shape a future quorum rung or a mis-ordered
     * reassignment would produce.
     *
     * CANCELLED, not SKIPPED: 0008 gives SKIPPED the meaning "a step the resolver
     * could not fill", and conflating the two makes "how often could we not find
     * an approver" unanswerable.
     *
     * In a strictly sequential ladder there is normally nothing to sweep, since
     * step N+1 only materializes once step N is approved. The sweep is defensive
     * — but a PENDING task on a closed run is invisible harm: it sits in an inbox
     * pointing at a report nobody can act on.
     */
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
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO approval_task
           (organization_id, request_id, step, assignee_id, resolved_via, status)
         VALUES (current_setting('app.current_org', true)::uuid, $1, 2, $2, 'REASSIGNED', 'PENDING')`,
        [approval.requestId, bystanderId],
      ),
    );
    // Rejecting step 1 closes the run with step 2 still open.
    await withOrg(orgId, (tx) => decide(tx, approval.taskId, managerId, 'REJECTED'));
    expect((await tasksOf(approval.requestId)).map((t) => [t.step, t.status])).toEqual([
      [1, 'REJECTED'],
      [2, 'CANCELLED'],
    ]);
  });
});

/* ── recalling ─────────────────────────────────────────────────────────────── */

describe('recall cancels the run', () => {
  it('voids the run and its pending task, so a resubmit can open a new one', async () => {
    /**
     * The hole this suite found. Recall took the report to DRAFT and left the run
     * RUNNING, so the next submit hit approval_request_one_running_idx and the
     * employee could never resubmit — a dead end with no error anybody would
     * understand.
     */
    const reportId = await draft();
    const first = await submit(reportId);
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId));

    const runs = await withOrg(orgId, (tx) =>
      tx.query('SELECT status, closed_at FROM approval_request WHERE report_id = $1', [reportId]),
    );
    expect(runs.rows[0].status).toBe('CANCELLED');
    expect(runs.rows[0].closed_at).not.toBeNull();
    expect((await tasksOf(first.approval.requestId))[0].status).toBe('CANCELLED');

    // …and the resubmit works, opening a fresh run.
    const second = await submit(reportId);
    expect(second.approval.requestId).not.toBe(first.approval.requestId);
    expect(await auditActions()).toEqual([
      'REPORT_SUBMITTED',
      'APPROVAL_RUN_OPENED',
      'REPORT_RECALLED',
      'APPROVAL_RUN_CANCELLED',
      'REPORT_SUBMITTED',
      'APPROVAL_RUN_OPENED',
    ]);
  });

  it('does not refuse a recall when there is no open run', async () => {
    // A report submitted before VX2-3, or one recalled twice. Refusing here
    // would strand it for a different reason than the one we just fixed.
    const reportId = await draft();
    await submit(reportId);
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId));
    await expect(
      withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitterId)),
    ).rejects.toThrow(/only a submitted or returned report/);
  });
});

/* ── the receipt-view acknowledgement ─────────────────────────────────────── */

describe('receipt-view acknowledgement', () => {
  it('is required on an approval when the rung demands it, and records what was seen', async () => {
    // VX2-1 defaults this ON, because the expensive direction to be wrong in is
    // the one where the evidence was never recorded at all.
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 1,
        requireReceiptViewAck: true,
        approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
      }),
    );
    const reportId = await draft();
    const { approval } = await submit(reportId);

    await expect(
      withOrg(orgId, (tx) => decide(tx, approval.taskId, managerId, 'APPROVED')),
    ).rejects.toMatchObject({ code: 'RECEIPT_ACK_REQUIRED' });
    // The refusal rolled back: no audit entry beyond the open, task still PENDING.
    expect(await auditActions()).toEqual(['REPORT_SUBMITTED', 'APPROVAL_RUN_OPENED']);
    expect((await tasksOf(approval.requestId))[0].status).toBe('PENDING');

    await withOrg(orgId, (tx) =>
      decide(tx, approval.taskId, managerId, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    const task = (await tasksOf(approval.requestId))[0];
    expect(task.receipt_view_acknowledged_at).not.toBeNull();
    // Zero receipts on this report — recorded, because "approved without the
    // approver looking at a receipt" needs the count AT the decision.
    expect(task.receipts_present_at_decision).toBe(0);
  });

  it('is NOT required to reject or return — neither claims the evidence was reviewed', async () => {
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 1,
        requireReceiptViewAck: true,
        approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
      }),
    );
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await expect(
      withOrg(orgId, (tx) => decide(tx, approval.taskId, managerId, 'REJECTED')),
    ).resolves.toMatchObject({ reportStatus: 'REJECTED' });
  });
});

/* ── authorization cannot be skipped ──────────────────────────────────────── */

describe('authorization', () => {
  it('refuses a bystander, and the submitter even as an admin', async () => {
    // `decide` calls assertCanDecide itself, so there is no path that forgets it
    // and no page that can disagree with it (GAP-AUDIT AP-15).
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await expect(
      withOrg(orgId, (tx) => decide(tx, approval.taskId, bystanderId, 'APPROVED')),
    ).rejects.toBeInstanceOf(DecisionForbiddenError);
    await expect(
      withOrg(orgId, (tx) =>
        decide(tx, approval.taskId, submitterId, 'APPROVED', {}, { isAdmin: true }),
      ),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    // Nothing decided, nothing logged.
    expect((await tasksOf(approval.requestId))[0].status).toBe('PENDING');
    expect(await auditActions()).toEqual(['REPORT_SUBMITTED', 'APPROVAL_RUN_OPENED']);
  });

  it('lets an admin decide somebody else’s task', async () => {
    const reportId = await draft();
    const { approval } = await submit(reportId);
    await expect(
      withOrg(orgId, (tx) =>
        decide(tx, approval.taskId, financeId, 'APPROVED', { receiptViewAcknowledged: true }, { isAdmin: true }),
      ),
    ).resolves.toMatchObject({ reportStatus: 'APPROVED' });
  });

  it('surfaces an engine error type callers can catch', async () => {
    const reportId = await draft();
    await expect(withOrg(orgId, (tx) => openRun(tx, reportId, submitterId))).rejects.toBeInstanceOf(
      ApprovalEngineError,
    );
  });
});
