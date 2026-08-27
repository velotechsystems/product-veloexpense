/**
 * VX2-1 — approvals service: the ladder's CRUD, planning a report's approval,
 * and reading a run back.
 *
 * Follows the lib/expenses + lib/policy pattern: pure functions over a tenant
 * `QueryRunner`, called inside a `withOrg` / `withCurrentOrg` transaction, with
 * `app.current_org` already set. Every statement here relies on RLS for tenant
 * scoping and never filters on organization_id itself — except on INSERT, where
 * the column has to be written and comes from the session variable so it cannot
 * disagree with the policy that is about to check it.
 *
 * NOT HERE, on purpose. There is no `openRequest` and no `decide`: opening runs
 * and moving them is VX2-3's engine, and it lands only after VX2-6's audit log
 * exists so that every transition it performs is written to the trail from the
 * engine's first commit. Resolving a rung to a person is VX2-2 (see
 * lib/approvals/routing.ts). Delegation CRUD is VX2-5. This ticket is the
 * schema, the ladder, and the reads the three of them need.
 */
import type { QueryRunner } from '@/lib/db/client';
import { toBigInt } from '@/lib/money';
import type { EmployeeRole } from '@/lib/employees/service';
import {
  ApprovalConfigError,
  DEFAULT_LADDER,
  planApproval,
  assertPolicyInput,
  type ApprovalPolicyPatch,
  type ApprovalPolicyRow,
  type ApproverKind,
  type NewApprovalPolicy,
  type RequestStatus,
  type RungPlan,
  type TaskResolution,
  type TaskStatus,
} from '@/lib/approvals/tiers';

export * from '@/lib/approvals/tiers';

/**
 * organization_id on INSERT comes from the session variable, never from an
 * argument — the same expression the RLS policy will evaluate, so the two can
 * never disagree. Copied from lib/expenses/lifecycle.ts.
 */
const ORG = "current_setting('app.current_org', true)::uuid";

const POLICY_COLUMNS = `
  p.id, p.name, p.sequence, p.threshold_minor, p.approver_kind, p.manager_level,
  p.approver_role, p.approver_user_id, p.require_receipt_view_ack, p.enabled,
  p.created_at, p.updated_at,
  u.email        AS approver_user_email,
  u.display_name AS approver_user_name`;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/* ── ladder CRUD ───────────────────────────────────────────────────────────── */

/** The whole ladder, in rung order. Disabled rungs included — an admin editing
 *  the ladder has to be able to see the rung they switched off. */
export async function listPolicies(tx: QueryRunner): Promise<ApprovalPolicyRow[]> {
  const r = await tx.query(
    `SELECT ${POLICY_COLUMNS}
       FROM approval_policy p
       LEFT JOIN app_user u ON u.id = p.approver_user_id
      ORDER BY p.sequence`,
  );
  return r.rows as ApprovalPolicyRow[];
}

export async function getPolicy(
  tx: QueryRunner,
  policyId: string,
): Promise<ApprovalPolicyRow | null> {
  const r = await tx.query(
    `SELECT ${POLICY_COLUMNS}
       FROM approval_policy p
       LEFT JOIN app_user u ON u.id = p.approver_user_id
      WHERE p.id = $1`,
    [policyId],
  );
  return (r.rows[0] as ApprovalPolicyRow) ?? null;
}

/**
 * A named approver must resolve inside the tenant. RLS already makes a user in
 * another org invisible, so a plain SELECT is the whole check — it returns no
 * row and we reject. Same shape as assertManagerInOrg in lib/employees/service.
 */
async function assertApproverInOrg(tx: QueryRunner, userId: string) {
  const r = await tx.query('SELECT id FROM app_user WHERE id = $1 AND deleted_at IS NULL', [
    userId,
  ]);
  if (r.rows.length === 0) {
    throw new ApprovalConfigError(
      'that approver is not an active employee in this organization',
      'INVALID_APPROVER',
    );
  }
}

export async function createPolicy(
  tx: QueryRunner,
  input: NewApprovalPolicy,
): Promise<ApprovalPolicyRow> {
  assertPolicyInput(input);
  if (input.approverUserId) await assertApproverInOrg(tx, input.approverUserId);

  try {
    const r = await tx.query(
      `INSERT INTO approval_policy
         (organization_id, name, sequence, threshold_minor, approver_kind,
          manager_level, approver_role, approver_user_id,
          require_receipt_view_ack, enabled)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.name.trim(),
        input.sequence,
        (input.thresholdMinor === undefined ? 0n : toBigInt(input.thresholdMinor)).toString(),
        input.approverKind,
        input.managerLevel ?? null,
        input.approverRole ?? null,
        input.approverUserId ?? null,
        input.requireReceiptViewAck ?? true,
        input.enabled ?? true,
      ],
    );
    return (await getPolicy(tx, r.rows[0].id))!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApprovalConfigError(
        `rung ${input.sequence} already exists — pick another position in the ladder`,
        'SEQUENCE_TAKEN',
      );
    }
    throw err;
  }
}

/**
 * Patch-with-nulls, not COALESCE: an absent key leaves the column alone, an
 * explicit null clears it. Under COALESCE, clearing a field from a form is
 * impossible (VX1-6's lesson, applied to updateReport and updateEmployee).
 *
 * The approver columns are the exception and are ALWAYS written together, from
 * the merged row: changing a rung from ROLE to MANAGER has to null
 * approver_role in the same statement that sets manager_level, or the
 * approval_policy_approver_complete CHECK rejects the write. Merging first also
 * means the TypeScript validation sees the row as it will end up rather than
 * only the part that changed.
 */
export async function updatePolicy(
  tx: QueryRunner,
  policyId: string,
  patch: ApprovalPolicyPatch,
): Promise<ApprovalPolicyRow> {
  const current = await getPolicy(tx, policyId);
  if (!current) throw new ApprovalConfigError('approval rung not found', 'NOT_FOUND');

  const kind: ApproverKind =
    patch.approverKind !== undefined ? patch.approverKind : current.approver_kind;

  // When the kind changes, the companion columns come from the patch alone: the
  // old row's manager_level is meaningless on a rung that now names a person.
  const kindChanged = kind !== current.approver_kind;
  const pick = <T>(patched: T | null | undefined, existing: T | null): T | null =>
    patched !== undefined ? patched : kindChanged ? null : existing;

  const merged: NewApprovalPolicy = {
    name: patch.name !== undefined ? patch.name : current.name,
    sequence: patch.sequence !== undefined ? patch.sequence : current.sequence,
    thresholdMinor:
      patch.thresholdMinor !== undefined ? patch.thresholdMinor : current.threshold_minor,
    approverKind: kind,
    managerLevel: pick(patch.managerLevel, current.manager_level),
    approverRole: pick(patch.approverRole, current.approver_role) as EmployeeRole | null,
    approverUserId: pick(patch.approverUserId, current.approver_user_id),
    requireReceiptViewAck:
      patch.requireReceiptViewAck !== undefined
        ? patch.requireReceiptViewAck
        : current.require_receipt_view_ack,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
  };

  assertPolicyInput(merged);
  if (merged.approverUserId) await assertApproverInOrg(tx, merged.approverUserId);

  try {
    await tx.query(
      `UPDATE approval_policy
          SET name = $2,
              sequence = $3,
              threshold_minor = $4,
              approver_kind = $5,
              manager_level = $6,
              approver_role = $7,
              approver_user_id = $8,
              require_receipt_view_ack = $9,
              enabled = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        policyId,
        merged.name.trim(),
        merged.sequence,
        toBigInt(merged.thresholdMinor ?? 0).toString(),
        merged.approverKind,
        merged.managerLevel ?? null,
        merged.approverRole ?? null,
        merged.approverUserId ?? null,
        merged.requireReceiptViewAck ?? true,
        merged.enabled ?? true,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApprovalConfigError(
        `rung ${merged.sequence} already exists — pick another position in the ladder`,
        'SEQUENCE_TAKEN',
      );
    }
    throw err;
  }
  return (await getPolicy(tx, policyId))!;
}

export async function deletePolicy(tx: QueryRunner, policyId: string): Promise<void> {
  const r = await tx.query('DELETE FROM approval_policy WHERE id = $1', [policyId]);
  if (r.rowCount === 0) throw new ApprovalConfigError('approval rung not found', 'NOT_FOUND');
}

/**
 * Restore the starter ladder, skipping any rung position already taken. Returns
 * how many were inserted, so the caller can say "added 2" rather than guessing.
 *
 * Idempotent by `sequence`, matching ensureDefaultPolicies in lib/policy: this is
 * a "give me a sensible starting point" button, not a reset — it must never
 * overwrite a ladder somebody has tuned.
 */
export async function ensureDefaultLadder(tx: QueryRunner): Promise<number> {
  const existing = await tx.query('SELECT sequence FROM approval_policy');
  const taken = new Set<number>(existing.rows.map((row) => Number(row.sequence)));
  let added = 0;
  for (const rung of DEFAULT_LADDER) {
    if (taken.has(rung.sequence)) continue;
    await createPolicy(tx, rung);
    added += 1;
  }
  return added;
}

/* ── planning ──────────────────────────────────────────────────────────────── */

export interface ApprovalPlan {
  reportId: string;
  submitterId: string;
  totalMinor: string;
  currencyCode: string;
  plan: RungPlan[];
  /** True when no rung was configured and IMPLICIT_RUNG was used. */
  implicit: boolean;
}

/**
 * What ladder does THIS report have to climb? Reads the rungs and the report's
 * total inside the caller's transaction, so a rung an admin added seconds ago
 * applies — the same reasoning that makes VX1-8's submit gate re-run the policy
 * engine rather than trust stored findings.
 *
 * Planning is separate from opening a run (VX2-3) so the workbench can show an
 * employee who will have to approve their report before they submit it.
 */
export async function planApprovalForReport(
  tx: QueryRunner,
  reportId: string,
): Promise<ApprovalPlan> {
  const r = await tx.query(
    'SELECT id, submitter_id, total_minor, currency_code FROM expense_report WHERE id = $1',
    [reportId],
  );
  if (r.rows.length === 0) throw new ApprovalConfigError('report not found', 'NOT_FOUND');
  const report = r.rows[0];

  const rungs = await listPolicies(tx);
  const plan = planApproval(rungs, String(report.total_minor));

  return {
    reportId: report.id,
    submitterId: report.submitter_id,
    totalMinor: String(report.total_minor),
    currencyCode: report.currency_code,
    plan,
    implicit: plan.length === 1 && plan[0].policyId === null,
  };
}

/* ── reading a run ─────────────────────────────────────────────────────────── */

export interface ApprovalRequestRow {
  id: string;
  report_id: string;
  policy_snapshot: RungPlan[];
  status: RequestStatus;
  current_step: number;
  total_steps: number;
  subject_total_minor: string;
  subject_currency_code: string;
  opened_by_id: string;
  opened_by_name: string | null;
  opened_by_email: string;
  opened_at: Date;
  closed_at: Date | null;
}

export interface ApprovalTaskRow {
  id: string;
  request_id: string;
  step: number;
  assignee_id: string;
  assignee_name: string | null;
  assignee_email: string;
  resolved_via: TaskResolution;
  delegated_from_id: string | null;
  escalation_level: number;
  status: TaskStatus;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  note: string | null;
  receipt_view_acknowledged_at: Date | null;
  receipts_present_at_decision: number | null;
  created_at: Date;
}

export interface ReportApproval {
  request: ApprovalRequestRow;
  tasks: ApprovalTaskRow[];
}

/**
 * The report's CURRENT run, plus its steps. `opened_at DESC` picks the newest
 * because a RETURN and resubmit opens a fresh run and the old ones stay as
 * history; `opened_at` is clock_timestamp() (0007's lesson) so the ordering is
 * real even for runs opened in one transaction, and `id` breaks any tie.
 */
export async function getReportApproval(
  tx: QueryRunner,
  reportId: string,
): Promise<ReportApproval | null> {
  const r = await tx.query(
    `SELECT q.id, q.report_id, q.policy_snapshot, q.status, q.current_step, q.total_steps,
            q.subject_total_minor, q.subject_currency_code, q.opened_by_id,
            o.display_name AS opened_by_name, o.email AS opened_by_email,
            q.opened_at, q.closed_at
       FROM approval_request q
       JOIN app_user o ON o.id = q.opened_by_id
      WHERE q.report_id = $1
      ORDER BY q.opened_at DESC, q.id DESC
      LIMIT 1`,
    [reportId],
  );
  const request = r.rows[0] as ApprovalRequestRow | undefined;
  if (!request) return null;
  return { request, tasks: await listTasks(tx, request.id) };
}

/** A run's steps in ladder order. `step` is unique per run, so this is total. */
export async function listTasks(
  tx: QueryRunner,
  requestId: string,
): Promise<ApprovalTaskRow[]> {
  const r = await tx.query(
    `SELECT t.id, t.request_id, t.step, t.assignee_id,
            a.display_name AS assignee_name, a.email AS assignee_email,
            t.resolved_via, t.delegated_from_id, t.escalation_level, t.status,
            t.decided_by_id, d.display_name AS decided_by_name, t.decided_at, t.note,
            t.receipt_view_acknowledged_at, t.receipts_present_at_decision, t.created_at
       FROM approval_task t
       JOIN app_user a ON a.id = t.assignee_id
       LEFT JOIN app_user d ON d.id = t.decided_by_id
      WHERE t.request_id = $1
      ORDER BY t.step`,
    [requestId],
  );
  return r.rows as ApprovalTaskRow[];
}

/**
 * How many STORED receipts hang off a report right now. Fills
 * approval_task.receipts_present_at_decision when VX2-3/VX2-4 record a decision:
 * that column is what lets Module 12's control ask the honest question
 * ("approved without the approver looking at a receipt") instead of the
 * approximation ExpenseOS was stuck with ("approved with no receipt on file").
 *
 * PENDING receipts do not count — an upload intent whose bytes never arrived is
 * not evidence of anything (VX1-5's two-phase upload).
 */
export async function countStoredReceipts(tx: QueryRunner, reportId: string): Promise<number> {
  const r = await tx.query(
    `SELECT COUNT(*)::int AS count
       FROM receipt rc
       JOIN expense e ON e.id = rc.expense_id
      WHERE e.report_id = $1 AND rc.status = 'STORED'`,
    [reportId],
  );
  return r.rows[0].count;
}
